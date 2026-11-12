'use strict';
/**
 * 回归测试：仪表盘积分必须「一次授权、自动续期」，且不把账号令牌泄露到磁盘/响应。
 *
 * 复现的约束：
 *   - 上游 /api/v1/user/usage-summary 只认账号 JWT；Router Key 访问 401。
 *   - 设备授权返回的 accessToken 短期过期，refreshToken 才能长期续期。
 *   - 用户要求「最无感、不用反复登录」：只持久化 refresh token，access token 只在内存。
 *
 * 断言：
 *   1) session.json 只有 refresh_token，没有 accessToken / Router Key，权限 0600；
 *   2) GET /api/dashboard（调用凭据）能读到真实用量 + 积分，响应不含任何令牌；
 *   3) access token 被 401 后自动刷新一次，轮换的新 refresh token 原子写回；
 *   4) 刷新后仍 401 时返回 reauth_required，只刷新一次，不无限循环；
 *   5) 现有 /api/usage 对调用凭据仍是 admin_only（零回归）。
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const TMP_DIR = path.join(os.tmpdir(), `aiwork-dashboard-credits-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
fs.mkdirSync(TMP_DIR, { recursive: true });
process.on('exit', () => {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
});

const JWT_1 = 'eyJhbGciOiJIUzI1NiJ9.dashboard-token-1.sig';
const JWT_2 = 'eyJhbGciOiJIUzI1NiJ9.dashboard-token-2.sig';
const JWT_3 = 'eyJhbGciOiJIUzI1NiJ9.dashboard-token-3.sig';
const ROUTER_KEY = 'sk-router-credits-0001';
const ADMIN_PASS = 'TestDashboardPass123!';
const API_KEY = 'sk-dashboard-client';

const LIVE_MODELS = [
  { id: 'deepseek-flash', name: 'deepseek-flash', ratio: '0.2x', tags: 'Low cost' },
  { id: 'glm-5.3', name: 'glm-5.3', ratio: '1.0x', tags: 'mid cost' },
  { id: 'kimi-k3', name: 'kimi-k3', ratio: '2.8x', tags: 'High cost' },
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

const rejectTokens = new Set();
let refreshCalls = 0;
let usageTokensSeen = [];
let refreshTokenSeen = [];
let nextAccessToken = JWT_2;
let nextRefreshToken = 'rf_2';
let authorized = false;

async function run() {
  const authServer = http.createServer(async (req, res) => {
    const body = await readBody(req);
    if (req.url === '/api/v1/auth/device/authorize' && req.method === 'POST') {
      return json(res, 200, {
        success: true,
        data: {
          deviceCode: 'dc_credits_1', userCode: 'CRED-1234',
          verificationUri: 'https://example.test/device',
          verificationUriComplete: 'https://example.test/device?user_code=CRED-1234',
          expiresIn: 180, interval: 1,
        },
      });
    }
    if (req.url === '/api/v1/auth/device/token' && req.method === 'POST') {
      if (!authorized) return json(res, 200, { success: true, data: { accessToken: null } });
      return json(res, 200, {
        success: true,
        data: { accessToken: JWT_1, refreshToken: 'rf_1', expiresIn: 7200, userId: 'user_credits_1' },
      });
    }
    if (req.url === '/api/v1/router/apikey/exchange' && req.method === 'POST') {
      return json(res, 200, {
        success: true,
        data: {
          memberId: 'member-credits', sk: ROUTER_KEY, status: 'ACTIVE',
          routerBaseUrl: routerBaseUrl,
          availableModels: LIVE_MODELS.map((m) => m.id),
        },
      });
    }
    if (req.url === '/api/v1/token/refresh' && req.method === 'POST') {
      refreshCalls++;
      refreshTokenSeen.push(body.refreshToken);
      return json(res, 200, {
        success: true,
        data: { accessToken: nextAccessToken, refreshToken: nextRefreshToken, expiresIn: 3600 },
      });
    }
    if (req.url === '/api/v1/user/usage-summary' && req.method === 'GET') {
      const auth = req.headers.authorization || '';
      usageTokensSeen.push(auth);
      const token = auth.replace(/^Bearer\s+/, '');
      if (rejectTokens.has(token)) {
        return json(res, 401, { success: false, code: 401, errorCode: 'token_invalid', errorMessage: 'Invalid token' });
      }
      return json(res, 200, {
        success: true,
        data: {
          planName: 'Pro',
          totalCredits: 1000,
          usedCredits: 250,
          remainingCredits: 750,
          allRemainingCredits: 800,
          usedPercent: 25,
          todayCredits: 12,
          todayRequests: 3,
          addonCredits: 60,
          addonUsed: 10,
          addonExpiry: '2027-01-01',
          expireAt: '2026-12-01',
          plan: { totalCredits: 1000, usedCredits: 250, remainingCredits: 750, expireAt: '2026-12-01', isActive: true },
          benefit: { totalCredits: 50, usedCredits: 0, remainingCredits: 50, expireAt: '2026-11-30' },
          addons: { totalCredits: 60, usedCredits: 10, remainingCredits: 50, expireAt: '2027-01-01' },
        },
      });
    }
    return json(res, 404, { error: 'not found' });
  });

  const routerServer = http.createServer(async (req, res) => {
    const auth = req.headers.authorization || '';
    if (req.url.startsWith('/v1/models') && req.method === 'GET') {
      if (auth !== `Bearer ${ROUTER_KEY}`) return json(res, 401, { error: { code: 'token_invalid' } });
      return json(res, 200, { object: 'list', data: LIVE_MODELS });
    }
    if (req.url.startsWith('/v1/dashboard/billing/usage')) {
      return json(res, 200, { object: 'list', total_usage: 12.5 });
    }
    if (req.url.startsWith('/v1/dashboard/billing/subscription')) {
      return json(res, 200, { hard_limit_usd: 100 });
    }
    return json(res, 404, { error: 'not found' });
  });

  await new Promise((r) => authServer.listen(0, '127.0.0.1', r));
  await new Promise((r) => routerServer.listen(0, '127.0.0.1', r));
  const authBaseUrl = `http://127.0.0.1:${authServer.address().port}`;
  const routerBaseUrl = `http://127.0.0.1:${routerServer.address().port}`;

  const dataDir = path.join(TMP_DIR, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const port = 18500 + Math.floor(Math.random() * 300);
  let childLogs = '';
  const gwProc = cp.fork(path.join(__dirname, '..', 'src', 'api-bridge.js'), [], {
    env: {
      ...process.env,
      PORT: String(port), BIND: '127.0.0.1',
      ADMIN_PASSWORD: ADMIN_PASS, API_KEYS: `${API_KEY}:test`,
      GATEWAY_DATA_DIR: dataDir,
      STATE_PATH: path.join(dataDir, 'usage-state.json'),
      AGENTIX_STATE_DIR: path.join(TMP_DIR, 'nonexistent-default-state'),
      ROUTER_BASE_URL: routerBaseUrl,
      QUIET: '1', LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  gwProc.stdout.on('data', (d) => { childLogs += d; });
  gwProc.stderr.on('data', (d) => { childLogs += d; });

  const base = `http://127.0.0.1:${port}`;
  function request(method, urlPath, body = null, headers = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request(new URL(urlPath, base), { method, headers, timeout: 10000 }, (res) => {
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
  for (let i = 0; i < 50; i++) {
    try { if ((await request('GET', '/healthz')).status === 200) { ready = true; break; } } catch (_) {}
    await new Promise((r) => setTimeout(r, 150));
  }
  assert(ready, `网桥未能在预期时间内启动。日志:\n${childLogs.slice(-1500)}`);

  try {
    // ---- 1. 设备授权一次 ----
    const login = await request('POST', '/api/admin/login', { password: ADMIN_PASS });
    assert.strictEqual(login.status, 200);
    const adminHeaders = { Cookie: login.headers['set-cookie'][0].split(';')[0] };

    // 先模拟「只手工导入 Router Key」的存量账号，设备授权后应复用它而不是新建一条。
    const preimport = await request('POST', '/api/admin/accounts/import',
      { name: '手动导入账号', routerKey: ROUTER_KEY }, adminHeaders);
    assert.strictEqual(preimport.status, 201, preimport.text);
    const preimportId = preimport.json.account.id;

    const start = await request('POST', '/api/admin/accounts/device-login/start',
      { name: '积分测试账号', authBaseUrl }, adminHeaders);
    assert.strictEqual(start.status, 200, start.text);
    const pollPath = `/api/admin/accounts/device-login/poll?session_id=${start.json.sessionId}`;
    authorized = true;
    let confirmed = null;
    for (let i = 0; i < 12; i++) {
      const r = await request('GET', pollPath, null, adminHeaders);
      if (r.json && r.json.status === 'confirmed') { confirmed = r.json; break; }
      await new Promise((r2) => setTimeout(r2, 120));
    }
    assert(confirmed, '设备登录必须完成落盘');
    const accId = confirmed.accountId;
    assert.strictEqual(accId, preimportId, '设备授权应复用相同 Router Key 的存量账号，避免同一账号出现两条');
    const accDir = path.join(dataDir, 'accounts', accId);
    const sessionPath = path.join(accDir, 'session.json');
    assert(fs.existsSync(sessionPath), '设备授权后必须写 session.json');

    // ---- 2. 磁盘上只能有 refresh token ----
    const sessionRaw = fs.readFileSync(sessionPath, 'utf8');
    const session = JSON.parse(sessionRaw);
    assert.strictEqual(session.refresh_token, 'rf_1');
    assert(!sessionRaw.includes(JWT_1), 'session.json 绝不能包含 access token');
    assert(!sessionRaw.includes(ROUTER_KEY), 'session.json 绝不能包含 Router Key');
    if (process.platform !== 'win32') {
      const mode = fs.statSync(sessionPath).mode & 0o777;
      assert.strictEqual(mode, 0o600, `session.json 权限应为 0600，实际 ${mode.toString(8)}`);
      // 账号目录的 .env 里是明文 Router Key，权限必须同样收紧
      const envMode = fs.statSync(path.join(accDir, '.env')).mode & 0o777;
      assert.strictEqual(envMode, 0o600, `账号 .env 权限应为 0600，实际 ${envMode.toString(8)}`);
    }

    // ---- 3. 调用凭据读仪表盘：积分（ADR-0011 后 Router 账单不再出现在仪表盘）----
    const dash = await request('GET', '/api/dashboard', null, { Authorization: `Bearer ${API_KEY}` });
    assert.strictEqual(dash.status, 200, dash.text);
    assert.strictEqual(
      dash.json.real, undefined,
      'ADR-0011 把积分定为唯一额度口径，仪表盘不得再下发 Router 账单（total_usage 是累计美分、hard_limit_usd 是无限制哨兵）'
    );
    assert.strictEqual(dash.json.pool.ready, 1);
    assert.strictEqual(dash.json.pool.total, 1);
    assert(dash.json.models.length >= LIVE_MODELS.length);
    assert.strictEqual(dash.json.credits.ok, true, `积分应成功: ${JSON.stringify(dash.json.credits)}`);
    const c = dash.json.credits.accounts[accId];
    assert(c, '积分响应必须包含账号');
    assert.strictEqual(c.total, 1000);
    assert.strictEqual(c.used, 250);
    assert.strictEqual(c.remaining, 750);
    assert.strictEqual(c.all_remaining, 800);
    assert.strictEqual(c.plan_name, 'Pro');
    assert.strictEqual(c.addon_total, 60);
    assert.strictEqual(dash.json.credits.total_remaining, 800);
    assert.strictEqual(usageTokensSeen[usageTokensSeen.length - 1], `Bearer ${JWT_1}`, '首次应使用设备授权拿到的 access token');

    // 响应与日志都不能泄露令牌
    for (const secret of [JWT_1, 'rf_1', ROUTER_KEY]) {
      assert(!dash.text.includes(secret), `仪表盘响应泄露了敏感值: ${secret.slice(0, 8)}...`);
      assert(!childLogs.includes(secret), `网关日志泄露了敏感值: ${secret.slice(0, 8)}...`);
    }

    // ---- 4. access token 被 401：自动刷新一次并轮换 refresh token ----
    rejectTokens.add(JWT_1);
    const beforeRefresh = refreshCalls;
    const dash2 = await request('GET', '/api/dashboard?force=1', null, { Authorization: `Bearer ${API_KEY}` });
    assert.strictEqual(dash2.status, 200);
    assert.strictEqual(refreshCalls, beforeRefresh + 1, '401 后应只刷新一次');
    assert.strictEqual(usageTokensSeen[usageTokensSeen.length - 1], `Bearer ${JWT_2}`, '刷新后应使用新 access token');
    const session2 = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    assert.strictEqual(session2.refresh_token, 'rf_2', '轮换后的 refresh token 必须原子写回');
    assert(!fs.readFileSync(sessionPath, 'utf8').includes(JWT_2), 'session.json 仍不能包含 access token');
    assert.strictEqual(dash2.json.credits.ok, true);

    // ---- 5. 刷新后仍 401：返回 reauth_required，且不无限刷新 ----
    rejectTokens.add(JWT_2);
    rejectTokens.add(JWT_3);
    nextAccessToken = JWT_3;
    nextRefreshToken = 'rf_3';
    const beforeReauth = refreshCalls;
    const dash3 = await request('GET', '/api/dashboard?force=1', null, { Authorization: `Bearer ${API_KEY}` });
    assert.strictEqual(dash3.status, 200);
    assert.strictEqual(dash3.json.credits.ok, false);
    assert.strictEqual(dash3.json.credits.error, 'reauth_required');
    assert.strictEqual(refreshCalls, beforeReauth + 1, '二次 401 不应继续循环刷新');
    for (const secret of [JWT_3, 'rf_3']) {
      assert(!dash3.text.includes(secret), 'reauth 响应不得泄露令牌');
    }

    // ---- 6. 零回归：/api/usage 对调用凭据仍是 admin_only ----
    const usage = await request('GET', '/api/usage', null, { Authorization: `Bearer ${API_KEY}` });
    assert.strictEqual(usage.status, 200);
    assert.strictEqual(usage.json.real.ok, false);
    assert.strictEqual(usage.json.real.error, 'admin_only');

    const models = await request('GET', '/api/models', null, { Authorization: `Bearer ${API_KEY}` });
    assert.strictEqual(models.status, 200);
    assert(models.json.data.length >= LIVE_MODELS.length);

    console.log('✓ [All Passed] 仪表盘积分：一次授权 + 自动续期 + 令牌不落盘/不泄露');
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
