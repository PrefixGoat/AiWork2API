'use strict';
/**
 * 用量账本接线（Issue #06）：网关真实请求 → 账本 → GET /api/usage/buckets。
 *
 * 单测只证明账本自己的算术；这里证明三件接线上的事：
 *   1) 成功请求用最终服务账号、失败请求用失败的账号，token 与上游 usage 一致；
 *   2) 账本独立于 usage-state.json：POST /api/local-stats/reset 清零本机统计后账本不动；
 *   3) 进程被 SIGKILL 强杀后重启，账本仍能读回同样的数字（防抖已落盘、无半截 JSON）。
 *
 * 所有状态目录都指向临时目录，绝不污染仓库。
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwork-usage-ledger-api-'));
process.on('exit', () => {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
});

const ADMIN_PASSWORD = 'TestUsageLedgerPass123!';
const INV_KEY = 'sk-usage-ledger-client';
const ROUTER_KEY = 'sk-router-ledger-0001';
const PORT = 18400 + Math.floor(Math.random() * 200);

let routerServer = null;
let gw = null;
let gwLogs = '';

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function startRouter() {
  routerServer = http.createServer((req, res) => {
    const auth = req.headers.authorization || '';
    if (req.url.startsWith('/v1/models')) {
      if (auth !== `Bearer ${ROUTER_KEY}`) return json(res, 401, { error: { code: 'token_invalid' } });
      return json(res, 200, {
        object: 'list',
        data: [
          { id: 'deepseek-flash', name: 'deepseek-flash', ratio: '0.2x', tags: 'Low cost' },
          { id: 'boom-model', name: 'boom-model', ratio: '1x', tags: '' },
        ],
      });
    }
    if (req.url.startsWith('/v1/dashboard/billing/usage')) {
      return json(res, 200, { object: 'list', total_usage: 12.5 });
    }
    if (req.url.startsWith('/v1/dashboard/billing/subscription')) {
      return json(res, 200, { hard_limit_usd: 100 });
    }
    if (req.url.startsWith('/v1/chat/completions') && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(body); } catch (_) {}
        if (String(parsed.model || '').includes('boom')) {
          return json(res, 500, { error: { message: 'upstream exploded', type: 'server_error' } });
        }
        return json(res, 200, {
          id: 'chatcmpl-ledger-1',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: parsed.model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
        });
      });
      return;
    }
    return json(res, 404, { error: 'not found' });
  });
  return new Promise((r) => routerServer.listen(0, '127.0.0.1', r));
}

function writeAccountState() {
  const accDir = path.join(TMP_DIR, 'acc1');
  fs.mkdirSync(accDir, { recursive: true });
  fs.writeFileSync(path.join(accDir, '.env'), `AGENTIX_CONFIG_MODELS_AIWORK_ROUTER_API_KEY=${ROUTER_KEY}\n`);
  fs.writeFileSync(path.join(accDir, 'config.json'), JSON.stringify({
    models: {
      'aiwork-router': {
        models: [
          { id: 'deepseek-flash', name: 'deepseek-flash', multiplier: 0.2, ratio: '0.2x' },
          { id: 'boom-model', name: 'boom-model', multiplier: 1, ratio: '1x' },
        ],
      },
    },
  }));
  return accDir;
}

function gatewayEnv(accDir, routerBaseUrl) {
  const dataDir = path.join(TMP_DIR, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(path.join(dataDir, 'api-keys.json'))) {
    fs.writeFileSync(path.join(dataDir, 'api-keys.json'), JSON.stringify({
      version: 1,
      keys: [{
        id: 'key-ledger-inv',
        token: INV_KEY,
        name: 'ledger-client',
        accountPolicy: { mode: 'all', allowedAccounts: [] },
        createdAt: Date.now(),
        revoked: false,
      }],
    }, null, 2));
  }
  return {
    ...process.env,
    PORT: String(PORT),
    BIND: '127.0.0.1',
    ADMIN_PASSWORD,
    UPSTREAM: 'direct',
    ROUTER_BASE_URL: routerBaseUrl,
    UPSTREAM_ACCOUNTS: JSON.stringify([{ id: 'acc1', name: 'AccOne', stateDir: accDir }]),
    GATEWAY_DATA_DIR: dataDir,
    AGENTIX_STATE_DIR: path.join(TMP_DIR, 'nonexistent-agentix'),
    STATE_PATH: path.join(dataDir, 'usage-state.json'),
    USAGE_BUCKETS_PATH: path.join(dataDir, 'usage-buckets.json'),
    USAGE_BUCKETS_DEBOUNCE_MS: '50',
    QUIET: '1',
    LOG_LEVEL: 'error',
  };
}

function request(method, urlPath, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(urlPath, `http://127.0.0.1:${PORT}`), {
      method, headers: headers || {}, timeout: 15000,
    }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(d); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, json: parsed, text: d });
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

async function startGateway(env) {
  gwLogs = '';
  gw = cp.fork(path.join(__dirname, '..', 'src', 'api-bridge.js'), [], {
    env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  gw.stdout.on('data', (d) => { gwLogs += d; });
  gw.stderr.on('data', (d) => { gwLogs += d; });
  for (let i = 0; i < 80; i++) {
    try { if ((await request('GET', '/healthz')).status === 200) return; } catch (_) {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`网关未能在预期时间内启动。日志:\n${gwLogs.slice(-2000)}`);
}

async function stopGateway(signal) {
  if (!gw) return;
  const proc = gw;
  gw = null;
  await new Promise((resolve) => {
    proc.once('exit', resolve);
    proc.kill(signal);
  });
}

async function adminLogin() {
  const res = await request('POST', '/api/admin/login', { body: JSON.stringify({ password: ADMIN_PASSWORD }) });
  assert.strictEqual(res.status, 200, `管理员登录失败: ${res.text}`);
  const cookie = res.headers['set-cookie'];
  const raw = Array.isArray(cookie) ? cookie[0] : cookie;
  assert.ok(raw, '登录必须下发会话 cookie');
  return { Cookie: raw.split(';')[0] };
}

async function run() {
  await startRouter();
  const routerBaseUrl = `http://127.0.0.1:${routerServer.address().port}`;
  const accDir = writeAccountState();
  const env = gatewayEnv(accDir, routerBaseUrl);
  const bucketsPath = env.USAGE_BUCKETS_PATH;

  await startGateway(env);
  try {
    const admin = await adminLogin();
    const inv = { Authorization: `Bearer ${INV_KEY}` };

    // ---- 1. 一次成功请求 ----
    const ok = await request('POST', '/v1/chat/completions', {
      headers: inv,
      body: { model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 },
    });
    assert.strictEqual(ok.status, 200, `成功请求应 200，实际 ${ok.status}: ${ok.text}`);

    // ---- 2. 一次上游失败请求（500，单账号无候选可换） ----
    const boom = await request('POST', '/v1/chat/completions', {
      headers: inv,
      body: { model: 'boom-model', messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 },
    });
    assert.notStrictEqual(boom.status, 200, '失败请求不应返回 200');

    await new Promise((r) => setTimeout(r, 400)); // 等防抖落盘

    const buckets = await request('GET', '/api/usage/buckets?hours=24', { headers: admin });
    assert.strictEqual(buckets.status, 200, `账本读取失败: ${buckets.status} ${buckets.text}`);
    assert.strictEqual(buckets.json.ok, true);
    assert.strictEqual(buckets.json.requests, 2, `账本应有 2 次请求，实际 ${buckets.json.requests}`);
    assert.strictEqual(buckets.json.errors, 1, '只有上游失败的那次算失败');
    assert.strictEqual(buckets.json.prompt_tokens, 12, 'token 必须与上游 usage 一致');
    assert.strictEqual(buckets.json.completion_tokens, 8);
    assert.strictEqual(buckets.json.total_tokens, 20, '失败尝试不能凭空加 token');
    assert.ok(buckets.json.credits > 0, '成功请求应有估算消耗');
    assert.strictEqual(buckets.json.buckets, 2, '成功/失败落在不同账号桶：acc1 的两种模型，共 2 个桶');

    // ---- 2b. 票 07：一次查询拿到总量、三组明细与趋势 ----
    assert.strictEqual(buckets.json.by_account.length, 1, '两次请求都落在 acc1');
    assert.strictEqual(buckets.json.by_model.length, 2, '两个模型各一行');
    assert.strictEqual(buckets.json.by_key.length, 1, '两次请求用的是同一把调用凭据，应合成一行');
    const sumOf = (rows, field) => rows.reduce((acc, row) => acc + row[field], 0);
    for (const rows of [buckets.json.by_account, buckets.json.by_model, buckets.json.by_key]) {
      assert.strictEqual(sumOf(rows, 'requests'), buckets.json.requests, '分组请求数之和必须等于总量');
      assert.strictEqual(sumOf(rows, 'total_tokens'), buckets.json.total_tokens);
    }
    assert.strictEqual(buckets.json.granularity, 'hour');
    assert.strictEqual(sumOf(buckets.json.series, 'requests'), 2, '小时趋势序列合计等于总量');
    assert(buckets.json.ledger, '响应必须带账本自身状态（桶数/上限/拒收数）');
    assert.ok(buckets.json.ledger.buckets >= 2, `ledger.buckets 应是当前桶数，实际 ${buckets.json.ledger.buckets}`);
    assert.ok(buckets.json.ledger.max_buckets > 0, 'ledger.max_buckets 应是硬上限');
    assert.strictEqual(buckets.json.ledger.dropped, 0, '没触顶时不应有拒收');
    const failedModel = buckets.json.by_model.find((row) => row.model === 'boom-model');
    assert.strictEqual(failedModel.errors, 1, '失败模型的明细里要能看到失败次数');

    const clamped = await request('GET', '/api/usage/buckets?hours=99999', { headers: admin });
    assert.strictEqual(clamped.status, 200, `超上限的小时窗口应被钳制而不是报错: ${clamped.text}`);
    assert.strictEqual(clamped.json.hours, 1440, '窗口上限是 60 天');
    assert.strictEqual(clamped.json.clamped, true);

    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const ranged = await request('GET', `/api/usage/buckets?from=${today}&to=${today}&granularity=day`, { headers: admin });
    assert.strictEqual(ranged.status, 200, ranged.text);
    assert.strictEqual(ranged.json.mode, 'range');
    assert.strictEqual(ranged.json.granularity, 'day');
    assert.strictEqual(ranged.json.requests, 2, '显式闭区间应包含今天');
    assert.strictEqual(sumOf(ranged.json.series, 'requests'), 2, '天趋势序列合计等于总量');

    const badGranularity = await request('GET', '/api/usage/buckets?granularity=week', { headers: admin });
    assert.strictEqual(badGranularity.status, 400, '非法粒度必须 400');
    // 窗口参数非法一律 400 + code=invalid_window：既不能落成 500，也不能静默回落到默认窗口。
    for (const qs of ['hours=abc', 'hours=0', `from=${today}`]) {
      const bad = await request('GET', `/api/usage/buckets?${qs}`, { headers: admin });
      assert.strictEqual(bad.status, 400, `${qs} 应 400，实际 ${bad.status}: ${bad.text}`);
      assert.strictEqual(bad.json && bad.json.error && bad.json.error.code, 'invalid_window',
        `${qs} 的错误码应是 invalid_window，实际 ${bad.json && bad.json.error && bad.json.error.code}`);
    }
    const anonRange = await request('GET', `/api/usage/buckets?from=${today}&to=${today}`);
    assert([401, 403].includes(anonRange.status), '区间查询的管理权限口径不变');

    // ---- 3. 权限：与 /api/dashboard、/api/logs 同一口径（ADR-0009 的部署级只读视图）----
    // 默认部署不设口令时，页面用调用凭据读取；若这里要求管理会话，用量页在默认部署里打不开。
    const viaInvocation = await request('GET', '/api/usage/buckets', { headers: inv });
    assert.strictEqual(viaInvocation.status, 200, `调用凭据应可读部署级只读用量，实际 ${viaInvocation.status}`);
    assert.strictEqual(viaInvocation.json.ok, true);
    const anon = await request('GET', '/api/usage/buckets');
    assert([401, 403].includes(anon.status), `未鉴权不应读到账本，实际 ${anon.status}`);

    // ---- 4. 清空本机统计不得影响账本 ----
    const reset = await request('POST', '/api/local-stats/reset', { headers: admin, body: '{}' });
    assert.strictEqual(reset.status, 200, `重置失败: ${reset.status} ${reset.text}`);
    const usage = await request('GET', '/api/usage', { headers: admin });
    assert.strictEqual(usage.json.requests, 0, '本机统计应被清零');

    const afterReset = await request('GET', '/api/usage/buckets?hours=24', { headers: admin });
    assert.strictEqual(afterReset.json.requests, 2, '清空本机统计不能清掉账本');
    assert.strictEqual(afterReset.json.total_tokens, 20);

    // ---- 5. 账本文件：完整 JSON、无临时文件残留 ----
    assert.ok(fs.existsSync(bucketsPath), '账本应已落盘到独立文件');
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(bucketsPath, 'utf8')), '账本文件必须是完整 JSON');
    const leftovers = fs.readdirSync(path.dirname(bucketsPath))
      .filter((f) => f.startsWith('usage-buckets.json.tmp'));
    assert.deepStrictEqual(leftovers, [], '不应留下临时文件');

    // ---- 6. 强杀后重启，账本仍可读 ----
    await stopGateway('SIGKILL');
    await startGateway(env);
    const admin2 = await adminLogin();
    const restored = await request('GET', '/api/usage/buckets?hours=24', { headers: admin2 });
    assert.strictEqual(restored.status, 200, restored.text);
    assert.strictEqual(restored.json.requests, 2, '强杀重启后请求数必须还在');
    assert.strictEqual(restored.json.total_tokens, 20, '强杀重启后 token 必须还在');

    console.log('✓ [All Passed] 用量账本接线：成功/失败记账 + 管理口径读取 + 与本机统计隔离 + 强杀重启不丢');
  } finally {
    await stopGateway('SIGTERM');
    if (routerServer) routerServer.close();
  }
}

run().catch((err) => {
  console.error('测试失败:', err && err.stack || err);
  if (gw) { try { gw.kill('SIGKILL'); } catch (_) {} }
  if (routerServer) routerServer.close();
  process.exit(1);
});
