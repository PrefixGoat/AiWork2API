'use strict';
/**
 * 回归测试：仪表盘把「已用积分 / 总积分 / 剩余」聚合到账号池级别。
 *
 * 背景：卡片从「本月用量/额度 + 积分」两张合并为一张「已用积分」，
 * 所以前端不再自己按账号求和，聚合口径必须由 GET /api/dashboard 提供。
 *
 * 断言（两个账号，数值自洽）：
 *   账号 A：total 1000 / used 250 / remaining 750
 *   账号 B：total  500 / used 100 / remaining 400
 *   => total_total 1500 / total_used 350 / total_remaining 1150
 *
 * 同时保证：单账号明细仍原样返回、响应不泄露任何令牌。
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const TMP_DIR = path.join(os.tmpdir(), `aiwork-credits-agg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
fs.mkdirSync(TMP_DIR, { recursive: true });
process.on('exit', () => {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
});

const ADMIN_PASS = 'TestAggregatePass123!';
const API_KEY = 'sk-aggregate-client';

const ACCOUNTS = [
  {
    jwt: 'eyJhbGciOiJIUzI1NiJ9.agg-token-a.sig',
    refresh: 'rf_agg_a',
    userId: 'user_agg_a',
    sk: 'sk-router-agg-a',
    credits: { total: 1000, used: 250, remaining: 750 },
  },
  {
    jwt: 'eyJhbGciOiJIUzI1NiJ9.agg-token-b.sig',
    refresh: 'rf_agg_b',
    userId: 'user_agg_b',
    sk: 'sk-router-agg-b',
    credits: { total: 500, used: 100, remaining: 400 },
  },
];

const LIVE_MODELS = [{ id: 'deepseek-flash', name: 'deepseek-flash', ratio: '0.2x', tags: 'Low cost' }];

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

const byDeviceCode = new Map();
let seq = 0;

function accountByJwt(jwt) {
  return ACCOUNTS.find((a) => a.jwt === jwt) || null;
}

async function run() {
  const authServer = http.createServer(async (req, res) => {
    const body = await readBody(req);
    if (req.url === '/api/v1/auth/device/authorize' && req.method === 'POST') {
      const acc = ACCOUNTS[seq++];
      const deviceCode = `dc_${acc.userId}`;
      byDeviceCode.set(deviceCode, acc);
      return json(res, 200, {
        success: true,
        data: {
          deviceCode,
          userCode: `CODE-${acc.userId}`,
          verificationUri: 'https://example.test/device',
          verificationUriComplete: `https://example.test/device?user_code=CODE-${acc.userId}`,
          expiresIn: 180,
          interval: 1,
        },
      });
    }
    if (req.url === '/api/v1/auth/device/token' && req.method === 'POST') {
      const acc = byDeviceCode.get(body.deviceCode);
      if (!acc) return json(res, 404, { success: false });
      return json(res, 200, {
        success: true,
        data: { accessToken: acc.jwt, refreshToken: acc.refresh, expiresIn: 7200, userId: acc.userId },
      });
    }
    if (req.url === '/api/v1/router/apikey/exchange' && req.method === 'POST') {
      const token = (req.headers.authorization || '').replace(/^Bearer\s+/, '');
      const acc = accountByJwt(token);
      if (!acc) return json(res, 401, { success: false });
      return json(res, 200, {
        success: true,
        data: {
          memberId: `member-${acc.userId}`,
          sk: acc.sk,
          status: 'ACTIVE',
          routerBaseUrl,
          availableModels: LIVE_MODELS.map((m) => m.id),
        },
      });
    }
    if (req.url === '/api/v1/user/usage-summary' && req.method === 'GET') {
      const token = (req.headers.authorization || '').replace(/^Bearer\s+/, '');
      const acc = accountByJwt(token);
      if (!acc) return json(res, 401, { success: false, code: 401, errorCode: 'token_invalid' });
      const c = acc.credits;
      return json(res, 200, {
        success: true,
        data: {
          planName: 'Teams',
          totalCredits: c.total,
          usedCredits: c.used,
          remainingCredits: c.remaining,
          allRemainingCredits: c.remaining,
          plan: { totalCredits: c.total, usedCredits: c.used, remainingCredits: c.remaining, expireAt: '2026-12-01', isActive: true },
          benefit: { totalCredits: 0, usedCredits: 0, remainingCredits: 0 },
          addons: { totalCredits: 0, usedCredits: 0, remainingCredits: 0 },
        },
      });
    }
    return json(res, 404, { error: 'not found' });
  });

  const routerServer = http.createServer(async (req, res) => {
    const auth = req.headers.authorization || '';
    const valid = ACCOUNTS.some((a) => `Bearer ${a.sk}` === auth);
    if (req.url.startsWith('/v1/models') && req.method === 'GET') {
      if (!valid) return json(res, 401, { error: { code: 'token_invalid' } });
      return json(res, 200, { object: 'list', data: LIVE_MODELS });
    }
    if (req.url.startsWith('/v1/dashboard/billing/usage')) {
      if (!valid) return json(res, 401, { error: { code: 'token_invalid' } });
      return json(res, 200, { object: 'list', total_usage: 12.5 });
    }
    if (req.url.startsWith('/v1/dashboard/billing/subscription')) {
      if (!valid) return json(res, 401, { error: { code: 'token_invalid' } });
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
  const port = 18800 + Math.floor(Math.random() * 300);
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
      const req = http.request(new URL(urlPath, base), { method, headers, timeout: 15000 }, (res) => {
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
  for (let i = 0; i < 60; i++) {
    try { if ((await request('GET', '/healthz')).status === 200) { ready = true; break; } } catch (_) {}
    await new Promise((r) => setTimeout(r, 150));
  }
  assert(ready, `网桥未能在预期时间内启动。日志:\n${childLogs.slice(-1500)}`);

  try {
    const login = await request('POST', '/api/admin/login', { password: ADMIN_PASS });
    assert.strictEqual(login.status, 200);
    const adminHeaders = { Cookie: login.headers['set-cookie'][0].split(';')[0] };

    // ---- 接入两个官方账号（各自持有独立 refresh token） ----
    const ids = [];
    for (const acc of ACCOUNTS) {
      const start = await request('POST', '/api/admin/accounts/device-login/start',
        { name: `聚合账号 ${acc.userId}`, authBaseUrl }, adminHeaders);
      assert.strictEqual(start.status, 200, start.text);
      const pollPath = `/api/admin/accounts/device-login/poll?session_id=${start.json.sessionId}`;
      let confirmed = null;
      for (let i = 0; i < 15; i++) {
        const r = await request('GET', pollPath, null, adminHeaders);
        if (r.json && r.json.status === 'confirmed') { confirmed = r.json; break; }
        await new Promise((r2) => setTimeout(r2, 120));
      }
      assert(confirmed, `账号 ${acc.userId} 设备登录未完成`);
      ids.push(confirmed.accountId);
    }
    assert.strictEqual(new Set(ids).size, 2, '两个不同 userId 必须落成两个独立账号');

    const dash = await request('GET', '/api/dashboard?force=1', null, { Authorization: `Bearer ${API_KEY}` });
    assert.strictEqual(dash.status, 200, dash.text);
    const credits = dash.json.credits;
    assert.strictEqual(credits.ok, true, `积分应成功: ${JSON.stringify(credits.error)}`);

    // 单账号明细不受影响
    for (let i = 0; i < ACCOUNTS.length; i++) {
      const acc = ACCOUNTS[i];
      const detail = credits.accounts[ids[i]];
      assert(detail, `缺少账号 ${acc.userId} 的明细`);
      assert.strictEqual(detail.total, acc.credits.total, '单账号总额');
      assert.strictEqual(detail.used, acc.credits.used, '单账号已用');
      assert.strictEqual(detail.remaining, acc.credits.remaining, '单账号剩余');
    }

    // 跨账号聚合：这就是「已用积分」卡直接消费的值
    const expectedTotal = ACCOUNTS.reduce((s, a) => s + a.credits.total, 0);
    const expectedUsed = ACCOUNTS.reduce((s, a) => s + a.credits.used, 0);
    const expectedRemaining = ACCOUNTS.reduce((s, a) => s + a.credits.remaining, 0);
    assert.strictEqual(credits.total_total, expectedTotal, `聚合总额应为 ${expectedTotal}`);
    assert.strictEqual(credits.total_used, expectedUsed, `聚合已用应为 ${expectedUsed}`);
    assert.strictEqual(credits.total_remaining, expectedRemaining, `聚合剩余应为 ${expectedRemaining}`);

    // 响应不得泄露令牌
    for (const acc of ACCOUNTS) {
      for (const secret of [acc.jwt, acc.refresh, acc.sk]) {
        assert(!dash.text.includes(secret), `响应泄露了敏感值: ${secret.slice(0, 10)}...`);
      }
    }

    console.log('✓ [All Passed] 积分跨账号聚合：total_total / total_used / total_remaining');
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
