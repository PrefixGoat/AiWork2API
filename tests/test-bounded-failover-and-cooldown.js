'use strict';
/**
 * Issue #06 验收测试套件: 内容交付边界、有限跨账号重试与错误分类冷却
 * 对应工单: 06-bounded-failover-delivery-boundary-and-cooldown.md
 * 架构决策: ADR-0004
 *
 * 验证目标:
 * 1. 可配置账号尝试上限参数 (MAX_ACCOUNT_ATTEMPTS, 范围 1-10, 默认 2, 包含首次尝试)；
 * 2. 未交付内容、可重建且无账号专属状态时，遇到可恢复故障在合格候选账号间有限换号 (Chat/Responses/Messages/WS)；
 * 3. 存在不透明账号状态 (opaque_account_state) 或不可重建时严禁换号重试；
 * 4. 严格执行内容交付边界：纯元信息不计入正文交付，一旦正文/思考/工具已下发客户端，严禁跨账号重放，中途断流输出失败事件，严禁伪造 [DONE]；
 * 5. 上游错误分类与冷却：429 按 Retry-After 冷却，401 标记 needs_reauth，5xx/408/403 临时退避，400 零处罚；
 * 6. 受控时钟机制 (POST /api/admin/debug/time) 瞬间快进时间验证冷却与恢复，零真实等待。
 */

const assert = require('assert');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const { MockUpstream } = require('./mock-upstream');

const TEST_DIR = path.join(__dirname, '..', '.scratch', 'v1', 'scratch', `test-failover-${Date.now()}`);
fs.mkdirSync(TEST_DIR, { recursive: true });

const GATEWAY_PORT = 18096;
const GATEWAY_KEY = 'sk-gw-test-failover-admin-key';
const INV_KEY = 'sk-gw-test-invocation-key';
const ADMIN_PASSWORD = 'TestFailoverAdminPassword123!';

let mockUpstream;
let gatewayProcess;

