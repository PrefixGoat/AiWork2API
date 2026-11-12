'use strict';
/**
 * 回归测试：设置项必须真的有后端消费者，且仪表盘/用量接口的口径契约不被破坏。
 *
 * 背景（代码评审发现）：
 *   - 评审发现 3 个设置项只有页面在读，后端仍读启动时的 env，属于「假开关」。
 *     CONTEXT.md 的「设置项」定义要求字段必须有后端读取方，ADR-0013 承诺立即生效。
 *   - 评审发现 /api/usage 在默认部署（未设 ADMIN_PASSWORD）下把全局数据返回给了调用凭据，
 *     破坏 ADR-0011「对调用凭据仍是 admin_only」的零回归承诺。
 *   - 评审发现 /api/dashboard 仍下发 Router 账单与本地金额字段，而 ADR-0011/0013
 *     已把积分定为唯一额度口径、并删除本地单价。
 *
 * 断言：
 *   A) 模块层：session-router 按运行时设置读并发上限 / 粘性 TTL / 粘性开关；
 *   B) HTTP 层：/api/usage 对调用凭据只返回自身统计（real=admin_only）；
 *   C) HTTP 层：/api/dashboard 不含 Router 账单与本地金额；
 *   D) HTTP 层：关闭粘性开关后，同一会话不再复用账号。
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const { SessionRouter } = require('../src/session-router');
const { MockUpstream } = require('./mock-upstream');

const TMP_DIR = path.join(os.tmpdir(), `aiwork-settings-effect-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
fs.mkdirSync(TMP_DIR, { recursive: true });
process.on('exit', () => {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
});

const API_KEY = 'sk-settings-effect-client';
const ACCOUNT_A_KEY = 'sk-account-alpha';
const ACCOUNT_B_KEY = 'sk-account-beta';

/* ------------------------------------------------------------------ */
/* A. 模块层：设置必须被 session-router 实时读取                        */
/* ------------------------------------------------------------------ */

function fakeAccount(id) {
  return { id, supportsModel: () => true };
}

function fakePool(accounts) {
  return {
    getReadyAccounts: () => accounts,
    listAccounts: () => accounts,
    reloadIfChanged: () => [],
  };
}

function checkRouterHonoursLiveSettings() {
  let settings = {
    max_concurrency_per_account: 1,
    session_binding_ttl_sec: 3600,
    session_binding_enabled: true,
  };
  // 构造参数故意给一个大值：只有真的读 settings 才能通过
  const router = new SessionRouter({ settings: () => settings, maxConcurrency: 99 });
  const pool = fakePool([fakeAccount('acc-a'), fakeAccount('acc-b')]);

  const pick = () => router.getCandidates({ accountPool: pool, checkConcurrency: true, skipReload: true });

  // --- 并发上限 ---
  router.acquireAccount('acc-a');
  assert.strictEqual(
    pick().filter((a) => a.id === 'acc-a').length, 0,
    'max_concurrency_per_account=1 时，acc-a 已有 1 个在途必须被排除（当前仍读启动值 99，属假开关）'
  );
  settings = { ...settings, max_concurrency_per_account: 2 };
  assert.strictEqual(
    pick().filter((a) => a.id === 'acc-a').length, 1,
    '把上限改成 2 后必须立即恢复候选，无需重启'
  );
  router.releaseAccount('acc-a');

  // --- 粘性 TTL ---
  settings = { ...settings, session_binding_ttl_sec: 60, session_binding_enabled: true };
  const first = router.routeSession({ keyId: 'k1', rawSessionId: 'sess-ttl', accountPool: pool });
  assert.strictEqual(first.isNewSession, true, '首次调用应新建绑定');
  const reused = router.routeSession({ keyId: 'k1', rawSessionId: 'sess-ttl', accountPool: pool });
  assert.strictEqual(reused.isNewSession, false, 'TTL 内必须复用绑定');
  assert.strictEqual(reused.account.id, first.account.id);

  router.fastForward(61 * 1000);
  const expired = router.routeSession({ keyId: 'k1', rawSessionId: 'sess-ttl', accountPool: pool });
  assert.strictEqual(
    expired.isNewSession, true,
    'TTL 设为 60 秒后，61 秒必须过期重选（当前仍读启动值 1 小时，属假开关）'
  );

  // --- 粘性开关 ---
  settings = { ...settings, session_binding_ttl_sec: 3600, session_binding_enabled: false };
  const off1 = router.routeSession({ keyId: 'k2', rawSessionId: 'sess-off', accountPool: pool });
  const off2 = router.routeSession({ keyId: 'k2', rawSessionId: 'sess-off', accountPool: pool });
  assert.strictEqual(off1.isNewSession, true);
  assert.strictEqual(off2.isNewSession, true, '关闭粘性路由后，同一会话每次都必须重新轮询');
  assert.notStrictEqual(off1.account.id, off2.account.id, '轮询应命中不同账号');
  assert.strictEqual(
    router.getBinding('k2', 'sess-off'), null,
    '粘性关闭时不得写入绑定表'
  );

  // 恢复开启后绑定行为回到正常
  settings = { ...settings, session_binding_enabled: true };
  const on1 = router.routeSession({ keyId: 'k3', rawSessionId: 'sess-on', accountPool: pool });
  const on2 = router.routeSession({ keyId: 'k3', rawSessionId: 'sess-on', accountPool: pool });
  assert.strictEqual(on1.isNewSession, true);
  assert.strictEqual(on2.isNewSession, false, '重新开启后必须恢复粘性');
  assert.strictEqual(on1.account.id, on2.account.id);

  console.log('  ✓ A 模块层：并发上限 / 粘性 TTL / 粘性开关 均按运行时设置生效');
}

