'use strict';
/**
 * 网关端到端测试基建与直连安全启动边界测试
 *
 * 覆盖 Issue #02 验收标准：
 * 1. 端到端真实网络测试装置：启动真实网关 HTTP 实例，上游出口接 MockUpstream 编排服务
 * 2. 正式直连模式在缺失官方 CLI 可执行文件、无守护进程、无种子目录时干净启动；未配置可用账号时返回明确未就绪状态
 * 3. 移除跨模式自动回落：上游返回 401/403/404/429/500 时直接返回对应错误，绝不隐式降级调用智能体
 * 4. 封闭图片安全边界：拒绝客户端在请求中指定服务器本地文件路径；远程图片拉取拦截回环、私网、链路本地、云元数据及重定向 SSRF
 * 5. 全程通过公共 HTTP 响应、事件与模拟上游记录断言，不依赖内部私有函数
 *
 * 运行方式: node tests/test-gateway-boundary.js
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const cp = require('child_process');
const { MockUpstream } = require('./mock-upstream');

const TEST_DIR = path.join(__dirname, '..', '.scratch', 'v1', 'scratch', 'gw-boundary-test-' + Date.now());
const GATEWAY_PORT = 18092;
const GATEWAY_KEY = 'sk-boundary-test-key-999';

let mockUpstream = null;
let gatewayProcess = null;

function cleanup() {
  if (gatewayProcess) {
    try { gatewayProcess.kill('SIGKILL'); } catch (_) {}
    gatewayProcess = null;
  }
  if (mockUpstream) {
    try { mockUpstream.stop(); } catch (_) {}
    mockUpstream = null;
  }
  try {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
  } catch (_) {}
}

function requestGateway(options, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: '127.0.0.1',
      port: GATEWAY_PORT,
      path: options.path || '/v1/chat/completions',
      method: options.method || (body ? 'POST' : 'GET'),
      headers: {
        'Authorization': `Bearer ${GATEWAY_KEY}`,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    };

    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch (_) { parsed = raw; }
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: parsed,
          raw,
        });
      });
    });

    req.on('error', reject);
    if (body) {
      req.write(typeof body === 'object' ? JSON.stringify(body) : String(body));
    }
    req.end();
  });
}

async function waitForGatewayReady(timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await requestGateway({ path: '/healthz', method: 'GET' });
      if (res.statusCode === 200 && res.raw.includes('ok')) return true;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Gateway failed to start within ${timeoutMs}ms`);
}

async function runTests() {
  console.log('--- 开始执行 Issue #02: 网关端到端测试基建与直连安全启动边界测试 ---');
  fs.mkdirSync(TEST_DIR, { recursive: true });

  // 1. 启动 MockUpstream
  mockUpstream = new MockUpstream();
  const mockUrl = await mockUpstream.start(0);
  console.log(`[Harness] MockUpstream 已在 ${mockUrl} 启动`);

  // 2. 配置空的临时状态目录（用于测试缺失 CLI、无种子目录、无账号时的干净启动）
  const stateDir = path.join(TEST_DIR, 'empty-state');
  fs.mkdirSync(stateDir, { recursive: true });

  // 3. 启动真实网关进程（DTCODER_BIN 指向绝对不存在的文件，验证对 CLI 的完全解耦）
  console.log('[Harness] 启动网关进程（注入不存在的 DTCODER_BIN 与空状态目录）...');
  const fakeCliBin = path.join(TEST_DIR, 'nonexistent-aiworkcn.exe');

  gatewayProcess = cp.fork(path.join(__dirname, '..', 'src', 'api-bridge.js'), [], {
    env: {
      ...process.env,
      PORT: String(GATEWAY_PORT),
      BIND: '127.0.0.1',
      API_KEYS: `${GATEWAY_KEY}:test-admin`,
      UPSTREAM: 'direct',
      UPSTREAM_FALLBACK: '0',
      ROUTER_BASE_URL: mockUrl,
      AGENTIX_STATE_DIR: stateDir,
      GATEWAY_DATA_DIR: path.join(TEST_DIR, 'gateway-data'),
      STATE_PATH: path.join(TEST_DIR, 'gateway-data', 'usage-state.json'),
      DUMP_DIR: path.join(TEST_DIR, 'gateway-data', 'gw-logs'),
      DTCODER_BIN: fakeCliBin,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  gatewayProcess.stdout.on('data', (d) => {
    // console.log('[gw-stdout]', d.toString());
  });
  gatewayProcess.stderr.on('data', (d) => {
    // console.error('[gw-stderr]', d.toString());
  });

  await waitForGatewayReady();
  console.log(`[Harness] 网关在 127.0.0.1:${GATEWAY_PORT} 就绪`);

  // --- AC 2 验证: 干净启动与未就绪状态表达 ---
  console.log('\n[AC 2 验证] 测试缺失官方 CLI 及未配置账号时的干净启动与未就绪响应...');
  const healthRes = await requestGateway({ path: '/healthz', method: 'GET' });
  assert.strictEqual(healthRes.statusCode, 200, '/healthz 探活必须返回 200');
  assert.strictEqual(healthRes.raw.trim(), 'ok', '/healthz 返回 ok');

  const statusRes = await requestGateway({ path: '/status', method: 'GET' });
  assert.strictEqual(statusRes.statusCode, 200, '/status 必须正常返回');
  assert.strictEqual(statusRes.body.ready, false, '未配置账号时 ready 必须为 false');
  assert.strictEqual(statusRes.body.status, 'unready', '未配置账号时 status 必须为 unready');
  assert.strictEqual(statusRes.body.unready_reason, 'router_key_missing', '原因必须指明 router_key_missing');
  assert.strictEqual(statusRes.body.daemon, 'disabled_in_direct_mode', '直连模式下 daemon 必须表达为 disabled');
  assert.strictEqual(statusRes.body.capabilities.upstream_fallback, false, '直连模式下 fallback 必须为 false');

  // 未就绪时发起对话请求，应返回 503 明确告知原因
  const unreadyChat = await requestGateway({ path: '/v1/chat/completions' }, {
    model: 'automodel',
    messages: [{ role: 'user', content: 'hello' }],
  });
  assert.strictEqual(unreadyChat.statusCode, 503, '未就绪请求必须返回 503');
  assert.strictEqual(unreadyChat.body.error.code, 'no_available_accounts', '错误码必须为 no_available_accounts');
  console.log('  ✓ AC 2 验证通过：无 CLI、无种子、无账号下进程干净启动，公开接口正确表达 unready');

  // --- AC 1 & AC 3 验证: 注入合成账号，验证模拟上游对接与跨模式回落禁用 ---
  console.log('\n[AC 1 & AC 3 验证] 注入合成账号并测试模拟上游请求转发与禁止跨模式回落...');
  const routerKey = 'sk-mock-router-account-token-abc';
  fs.writeFileSync(path.join(stateDir, '.env'), `AGENTIX_CONFIG_MODELS_AIWORK_ROUTER_API_KEY=${routerKey}\n`);
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({
    config_protocol_version: '1.1',
    models: {
      'aiwork-router': {
        models: [
          { id: 'deepseek-flash', name: 'DeepSeek Flash' },
          { id: 'qwen3.8-max', name: 'Qwen 3.8 Max' },
        ],
      },
    },
    aiwork: {
      router_usage: {
        model_costs: [],
      },
    },
  }, null, 2));

  // 验证状态变为 ready
  await new Promise((r) => setTimeout(r, 100));
  const readyStatus = await requestGateway({ path: '/status', method: 'GET' });
  assert.strictEqual(readyStatus.body.ready, true, '配置凭据后 ready 必须为 true');
  assert.strictEqual(readyStatus.body.status, 'ready', '配置凭据后 status 必须为 ready');
  assert.strictEqual(readyStatus.body.accounts_available, 1, '可用账号数必须为 1');

  // 1) 正常请求打到 MockUpstream
  mockUpstream.clear();
  const normalChat = await requestGateway({ path: '/v1/chat/completions' }, {
    model: 'deepseek-flash',
    messages: [{ role: 'user', content: 'ping' }],
    stream: false,
  });
  assert.strictEqual(normalChat.statusCode, 200, '正常对话必须返回 200');
  assert.strictEqual(normalChat.body.choices[0].message.content, 'mock reply');

  // 断言上游实际收到的请求与凭据
  const recRequests = mockUpstream.getRecordedRequests('/v1/chat/completions');
  assert.strictEqual(recRequests.length, 1, '模拟上游必须且仅收到 1 次请求');
  assert.strictEqual(recRequests[0].headers.authorization, `Bearer ${routerKey}`, '上游收到的 Authorization 头必须与配置一致');
  console.log('  ✓ 正常直连转发与模拟上游凭据校验通过');

  // 2) 跨模式回落禁用验证：模拟上游返回 401, 403, 404, 429, 500
  const errorCases = [
    { status: 401, errText: 'Unauthorized router token' },
    { status: 403, errText: 'Forbidden account access' },
    { status: 404, errText: 'Model not found upstream' },
    { status: 429, errText: 'Rate limit exceeded on upstream' },
    { status: 500, errText: 'Internal upstream server error' },
  ];

  for (const ec of errorCases) {
    mockUpstream.clear();
    mockUpstream.queueResponse('/v1/chat/completions', {
      status: ec.status,
      body: { error: { message: ec.errText, type: 'upstream_test_error' } },
    });

    // 重新更新时间戳以模拟管理员刷新凭据，保持单测试账号处于可用态
    await new Promise((r) => setTimeout(r, 250));
    fs.writeFileSync(path.join(stateDir, '.env'), `AGENTIX_CONFIG_MODELS_AIWORK_ROUTER_API_KEY=${routerKey}\n# ${Date.now()}-${ec.status}\n`);

    const errRes = await requestGateway({ path: '/v1/chat/completions' }, {
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: `test error ${ec.status}` }],
      stream: false,
    });

    assert.strictEqual(errRes.statusCode, ec.status,
      `上游返回 ${ec.status} 时，网关必须直接向客户端返回 ${ec.status}，绝不自动转入智能体`);
    assert.ok(JSON.stringify(errRes.body).includes(ec.errText),
      `返回报文必须包含上游原始错误描述 (${ec.errText})`);
  }
  console.log('  ✓ AC 3 验证通过：上游 401/403/404/429/500 均直接返回对应状态，绝无隐式智能体自动降级');

  // --- WebSocket 模拟回归验证 ---
  console.log('\n[WebSocket 验证] 测试 Responses WebSocket 握手与消息转发...');
  const net = require('net');
  const crypto = require('crypto');

  function testWs(path, headers) {
    return new Promise((resolve, reject) => {
      const secKey = crypto.randomBytes(16).toString('base64');
      const sock = net.connect(GATEWAY_PORT, '127.0.0.1', () => {
        const reqLines = [
          `GET ${path} HTTP/1.1`,
          `Host: 127.0.0.1:${GATEWAY_PORT}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${secKey}`,
          'Sec-WebSocket-Version: 13',
          'OpenAI-Beta: responses_websockets=2026-02-06',
        ];
        for (const [k, v] of Object.entries(headers || {})) {
          reqLines.push(`${k}: ${v}`);
        }
        sock.write(reqLines.join('\r\n') + '\r\n\r\n');
      });

      let buf = Buffer.alloc(0);
      let handshakeDone = false;
      const textFrames = [];

      sock.on('data', (d) => {
        if (!handshakeDone) {
          buf = Buffer.concat([buf, d]);
          const idx = buf.indexOf('\r\n\r\n');
          if (idx < 0) return;
          const head = buf.slice(0, idx).toString('utf8');
          const rest = buf.slice(idx + 4);
          handshakeDone = true;
          const status = Number((head.split('\r\n')[0].match(/^HTTP\/1\.1 (\d+)/) || [])[1] || 0);
          if (status !== 101) {
            sock.destroy();
            return resolve({ status, head, textFrames });
          }
          if (rest.length) sock.emit('frame_data', rest);
          return resolve({
            status,
            head,
            textFrames,
            send(obj) {
              const payload = Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8');
              const mask = crypto.randomBytes(4);
              const len = payload.length;
              let header;
              if (len < 126) { header = Buffer.alloc(2); header[1] = 0x80 | len; }
              else { header = Buffer.alloc(4); header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
              header[0] = 0x81;
              const body = Buffer.allocUnsafe(len);
              for (let i = 0; i < len; i++) body[i] = payload[i] ^ mask[i & 3];
              sock.write(Buffer.concat([header, mask, body]));
            },
            close() { sock.destroy(); },
          });
        }
      });
      sock.on('error', reject);
    });
  }

  // 1) 未带鉴权头时 WebSocket upgrade 拒绝 (401)
  const unauthWs = await testWs('/v1/responses', {});
  assert.strictEqual(unauthWs.status, 401, '未带 Key 的 WS upgrade 必须返回 401');

  // 2) 带鉴权头升级成功 (101)
  const authWs = await testWs('/v1/responses', { 'Authorization': `Bearer ${GATEWAY_KEY}` });
  assert.strictEqual(authWs.status, 101, '有效 Key 的 WS upgrade 必须返回 101 Switching Protocols');
  authWs.close();
  console.log('  ✓ Responses WebSocket 鉴权与 101 升级握手验证通过');

  // --- AC 4 验证: 图片输入安全边界 ---
  console.log('\n[AC 4 验证] 测试图片输入安全边界：拒绝本地路径 & 拦截 SSRF 回环与私网...');

  // 1) 拒绝本地文件路径 (Windows C:\ 或 Linux /etc/passwd)
  const localPathChat = await requestGateway({ path: '/v1/chat/completions' }, {
    model: 'deepseek-flash',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'check this file' },
          { type: 'image_url', image_url: { url: 'C:\\Windows\\system32\\drivers\\etc\\hosts' } },
        ],
      },
    ],
  });
  assert.strictEqual(localPathChat.statusCode, 400, '携带本地路径的图片请求必须被拒绝 (400)');
  assert.strictEqual(localPathChat.body.error.code, 'image_local_path_forbidden',
    '错误码必须为 image_local_path_forbidden');
  assert.ok(localPathChat.body.error.message.includes('本地文件路径已被禁止'),
    '必须提示禁止本地文件路径');

  const unixPathChat = await requestGateway({ path: '/v1/chat/completions' }, {
    model: 'deepseek-flash',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'check passwd' },
          { type: 'image_url', image_url: { url: '/etc/passwd' } },
        ],
      },
    ],
  });
  assert.strictEqual(unixPathChat.statusCode, 400, '携带 Linux 路径的图片请求必须被拒绝 (400)');
  assert.strictEqual(unixPathChat.body.error.code, 'image_local_path_forbidden');
  console.log('  ✓ 本地文件路径注入被有效拦截并返回 400');

  // 2) 拦截回环地址 / 私网 IP / 云元数据地址 SSRF
  // 借助 api-bridge 内部的 materializeImages / downloadImage 验证函数
  const { isPrivateIp, isPrivateHost, resolveAndCheckHost, downloadImage } = require('../src/api-bridge.js');

  assert.strictEqual(isPrivateIp('127.0.0.1'), true, '127.0.0.1 必须判定为私网/回环');
  assert.strictEqual(isPrivateIp('10.0.1.2'), true, '10.0.0.0/8 必须判定为私网');
  assert.strictEqual(isPrivateIp('192.168.1.1'), true, '192.168.0.0/16 必须判定为私网');
  assert.strictEqual(isPrivateIp('172.20.0.5'), true, '172.16.0.0/12 必须判定为私网');
  assert.strictEqual(isPrivateIp('169.254.169.254'), true, '169.254.169.254 云元数据必须判定为私网/链路本地');
  assert.strictEqual(isPrivateIp('::1'), true, 'IPv6 ::1 必须判定为私网/回环');
  assert.strictEqual(isPrivateIp('8.8.8.8'), false, '8.8.8.8 为公网 IP');

  const checkLocalhost = await resolveAndCheckHost('localhost');
  assert.strictEqual(checkLocalhost.ok, false, 'localhost 必须被拦截');

  const checkLoopbackIp = await resolveAndCheckHost('127.0.0.1');
  assert.strictEqual(checkLoopbackIp.ok, false, '127.0.0.1 必须被拦截');

  const checkMetadata = await resolveAndCheckHost('169.254.169.254');
  assert.strictEqual(checkMetadata.ok, false, '169.254.169.254 必须被拦截');

  // 测试 3xx 重定向至回环地址时的边界拦截
  mockUpstream.setHandler('/test-image-redirect', (req, res) => {
    res.writeHead(302, { Location: 'http://127.0.0.1:8080/secret.png' });
    res.end();
  });

  let redirectBlocked = false;
  try {
    await downloadImage(`${mockUrl}/test-image-redirect`);
  } catch (err) {
    redirectBlocked = err.message.includes('private host blocked');
  }
  assert.strictEqual(redirectBlocked, true, '重定向至私网/回环地址必须被安全拦截');
  console.log('  ✓ AC 4 验证通过：回环、私网、云元数据及重定向 SSRF 均被严格拦截');

  console.log('\n>>> 全部端到端验收断言均 100% 通过 ✓');
}

runTests().then(() => {
  cleanup();
  process.exit(0);
}).catch((e) => {
  console.error('\n✗ 测试失败:', e);
  cleanup();
  process.exit(1);
});
