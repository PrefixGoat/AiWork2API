'use strict';
/**
 * 回归测试：管理权限随调用凭据授予（ADR-0012）。
 *
 * 三种部署形态必须分别成立：
 *   A) 未配置管理口令 + 配置了调用凭据 → 有效调用凭据即可管理；无凭据 401；错误 key 401
 *   B) 未配置管理口令 + 没有任何调用凭据（本机裸跑）→ 管理接口直接可用
 *   C) 显式配置了管理口令 → 调用凭据不能顶替口令（403），必须登录
 *
 * 这条边界取代 ADR-0002 的「管理凭据必须独立」；C 组保证旧行为仍可一键恢复。
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const TMP_ROOT = path.join(os.tmpdir(), `aiwork-admin-perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
fs.mkdirSync(TMP_ROOT, { recursive: true });
process.on('exit', () => {
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch (_) {}
});

const API_KEY = 'sk-admin-perm-client';
const ADMIN_PASS = 'TestAdminPermPass123!';

function requestFactory(port) {
  return function request(method, urlPath, body = null, headers = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request(new URL(urlPath, `http://127.0.0.1:${port}`), { method, headers, timeout: 10000 }, (res) => {
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
  };
}

async function startGateway(name, extraEnv, seed) {
  const dataDir = path.join(TMP_ROOT, name);
  fs.mkdirSync(dataDir, { recursive: true });
  // 每个用例独立的统计文件：默认 STATE_PATH 指向源码目录，多个用例会互相改写同一份。
  if (typeof seed === 'function') seed(dataDir);
  const port = 19700 + Math.floor(Math.random() * 400);
  let logs = '';
  const proc = cp.fork(path.join(__dirname, '..', 'src', 'api-bridge.js'), [], {
    env: {
      ...process.env,
      PORT: String(port), BIND: '127.0.0.1',
      GATEWAY_DATA_DIR: dataDir,
      STATE_PATH: path.join(dataDir, 'usage-state.json'),
      AGENTIX_STATE_DIR: path.join(TMP_ROOT, `nonexistent-${name}`),
      QUIET: '1', LOG_LEVEL: 'error',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  proc.stdout.on('data', (d) => { logs += d; });
  proc.stderr.on('data', (d) => { logs += d; });

  const request = requestFactory(port);
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { if ((await request('GET', '/healthz')).status === 200) { ready = true; break; } } catch (_) {}
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!ready) {
    proc.kill('SIGTERM');
    throw new Error(`[${name}] 网关未能启动。日志:\n${logs.slice(-1200)}`);
  }
  return { proc, request };
}

async function run() {
  // ---- A) 无口令 + 有凭据：key 即管理 ----
  {
    // 预置非零统计：否则「重置后归零」断言在空实现下也成立（评审点：恒真断言）。
    // byKey / byAccount / sessions 也必须非零——个人视图曾经用 `||` 回落到未清零的 byKey，
    // 只 seed tokens 的话这条真实路径会被整条绕开（第三轮评审复现出来的假绿）。
    const seed = (dataDir) => {
      fs.writeFileSync(path.join(dataDir, 'usage-state.json'), JSON.stringify({
        costPer1k: 0.02,
        balance: 100,
        spent: 3.5,
        tokens: { input: 600, output: 300, total: 900, cached: 50 },
        requests: 5,
        byModel: { 'seed-model': { tokens: 900, requests: 5 } },
        byKey: {
          key_seeded: { tokens: 900, requests: 5, cached: 10, spent: 3.5, keyId: 'key_seeded', keyName: 'test' },
        },
        byAccount: { acc_seeded: { tokens: 900, requests: 5, cached: 10, spent: 3.5 } },
        sessions: {
          sess_seeded: {
            id: 'sess_seeded', keyId: 'key_seeded', key: 'test', model: 'seed-model',
            tokens: 900, requests: 5, input: 600, output: 300, firstAt: 1, lastAt: 2,
          },
        },
      }, null, 2));
      // 凭据的累计用量也要非零：个人视图优先读 key.stats，只清 STATE 时页面不会变。
      fs.writeFileSync(path.join(dataDir, 'api-keys.json'), JSON.stringify({
        version: 1,
        keys: [{
          id: 'key_seeded', name: 'test', token: API_KEY, revoked: false,
          account_policy: { mode: 'all', accounts: [] },
          stats: { requests: 5, tokens: 900, cached: 10, spent: 3.5, last_used_at: null },
        }],
      }, null, 2));
    };
    const { proc, request } = await startGateway('key-mode', {
      API_KEYS: `${API_KEY}:test`,
      ADMIN_PASSWORD: '',
    }, seed);
    try {
      const anon = await request('GET', '/api/admin/accounts');
      assert.strictEqual(anon.status, 401, `无凭据必须 401，实际 ${anon.status}`);

      const badKey = await request('GET', '/api/admin/accounts', null, { Authorization: 'Bearer sk-wrong' });
      assert.strictEqual(badKey.status, 401, `错误 key 必须 401，实际 ${badKey.status}`);

      const withKey = await request('GET', '/api/admin/accounts', null, { Authorization: `Bearer ${API_KEY}` });
      assert.strictEqual(withKey.status, 200, `未配置口令时调用凭据应可管理，实际 ${withKey.status} ${withKey.text}`);

      const write = await request('PUT', '/api/settings', {
        outbound_user_agent: 'perm-test/1.0',
      }, { Authorization: `Bearer ${API_KEY}` });
      assert.strictEqual(write.status, 200, `调用凭据应可写设置，实际 ${write.status} ${write.text}`);

      const keys = await request('GET', '/api/keys', null, { Authorization: `Bearer ${API_KEY}` });
      assert.strictEqual(keys.status, 200, `调用凭据应可读凭据列表，实际 ${keys.status}`);

      // ADR-0015 §5：重置本地统计走专用端点，旧 /api/balance 契约保持可用。
      // 先证明「重置前确实非零」，否则空实现也能让下面的归零断言通过。
      const auth = { Authorization: `Bearer ${API_KEY}` };
      const before = await request('GET', '/api/dashboard', null, auth);
      assert.strictEqual(before.status, 200, before.text);
      assert.strictEqual(before.json.local.tokens.total, 900, `重置前应有 900 token，实际 ${JSON.stringify(before.json.local)}`);

      const usageBefore = await request('GET', '/api/usage', null, auth);
      assert.strictEqual(usageBefore.json.tokens.total, 900, '个人视图应读到凭据累计 900 token');
      assert.strictEqual(usageBefore.json.byModel['seed-model'] && usageBefore.json.byModel['seed-model'].tokens, 900,
        '个人视图的按模型聚合应先读到种子数据');

      const reset = await request('POST', '/api/local-stats/reset', { reset: true }, auth);
      assert.strictEqual(reset.status, 200, `调用凭据应可重置本机统计，实际 ${reset.status} ${reset.text}`);
      assert.strictEqual(reset.json.ok, true);
      assert.strictEqual(reset.json.usage.tokens.total, 0, '重置后本机 token 统计应归零');
      assert.strictEqual(reset.json.usage.requests, 0, '重置后本机请求数应归零');
      // 响应只回本机计数，不能顺带下发 byKey / byAccount / sessions（ADR-0014 §3 的权限口径）。
      assert.strictEqual(reset.json.usage.byKey, undefined, '重置响应不得携带 byKey');
      assert.strictEqual(reset.json.usage.sessions, undefined, '重置响应不得携带 sessions');

      const after = await request('GET', '/api/dashboard', null, auth);
      assert.strictEqual(after.json.local.tokens.total, 0, '重置必须落盘：仪表盘读到的本机统计应为 0');
      const usageAfter = await request('GET', '/api/usage', null, auth);
      assert.strictEqual(usageAfter.json.tokens.total, 0, '凭据累计用量必须一起清零，否则页面上的「重置」看起来没生效');
      assert.strictEqual(usageAfter.json.tokens.input, 0, '输入侧也必须归零（否则会出现「合计 0、输入 600」）');
      assert.strictEqual(usageAfter.json.tokens.output, 0, '输出侧也必须归零');
      assert.deepStrictEqual(usageAfter.json.byModel, {}, '按模型聚合必须归零');
      assert.deepStrictEqual(usageAfter.json.sessions, [], '最近会话统计必须清空');
      const keysAfter = await request('GET', '/api/keys', null, auth);
      assert.strictEqual(keysAfter.json.data[0].tokens, 0, '/api/keys 的凭据累计也应归零');

      const getReset = await request('GET', '/api/local-stats/reset', null, auth);
      assert.strictEqual(getReset.status, 405, `重置端点只接受 POST，实际 ${getReset.status}`);
      assert.strictEqual(getReset.headers.allow, 'POST', '405 必须带 Allow 头');

      const legacy = await request('GET', '/api/balance', null, auth);
      assert.strictEqual(legacy.status, 200, `/api/balance 旧契约必须保持可用，实际 ${legacy.status}`);

      // ADR-0014 §5：{ sessions: {...} } 包裹层不再被接受，且不能静默 200。
      const nested = await request('PUT', '/api/settings', { sessions: { max_concurrency_per_account: 3 } }, auth);
      assert.strictEqual(nested.status, 400, `嵌套包裹层应被拒绝，实际 ${nested.status} ${nested.text}`);
      const partial = await request('PUT', '/api/settings', {
        max_concurrency_per_account: 7,
        unknown_future_key: true,
      }, auth);
      assert.strictEqual(partial.status, 200, partial.text);
      assert.deepStrictEqual(partial.json.ignored, ['unknown_future_key'], '未知键应回报而不是静默丢弃');
    } finally {
      proc.kill('SIGTERM');
    }
  }

  // ---- B) 无口令 + 无凭据：本机裸跑直接可用 ----
  {
    const { proc, request } = await startGateway('open-mode', {
      API_KEYS: '',
      API_TOKEN: '',
      ADMIN_PASSWORD: '',
    });
    try {
      const anon = await request('GET', '/api/admin/accounts');
      assert.strictEqual(anon.status, 200, `未配置任何凭据时管理接口应放行，实际 ${anon.status} ${anon.text}`);
      const status = await request('GET', '/status');
      assert.strictEqual(status.json.auth_required, false, 'AUTH_ON 应为 false');
    } finally {
      proc.kill('SIGTERM');
    }
  }

  // ---- C) 显式口令：调用凭据不能顶替 ----
  {
    const { proc, request } = await startGateway('password-mode', {
      API_KEYS: `${API_KEY}:test`,
      ADMIN_PASSWORD: ADMIN_PASS,
    });
    try {
      const withKey = await request('GET', '/api/admin/accounts', null, { Authorization: `Bearer ${API_KEY}` });
      assert.strictEqual(withKey.status, 403, `配置口令后调用凭据必须 403，实际 ${withKey.status}`);

      const anon = await request('GET', '/api/admin/accounts');
      assert.strictEqual(anon.status, 401, `配置口令后无凭据必须 401，实际 ${anon.status}`);

      const login = await request('POST', '/api/admin/login', { password: ADMIN_PASS });
      assert.strictEqual(login.status, 200, login.text);
      const cookie = login.headers['set-cookie'][0].split(';')[0];
      const viaSession = await request('GET', '/api/admin/accounts', null, { Cookie: cookie });
      assert.strictEqual(viaSession.status, 200, `口令登录后应可管理，实际 ${viaSession.status}`);

      // 重置是本机写操作：口令模式下不能靠调用凭据绕过（ADR-0015 §5 沿用了这条边界）
      const resetByKey = await request('POST', '/api/local-stats/reset', { reset: true },
        { Authorization: `Bearer ${API_KEY}` });
      assert.strictEqual(resetByKey.status, 403, `配置口令后调用凭据不得重置统计，实际 ${resetByKey.status}`);
      const resetBySession = await request('POST', '/api/local-stats/reset', { reset: true }, { Cookie: cookie });
      assert.strictEqual(resetBySession.status, 200, `口令会话应可重置统计，实际 ${resetBySession.status}`);
    } finally {
      proc.kill('SIGTERM');
    }
  }

  // ---- D) 页面不再调用 /api/balance（ADR-0013 §5 / ADR-0015 §5）----
  // 这是「代码与 ADR 是否一致」的硬断言：只看真实调用点。
  // 必须先把注释剥掉，否则把 fetch 注释掉仍然绿——这正是本项目踩过两次的假绿（ADR-0014 §8）。
  {
    const raw = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
    const code = stripJsComments(raw);
    assert(!/fetch\(\s*['"]\/api\/balance/.test(code), '页面不得再调用 /api/balance，重置本地统计应走 /api/local-stats/reset');
    assert(/fetch\(\s*['"]\/api\/local-stats\/reset/.test(code), '页面应调用 /api/local-stats/reset');
  }

  console.log('✓ [All Passed] 管理权限：key 即管理（无口令）/ 裸跑放行 / 口令模式仍隔离');
}

/**
 * 剥掉 JS 注释，只留可执行代码。
 * 不追求完整的词法分析：块注释整体删除，行注释只删除「行首或空白后是 //」的情况，
 * 这样字符串里的 'https://...' 不会被误伤，而 `// fetch(...)` 这种注释掉的行会被删掉。
 */
function stripJsComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n');
}

run().catch((err) => {
  console.error('测试失败:', err.message);
  process.exit(1);
});
