'use strict';
/**
 * Issue #08 验收测试套件: 可选服务端内存历史续接、默认无正文持久化与有界调试抓包
 * 对应工单: 08-in-memory-continuation-and-privacy-persistence.md
 * 规格依据: spec.md & v1-acceptance.md (AC 45, AC 46, AC 47; US 47-51) & ADR-0003
 *
 * 验证目标:
 * 1. 完整对话历史独立交互 (US 47): 客户端自行携带完整历史交互，无需依赖服务端存储；
 * 2. 可选内存历史续接一致性 (US 48): 启用内存历史时，流式与非流式请求均一致存储规范输入、assistant 文本及工具上下文，支持 previous_response_id 续接与 GET 查询，受 LRU 容量与 TTL 控制；
 * 3. 严格历史归属隔离与错误契约 (US 49): 跨凭据严禁续接/读取历史 (404)；未启用 (400) 或不存在/淘汰/重启 (404) 明确报错，绝不静默当全新对话；
 * 4. 默认隐私持久化与日志脱敏 (US 50): usage-state.json 零聊天正文、零首句摘要 (label 为空)；日志对 Bearer 与 API key 脱敏；
 * 5. 有界调试抓包 (US 51): 默认关闭；开启时自动掩码凭据，且严格执行保留条数/字节数有界淘汰清理。
 */

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const { MockUpstream } = require('./mock-upstream');
const { ResponseHistoryManager } = require('../src/response-history');

const TEST_DIR = path.join(__dirname, '..', '.scratch', 'v1', 'scratch', `test-continuation-${Date.now()}`);
fs.mkdirSync(TEST_DIR, { recursive: true });

const GATEWAY_PORT = 18098;
const GATEWAY_KEY_ADMIN = 'sk-gw-admin-token-08';
const KEY_A = 'sk-gw-client-key-a';
const KEY_B = 'sk-gw-client-key-b';
const ADMIN_PASSWORD = 'TestContinuationAdminPass123!';

let mockUpstream;
let gatewayProcess;

function requestGateway(port, options, bodyObj) {
  return new Promise((resolve, reject) => {
    let bodyBuffer = null;
    if (options.rawBodyBuffer) {
      bodyBuffer = options.rawBodyBuffer;
    } else if (bodyObj !== undefined) {
      const bodyStr = typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj);
      bodyBuffer = Buffer.from(bodyStr, 'utf8');
    }

    const headers = {
      'Content-Type': 'application/json',
      ...(options.cookie ? { 'Cookie': options.cookie } : {}),
      ...(options.headers || {}),
    };
    if (options.key) {
      headers['Authorization'] = `Bearer ${options.key}`;
    } else if (!headers['Authorization'] && !headers['x-api-key'] && !options.cookie && !options.noAuth) {
      headers['Authorization'] = `Bearer ${KEY_A}`;
    }

    if (bodyBuffer) {
      headers['Content-Length'] = bodyBuffer.length;
    }

    const reqOptions = {
      hostname: '127.0.0.1',
      port: port || GATEWAY_PORT,
      path: options.path || '/v1/chat/completions',
      method: options.method || (bodyBuffer ? 'POST' : 'GET'),
      headers,
      timeout: options.timeout || 10000,
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
          chunks,
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Gateway request timed out')));
    if (bodyBuffer) req.write(bodyBuffer);
    req.end();
  });
}

