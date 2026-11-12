'use strict';
/**
 * 回归测试：上游刷新的缓存语义（ADR-0015 §7 / §10）。
 *
 * 背景：
 *   - 模型目录抓取失败时曾不记录任何时间戳，`isFresh()` 恒为 false，页面 15 秒一刷
 *     就变成每 15 秒打一次上游（还带 12 秒超时）。
 *   - `refreshReal` 的 TTL 命中必须复用已有结果，而不是再打一次账单；
 *     缓存命中与真正刷新必须返回同一种形状（否则调用方会拿到 undefined）。
 *
 * 断言：
 *   1) 目录抓取 401 后，第二次仪表盘请求不再打上游（负缓存生效）；
 *   2) force=1 能突破负缓存并在成功后把 ratio_real 变真；
 *   3) `/api/usage` 连续两次只产生一组账单请求（TTL 复用），且两次都 real.ok=true；
 *   4) 响应与日志都不包含 Router Key。
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const TMP_DIR = path.join(os.tmpdir(), `aiwork-router-cache-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
fs.mkdirSync(TMP_DIR, { recursive: true });
process.on('exit', () => {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
});

const API_KEY = 'sk-cache-client';
const ROUTER_KEY = 'sk-cache-router-key';
const ADMIN_PASS = 'TestCachePass123!';

async function run() {
  let catalogOk = false;
  let catalogHits = 0;
  let usageHits = 0;
  let subHits = 0;

  const router = http.createServer((req, res) => {
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url.startsWith('/v1/models')) {
      catalogHits += 1;
      if (!catalogOk) return json(401, { error: { code: 'token_invalid' } });
      return json(200, {
        object: 'list',
        data: [{ id: 'deepseek-flash', name: 'deepseek-flash', ratio: '0.2x', tags: 'Low cost' }],
      });
    }
    if (req.url.startsWith('/v1/dashboard/billing/usage')) {
      usageHits += 1;
      return json(200, { object: 'list', total_usage: 1.5 });
    }
    if (req.url.startsWith('/v1/dashboard/billing/subscription')) {
      subHits += 1;
      return json(200, { hard_limit_usd: 100 });
    }
    return json(404, { error: 'not found' });
  });
  await new Promise((r) => router.listen(0, '127.0.0.1', r));
  const routerUrl = `http://127.0.0.1:${router.address().port}`;

  const stateDir = path.join(TMP_DIR, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, '.env'), `AGENTIX_CONFIG_MODELS_AIWORK_ROUTER_API_KEY=${ROUTER_KEY}\n`);
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({
    config_protocol_version: '1.1',
    models: { 'aiwork-router': { models: [{ id: 'deepseek-flash', name: 'deepseek-flash' }] } },
  }, null, 2));

  const dataDir = path.join(TMP_DIR, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const port = 20600 + Math.floor(Math.random() * 300);
  let logs = '';
  const gw = cp.fork(path.join(__dirname, '..', 'src', 'api-bridge.js'), [], {
    env: {
      ...process.env,
      PORT: String(port), BIND: '127.0.0.1',
      UPSTREAM: 'direct',
      ROUTER_BASE_URL: routerUrl,
      AGENTIX_STATE_DIR: stateDir,
      GATEWAY_DATA_DIR: dataDir,
      STATE_PATH: path.join(dataDir, 'usage-state.json'),
      API_KEYS: `${API_KEY}:cache`,
      ADMIN_PASSWORD: ADMIN_PASS,
      QUIET: '1', LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  gw.stdout.on('data', (d) => { logs += d; });
  gw.stderr.on('data', (d) => { logs += d; });

  const base = `http://127.0.0.1:${port}`;
  function request(method, urlPath, body = null, headers = {}, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const req = http.request(new URL(urlPath, base), { method, headers, timeout: timeoutMs }, (res) => {
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
  for (let i = 0; i < 80; i++) {
    try { if ((await request('GET', '/healthz')).status === 200) { ready = true; break; } } catch (_) {}
    await new Promise((r) => setTimeout(r, 150));
  }
  assert(ready, `网关未启动。日志:\n${logs.slice(-1500)}`);

  try {
    const login = await request('POST', '/api/admin/login', { password: ADMIN_PASS });
    assert.strictEqual(login.status, 200, login.text);
    const cookie = { Cookie: login.headers['set-cookie'][0].split(';')[0] };

    // 启动时会预热一次（refreshReal），先等它落定再取基线，避免把预热算进断言。
    await new Promise((r) => setTimeout(r, 1200));
    const baseCatalog = catalogHits;
    const baseUsage = usageHits;
    const baseSub = subHits;

    // ---- 1. 目录 401：一次强制刷新打一次上游，随后靠负缓存不再打 ----
    const dash1 = await request('GET', '/api/dashboard?force=1', null, cookie);
    assert.strictEqual(dash1.status, 200, dash1.text);
    assert.strictEqual(catalogHits, baseCatalog + 1, `强制刷新应只打一次模型目录，实际 ${catalogHits - baseCatalog}`);
    assert(dash1.json.models.length >= 1, '账号仍有本地模型可列');
    assert(dash1.json.models.every((m) => m.ratio_real === false), '抓取失败时倍率必须标记为非真实值');

    const dash2 = await request('GET', '/api/dashboard', null, cookie);
    assert.strictEqual(dash2.status, 200, dash2.text);
    assert.strictEqual(catalogHits, baseCatalog + 1, `负缓存内不得重复打上游，实际又打了 ${catalogHits - baseCatalog - 1} 次`);

    // ---- 2. force=1 突破负缓存；成功后 ratio_real 变真 ----
    catalogOk = true;
    const dash3 = await request('GET', '/api/dashboard?force=1', null, cookie);
    assert.strictEqual(dash3.status, 200, dash3.text);
    assert.strictEqual(catalogHits, baseCatalog + 2, `force=1 应再强制刷新一次，实际 ${catalogHits - baseCatalog}`);
    const live = dash3.json.models.find((m) => m.id === 'deepseek-flash');
    assert(live, '应列出 deepseek-flash');
    assert.strictEqual(live.ratio_real, true, '刷新成功后倍率应标记为真实值');
    assert.strictEqual(live.ratio, '0.2x', `应取到上游倍率，实际 ${live.ratio}`);

    // ---- 3. refreshReal 的 TTL：连续两次只产生一组账单请求 ----
    const u1 = await request('GET', '/api/usage', null, cookie);
    assert.strictEqual(u1.status, 200, u1.text);
    assert.strictEqual(u1.json.real.ok, true, `首次真实用量应成功：${JSON.stringify(u1.json.real)}`);
    assert.strictEqual(usageHits, baseUsage + 1, '首次应打一次 usage');
    assert.strictEqual(subHits, baseSub + 1, '首次应打一次 subscription');
    const catalogAfterU1 = catalogHits;

    const u2 = await request('GET', '/api/usage', null, cookie);
    assert.strictEqual(u2.status, 200, u2.text);
    assert.strictEqual(usageHits, baseUsage + 1, 'TTL 内不得重复请求 usage');
    assert.strictEqual(subHits, baseSub + 1, 'TTL 内不得重复请求 subscription');
    assert.strictEqual(catalogHits, catalogAfterU1, 'TTL 内不得重复拉模型目录');
    assert.strictEqual(u2.json.real.ok, true, '缓存命中时必须返回与刷新同形状的结果（real.ok=true）');
    assert.strictEqual(u2.json.real.usage, u1.json.real.usage, '缓存命中应复用同一份数值');

    // ---- 4. 不泄露 Router Key ----
    for (const r of [dash1, dash3, u1, u2]) {
      assert(!r.text.includes(ROUTER_KEY), '响应不得包含 Router Key');
    }
    assert(!logs.includes(ROUTER_KEY), '日志不得包含 Router Key');

    console.log('✓ [All Passed] 上游刷新缓存：负缓存 + force 突破 + TTL 复用 + 不泄露 Key');
  } finally {
    gw.kill('SIGTERM');
    router.close();
  }
}

run().catch((err) => {
  console.error('测试失败:', err.message);
  process.exit(1);
});
