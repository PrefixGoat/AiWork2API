'use strict';
/**
 * 回归测试：网页设备授权登录必须换取真正的 Router API Key 与实时模型目录。
 *
 * 用户报告的故障链路：
 *   - 设备授权返回的 accessToken 是账号服务的 JWT，不是 Router 的 API Key；
 *     旧实现把它直接写进 .env，导致上游 /v1/models 与 /v1/chat/completions 全部 401，
 *     账号被标记 needs_reauth，/status 回退报「未找到 router key（.../.env）」。
 *   - 旧实现落盘 config.json 时硬编码了 automodel / auto-high 两个占位模型，
 *     页面因此只显示 2 个模型，真实倍率也永远读不到。
 *
 * 本测试用 mock 官方鉴权服务 + mock Router 复现整条链路，断言：
 *   1) 落盘 .env 是换票得到的 sk，而不是 accessToken；
 *   2) config.json 与 /api/models 使用 Router /v1/models 的实时模型目录（10 个，带 ratio）；
 *   3) /api/models 与 /status 的 real.ok 为 true，且真实倍率生效；
 *   4) 用该账号发起对话可以成功（凭据确实被上游接受）。
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const TMP_DIR = path.join(os.tmpdir(), `aiwork-device-key-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
fs.mkdirSync(TMP_DIR, { recursive: true });
process.on('exit', () => {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
});

const JWT = 'eyJhbGciOiJIUzI1NiJ9.mock-account-service-token.sig';
const ROUTER_KEY = 'sk-router-valid-0001';
const HTTP_PASS = 'TestDeviceLoginPass123!';
const HTTP_KEY = 'sk-device-login-client';

// 与真实 Router /v1/models 同构的快照（10 个模型、7 个带 ratio、1 个 Free 标签）
const LIVE_MODELS = [
  { id: 'automodel', name: 'auto-eco', ratio: '', tags: '', context_window: 1048576, max_token: 65535 },
  { id: 'auto-high', name: 'auto-high', ratio: '', tags: '', context_window: 1048576, max_token: 65535 },
  { id: 'atria-dawn-preview', name: 'atria-dawn-preview', ratio: '', tags: 'Free' },
  { id: 'deepseek-flash', name: 'deepseek-flash', ratio: '0.2x', tags: 'Low cost' },
  { id: 'deepseek-v4-pro-0813', name: 'deepseek-v4-pro', ratio: '1x', tags: 'Medium cost' },
  { id: 'glm-5.3', name: 'glm-5.3', ratio: '1.0x', tags: 'mid cost' },
  { id: 'glm-5.3-flash', name: 'glm-5.3-flash', ratio: '0.1x', tags: 'low cost' },
  { id: 'kimi-k3', name: 'kimi-k3', ratio: '2.8x', tags: 'High cost' },
  { id: 'ling-3.1-flash', name: 'ling-3.1-flash', ratio: '0.2x', tags: 'Time-Limited Discount' },
  { id: 'qwen3.8-max', name: 'qwen3.8-max', ratio: '1.33x', tags: 'High cost' },
];

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => {
      try { resolve(JSON.parse(s || '{}')); } catch (_) { resolve({}); }
    });
  });
}

let authorized = false;
let exchangeCalls = 0;
let exchangeAuthSeen = '';
let routerModelsCalls = 0;
let upstreamChatAuth = [];
let routerBaseUrlForExchange = '';

async function run() {
  // ---------------------------------------------------------------
  // 1. Mock 官方账号服务：设备码 -> accessToken(JWT) -> Router Key 换票
  // ---------------------------------------------------------------
  const authServer = http.createServer(async (req, res) => {
    const body = await readBody(req);
    if (req.url === '/api/v1/auth/device/authorize' && req.method === 'POST') {
      return json(res, 200, {
        success: true,
        data: {
          deviceCode: 'dc_mock_123', userCode: '1234-ABCD',
          verificationUri: 'https://example.test/device',
          verificationUriComplete: 'https://example.test/device?user_code=1234-ABCD',
          expiresIn: 180, interval: 1,
        },
      });
    }
    if (req.url === '/api/v1/auth/device/token' && req.method === 'POST') {
      if (!authorized) return json(res, 200, { success: true, data: { accessToken: null } });
      return json(res, 200, {
        success: true,
        data: { accessToken: JWT, refreshToken: 'refresh_mock', expiresIn: 7200, userId: 'user_oauth_777' },
      });
    }
    if (req.url === '/api/v1/router/apikey/exchange' && req.method === 'POST') {
      exchangeCalls++;
      // 官方端点靠 Bearer JWT 鉴权，换票请求体可为空
      exchangeAuthSeen = req.headers.authorization || '';
      return json(res, 200, {
        success: true,
        data: {
          memberId: 'member-42', newApiUserId: 44265, tokenId: 43497,
          sk: ROUTER_KEY, status: 'ACTIVE',
          routerBaseUrl: routerBaseUrlForExchange,
          // 官方换票响应里的模型目录是旧快照，不能拿它当实时目录
          availableModels: ['glm-5.2', 'qwen3.7-max'],
          models: [{ name: 'glm-5.2', multiplier: '0.8', costTag: '低成本' }],
        },
      });
    }
    return json(res, 404, { error: 'not found' });
  });

  // ---------------------------------------------------------------
  // 2. Mock Router：只认真正的 sk，JWT 一律 401
  // ---------------------------------------------------------------
  const routerServer = http.createServer(async (req, res) => {
    const auth = req.headers.authorization || '';
    if (req.url.startsWith('/v1/models') && req.method === 'GET') {
      routerModelsCalls++;
      if (auth !== `Bearer ${ROUTER_KEY}`) {
        return json(res, 401, { error: { code: 'token_invalid', message: 'Invalid token' } });
      }
      return json(res, 200, { object: 'list', data: LIVE_MODELS });
    }
    if (req.url.startsWith('/v1/dashboard/billing/usage')) {
      return json(res, 200, { object: 'list', total_usage: 12.5 });
    }
    if (req.url.startsWith('/v1/dashboard/billing/subscription')) {
      return json(res, 200, { hard_limit_usd: 100 });
    }
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      upstreamChatAuth.push(auth);
      if (auth !== `Bearer ${ROUTER_KEY}`) {
        return json(res, 401, { error: { code: 'token_invalid', message: 'Invalid token' } });
      }
      await readBody(req);
      return json(res, 200, {
        id: 'chatcmpl-mock', object: 'chat.completion', created: 1,
        model: 'deepseek-flash',
        choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    }
    return json(res, 404, { error: 'not found' });
  });

  await new Promise((r) => authServer.listen(0, '127.0.0.1', r));
  await new Promise((r) => routerServer.listen(0, '127.0.0.1', r));
  const authBaseUrl = `http://127.0.0.1:${authServer.address().port}`;
  const routerBaseUrl = `http://127.0.0.1:${routerServer.address().port}`;
  routerBaseUrlForExchange = routerBaseUrl;

  // ---------------------------------------------------------------
  // 3. 启动真实网桥：AGENTIX_STATE_DIR 指向一个不存在的挂载目录
  //    （与线上 /accounts/default 未挂载的情形一致）
  // ---------------------------------------------------------------
  const dataDir = path.join(TMP_DIR, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const port = 18200 + Math.floor(Math.random() * 300);
  const gwProc = cp.fork(path.join(__dirname, '..', 'src', 'api-bridge.js'), [], {
    env: {
      ...process.env,
      PORT: String(port), BIND: '127.0.0.1',
      ADMIN_PASSWORD: HTTP_PASS, API_KEYS: `${HTTP_KEY}:test`,
      GATEWAY_DATA_DIR: dataDir,
      STATE_PATH: path.join(dataDir, 'usage-state.json'),
      AGENTIX_STATE_DIR: path.join(TMP_DIR, 'nonexistent-default-state'),
      ROUTER_BASE_URL: routerBaseUrl,
      QUIET: '1', LOG_LEVEL: 'error',
    },
    stdio: 'ignore',
  });

  const base = `http://127.0.0.1:${port}`;
  function request(method, urlPath, body = null, headers = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request(new URL(urlPath, base), { method, headers, timeout: 8000 }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          let j = null;
          try { j = JSON.parse(d); } catch (_) {}
          resolve({ status: res.statusCode, headers: res.headers, json: j, text: d });
        });
      });
      req.on('error', reject);
      if (body) {
        req.setHeader('Content-Type', 'application/json');
        req.write(typeof body === 'string' ? body : JSON.stringify(body));
      }
      req.end();
    });
  }

  let ready = false;
  for (let i = 0; i < 40; i++) {
    try { if ((await request('GET', '/healthz')).status === 200) { ready = true; break; } } catch (_) {}
    await new Promise((r) => setTimeout(r, 150));
  }
  assert(ready, '网桥未能在预期时间内启动');

  try {
    const login = await request('POST', '/api/admin/login', { password: HTTP_PASS });
    assert.strictEqual(login.status, 200);
    const adminHeaders = { Cookie: login.headers['set-cookie'][0].split(';')[0] };

    const start = await request('POST', '/api/admin/accounts/device-login/start',
      { name: '回归测试账号', authBaseUrl }, adminHeaders);
    assert.strictEqual(start.status, 200);
    assert(start.json.sessionId);

    const pollPath = `/api/admin/accounts/device-login/poll?session_id=${start.json.sessionId}`;
    const pending = await request('GET', pollPath, null, adminHeaders);
    assert.strictEqual(pending.json.status, 'pending', '授权前应为 pending');

    authorized = true;
    let confirmed = null;
    for (let i = 0; i < 10; i++) {
      const r = await request('GET', pollPath, null, adminHeaders);
      if (r.json.status === 'confirmed') { confirmed = r.json; break; }
      await new Promise((r2) => setTimeout(r2, 120));
    }
    assert(confirmed, `设备登录必须完成换票入池，最后一次结果: ${JSON.stringify(confirmed)}`);
    // --- 断言 1：.env 里是换票得到的 sk，不是 JWT ---
    //  symptom: 旧实现把 JWT 当 Router Key 落盘 -> 上游 401 -> 真实倍率读取失败
    const accDir = path.join(dataDir, 'accounts', confirmed.accountId);
    const envText = fs.readFileSync(path.join(accDir, '.env'), 'utf8');
    assert(!envText.includes(JWT),
      '故障症状：设备登录把账号访问令牌 JWT 当作 Router Key 落盘，上游必然 401，真实倍率读取失败');
    assert(envText.includes(ROUTER_KEY), `.env 必须持久化真正的 Router Key，实际: ${envText.slice(0, 120)}`);

    // --- 断言 2：模型目录来自实时 /v1/models，而不是 2 个占位模型 ---
    //  symptom: 页面只显示 automodel / auto-high 两个模型
    const cfg = JSON.parse(fs.readFileSync(path.join(accDir, 'config.json'), 'utf8'));
    const cfgModels = cfg.models['aiwork-router'].models;
    assert.strictEqual(cfgModels.length, LIVE_MODELS.length,
      `故障症状：只显示 ${cfgModels.length} 个占位模型，Router 实际有 ${LIVE_MODELS.length} 个`);
    const flashCfg = cfgModels.find((m) => m.id === 'deepseek-flash');
    assert(flashCfg && String(flashCfg.ratio) === '0.2x', '实时倍率应写入模型目录');

    assert.strictEqual(exchangeCalls, 1, '必须调用官方 Router Key 换票接口');
    assert.strictEqual(exchangeAuthSeen, `Bearer ${JWT}`, '换票必须携带账号访问令牌');
    assert(routerModelsCalls >= 1, '必须用 Router Key 拉取实时模型目录');

    // --- 断言 3：/api/models 与 /status 的真实数据读取成功 ---
    const models = await request('GET', '/api/models?force=1', null,
      { Authorization: `Bearer ${HTTP_KEY}` });
    assert.strictEqual(models.status, 200);
    assert.strictEqual(models.json.real.ok, true,
      `真实倍率读取必须成功，实际错误: ${models.json.real.error}`);
    assert.strictEqual(models.json.data.length, LIVE_MODELS.length,
      `页面应展示全部 ${LIVE_MODELS.length} 个模型，实际 ${models.json.data.length}`);
    const flash = models.json.data.find((m) => m.id === 'deepseek-flash');
    assert(flash && flash.ratioReal === true, 'deepseek-flash 必须标记为真实倍率');
    assert.strictEqual(flash.multiplier, 0.2, '真实倍率应为 0.2');

    const status = await request('GET', '/status');
    assert.strictEqual(status.json.real_data.ok, true,
      `/status 的真实数据读取必须成功，实际: ${JSON.stringify(status.json.real_data)}`);
    assert.strictEqual(status.json.ready, true, '账号池应处于 ready');

    // --- 断言 4：该账号可以真正发起对话 ---
    const chat = await request('POST', '/v1/chat/completions',
      { model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }], stream: false },
      { Authorization: `Bearer ${HTTP_KEY}` });
    assert.strictEqual(chat.status, 200, `对话必须使用有效 Router Key，实际: ${chat.status} ${chat.text.slice(0, 200)}`);
    assert(upstreamChatAuth.includes(`Bearer ${ROUTER_KEY}`), '上游鉴权头必须是换票得到的 sk');

    console.log('✓ [All Passed] 设备登录换票 + 实时模型目录 + 真实倍率回归测试通过');
  } finally {
    gwProc.kill('SIGTERM');
    authServer.close();
    routerServer.close();
  }
}

run().catch((err) => {
  console.error('测试失败:', err.message);
  process.exit(1);
});
