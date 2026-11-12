'use strict';
/**
 * 回归测试：左侧「日志」TAB 的数据源。
 *
 * 约束：
 *   - 容器以 QUIET=1 运行，stdout 访问日志被静默，页面不能靠日志流。
 *   - 日志必须只读、可被调用凭据读取（ADR 0009），且绝不回显凭据。
 *   - 只记录代理调用（/v1/*），页面自身的轮询（/api/dashboard、/healthz）不能刷屏。
 *
 * 断言：
 *   1) 一次 /v1/models 调用后，GET /api/logs 能看到这条记录（方法/路径/状态/耗时）；
 *   2) /healthz、/api/dashboard、/api/logs 自身不进日志；
 *   3) limit 参数生效，且返回按时间倒序（最新在前）；
 *   4) 响应与记录里都没有 Authorization / API Key 明文；
 *   5) 未鉴权访问 /api/logs 被拒绝（401/403）。
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const TMP_DIR = path.join(os.tmpdir(), `aiwork-request-log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
fs.mkdirSync(TMP_DIR, { recursive: true });
process.on('exit', () => {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
});

const ADMIN_PASS = 'TestRequestLogPass123!';
const API_KEY = 'sk-request-log-client';
const ROUTER_KEY = 'sk-router-log-0001';

const LIVE_MODELS = [{ id: 'deepseek-flash', name: 'deepseek-flash', ratio: '0.2x', tags: 'Low cost' }];

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function run() {
  const routerServer = http.createServer((req, res) => {
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

  await new Promise((r) => routerServer.listen(0, '127.0.0.1', r));
  const routerBaseUrl = `http://127.0.0.1:${routerServer.address().port}`;

  const dataDir = path.join(TMP_DIR, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const port = 19100 + Math.floor(Math.random() * 300);
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
    const authHeaders = { Authorization: `Bearer ${API_KEY}` };

    // ---- 5. 未鉴权先测：日志是只读但需要凭据 ----
    const anon = await request('GET', '/api/logs');
    assert([401, 403].includes(anon.status), `未鉴权访问 /api/logs 应被拒绝，实际 ${anon.status}`);

    // 造两条代理调用（一条成功、一条 404 路径）
    const models = await request('GET', '/v1/models', null, authHeaders);
    assert.strictEqual(models.status, 200, models.text);
    const missing = await request('GET', '/v1/not-a-real-endpoint', null, authHeaders);
    assert.notStrictEqual(missing.status, 200);

    // 噪声：页面自身的轮询不应进日志
    await request('GET', '/api/dashboard?force=1', null, authHeaders);
    await request('GET', '/healthz');
    await request('GET', '/status');

    const logs = await request('GET', '/api/logs?limit=50', null, authHeaders);
    assert.strictEqual(logs.status, 200, logs.text);
    assert.strictEqual(logs.json.ok, true);

    const entries = logs.json.entries || [];
    assert(entries.length >= 2, `日志至少应有 2 条代理调用，实际 ${entries.length}`);

    const okEntry = entries.find((e) => e.path === '/v1/models' && e.status === 200);
    assert(okEntry, `缺少 /v1/models 的成功记录: ${JSON.stringify(entries.slice(0, 3))}`);
    assert.strictEqual(okEntry.method, 'GET');
    assert(typeof okEntry.ms === 'number' && okEntry.ms >= 0, '日志需要耗时');
    assert(okEntry.t, '日志需要时间戳');

    const missEntry = entries.find((e) => e.path === '/v1/not-a-real-endpoint');
    assert(missEntry, '失败请求也必须记录');

    // 3. 噪声过滤 + 倒序
    assert(!entries.some((e) => e.path.startsWith('/healthz')), '/healthz 不应进日志');
    assert(!entries.some((e) => e.path === '/status'), '/status 不应进日志');
    assert(!entries.some((e) => e.path.startsWith('/api/dashboard')), '/api/dashboard 不应进日志');
    assert(!entries.some((e) => e.path.startsWith('/api/logs')), '/api/logs 自身不应进日志');
    for (let i = 1; i < entries.length; i++) {
      assert(new Date(entries[i - 1].t).getTime() >= new Date(entries[i].t).getTime(), '日志应按时间倒序');
    }

    const limited = await request('GET', '/api/logs?limit=1', null, authHeaders);
    assert.strictEqual(limited.status, 200);
    assert.strictEqual((limited.json.entries || []).length, 1, 'limit=1 应只返回 1 条');

    // 4. 不泄露凭据
    for (const secret of [API_KEY, ROUTER_KEY]) {
      assert(!logs.text.includes(secret), `日志响应泄露了敏感值: ${secret.slice(0, 10)}...`);
    }

    console.log('✓ [All Passed] 请求日志：只读接口 + 噪声过滤 + 倒序 + 不泄露凭据');
  } finally {
    gwProc.kill('SIGTERM');
    routerServer.close();
  }
}

run().catch((err) => {
  console.error('测试失败:', err.message);
  process.exit(1);
});
