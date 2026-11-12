'use strict';
/**
 * 回归测试：未挂载的默认状态目录不应制造占位账号。
 *
 * 背景（ADR-0006 双源账号共存）：
 *   docker-compose.yml 声明 AGENTIX_STATE_DIR=/accounts/default，但没有把宿主目录
 *   挂进去。AccountPool.load() 旧实现无条件创建 id=default 的挂载账号，于是它永远
 *   是 credentials_missing，管理面板多出一个无法恢复的幽灵账号，报错也指向不存在的路径。
 *
 * 行为规格（两个已确认的公共 seam）：
 *   1) 模块 seam  AccountPool.listAccounts() / getReadyAccounts()
 *   2) HTTP seam  GET /api/admin/accounts 与 GET /status
 *
 * 判定口径：仅「目录不存在」时跳过；目录存在但暂无凭据时仍创建，保留运行时
 * 写入 .env 后热重载纳管的能力（tests/test-gateway-boundary.js 依赖该行为）。
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const { AccountPool } = require('../src/account-pool');

const TMP = path.join(os.tmpdir(), `aiwork-default-account-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
fs.mkdirSync(TMP, { recursive: true });
process.on('exit', () => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

const ROUTER_KEY = 'sk-unit-test-router-key';

function writeAccountState(dir, models = ['deepseek-flash']) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.env'),
    `AGENTIX_CONFIG_MODELS_AIWORK_ROUTER_API_KEY=${ROUTER_KEY}\n`);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    models: { 'aiwork-router': { models: models.map((id) => ({ id, name: id })) } },
  }));
}

function idsOf(pool) {
  return pool.listAccounts().map((a) => a.id).sort();
}

function testAccountPoolSeam() {
  console.log('--- 模块 seam: AccountPool 默认账号创建规则 ---');

  // 1) 目录不存在：完全不该产生账号
  const missing = path.join(TMP, 'not-mounted');
  const dataA = path.join(TMP, 'data-a');
  const poolA = new AccountPool({ dataDir: dataA, defaultStateDir: missing, upstreamAccounts: '' });
  assert.deepStrictEqual(idsOf(poolA), [],
    '未挂载的状态目录不应生成 credentials_missing 的占位账号');
  assert.strictEqual(poolA.getAccount('default'), null);
  assert.strictEqual(poolA.getReadyAccounts().length, 0);

  // 2) 目录存在且有凭据：仍按原有行为创建 ready 的 default 账号
  const mounted = path.join(TMP, 'mounted');
  writeAccountState(mounted);
  const dataB = path.join(TMP, 'data-b');
  const poolB = new AccountPool({ dataDir: dataB, defaultStateDir: mounted, upstreamAccounts: '' });
  assert.deepStrictEqual(idsOf(poolB), ['default'], '真实挂载目录必须继续创建 default 账号');
  assert.strictEqual(poolB.getAccount('default').status, 'ready');
  assert.strictEqual(poolB.getReadyAccounts().length, 1);

  // 3) 目录不存在但有动态账号：只纳管动态账号，不再掺入幽灵 default
  const dataC = path.join(TMP, 'data-c');
  writeAccountState(path.join(dataC, 'accounts', 'acc_dynamic'));
  const poolC = new AccountPool({ dataDir: dataC, defaultStateDir: missing, upstreamAccounts: '' });
  assert.deepStrictEqual(idsOf(poolC), ['acc_dynamic'],
    '动态账号必须与未挂载的默认目录解耦');
  assert.strictEqual(poolC.getAccount('default'), null);
  assert.strictEqual(poolC.getAccount('acc_dynamic').source, 'dynamic');

  console.log('✓ 模块 seam 断言通过');
}

function request(base, method, urlPath, body = null, headers = {}) {
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

async function testHttpSeam() {
  console.log('--- HTTP seam: 管理面板账号列表与 /status ---');

  const dataDir = path.join(TMP, 'http-data');
  writeAccountState(path.join(dataDir, 'accounts', 'acc_web_login'));
  const missing = path.join(TMP, 'http-not-mounted');
  const port = 19100 + Math.floor(Math.random() * 400);
  const adminPassword = 'TestDefaultAccountPass123!';

  const gw = cp.fork(path.join(__dirname, '..', 'src', 'api-bridge.js'), [], {
    env: {
      ...process.env,
      PORT: String(port), BIND: '127.0.0.1',
      ADMIN_PASSWORD: adminPassword,
      API_KEYS: 'sk-default-account-test:test',
      GATEWAY_DATA_DIR: dataDir,
      STATE_PATH: path.join(dataDir, 'usage-state.json'),
      AGENTIX_STATE_DIR: missing,
      UPSTREAM_ACCOUNTS: '',
      QUIET: '1', LOG_LEVEL: 'error',
    },
    stdio: 'ignore',
  });

  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try { if ((await request(base, 'GET', '/healthz')).status === 200) { ready = true; break; } } catch (_) {}
    await new Promise((r) => setTimeout(r, 150));
  }
  assert(ready, '网关子进程未能在预期时间内启动');

  try {
    const login = await request(base, 'POST', '/api/admin/login', { password: adminPassword });
    assert.strictEqual(login.status, 200);
    const adminHeaders = { Cookie: login.headers['set-cookie'][0].split(';')[0] };

    const listed = await request(base, 'GET', '/api/admin/accounts', null, adminHeaders);
    assert.strictEqual(listed.status, 200);
    const ids = (listed.json.accounts || []).map((a) => a.id).sort();
    assert.deepStrictEqual(ids, ['acc_web_login'],
      `管理面板不应出现无法恢复的 default 占位账号，实际: ${ids.join(', ')}`);

    const status = await request(base, 'GET', '/status');
    assert.strictEqual(status.json.accounts_total, 1,
      `账号总数应为 1（只有动态账号），实际 ${status.json.accounts_total}`);
    assert.strictEqual(status.json.accounts_available, 1);
    assert.strictEqual(status.json.ready, true, '动态账号应正常就绪');

    console.log('✓ HTTP seam 断言通过');
  } finally {
    gw.kill('SIGTERM');
  }
}

async function run() {
  testAccountPoolSeam();
  await testHttpSeam();
  console.log('✓ [All Passed] 未挂载默认状态目录不再生成占位账号');
}

run().catch((err) => {
  console.error('测试失败:', err.message);
  process.exit(1);
});