/* ------------------------------------------------------------------ */
/* B/C/D. HTTP 层                                                      */
/* ------------------------------------------------------------------ */

function writeAccount(dataDir, id, routerKey, name) {
  const dir = path.join(dataDir, 'accounts', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.env'), `AGENTIX_CONFIG_MODELS_AIWORK_ROUTER_API_KEY=${routerKey}\n`);
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ name, user_id: id }), 'utf8');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    config_protocol_version: '1.1',
    models: {
      'aiwork-router': {
        models: [
          { id: 'deepseek-flash', name: 'DeepSeek Flash' },
          { id: 'qwen3.8-max', name: 'Qwen 3.8 Max' },
        ],
      },
    },
  }, null, 2), 'utf8');
}

function request(base, method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request(new URL(urlPath, base), {
      method,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
      timeout: 15000,
    }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, json, raw });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function runHttpChecks() {
  const dataDir = path.join(TMP_DIR, 'gateway-data');
  writeAccount(dataDir, 'acc_alpha', ACCOUNT_A_KEY, 'Alpha');
  writeAccount(dataDir, 'acc_beta', ACCOUNT_B_KEY, 'Beta');

  const upstream = new MockUpstream({ quiet: true });
  await upstream.start();

  const port = 19600 + Math.floor(Math.random() * 300);
  const base = `http://127.0.0.1:${port}`;
  let logs = '';
  const gw = cp.fork(path.join(__dirname, '..', 'src', 'api-bridge.js'), [], {
    env: {
      ...process.env,
      PORT: String(port), BIND: '127.0.0.1',
      // 关键：不设 ADMIN_PASSWORD —— 默认部署形态，评审发现问题就出在这种形态
      API_KEYS: `${API_KEY}:effect-client`,
      UPSTREAM: 'direct',
      ROUTER_BASE_URL: upstream.url,
      GATEWAY_DATA_DIR: dataDir,
      AGENTIX_STATE_DIR: path.join(TMP_DIR, 'nonexistent-default-state'),
      STATE_PATH: path.join(dataDir, 'usage-state.json'),
      DUMP_DIR: path.join(dataDir, 'gw-logs'),
      QUIET: '1', LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  gw.stdout.on('data', (d) => { logs += d; });
  gw.stderr.on('data', (d) => { logs += d; });

  try {
    let ready = false;
    for (let i = 0; i < 80; i++) {
      try { if ((await request(base, 'GET', '/healthz')).status === 200) { ready = true; break; } } catch (_) {}
      await new Promise((r) => setTimeout(r, 150));
    }
    assert(ready, `网桥未能在预期时间内启动。日志:\n${logs.slice(-1500)}`);

    const auth = { Authorization: `Bearer ${API_KEY}` };

    // ---- B. /api/usage 零回归：调用凭据只能看自己 ----
    const usage = await request(base, 'GET', '/api/usage', null, auth);
    assert.strictEqual(usage.status, 200, usage.raw);
    assert.strictEqual(
      usage.json.real && usage.json.real.error, 'admin_only',
      `默认部署下调用凭据读 /api/usage 必须是 admin_only，实际 real=${JSON.stringify(usage.json.real)}`
    );
    assert.strictEqual(usage.json.byKey, undefined, '/api/usage 不得向调用凭据下发 byKey 全局聚合');
    assert.strictEqual(usage.json.byAccount, undefined, '/api/usage 不得向调用凭据下发 byAccount 账号明细');

    // ---- C. /api/dashboard 只回积分口径，不回 Router 账单与本地金额 ----
    const dash = await request(base, 'GET', '/api/dashboard', null, auth);
    assert.strictEqual(dash.status, 200, dash.raw);
    assert.strictEqual(
      dash.json.real, undefined,
      'ADR-0011 规定 Router 账单不再参与展示，/api/dashboard 不得再下发 real'
    );
    const local = dash.json.local || {};
    for (const key of ['spent', 'balance', 'remaining', 'cost_per_1k']) {
      assert.strictEqual(
        local[key], undefined,
        `ADR-0013 已删除本地单价，/api/dashboard 的 local 不得再下发 ${key}`
      );
    }
    assert.strictEqual(typeof local.tokens, 'object', 'local.tokens 必须保留（不受上游口径影响的客观数据）');
    assert.strictEqual(typeof local.requests, 'number', 'local.requests 必须保留');
    assert(Array.isArray(dash.json.models) && dash.json.models.length > 0, '仪表盘必须仍能列出模型（不依赖账单刷新）');
    assert(dash.json.credits, '仪表盘必须仍返回积分区块');

    // ---- D. 粘性开关：关闭后同一会话不再复用账号 ----
    const chat = async (sessionId) => {
      const before = upstream.recordedRequests.filter((r) => r.url.startsWith('/v1/chat/completions')).length;
      const res = await request(base, 'POST', '/v1/chat/completions', {
        model: 'deepseek-flash',
        messages: [{ role: 'user', content: 'ping' }],
        stream: false,
      }, { ...auth, 'x-session-id': sessionId });
      assert.strictEqual(res.status, 200, `chat 失败: ${res.status} ${res.raw.slice(0, 300)}`);
      const after = upstream.recordedRequests.filter((r) => r.url.startsWith('/v1/chat/completions'));
      const last = after.slice(before).pop();
      return String((last && last.headers && last.headers.authorization) || '').replace(/^Bearer\s+/, '');
    };

    const sticky1 = await chat('sess-sticky');
    const sticky2 = await chat('sess-sticky');
    assert.strictEqual(sticky1, sticky2, '默认开启粘性时，同一会话必须落在同一个上游账号');

    const off = await request(base, 'PUT', '/api/settings', { session_binding_enabled: false }, auth);
    assert.strictEqual(off.status, 200, off.raw);

    const loose1 = await chat('sess-loose');
    const loose2 = await chat('sess-loose');
    assert.notStrictEqual(
      loose1, loose2,
      '设置页关闭会话粘性后，同一会话必须重新轮询到另一个账号（当前仍读启动值，属假开关）'
    );

    console.log('  ✓ B/C/D HTTP 层：用量契约、仪表盘口径、粘性开关端到端生效');
  } finally {
    gw.kill('SIGTERM');
    await upstream.stop();
  }
}

async function run() {
  checkRouterHonoursLiveSettings();
  await runHttpChecks();
  console.log('✓ [All Passed] 设置项真实生效 + 用量/仪表盘口径契约');
}

run().catch((err) => {
  console.error('测试失败:', err.message);
  process.exit(1);
});
