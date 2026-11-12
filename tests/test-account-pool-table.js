'use strict';
/**
 * 账号池表格化（ADR-0016）：状态位、指标口径与页面接线。
 *
 * 口径对齐 workbuddy2api：
 *   - 成功 / 失败按「尝试」累计（换号前的失败记在原账号）；
 *   - 次数与 token 是累计值，延迟与 tok/s 取最近一次，失败/无 completion token 时为 null；
 *   - 「暂停选号」(paused) 与「禁用」(enabled=false) 是两个独立状态位。
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const TMP_DIR = path.join(os.tmpdir(), `aiwork-acct-table-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
fs.mkdirSync(TMP_DIR, { recursive: true });
process.on('exit', () => {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
});

const API_KEY = 'sk-table-client';
const ROUTER_KEY = 'sk-table-router';
const ADMIN_PASS = 'TablePass123!';

async function run() {
  let mode = 'ok'; // ok | fail

  const router = http.createServer((req, res) => {
    if (req.url.startsWith('/v1/chat/completions')) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (mode === 'fail') {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: 'boom', type: 'server_error' } }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-test', object: 'chat.completion', created: Date.now() / 1000 | 0,
          model: 'deepseek-flash',
          choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
        }));
      });
      return;
    }
    if (req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-flash', ratio: '0.2x' }] }));
    }
    if (req.url.startsWith('/v1/dashboard/billing')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ total_usage: 1, hard_limit_usd: 100 }));
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  await new Promise((r) => router.listen(0, '127.0.0.1', r));
  const routerUrl = `http://127.0.0.1:${router.address().port}`;

  const dataDir = path.join(TMP_DIR, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  // 用「动态账号」而不是只读挂载：动态账号才有积分、暂停/禁用与移除这些行内操作，
  // 也能覆盖 source 落盘后不被降级（曾经因为 save() 漏写 source 把动态号变成挂载号）。
  const accId = 'acc_table_test';
  const accDir = path.join(dataDir, 'accounts', accId);
  fs.mkdirSync(accDir, { recursive: true });
  fs.writeFileSync(path.join(accDir, '.env'), `AGENTIX_CONFIG_MODELS_AIWORK_ROUTER_API_KEY=${ROUTER_KEY}\n`);
  fs.writeFileSync(path.join(accDir, 'config.json'), JSON.stringify({
    config_protocol_version: '1.1',
    models: { 'aiwork-router': { models: [{ id: 'deepseek-flash', name: 'deepseek-flash' }] } },
  }, null, 2));
  fs.writeFileSync(path.join(accDir, 'auth.json'), JSON.stringify({
    name: '表格测试号', enabled: true, user_id: 'u-table-1',
  }, null, 2));

  const port = 21200 + Math.floor(Math.random() * 300);
  let logs = '';
  const gw = cp.fork(path.join(__dirname, '..', 'src', 'api-bridge.js'), [], {
    env: {
      ...process.env,
      PORT: String(port), BIND: '127.0.0.1',
      UPSTREAM: 'direct',
      ROUTER_BASE_URL: routerUrl,
      AGENTIX_STATE_DIR: path.join(TMP_DIR, 'no-state'),
      GATEWAY_DATA_DIR: dataDir,
      STATE_PATH: path.join(dataDir, 'usage-state.json'),
      API_KEYS: `${API_KEY}:table`,
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
        req.write(JSON.stringify(body));
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
    const auth = { Authorization: `Bearer ${API_KEY}` };

    // ---- 1. 新账号：指标是 0 / null，而不是缺字段 ----
    const list0 = await request('GET', '/api/admin/accounts', null, cookie);
    assert.strictEqual(list0.status, 200, list0.text);
    const acc0 = list0.json.accounts[0];
    assert(acc0, '应有一个账号');
    assert.strictEqual(acc0.source, 'dynamic', '动态账号不能被当成只读挂载（source 必须落盘并回读）');
    assert.strictEqual(acc0.name, '表格测试号', '应沿用 auth.json 里的展示名称');
    assert.strictEqual(acc0.paused, false, '默认不是暂停状态');
    assert(acc0.usage, '账号必须带 usage 指标块');
    assert.strictEqual(acc0.usage.success, 0);
    assert.strictEqual(acc0.usage.errors, 0);
    assert.strictEqual(acc0.usage.last_latency_ms, null, '没有请求时延迟为 null（界面显示 —）');
    assert.strictEqual(acc0.usage.last_tok_per_sec, null);

    // ---- 2. 成功一次：成功/次数/token 累计，延迟与 tok/s 有值 ----
    const chat1 = await request('POST', '/v1/chat/completions', {
      model: 'deepseek-flash', messages: [{ role: 'user', content: 'ping' }],
    }, auth);
    assert.strictEqual(chat1.status, 200, chat1.text);

    const list1 = await request('GET', '/api/admin/accounts', null, cookie);
    const u1 = list1.json.accounts[0].usage;
    assert.strictEqual(u1.success, 1, `成功计数应按尝试 +1，实际 ${u1.success}`);
    assert.strictEqual(u1.requests, 1);
    assert.strictEqual(u1.tokens, 52, `token 应累计 52，实际 ${u1.tokens}`);
    assert(u1.last_success_at > 0, '最近成功时间应被记录');
    assert(u1.last_latency_ms > 0, '最近延迟应被记录');
    assert(u1.last_tok_per_sec > 0, '最近吞吐应被记录（12 completion tokens / 延迟）');

    // ---- 3. 暂停选号：新会话不选它，已绑定会话继续用；与禁用是两个状态位 ----
    const sticky = { ...auth, 'x-session-id': 'sticky-pause-1' };
    const bound = await request('POST', '/v1/chat/completions', {
      model: 'deepseek-flash', messages: [{ role: 'user', content: 'bind me' }],
    }, sticky);
    assert.strictEqual(bound.status, 200, `首次请求应成功并建立绑定：${bound.text}`);

    const paused = await request('PATCH', `/api/admin/accounts/${acc0.id}`, { paused: true }, cookie);
    assert.strictEqual(paused.status, 200, paused.text);
    const list3 = await request('GET', '/api/admin/accounts', null, cookie);
    const acc3 = list3.json.accounts[0];
    assert.strictEqual(acc3.paused, true, '暂停状态应可读回');
    assert.strictEqual(acc3.enabled, true, '暂停不能把账号变成禁用');
    assert.strictEqual(acc3.ready, true, '暂停的账号仍然可用（已绑定会话继续）');

    const diskPaused = JSON.parse(fs.readFileSync(path.join(dataDir, 'accounts.json'), 'utf8'))
      .accounts.find((a) => a.id === acc0.id);
    assert.strictEqual(diskPaused.paused, true, '暂停状态必须立刻落盘，重启不能被复位');

    // 已绑定会话：仍然命中这个暂停账号
    const reused = await request('POST', '/v1/chat/completions', {
      model: 'deepseek-flash', messages: [{ role: 'user', content: 'same session' }],
    }, sticky);
    assert.strictEqual(reused.status, 200,
      `暂停选号只挡新会话，已绑定的会话必须继续命中，实际 ${reused.status} ${reused.text}`);

    // 新会话：不再选它（唯一账号 → 无可用账号）
    const afterPause = await request('POST', '/v1/chat/completions', {
      model: 'deepseek-flash', messages: [{ role: 'user', content: 'new session' }],
    }, { ...auth, 'x-session-id': 'fresh-after-pause' });
    assert([404, 503].includes(afterPause.status),
      `暂停后新会话不应再选到该账号，实际 ${afterPause.status} ${afterPause.text}`);

    // ---- 4. 恢复后：失败一次 → errors 累计，tok/s 清空（不留上次的旧速度） ----
    await request('PATCH', `/api/admin/accounts/${acc0.id}`, { paused: false }, cookie);
    mode = 'fail';
    const chat2 = await request('POST', '/v1/chat/completions', {
      model: 'deepseek-flash', messages: [{ role: 'user', content: 'ping' }],
    }, auth);
    assert([500, 502, 503].includes(chat2.status), `上游 500 应该失败，实际 ${chat2.status} ${chat2.text}`);

    const list2 = await request('GET', '/api/admin/accounts', null, cookie);
    const u2 = list2.json.accounts[0].usage;
    assert(u2.errors >= 1, `失败计数应累加，实际 ${u2.errors}`);
    assert.strictEqual(u2.success, 3, '失败不应计入成功（此前已有 3 次成功）');
    assert.strictEqual(u2.last_tok_per_sec, null, '失败后不得保留上一次的吞吐数字');

    const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'accounts.json'), 'utf8'));
    const diskRow = onDisk.accounts.find((a) => a.id === acc0.id);
    assert(diskRow, 'accounts.json 应包含该账号');
    // 恢复之后落盘也应是 false（状态跟着最新一次操作走）
    assert.strictEqual(diskRow.paused, false, '恢复后都要落盘，重启不能把暂停状态带回来');

    // ---- 6. 行内「刷新积分」是单账号端点，不是全局刷新 ----
    const one = await request('POST', `/api/admin/accounts/${acc0.id}/credits`, {}, cookie);
    assert.strictEqual(one.status, 200, one.text);
    assert(one.json && one.json.credits, '应回该账号的积分结果');
    assert.strictEqual(one.json.credits.account_id, acc0.id, '只处理目标账号');
    // 挂载账号不读上游积分，返回明确的 not_applicable 而不是假装成功
    assert.strictEqual(typeof one.json.credits.ok, 'boolean');
    assert.notStrictEqual(one.json.credits.error, 'not_applicable', '动态账号不应被当成挂载账号拒绝读积分');

    const credits404 = await request('POST', '/api/admin/accounts/key_nope/credits', {}, cookie);
    assert.strictEqual(credits404.status, 404, `未知账号应 404，实际 ${credits404.status}`);

    const credits405 = await request('GET', `/api/admin/accounts/${acc0.id}/credits`, null, cookie);
    assert.strictEqual(credits405.status, 405, '刷新积分只接受 POST');
    assert.strictEqual(credits405.headers.allow, 'POST');

    // ---- 7. 页面接线（无 DOM 测试环境，静态断言守接线）----
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
    assert(/VIEWS\s*=\s*\[[^\]]*'usage'/.test(html), '用量必须是独立视图');
    assert(/data-tab="usage"/.test(html), '导航里要有「用量」');
    assert(/data-view="usage"/.test(html), '用量视图容器必须存在');
    for (const label of ['成功 / 失败', '在途', '最近成功', '用量']) {
      assert(new RegExp(label).test(html), `表格应包含「${label}」列`);
    }
    assert(/暂停选号/.test(html), '操作区应有「暂停选号」');
    assert(/余额刷新/.test(html), '行内按钮应叫「余额刷新」');
    assert(/刷新全部积分/.test(html), '工具栏应有「刷新全部积分」');
    assert(/\/api\/admin\/accounts\/\$\{acc\.id\}\/credits/.test(html), '行内刷新应打单账号积分端点');
    assert(/清空全部冷却/.test(html), '工具栏应有「清空全部冷却」');
    assert(!/dashLocalTokens/.test(html), '仪表盘不再重复展示本机累计（已迁到用量视图）');

    console.log('✓ [All Passed] 账号池表格：指标口径 + 暂停/禁用双状态 + 用量独立视图');
  } finally {
    gw.kill('SIGTERM');
    router.close();
  }
}

run().catch((err) => {
  console.error('测试失败:', err.message);
  process.exit(1);
});