async function waitForGateway(port, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await requestGateway(port, { path: '/healthz', method: 'GET', noAuth: true });
      if (res.statusCode === 200 && res.raw.includes('ok')) return true;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Gateway on port ${port} failed to become ready within timeout`);
}

function startGatewayProcess(envOverrides = {}, port = GATEWAY_PORT) {
  const dataDir = path.join(TEST_DIR, `data-${port}`);
  fs.mkdirSync(dataDir, { recursive: true });

  const accDir = path.join(TEST_DIR, `acc-${port}`);
  fs.mkdirSync(accDir, { recursive: true });
  fs.writeFileSync(path.join(accDir, '.env'), 'AGENTIX_CONFIG_MODELS_AIWORK_ROUTER_API_KEY=sk-upstream-token\n');
  fs.writeFileSync(path.join(accDir, 'config.json'), JSON.stringify({
    config_protocol_version: '1.1',
    models: {
      'aiwork-router': {
        models: [
          { id: 'deepseek-flash', name: 'DeepSeek Flash' },
          { id: 'qwen3.8-max', name: 'Qwen 3.8 Max' },
        ],
      },
    },
  }, null, 2));

  fs.writeFileSync(path.join(dataDir, 'api-keys.json'), JSON.stringify({
    keys: [
      {
        id: 'key-id-a',
        name: 'Client Key A',
        token: KEY_A,
        created_at: new Date().toISOString(),
        revoked: false,
        account_policy: { mode: 'all' },
      },
      {
        id: 'key-id-b',
        name: 'Client Key B',
        token: KEY_B,
        created_at: new Date().toISOString(),
        revoked: false,
        account_policy: { mode: 'all' },
      },
    ],
  }, null, 2));

  const accountsConfig = JSON.stringify([
    { id: 'acc1', name: 'AccOne', stateDir: accDir },
  ]);

  const p = cp.spawn(process.execPath, [path.join(__dirname, '..', 'src', 'api-bridge.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      BIND: '127.0.0.1',
      GATEWAY_DATA_DIR: dataDir,
      DATA_DIR: dataDir,
      STATE_PATH: path.join(dataDir, 'usage-state.json'),
      UPSTREAM_ACCOUNTS: accountsConfig,
      ROUTER_BASE_URL: mockUpstream.url,
      API_KEYS: `${GATEWAY_KEY_ADMIN},${KEY_A}:Client Key A,${KEY_B}:Client Key B`,
      ADMIN_PASSWORD: ADMIN_PASSWORD,
      ...envOverrides,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logs = [];
  p.stdout.on('data', (d) => {
    const s = d.toString();
    logs.push(s);
  });
  p.stderr.on('data', (d) => {
    const s = d.toString();
    logs.push(s);
  });

  p.getLogs = () => logs.join('');
  return p;
}

async function runTests() {
  console.log('--- 开始执行 Issue #08: 可选服务端内存历史续接、默认无正文持久化与有界调试抓包验收测试 ---');

  // 启动 MockUpstream
  mockUpstream = new MockUpstream();
  const mockUrl = await mockUpstream.start(0);
  console.log(`[Harness] MockUpstream 已在 ${mockUrl} 启动`);

  // =========================================================================
  // 1. 单元契约测试: ResponseHistoryManager LRU 与 TTL 淘汰
  // =========================================================================
  console.log('\n[单元契约测试] 测试 ResponseHistoryManager 内存存储、LRU 与 TTL 淘汰机制...');
  {
    const mgr = new ResponseHistoryManager({
      enabled: true,
      maxEntries: 2,
      ttlSec: 1, // 1 秒过期
    });

    mgr.record({ id: 'resp_1', keyId: 'key_1', model: 'deepseek-flash', messages: [{ role: 'user', content: 'q1' }], output: [] });
    mgr.record({ id: 'resp_2', keyId: 'key_1', model: 'deepseek-flash', messages: [{ role: 'user', content: 'q2' }], output: [] });
    assert.strictEqual(mgr.size, 2, '历史记录条数应为 2');

    // 记录第 3 条，最旧的 resp_1 应该被 LRU 淘汰
    mgr.record({ id: 'resp_3', keyId: 'key_1', model: 'deepseek-flash', messages: [{ role: 'user', content: 'q3' }], output: [] });
    assert.strictEqual(mgr.size, 2, 'LRU 淘汰后总条数保持上限 2');
    const get1 = mgr.get('resp_1', 'key_1');
    assert.strictEqual(get1.ok, false, '被淘汰的 resp_1 必须不可访问');
    assert.strictEqual(get1.status, 404);

    const get2 = mgr.get('resp_2', 'key_1');
    assert.strictEqual(get2.ok, true, '未被淘汰的 resp_2 正常访问');

    // 等待 1.1 秒让 TTL 超期
    await new Promise((r) => setTimeout(r, 1100));
    const get2Expired = mgr.get('resp_2', 'key_1');
    assert.strictEqual(get2Expired.ok, false, '过期的 resp_2 必须返回 404');
    assert.strictEqual(get2Expired.code, 'response_not_found');
    console.log('  ✓ 单元契约通过：ResponseHistoryManager LRU 容量与 TTL 淘汰机制运行正常');
  }

  // =========================================================================
  // AC 1 验证: 客户端自行携带完整对话历史 (US 47)
  // =========================================================================
  console.log('\n[AC 1 验证] 测试客户端自行携带完整历史交互，无需依赖服务端存储 (US 47)...');
  {
    // 启动一个未开启服务端历史的网关 (默认配置)
    const gwPort1 = 18098;
    const gw = startGatewayProcess({
      ENABLE_IN_MEMORY_CONTINUATION: '0',
      DEBUG_DUMP: '0',
    }, gwPort1);

    await waitForGateway(gwPort1);

    mockUpstream.clear();
    mockUpstream.queueResponse('/v1/chat/completions', {
      status: 200,
      body: {
        id: 'chat-turn-2',
        model: 'deepseek-flash',
        choices: [{ message: { role: 'assistant', content: 'France is Paris.' } }],
      },
    });

    // 客户端发送包含前序 user 与 assistant 消息的完整数组
    const res = await requestGateway(gwPort1, {
      path: '/v1/responses',
      method: 'POST',
      key: KEY_A,
    }, {
      model: 'deepseek-flash',
      input: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
        { role: 'user', content: 'What is the capital of France?' },
      ],
      store: false,
    });

    assert.strictEqual(res.statusCode, 200, '携带完整历史的请求必须返回 200');
    assert.strictEqual(res.body.status, 'completed');
    assert.ok(res.body.output_text.includes('Paris'), '客户端成功获得正确回答');

    // 验证发给上游的报文包含全部 3 条历史
    // 注意：/api/models 与仪表盘刷新会并行向上游发 /v1/models 与账单请求，
    // 所以不能假设「最后一条上游记录就是本次 chat」，必须按路径取最后一条。
    const chatReqs = mockUpstream.recordedRequests.filter((r) => r.url.startsWith('/v1/chat/completions'));
    const lastUpReq = chatReqs[chatReqs.length - 1];
    const upBody = typeof lastUpReq.body === 'string' ? JSON.parse(lastUpReq.body) : lastUpReq.body;
    assert.strictEqual(upBody.messages.length, 3, '上游必须完整收到客户端提交的 3 条上下文消息');

    gw.kill();
    console.log('  ✓ AC 1 验证通过：客户端自行携带完整对话历史时无缝交互，无需依赖服务端存储');
  }

  // =========================================================================
  // AC 3a 验证: 服务端历史未启用时，依赖 previous_response_id 明确报错 (US 49)
  // =========================================================================
  console.log('\n[AC 3a 验证] 测试未启用历史时依赖 previous_response_id 或 GET 返回 400 (US 49)...');
  {
    const gwPort2 = 18099;
    const gw = startGatewayProcess({
      ENABLE_IN_MEMORY_CONTINUATION: '0',
    }, gwPort2);

    await waitForGateway(gwPort2);

    // 1. 尝试使用 previous_response_id
    const resPost = await requestGateway(gwPort2, {
      path: '/v1/responses',
      method: 'POST',
      key: KEY_A,
    }, {
      model: 'deepseek-flash',
      previous_response_id: 'resp_non_existent',
      input: 'Continue please',
    });

    assert.strictEqual(resPost.statusCode, 400, '未启用历史时使用 previous_response_id 必须返回 400');
    assert.strictEqual(resPost.body.error.code, 'history_disabled');

    // 2. 尝试 GET /v1/responses/:id
    const resGet = await requestGateway(gwPort2, {
      path: '/v1/responses/resp_any_id',
      method: 'GET',
      key: KEY_A,
    });

    assert.strictEqual(resGet.statusCode, 400, '未启用历史时 GET 必须返回 400');
    assert.strictEqual(resGet.body.error.code, 'history_disabled');

    gw.kill();
    console.log('  ✓ AC 3a 验证通过：未启用历史时请求明确返回 400 history_disabled，绝不静默当全新对话');
  }

  // =========================================================================
  // AC 2 & AC 3 验证: 启用服务端内存历史续接、流式/非流式一致性与权限隔离 (US 48, US 49)
  // =========================================================================
  console.log('\n[AC 2 & AC 3 验证] 测试启用内存历史、流式/非流式续接一致性与凭据隔离...');
  {
    const gwPort3 = 18100;
    const dumpDir3 = path.join(TEST_DIR, 'test-dumps-bounded');
    const gw = startGatewayProcess({
      ENABLE_IN_MEMORY_CONTINUATION: '1',
      HISTORY_MAX_ENTRIES: '5',
      HISTORY_TTL_SEC: '3600',
      DEBUG_DUMP: '1',
      DUMP_DIR: dumpDir3,
      DEBUG_DUMP_MAX_FILES: '3',
    }, gwPort3);

    await waitForGateway(gwPort3);

    // 2a: 非流式请求 (Key A) 产出响应，并验证记录历史
    mockUpstream.clear();
    mockUpstream.queueResponse('/v1/chat/completions', {
      status: 200,
      body: {
        id: 'resp-turn-1',
        model: 'deepseek-flash',
        choices: [{
          message: {
            role: 'assistant',
            content: 'I have calculated 2 + 2 = 4.',
            tool_calls: [{
              id: 'call_calc_1',
              type: 'function',
              function: { name: 'calculator', arguments: '{"expr":"2+2"}' },
            }],
          },
        }],
      },
    });

    const res1 = await requestGateway(gwPort3, {
      path: '/v1/responses',
      method: 'POST',
      key: KEY_A,
    }, {
      model: 'deepseek-flash',
      input: 'Calculate 2+2 please',
      store: true,
      stream: false,
    });

    assert.strictEqual(res1.statusCode, 200);
    const respId1 = res1.body.id;
    assert.ok(respId1 && respId1.startsWith('resp_'), '必须返回合法响应 ID');
    assert.strictEqual(res1.body.status, 'completed');
    console.log(`  ✓ 2a-1: 非流式首轮生成成功，得到响应 ID: ${respId1}`);

    // GET /v1/responses/:id 验证能够正确获取
    const getRes1 = await requestGateway(gwPort3, {
      path: `/v1/responses/${respId1}`,
      method: 'GET',
      key: KEY_A,
    });
    assert.strictEqual(getRes1.statusCode, 200, '正确凭据查询响应历史必须返回 200');
    assert.strictEqual(getRes1.body.id, respId1);
    console.log('  ✓ 2a-2: GET /v1/responses/:id 成功查回已完成的响应元数据');

    // 2b: 使用 previous_response_id 继续第二轮对话 (Key A)，验证历史消息被正确接上
    mockUpstream.clear();
    mockUpstream.queueResponse('/v1/chat/completions', {
      status: 200,
      body: {
        id: 'resp-turn-2',
        model: 'deepseek-flash',
        choices: [{ message: { role: 'assistant', content: 'The result is indeed 4.' } }],
      },
    });

    const res2 = await requestGateway(gwPort3, {
      path: '/v1/responses',
      method: 'POST',
      key: KEY_A,
    }, {
      model: 'deepseek-flash',
      previous_response_id: respId1,
      input: [
        { type: 'function_call_output', call_id: 'call_calc_1', output: '4' },
      ],
      store: true,
      stream: false,
    });

    assert.strictEqual(res2.statusCode, 200, '续接上一轮历史成功返回 200');
    const respId2 = res2.body.id;

    // 检查发给上游的请求：必须包含第 1 轮 user、第 1 轮 assistant (含 tool_calls) 以及第 2 轮 tool output
    const upReq2 = mockUpstream.recordedRequests[mockUpstream.recordedRequests.length - 1];
    const upBody2 = typeof upReq2.body === 'string' ? JSON.parse(upReq2.body) : upReq2.body;
    assert.strictEqual(upBody2.messages.length, 3, '上游收到的上下文必须为 3 条');
    assert.strictEqual(upBody2.messages[0].role, 'user');
    assert.strictEqual(upBody2.messages[1].role, 'assistant');
    assert.ok(upBody2.messages[1].tool_calls && upBody2.messages[1].tool_calls.length === 1, '第 1 轮 assistant tool_calls 必须完整续接');
    assert.strictEqual(upBody2.messages[2].role, 'tool');
    console.log('  ✓ 2b: previous_response_id 成功续接工具调用历史与 tool_call_output');

    // 2c: 流式请求 (Key A) 续接流式生成，流式与非流式语义完全一致
    mockUpstream.clear();
    mockUpstream.queueResponse('/v1/chat/completions', {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      sseEvents: [
        { data: { id: 'stream-c1', choices: [{ delta: { role: 'assistant', content: 'Streamed continuation.' } }] } },
        { data: '[DONE]' },
      ],
    });

    const res3 = await requestGateway(gwPort3, {
      path: '/v1/responses',
      method: 'POST',
      key: KEY_A,
    }, {
      model: 'deepseek-flash',
      previous_response_id: respId2,
      input: 'Now reply in stream please',
      stream: true,
      store: true,
    });

    assert.strictEqual(res3.statusCode, 200);
    assert.ok(res3.raw.includes('response.completed'), '流式生成必须输出 response.completed 事件');
    // 从流式返回提取响应 ID
    const matchId = res3.raw.match(/"id":"(resp_[a-zA-Z0-9]+)"/);
    assert.ok(matchId, '流式输出中必须包含 response id');
    const respId3 = matchId[1];

    // 验证流式生成的响应也已完好保存在历史管理器中，支持继续第 4 轮
    const getRes3 = await requestGateway(gwPort3, {
      path: `/v1/responses/${respId3}`,
      method: 'GET',
      key: KEY_A,
    });
    assert.strictEqual(getRes3.statusCode, 200, '流式生成的响应同样支持通过 GET 查询');
    console.log('  ✓ 2c: 流式响应完成时一致持久化 assistant 输出与上下文，流式/非流式语义完全对齐');

    // =========================================================================
    // AC 3b & 3c: 凭据隔离与不存在历史明确报错 (US 49)
    // =========================================================================
    console.log('\n[AC 3b & 3c 验证] 测试跨凭据所有权隔离 (404) 与不存在历史明确返回 404...');

    // 3b: Key B 尝试访问 Key A 生成的响应 respId1
    const resGetCross = await requestGateway(gwPort3, {
      path: `/v1/responses/${respId1}`,
      method: 'GET',
      key: KEY_B,
    });
    assert.strictEqual(resGetCross.statusCode, 404, 'Key B 跨权读取 Key A 历史必须严格返回 404');
    assert.strictEqual(resGetCross.body.error.code, 'response_not_found');

    // Key B 尝试使用 Key A 的 previous_response_id 续接
    const resPostCross = await requestGateway(gwPort3, {
      path: '/v1/responses',
      method: 'POST',
      key: KEY_B,
    }, {
      model: 'deepseek-flash',
      previous_response_id: respId1,
      input: 'Attempt cross key continuation',
    });
    assert.strictEqual(resPostCross.statusCode, 404, 'Key B 跨权续接 Key A 历史必须严格返回 404');
    assert.strictEqual(resPostCross.body.error.code, 'response_not_found');
    console.log('  ✓ 3b: 跨调用凭据读取与续接被严格隔离，绝不泄露其他 Key 的历史');

    // 3c: 传入不存在或已淘汰的 ID
    const resNotFound = await requestGateway(gwPort3, {
      path: '/v1/responses',
      method: 'POST',
      key: KEY_A,
    }, {
      model: 'deepseek-flash',
      previous_response_id: 'resp_totally_fake_id',
      input: 'Should fail',
    });
    assert.strictEqual(resNotFound.statusCode, 404, '不存在的历史 ID 必须明确返回 404');
    assert.strictEqual(resNotFound.body.error.code, 'response_not_found');
    console.log('  ✓ 3c: 不存在的 previous_response_id 严格返回 404，绝不作为全新会话静默替跑');

    gw.kill();
  }

  // =========================================================================
  // AC 3d 验证: 进程重启后内存历史清空，不承诺跨重启恢复 (US 48, US 49)
  // =========================================================================
  console.log('\n[AC 3d 验证] 测试进程重启后内存历史完全清空，前序 ID 明确报 404...');
  {
    const gwPort4 = 18101;
    let gw4 = startGatewayProcess({
      ENABLE_IN_MEMORY_CONTINUATION: '1',
    }, gwPort4);

    await waitForGateway(gwPort4);

    mockUpstream.clear();
    mockUpstream.queueResponse('/v1/chat/completions', {
      status: 200,
      body: {
        id: 'restart-turn-1',
        model: 'deepseek-flash',
        choices: [{ message: { role: 'assistant', content: 'Before restart.' } }],
      },
    });

    const resPre = await requestGateway(gwPort4, {
      path: '/v1/responses',
      method: 'POST',
      key: KEY_A,
    }, {
      model: 'deepseek-flash',
      input: 'Remember this before restart',
      store: true,
    });
    assert.strictEqual(resPre.statusCode, 200);
    const preRestartId = resPre.body.id;

    // 重启网关进程
    gw4.kill();
    await new Promise((r) => setTimeout(r, 600));

    gw4 = startGatewayProcess({
      ENABLE_IN_MEMORY_CONTINUATION: '1',
    }, gwPort4);
    await waitForGateway(gwPort4);

    // 重启后查询 preRestartId 必须返回 404
    const resPostRestart = await requestGateway(gwPort4, {
      path: `/v1/responses/${preRestartId}`,
      method: 'GET',
      key: KEY_A,
    });
    assert.strictEqual(resPostRestart.statusCode, 404, '重启后前序历史必须清空，返回 404');
    assert.strictEqual(resPostRestart.body.error.code, 'response_not_found');

    gw4.kill();
    console.log('  ✓ 3d: 进程重启后内存历史清空，不跨重启恢复，符合纯内存契约');
  }

  // =========================================================================
  // AC 4 验证: 默认状态持久化与日志脱敏 (US 50)
  // =========================================================================
  console.log('\n[AC 4 验证] 测试 usage-state.json 零正文/零首句摘要及日志脱敏 (US 50)...');
  {
    const gwPort5 = 18102;
    const stateFile5 = path.join(TEST_DIR, 'privacy-usage-state.json');
    const gw5 = startGatewayProcess({
      STATE_PATH: stateFile5,
      ENABLE_IN_MEMORY_CONTINUATION: '0',
    }, gwPort5);

    await waitForGateway(gwPort5);

    const secretPromptText = 'TopSecretProjectConfidentialDetailsAndNumbers12345';
    mockUpstream.clear();
    mockUpstream.queueResponse('/v1/chat/completions', {
      status: 200,
      body: {
        id: 'c-secret',
        model: 'deepseek-flash',
        choices: [{ message: { role: 'assistant', content: 'Secret response.' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    });

    await requestGateway(gwPort5, {
      path: '/v1/chat/completions',
      method: 'POST',
      key: KEY_A,
    }, {
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: secretPromptText }],
    });

    // 触发即时持久化
    await requestGateway(gwPort5, {
      path: '/api/usage',
      method: 'GET',
      key: KEY_A,
    });

    await new Promise((r) => setTimeout(r, 400));

    // 1. 检查 usage-state.json
    assert.ok(fs.existsSync(stateFile5), '状态持久化文件必须存在');
    const stateRaw = fs.readFileSync(stateFile5, 'utf8');
    assert.strictEqual(stateRaw.includes(secretPromptText), false, '持久化文件严禁包含用户提问正文！');
    assert.strictEqual(stateRaw.includes('Secret response'), false, '持久化文件严禁包含模型回答正文！');

    const stateJson = JSON.parse(stateRaw);
    if (stateJson.sessions) {
      for (const [sid, sess] of Object.entries(stateJson.sessions)) {
        assert.ok(!sess.label || sess.label === '', `会话 ${sid} 的首句摘要 label 必须为空`);
        assert.ok(!sess.prompt && !sess.content && !sess.text, '会话记录绝不可包含聊天正文字段');
      }
    }
    console.log('  ✓ 4a: usage-state.json 仅持久化数值统计，零聊天正文、零首句摘要 (label 为空)');

    // 2. 检查控制台与访问日志脱敏
    const logs = gw5.getLogs();
    assert.strictEqual(logs.includes(KEY_A), false, '控制台及访问日志严禁输出明文调用凭据！');
    assert.strictEqual(logs.includes(KEY_B), false, '控制台及访问日志严禁输出明文调用凭据！');
    console.log('  ✓ 4b: 控制台与访问日志中的调用凭据与 Bearer 令牌已全部脱敏 (sk-***)');

    gw5.kill();
  }

  // =========================================================================
  // AC 5 验证: 调试抓包默认关闭且开启时有界 (US 51)
  // =========================================================================
  console.log('\n[AC 5 验证] 测试调试抓包默认关闭，开启时敏感凭据脱敏且执行有界淘汰清理 (US 51)...');
  {
    // 5a: 默认关闭时，不创建任何抓包文件
    const gwPort6a = 18103;
    const dumpDir6a = path.join(TEST_DIR, 'dumps-off');
    const gw6a = startGatewayProcess({
      DEBUG_DUMP: '0',
      DUMP_DIR: dumpDir6a,
    }, gwPort6a);

    await waitForGateway(gwPort6a);

    mockUpstream.clear();
    mockUpstream.queueResponse('/v1/chat/completions', {
      status: 200,
      body: {
        id: 'c-dump-off',
        model: 'deepseek-flash',
        choices: [{ message: { role: 'assistant', content: 'hello' } }],
      },
    });

    await requestGateway(gwPort6a, {
      path: '/v1/chat/completions',
      method: 'POST',
      key: KEY_A,
    }, {
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: 'hello' }],
    });

    if (fs.existsSync(dumpDir6a)) {
      const files = fs.readdirSync(dumpDir6a);
      assert.strictEqual(files.length, 0, 'DEBUG_DUMP 关闭时抓包目录中不得有任何文件');
    }
    gw6a.kill();
    console.log('  ✓ 5a: 调试抓包默认关闭，日常运行零抓包文件落盘');

    // 5b & 5c: 开启抓包时脱敏敏感凭据并严格执行有界数量清理 (DEBUG_DUMP_MAX_FILES=3)
    const gwPort6b = 18104;
    const dumpDir6b = path.join(TEST_DIR, 'dumps-bounded');
    const gw6b = startGatewayProcess({
      DEBUG_DUMP: '1',
      DUMP_DIR: dumpDir6b,
      DEBUG_DUMP_MAX_FILES: '3', // 最多保留 3 个抓包文件
    }, gwPort6b);

    await waitForGateway(gwPort6b);

    for (let i = 1; i <= 4; i++) {
      mockUpstream.clear();
      mockUpstream.queueResponse('/v1/chat/completions', {
        status: 200,
        body: {
          id: `c-dump-${i}`,
          model: 'deepseek-flash',
          choices: [{ message: { role: 'assistant', content: `reply ${i}` } }],
        },
      });

      await requestGateway(gwPort6b, {
        path: '/v1/chat/completions',
        method: 'POST',
        key: KEY_A,
      }, {
        model: 'deepseek-flash',
        messages: [{ role: 'user', content: `test dump count ${i}` }],
      });
      await new Promise((r) => setTimeout(r, 100));
    }

    assert.ok(fs.existsSync(dumpDir6b), '开启 DEBUG_DUMP 后抓包目录必须存在');
    const dumpFiles = fs.readdirSync(dumpDir6b);
    assert.ok(dumpFiles.length <= 3, `抓包文件数量 (${dumpFiles.length}) 必须被限制在 DEBUG_DUMP_MAX_FILES (3) 以内`);
    assert.ok(dumpFiles.length > 0, '抓包文件应成功生成');

    // 检查抓包文件内部脱敏情况
    for (const file of dumpFiles) {
      const raw = fs.readFileSync(path.join(dumpDir6b, file), 'utf8');
      assert.strictEqual(raw.includes(KEY_A), false, `抓包文件 ${file} 内部严禁包含明文调用凭据！`);
      assert.strictEqual(raw.includes('sk-upstream-token'), false, `抓包文件 ${file} 内部严禁包含明文上游令牌！`);
    }

    gw6b.kill();
    console.log('  ✓ 5b & 5c: 抓包文件内敏感凭据严格脱敏，且有界清理生效，严格限制文件上限');
  }

  mockUpstream.stop();
  console.log('\n>>> Issue #08 全部 5 项验收指标测试 100% 通过 ✓ <<<');
}

runTests().catch((err) => {
  console.error('\n❌ Issue #08 验收测试失败:', err);
  if (mockUpstream) mockUpstream.stop();
  if (gatewayProcess) gatewayProcess.kill();
  process.exit(1);
});