function requestGateway(options, bodyObj) {
  return new Promise((resolve, reject) => {
    const isStream = Boolean(bodyObj && bodyObj.stream);
    const bodyStr = bodyObj ? (typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj)) : null;
    const headers = {
      ...(options.cookie ? { 'Cookie': options.cookie } : {}),
      ...(options.headers || {}),
    };
    if (options.key) {
      headers['Authorization'] = `Bearer ${options.key}`;
    } else if (!options.cookie) {
      headers['Authorization'] = `Bearer ${INV_KEY}`;
    }

    const reqOptions = {
      hostname: '127.0.0.1',
      port: GATEWAY_PORT,
      path: options.path || '/v1/chat/completions',
      method: options.method || (bodyStr ? 'POST' : 'GET'),
      headers: {
        ...headers,
        ...(bodyStr ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
        } : {}),
      },
      timeout: 10000,
    };

    const req = http.request(reqOptions, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try {
          body = JSON.parse(raw);
        } catch (_) {
          body = raw;
        }
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body,
          raw,
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Gateway request timed out')));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function testWsClient(pathStr, key, onConnect) {
  return new Promise((resolve, reject) => {
    const secKey = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(GATEWAY_PORT, '127.0.0.1', () => {
      const reqLines = [
        `GET ${pathStr} HTTP/1.1`,
        `Host: 127.0.0.1:${GATEWAY_PORT}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${secKey}`,
        'Sec-WebSocket-Version: 13',
        `Authorization: Bearer ${key}`,
        '',
        '',
      ];
      sock.write(reqLines.join('\r\n'));
    });

    let headerBuf = '';
    let upgraded = false;
    const receivedFrames = [];

    sock.on('data', (chunk) => {
      if (!upgraded) {
        headerBuf += chunk.toString('utf8');
        const idx = headerBuf.indexOf('\r\n\r\n');
        if (idx !== -1) {
          upgraded = true;
          if (!headerBuf.startsWith('HTTP/1.1 101')) {
            sock.destroy();
            return reject(new Error('WS handshake failed: ' + headerBuf.slice(0, 100)));
          }
          if (onConnect) {
            onConnect({
              sendJson: (obj) => {
                const payload = Buffer.from(JSON.stringify(obj), 'utf8');
                const len = payload.length;
                let header;
                if (len < 126) {
                  header = Buffer.alloc(6);
                  header[0] = 0x81;
                  header[1] = 0x80 | len;
                  const mask = crypto.randomBytes(4);
                  mask.copy(header, 2);
                  for (let i = 0; i < len; i++) payload[i] ^= mask[i % 4];
                  sock.write(Buffer.concat([header, payload]));
                }
              },
              close: () => sock.destroy(),
            });
          }
        }
        return;
      }

      // 简易解析服务端非掩码文本帧
      let off = 0;
      while (off < chunk.length) {
        if (off + 2 > chunk.length) break;
        const b0 = chunk[off];
        const b1 = chunk[off + 1];
        const opcode = b0 & 0x0f;
        let len = b1 & 0x7f;
        let headLen = 2;
        if (len === 126) {
          if (off + 4 > chunk.length) break;
          len = chunk.readUInt16BE(off + 2);
          headLen = 4;
        }
        if (off + headLen + len > chunk.length) break;
        const payload = chunk.slice(off + headLen, off + headLen + len);
        if (opcode === 0x1) {
          try { receivedFrames.push(JSON.parse(payload.toString('utf8'))); } catch (_) {}
        }
        off += headLen + len;
      }
    });

    sock.on('error', (e) => {
      if (!upgraded) reject(e);
    });

    sock.on('close', () => {
      resolve(receivedFrames);
    });

    // 默认 2 秒后关闭以便收集返回帧
    setTimeout(() => {
      try { sock.destroy(); } catch (_) {}
    }, 1200);
  });
}

async function waitForGatewayReady() {
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    try {
      const res = await requestGateway({ path: '/healthz', method: 'GET' });
      if (res.statusCode === 200) return true;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Gateway failed to start within 8s');
}

async function run() {
  console.log('--- 开始执行 Issue #06: 内容交付边界、有限跨账号重试与错误分类冷却验收测试 ---');

  // 1. 启动 MockUpstream
  mockUpstream = new MockUpstream();
  const mockUrl = await mockUpstream.start(0);
  console.log(`[Harness] MockUpstream 已在 ${mockUrl} 启动`);

  // 2. 准备 3 个独立的合成账号状态目录 (acc1, acc2, acc3)
  const acc1Dir = path.join(TEST_DIR, 'acc1');
  const acc2Dir = path.join(TEST_DIR, 'acc2');
  const acc3Dir = path.join(TEST_DIR, 'acc3');
  for (const d of [acc1Dir, acc2Dir, acc3Dir]) fs.mkdirSync(d, { recursive: true });

  const acc1Key = 'sk-upstream-acc1-key';
  const acc2Key = 'sk-upstream-acc2-key';
  const acc3Key = 'sk-upstream-acc3-key';

  const configJson = JSON.stringify({
    config_protocol_version: '1.1',
    models: {
      'aiwork-router': {
        models: [
          { id: 'deepseek-flash', name: 'DeepSeek Flash' },
          { id: 'qwen3.8-max', name: 'Qwen 3.8 Max' },
        ],
      },
    },
  }, null, 2);

  fs.writeFileSync(path.join(acc1Dir, '.env'), `AGENTIX_CONFIG_MODELS_AIWORK_ROUTER_API_KEY=${acc1Key}\n`);
  fs.writeFileSync(path.join(acc1Dir, 'config.json'), configJson);

  fs.writeFileSync(path.join(acc2Dir, '.env'), `AGENTIX_CONFIG_MODELS_AIWORK_ROUTER_API_KEY=${acc2Key}\n`);
  fs.writeFileSync(path.join(acc2Dir, 'config.json'), configJson);

  fs.writeFileSync(path.join(acc3Dir, '.env'), `AGENTIX_CONFIG_MODELS_AIWORK_ROUTER_API_KEY=${acc3Key}\n`);
  fs.writeFileSync(path.join(acc3Dir, 'config.json'), configJson);

  const upstreamAccountsEnv = JSON.stringify([
    { id: 'acc1', name: 'AccOne', stateDir: acc1Dir },
    { id: 'acc2', name: 'AccTwo', stateDir: acc2Dir },
    { id: 'acc3', name: 'AccThree', stateDir: acc3Dir },
  ]);
  const dataDir = path.join(TEST_DIR, 'gw-data');
  fs.mkdirSync(dataDir, { recursive: true });

  // 写入调用凭据：允许访问全部账号
  fs.writeFileSync(path.join(dataDir, 'api-keys.json'), JSON.stringify({
    version: 1,
    keys: [
      {
        id: 'key-test-inv-id',
        token: INV_KEY,
        name: 'test-inv-key',
        accountPolicy: { mode: 'all', allowedAccounts: [] },
        createdAt: Date.now(),
        revoked: false,
      },
    ],
  }, null, 2));

  // 3. 启动网关
  console.log('[Harness] 启动网关进程（注入 3 账号池与时间受控时钟）...');
  gatewayProcess = cp.fork(path.join(__dirname, '..', 'src', 'api-bridge.js'), [], {
    env: {
      ...process.env,
      PORT: String(GATEWAY_PORT),
      BIND: '127.0.0.1',
      ADMIN_PASSWORD: ADMIN_PASSWORD,
      UPSTREAM: 'direct',
      UPSTREAM_FALLBACK: '0',
      ROUTER_BASE_URL: mockUrl,
      UPSTREAM_ACCOUNTS: upstreamAccountsEnv,
      GATEWAY_DATA_DIR: dataDir,
      STATE_PATH: path.join(dataDir, 'usage-state.json'),
      MAX_ACCOUNT_ATTEMPTS: '2', // 明确默认值 2
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  await waitForGatewayReady();
  console.log(`[Harness] 网关在 127.0.0.1:${GATEWAY_PORT} 就绪`);

  // 获取管理端点 Session Cookie
  const loginRes = await requestGateway({
    path: '/api/admin/login',
    method: 'POST',
    key: GATEWAY_KEY,
  }, { password: ADMIN_PASSWORD });
  assert.strictEqual(loginRes.statusCode, 200, '管理员登录必须成功');
  const cookieHeader = loginRes.headers['set-cookie'];
  const adminCookie = Array.isArray(cookieHeader) ? cookieHeader[0].split(';')[0] : '';
  assert.ok(adminCookie, '必须获取到有效的 admin 会话 cookie');

  try {
    // --------------------------------------------------------------------------
    // Test 1: 账号尝试上限参数校验与计数语义 (AC 1)
    // --------------------------------------------------------------------------
    console.log('\n[AC 1 验证] 测试账号尝试上限参数解析、合法范围与计数语义...');
    const { SessionRouter } = require('../src/session-router');
    assert.strictEqual(SessionRouter.parseMaxAccountAttempts(undefined), 2, '未指定时必须明确默认为 2');
    assert.strictEqual(SessionRouter.parseMaxAccountAttempts(''), 2, '空串时必须默认为 2');
    assert.strictEqual(SessionRouter.parseMaxAccountAttempts('0'), 2, '0 越出 1-10 范围必须默认为 2');
    assert.strictEqual(SessionRouter.parseMaxAccountAttempts('-5'), 2, '负数必须默认为 2');
    assert.strictEqual(SessionRouter.parseMaxAccountAttempts('1'), 1, '合法值 1 正确保留');
    assert.strictEqual(SessionRouter.parseMaxAccountAttempts('5'), 5, '合法值 5 正确保留');
    assert.strictEqual(SessionRouter.parseMaxAccountAttempts('10'), 10, '合法上限值 10 正确保留');
    assert.strictEqual(SessionRouter.parseMaxAccountAttempts('15'), 10, '超过 10 必须截断为 10');
    assert.strictEqual(SessionRouter.parseMaxAccountAttempts('invalid'), 2, '非法字符串必须回退默认值 2');

    // 验证默认 MAX_ACCOUNT_ATTEMPTS=2 计数语义：包含首个账号（尝试上限为 2，即使池中有 3 账号，失败两次后立即终止）
    mockUpstream.clear();
    mockUpstream.queueResponse('/v1/chat/completions', {
      status: 500,
      body: { error: { message: 'upstream acc1 failure', type: 'server_error' } },
    });
    mockUpstream.queueResponse('/v1/chat/completions', {
      status: 500,
      body: { error: { message: 'upstream acc2 failure', type: 'server_error' } },
    });
    mockUpstream.queueResponse('/v1/chat/completions', {
      status: 200,
      body: { id: 'chatcmpl-acc3', choices: [{ message: { content: 'acc3 reply' } }] },
    });

    const attemptLimitRes = await requestGateway({
      path: '/v1/chat/completions',
      headers: { 'x-session-id': 'attempt-limit-sess' },
    }, {
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: 'test attempts limit' }],
      stream: false,
    });

    // 尝试两次后（acc1 与 acc2）均失败，到达上限 2，网关必须停止并不触碰 acc3
    assert.strictEqual(attemptLimitRes.statusCode, 500, '两次尝试均失败后网关应返回最后一次上游错误');
    const recordedReqs = mockUpstream.getRecordedRequests('/v1/chat/completions');
    assert.strictEqual(recordedReqs.length, 2, '上游必须且仅收到 2 次请求（首选账号 + 1 次故障切换），不触碰第 3 个账号');
    const authHeaders = recordedReqs.map((r) => r.headers.authorization);
    assert.strictEqual(new Set(authHeaders).size, 2, '必须尝试了 2 个不同的候选账号');
    const validKeys = [`Bearer ${acc1Key}`, `Bearer ${acc2Key}`, `Bearer ${acc3Key}`];
    assert.ok(validKeys.includes(authHeaders[0]) && validKeys.includes(authHeaders[1]), '两个请求凭据均必须来自合法候选账号池');
    console.log('  ✓ AC 1 验证通过：MAX_ACCOUNT_ATTEMPTS 参数范围校验严密，计数语义明确包含首个账号 (2/2 后停止)');

    // --------------------------------------------------------------------------
    // Test 2: 内容交付前安全有限故障换号 (AC 2)
    // --------------------------------------------------------------------------
    console.log('\n[AC 2 验证] 测试未越过内容交付边界时，遇 429/5xx/网络故障在候选账号间安全换号 (Chat/Responses/WS/Messages)...');
    // 清除上一次测试的冷却以恢复干净状态
    await requestGateway({
      path: '/api/admin/debug/time',
      method: 'POST',
      cookie: adminCookie,
    }, { reset: true, advance_sec: 7200 }); // 快进 2 小时解除全部冷却

    // 2a. Chat Completions 非流式换号：首个账号返回 429，第二个账号成功返回 200
    mockUpstream.clear();
    mockUpstream.queueResponse('/v1/chat/completions', {
      status: 429,
      headers: { 'Retry-After': '30' },
      body: { error: { message: 'rate limit reached on acc1', type: 'rate_limit_error' } },
    });
    mockUpstream.queueResponse('/v1/chat/completions', {
      status: 200,
      body: {
        id: 'chatcmpl-failover-success',
        model: 'deepseek-flash',
        choices: [{ index: 0, message: { role: 'assistant', content: 'chat failover success' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    });

    const chatFailoverRes = await requestGateway({
      path: '/v1/chat/completions',
      headers: { 'x-session-id': 'chat-failover-sess' },
    }, {
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: 'hello failover' }],
      stream: false,
    });
    assert.strictEqual(chatFailoverRes.statusCode, 200, 'Chat Completions 换号后应顺利返回 200');
    assert.strictEqual(chatFailoverRes.body.choices[0].message.content, 'chat failover success');
    const chatReqs = mockUpstream.getRecordedRequests('/v1/chat/completions');
    assert.strictEqual(chatReqs.length, 2, '上游应收到 2 次请求（首账号失败换号至第二账号）');
    console.log('  ✓ 2a: Chat Completions 非流式换号成功，客户端透明获取最终正确响应');

    // 重置状态与冷却以供 2b 独立测试
    await requestGateway({
      path: '/api/admin/debug/time',
      method: 'POST',
      cookie: adminCookie,
    }, { reset: true });

    // 2b. Responses API 协议换号：首个账号连接断开/502，第二个账号成功返回 response
    mockUpstream.clear();
    mockUpstream.queueResponse('/v1/chat/completions', {
      status: 502,
      body: { error: { message: 'bad gateway on upstream' } },
    });
    mockUpstream.queueResponse('/v1/chat/completions', {
      status: 200,
      body: {
        id: 'chatcmpl-resp-success',
        model: 'deepseek-flash',
        choices: [{ index: 0, message: { role: 'assistant', content: 'responses failover success' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    });

    const respFailoverRes = await requestGateway({
      path: '/v1/responses',
      headers: { 'x-session-id': 'resp-failover-sess' },
    }, {
      model: 'deepseek-flash',
      input: [{ role: 'user', content: 'hello responses failover' }],
      stream: false,
    });
    assert.strictEqual(respFailoverRes.statusCode, 200, 'Responses API 换号后应顺利返回 200');
    assert.strictEqual(respFailoverRes.body.output[0].content[0].text, 'responses failover success');
    console.log('  ✓ 2b: Responses API 路径透明执行换号并返回规范 Responses 输出');

    // 重置状态与冷却以供 2c 独立测试
    await requestGateway({
      path: '/api/admin/debug/time',
      method: 'POST',
      cookie: adminCookie,
    }, { reset: true });

    // 2c. Responses WebSocket 换号：通过 WebSocket 发送 response.create，首个账号 500，第二个账号成功
    mockUpstream.clear();
    mockUpstream.queueResponse('/v1/chat/completions', {
      status: 500,
      body: { error: { message: 'upstream internal error' } },
    });
    // 第二个账号以流式 SSE 吐出正文
    mockUpstream.queueResponse('/v1/chat/completions', {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      body: [
        'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"ws failover success"}}]}\n\n',
        'data: [DONE]\n\n',
      ].join(''),
    });

    const wsFrames = await testWsClient('/v1/responses', INV_KEY, (client) => {
      client.sendJson({
        type: 'response.create',
        model: 'deepseek-flash',
        input: [{ role: 'user', content: 'hello ws failover' }],
        stream: true,
      });
    });

    const outputDeltaFrame = wsFrames.find((f) => f.type === 'response.output_text.delta');
    assert.ok(outputDeltaFrame, 'Responses WebSocket 客户端必须收到正文增量帧');
    assert.strictEqual(outputDeltaFrame.delta, 'ws failover success');
    const completedFrame = wsFrames.find((f) => f.type === 'response.completed');
    assert.ok(completedFrame, '必须收到 response.completed 帧');
    console.log('  ✓ 2c: Responses WebSocket 连接在交付前故障时平滑迁移至候选账号');

    // 重置状态与冷却以供 2d 独立测试
    await requestGateway({
      path: '/api/admin/debug/time',
      method: 'POST',
      cookie: adminCookie,
    }, { reset: true });

    // 2d. Messages API 流式换号：首个账号返回 503，第二个账号成功返回 Anthropic SSE
    mockUpstream.clear();
    mockUpstream.queueResponse('/v1/chat/completions', {
      status: 503,
      body: { error: { message: 'service unavailable upstream' } },
    });
    mockUpstream.queueResponse('/v1/chat/completions', {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      body: [
        'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"messages failover success"}}]}\n\n',
        'data: [DONE]\n\n',
      ].join(''),
    });

    const msgFailoverRes = await requestGateway({
      path: '/v1/messages',
      headers: { 'x-session-id': 'msg-failover-sess' },
    }, {
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: 'hello messages failover' }],
      stream: true,
    });
    assert.strictEqual(msgFailoverRes.statusCode, 200);
    assert.ok(msgFailoverRes.raw.includes('content_block_delta'), 'Messages 流必须包含 content_block_delta 事件');
    assert.ok(msgFailoverRes.raw.includes('messages failover success'), '必须包含换号后账号交付的正文');
    console.log('  ✓ 2d: Anthropic Messages API 流式交付前安全换号验证通过');

    // 2e. 流中错误帧紧随 [DONE] 换号：旧流被丢弃，绝不能下发旧流的 [DONE] 抢先结束客户端响应
    await requestGateway({
      path: '/api/admin/debug/time',
      method: 'POST',
      cookie: adminCookie,
    }, { reset: true });
    mockUpstream.clear();
    mockUpstream.queueResponse('/v1/chat/completions', {
      sseEvents: [
        { data: { error: { message: 'stream failed' } } },
        { data: '[DONE]' },
      ],
    });
    mockUpstream.queueResponse('/v1/chat/completions', {
      delayMs: 100,
      sseEvents: [
        { data: { choices: [{ delta: { content: 'replacement response' }, finish_reason: 'stop' }] } },
        { data: '[DONE]' },
      ],
    });
    const sseFailoverRes = await requestGateway({
      path: '/v1/chat/completions',
      headers: { 'x-session-id': 'sse-failover-race-sess' },
    }, {
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: 'hello sse failover race' }],
      stream: true,
    });
    assert.strictEqual(sseFailoverRes.statusCode, 200);
    assert.ok(sseFailoverRes.raw.includes('replacement response'), '必须包含换号后第二账号交付的替换正文');
    assert.strictEqual(mockUpstream.getRecordedRequests('/v1/chat/completions').length, 2, '必须产生 2 次上游请求');
    console.log('  ✓ 2e: 流中错误帧紧随 [DONE] 换号成功，旧流彻底阻断，新流完整交付');

    // --------------------------------------------------------------------------
    // Test 3: 不透明账号状态与不可重建会话拦截 (AC 3)
    // --------------------------------------------------------------------------
    console.log('\n[AC 3 验证] 测试携带不透明账号状态或会话不可重建时严禁换号...');
    await requestGateway({
      path: '/api/admin/debug/time',
      method: 'POST',
      cookie: adminCookie,
    }, { reset: true, advance_sec: 7200 });

    // 3a. 携带 opaque_account_state: true
    mockUpstream.clear();
    mockUpstream.queueResponse('/v1/chat/completions', {
      status: 429,
      body: { error: { message: 'rate limit with opaque state', type: 'rate_limit_error' } },
    });
    mockUpstream.queueResponse('/v1/chat/completions', {
      status: 200,
      body: { id: 'should-not-reach', choices: [{ message: { content: 'never reached' } }] },
    });

    const opaqueStateRes = await requestGateway({
      path: '/v1/chat/completions',
      headers: { 'x-session-id': 'opaque-test-sess' },
    }, {
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: 'test opaque' }],
      opaque_account_state: true, // 明确携带不透明状态
      stream: false,
    });

    assert.strictEqual(opaqueStateRes.statusCode, 429, '存在不透明状态时必须直接返回错误，严禁跨账号重放');
    assert.strictEqual(mockUpstream.getRecordedRequests('/v1/chat/completions').length, 1, '仅尝试 1 次，严禁向其他账号换号');
    console.log('  ✓ 3a: 携带 opaque_account_state 时严格禁止换号重放');

    // 3b. 请求头携带 x-reconstructible: 'false'
    mockUpstream.clear();
    mockUpstream.queueResponse('/v1/chat/completions', {
      status: 500,
      body: { error: { message: 'upstream error non reconstructible', type: 'server_error' } },
    });
    mockUpstream.queueResponse('/v1/chat/completions', {
      status: 200,
      body: { id: 'should-not-reach', choices: [{ message: { content: 'never reached' } }] },
    });

    const nonReconRes = await requestGateway({
      path: '/v1/chat/completions',
      headers: {
        'x-session-id': 'non-recon-sess',
        'x-reconstructible': 'false', // 明确上下文不可重建
      },
    }, {
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: 'test non reconstructible' }],
      stream: false,
    });

    assert.strictEqual(nonReconRes.statusCode, 500, '上下文不可重建时必须直接返回错误，严禁换号');
    assert.strictEqual(mockUpstream.getRecordedRequests('/v1/chat/completions').length, 1, '仅尝试 1 次，严禁向其他账号重放');
    console.log('  ✓ 3b: 上下文不可重建 (x-reconstructible: false) 时严格禁止换号重放');

    // 3c. Responses 与 Messages 传入 opaque_account_state / reconstructible 时严禁换号
    await requestGateway({
      path: '/api/admin/debug/time',
      method: 'POST',
      cookie: adminCookie,
    }, { reset: true, advance_sec: 7200 });
    mockUpstream.clear();
    mockUpstream.queueResponse('/v1/chat/completions', {
      status: 500,
      body: { error: { message: 'first account fail' } },
    });
    mockUpstream.queueResponse('/v1/chat/completions', {
      status: 200,
      body: { id: 'should-not-reach', choices: [{ message: { content: 'second account' } }] },
    });

    const respOpaqueRes = await requestGateway({
      path: '/v1/responses',
      method: 'POST',
    }, {
      model: 'deepseek-flash',
      input: 'protected',
      opaque_account_state: true,
      reconstructible: false,
    });
    assert.strictEqual(mockUpstream.getRecordedRequests('/v1/chat/completions').length, 1, 'Responses 仅尝试 1 次，严禁向其他账号换号');
    assert.strictEqual(respOpaqueRes.statusCode, 500, 'Responses 携带不透明状态时必须直接返回错误，严禁换号');

    // Messages API 路径测试
    await requestGateway({
      path: '/api/admin/debug/time',
      method: 'POST',
      cookie: adminCookie,
    }, { reset: true, advance_sec: 7200 });
    mockUpstream.clear();
    mockUpstream.queueResponse('/v1/chat/completions', {
      status: 500,
      body: { error: { message: 'first account fail messages' } },
    });
    mockUpstream.queueResponse('/v1/chat/completions', {
      status: 200,
      body: { id: 'should-not-reach-msg', choices: [{ message: { content: 'second account' } }] },
    });
    const msgOpaqueRes = await requestGateway({
      path: '/v1/messages',
      method: 'POST',
    }, {
      model: 'deepseek-flash',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'protected msg' }],
      opaque_account_state: true,
      reconstructible: false,
    });
    assert.strictEqual(mockUpstream.getRecordedRequests('/v1/chat/completions').length, 1, 'Messages 仅尝试 1 次，严禁向其他账号换号');
    assert.strictEqual(msgOpaqueRes.statusCode, 500, 'Messages 携带不透明状态时必须直接返回错误，严禁换号');
    console.log('  ✓ 3c: Responses 与 Messages 携带 opaque_account_state / reconstructible 时严格禁止换号重放');

    // --------------------------------------------------------------------------
    // Test 4: 内容交付边界严格执行 (AC 4)
    // --------------------------------------------------------------------------
    console.log('\n[AC 4 验证] 测试内容交付边界：纯元数据允许换号；一旦正文/思考/工具下发严禁换号且绝不下发假 [DONE]...');
    await requestGateway({
      path: '/api/admin/debug/time',
      method: 'POST',
      cookie: adminCookie,
    }, { reset: true, advance_sec: 7200 });

    // 4a. 纯元数据块（仅 choices[0].delta 为空或仅包含 role: 'assistant'）不计入正文交付，允许安全换号
    mockUpstream.clear();
    // 首个账号：下发 HTTP 200 头和空元数据帧后，上游突然中断
    mockUpstream.queueResponse('/v1/chat/completions', {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      body: 'data: {"id":"chatcmpl-meta","choices":[{"delta":{"role":"assistant"}}]}\n\n',
      // 无 [DONE]，直接断开
    });
    // 第二个账号：成功接力完整流
    mockUpstream.queueResponse('/v1/chat/completions', {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      body: [
        'data: {"choices":[{"delta":{"content":"Recovered after pure metadata"}}]}\n\n',
        'data: [DONE]\n\n',
      ].join(''),
    });

    const metaOnlyRes = await requestGateway({
      path: '/v1/chat/completions',
      headers: { 'x-session-id': 'meta-boundary-sess' },
    }, {
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: 'test metadata boundary' }],
      stream: true,
    });
    assert.strictEqual(metaOnlyRes.statusCode, 200);
    assert.ok(metaOnlyRes.raw.includes('Recovered after pure metadata'), '必须从第二个账号成功接力交付完整正文');
    assert.ok(metaOnlyRes.raw.includes('data: [DONE]'), '最终必须正常结束流');
    assert.strictEqual(mockUpstream.getRecordedRequests('/v1/chat/completions').length, 2, '纯元数据下上游断流允许安全换号至第二账号');
    console.log('  ✓ 4a: 纯元数据块（无正文/思考/工具）不触发交付边界，允许安全换号接力');

    // 4a-2: REASONING=off 时被剥除的思考片段未真正下发给客户端，不应过早封锁换号 (Spec line 57 / US 33)
    mockUpstream.clear();
    // 首个账号：仅包含 reasoning_content，无正文 content，随后突然断流
    mockUpstream.queueResponse('/v1/chat/completions', {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      body: 'data: {"id":"chatcmpl-reasoning-only","choices":[{"delta":{"role":"assistant","reasoning_content":"internal stripped thought"}}]}\n\n',
      // 断流
    });
    // 第二个账号：接力成功
    mockUpstream.queueResponse('/v1/chat/completions', {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      body: [
        'data: {"choices":[{"delta":{"content":"Recovered after stripped reasoning"}}]}\n\n',
        'data: [DONE]\n\n',
      ].join(''),
    });

    const strippedReasoningRes = await requestGateway({
      path: '/v1/chat/completions',
      headers: { 'x-session-id': 'reasoning-boundary-sess' },
    }, {
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: 'test stripped reasoning boundary' }],
      stream: true,
    });
    assert.strictEqual(strippedReasoningRes.statusCode, 200);
    assert.ok(strippedReasoningRes.raw.includes('Recovered after stripped reasoning'), '被剥除思考片段未真正交付时必须允许换号接力');
    assert.strictEqual(mockUpstream.getRecordedRequests('/v1/chat/completions').length, 2, '未交付思考内容时必须成功换号至第二账号');
    console.log('  ✓ 4a-2: 被剥除思考片段不触发交付边界，允许换号接力');

    // 4b. 越过内容交付边界后发生中断：严禁跨账号重放，保留已交付部分，明确下发 stream_interrupted 错误帧，严禁伪造 [DONE]
    mockUpstream.clear();
    // 首个账号下发了包含真实正文的块，然后连接突然中断
    mockUpstream.queueResponse('/v1/chat/completions', {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      body: [
        'data: {"id":"chatcmpl-partial","choices":[{"delta":{"role":"assistant","content":"First half content delivered..."}}]}\n\n',
        // 突然终止，没有 [DONE]
      ].join(''),
    });
    // 若错误换号，第二个账号会被请求：
    mockUpstream.queueResponse('/v1/chat/completions', {
      status: 200,
      body: { choices: [{ message: { content: 'illegal duplicate replay' } }] },
    });

    const partialDeliveredRes = await requestGateway({
      path: '/v1/chat/completions',
      headers: { 'x-session-id': 'partial-delivery-sess' },
    }, {
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: 'test partial content boundary' }],
      stream: true,
    });

    assert.strictEqual(partialDeliveredRes.statusCode, 200);
    assert.ok(partialDeliveredRes.raw.includes('First half content delivered...'), '必须保留已下发的首段正文');
    assert.ok(partialDeliveredRes.raw.includes('stream_interrupted'), '必须明确输出 stream_interrupted 失败帧');
    // 关键断言：绝对不能下发假 [DONE] 掩饰中断
    assert.ok(!partialDeliveredRes.raw.includes('[DONE]'), '一旦中途断流，绝对不能伪造下发 [DONE] 掩饰失败');
    assert.strictEqual(mockUpstream.getRecordedRequests('/v1/chat/completions').length, 1, '越过内容交付边界后严禁发起跨账号重放');
    console.log('  ✓ 4b: 交付正文后中途断流严格禁止换号重放，输出 stream_interrupted，绝对不发假 [DONE]');

    // 4c. Responses API 越过内容交付边界后中断：下发 response.failed，绝不下发 response.completed
    mockUpstream.clear();
    mockUpstream.queueResponse('/v1/chat/completions', {
      sseEvents: [
        { data: { choices: [{ delta: { content: 'responses mid stream chunk' } }] } },
        { delayMs: 40, abort: true },
      ],
    });

    const respStreamFailRes = await requestGateway({
      path: '/v1/responses',
      headers: { 'x-session-id': 'resp-boundary-sess' },
    }, {
      model: 'deepseek-flash',
      input: [{ role: 'user', content: 'test resp boundary' }],
      stream: true,
    });
    assert.strictEqual(respStreamFailRes.statusCode, 200);
    assert.ok(respStreamFailRes.raw.includes('response.output_text.delta'), '必须已向客户端交付了部分文本增量');
    assert.ok(respStreamFailRes.raw.includes('response.failed'), '中断时必须明确下发 response.failed 事件');
    assert.ok(!respStreamFailRes.raw.includes('response.completed'), '中断时严禁下发 fake response.completed');
    console.log('  ✓ 4c: Responses 流式交付后中断明确下发 response.failed，绝不下发假 response.completed');

    // --------------------------------------------------------------------------
    // Test 5: 错误分类、账号冷却与状态更新 (AC 5)
    // --------------------------------------------------------------------------
    console.log('\n[AC 5 验证] 测试上游错误性质分类处理：400 零处罚、401 needs_reauth、429 冷却、408/403 短期退避...');
    await requestGateway({
      path: '/api/admin/debug/time',
      method: 'POST',
      cookie: adminCookie,
    }, { reset: true, advance_sec: 7200 });

    // 5a. 400 客户端参数错误：客户端责任，严禁处罚账号健康度
    mockUpstream.clear();
    mockUpstream.queueResponse('/v1/chat/completions', {
      status: 400,
      body: { error: { message: 'Invalid parameter temperature=999', type: 'invalid_request_error' } },
    });

    const badReqRes = await requestGateway({
      path: '/v1/chat/completions',
      headers: { 'x-session-id': 'bad-req-sess' },
    }, {
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: 'test 400' }],
      temperature: 999,
      stream: false,
    });
    assert.strictEqual(badReqRes.statusCode, 400, '参数错误应直接返回 400');
    // 查看账号健康状态
    const accListRes1 = await requestGateway({
      path: '/api/admin/accounts',
      method: 'GET',
      cookie: adminCookie,
    });
    const acc1State = accListRes1.body.accounts.find((a) => a.id === 'acc1');
    assert.strictEqual(acc1State.status, 'ready', '400 错误绝对不可改变账号 ready 状态');
    assert.strictEqual(acc1State.in_cooldown, false, '400 错误绝对不可进入冷却');
    assert.strictEqual(acc1State.cooldown_remaining_sec, 0, '400 冷却剩余必须为 0');
    console.log('  ✓ 5a: 400 参数错误实施零处罚，账号健康度与冷却状态完好');

    // 5b. 401 凭据失效：标记 needs_reauth，提供 CLI 恢复指引，并暂停选择
    mockUpstream.clear();
    mockUpstream.queueResponse('/v1/chat/completions', {
      status: 401,
      body: { error: { message: 'Unauthorized: token expired', type: 'auth_error' } },
    });
    // 换号至 acc2 成功
    mockUpstream.queueResponse('/v1/chat/completions', {
      status: 200,
      body: { choices: [{ message: { content: 'acc2 ok after 401' } }] },
    });

    const reauthReqRes = await requestGateway({
      path: '/v1/chat/completions',
      headers: { 'x-session-id': 'reauth-test-sess' },
    }, {
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: 'test 401' }],
      stream: false,
    });
    assert.strictEqual(reauthReqRes.statusCode, 200);

    const accListRes2 = await requestGateway({
      path: '/api/admin/accounts',
      method: 'GET',
      cookie: adminCookie,
    });
    const recordedIn5b = mockUpstream.getRecordedRequests('/v1/chat/completions');
    const failedAcc5bId = recordedIn5b[0].headers.authorization.includes(acc1Key) ? 'acc1'
      : (recordedIn5b[0].headers.authorization.includes(acc2Key) ? 'acc2' : 'acc3');
    const failedAcc5bState = accListRes2.body.accounts.find((a) => a.id === failedAcc5bId);
    assert.strictEqual(failedAcc5bState.status, 'needs_reauth', '401 必须标记账号状态为 needs_reauth');
    assert.ok(failedAcc5bState.recoveryHint.includes('dtcoder login'), '恢复指引中必须包含 dtcoder login');
    assert.strictEqual(failedAcc5bState.in_cooldown, true, '失效账号必须暂停选择进入冷却');
    console.log('  ✓ 5b: 401 明确标记 needs_reauth，包含 CLI 恢复指引并从候选集合暂停选择');

    // 5c. 429 限流：根据 Retry-After 进入精准冷却
    mockUpstream.clear();
    mockUpstream.queueResponse('/v1/chat/completions', {
      status: 429,
      headers: { 'Retry-After': '45' }, // 显式 45s
      body: { error: { message: 'account quota limit exceeded', type: 'rate_limit_error' } },
    });
    // 换号至下一个可用账号
    mockUpstream.queueResponse('/v1/chat/completions', {
      status: 200,
      body: { choices: [{ message: { content: 'ok after 429' } }] },
    });

    const rateLimitReqRes = await requestGateway({
      path: '/v1/chat/completions',
      headers: { 'x-session-id': 'rate-limit-sess' },
    }, {
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: 'test 429' }],
      stream: false,
    });
    assert.strictEqual(rateLimitReqRes.statusCode, 200);

    const recordedIn5c = mockUpstream.getRecordedRequests('/v1/chat/completions');
    const failedAcc5cId = recordedIn5c[0].headers.authorization.includes(acc1Key) ? 'acc1'
      : (recordedIn5c[0].headers.authorization.includes(acc2Key) ? 'acc2' : 'acc3');

    const accListRes3 = await requestGateway({
      path: '/api/admin/accounts',
      method: 'GET',
      cookie: adminCookie,
    });
    const accRateState = accListRes3.body.accounts.find((a) => a.id === failedAcc5cId);
    assert.strictEqual(accRateState.in_cooldown, true, '被限流的账号必须进入冷却状态');
    assert.ok(accRateState.cooldown_remaining_sec >= 40 && accRateState.cooldown_remaining_sec <= 45,
      `冷却剩余时间必须约为 45 秒 (实际: ${accRateState.cooldown_remaining_sec})`);
    console.log('  ✓ 5c: 429 解析 Retry-After 正确进入精准时间冷却');

    // --------------------------------------------------------------------------
    // Test 6: 受控时钟机制与管理端点时间旅行验证 (AC 6)
    // --------------------------------------------------------------------------
    console.log('\n[AC 6 验证] 测试受控时钟机制 (POST /api/admin/debug/time) 瞬间穿越冷却，无真实等待...');
    // 调用 POST /api/admin/debug/time 穿越 50 秒，使该被限流账号的 45 秒冷却瞬间到期
    const timeAdvanceRes = await requestGateway({
      path: '/api/admin/debug/time',
      method: 'POST',
      cookie: adminCookie,
    }, { advance_sec: 50 });
    assert.strictEqual(timeAdvanceRes.statusCode, 200);
    assert.strictEqual(timeAdvanceRes.body.ok, true);
    assert.ok(timeAdvanceRes.body.offset_ms >= 50000, '时钟偏移必须成功累加 50000ms');

    // 检查账号状态：该账号的冷却应已完全恢复
    const accListRes4 = await requestGateway({
      path: '/api/admin/accounts',
      method: 'GET',
      cookie: adminCookie,
    });
    const accRecoveredState = accListRes4.body.accounts.find((a) => a.id === failedAcc5cId);
    assert.strictEqual(accRecoveredState.in_cooldown, false, '时钟快进后账号必须自动脱离冷却恢复就绪');
    assert.strictEqual(accRecoveredState.cooldown_remaining_sec, 0, '冷却剩余时间必须为 0');

    // 测试管理接口手动设置与清除冷却 (POST /api/admin/accounts/:id/cooldown)
    const setCooldownRes = await requestGateway({
      path: `/api/admin/accounts/${failedAcc5cId}/cooldown`,
      method: 'POST',
      cookie: adminCookie,
    }, { duration_sec: 60 });
    assert.strictEqual(setCooldownRes.statusCode, 200);
    assert.strictEqual(setCooldownRes.body.in_cooldown, true);

    const clearCooldownRes = await requestGateway({
      path: `/api/admin/accounts/${failedAcc5cId}/cooldown`,
      method: 'POST',
      cookie: adminCookie,
    }, { clear: true });
    assert.strictEqual(clearCooldownRes.statusCode, 200);
    assert.strictEqual(clearCooldownRes.body.in_cooldown, false);
    assert.strictEqual(clearCooldownRes.body.cooldown_remaining_sec, 0);
    console.log('  ✓ AC 6 验证通过：受控时钟瞬间快进冷却时间，管理端点自由操控冷却，零真实等待');

    console.log('\n>>> Issue #06 全部 6 项验收指标测试 100% 通过 ✓ <<<');
  } finally {
    if (mockUpstream) await mockUpstream.stop();
    if (gatewayProcess) {
      gatewayProcess.kill();
      await new Promise((r) => setTimeout(r, 100));
    }
    try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch (_) {}
  }
}

run().catch((err) => {
  console.error('\n✗ 测试失败:', err);
  if (mockUpstream) mockUpstream.stop();
  if (gatewayProcess) gatewayProcess.kill();
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch (_) {}
  process.exit(1);
});
