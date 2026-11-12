'use strict';
/**
 * 三个面板互相跳转（Issue #09）：结构契约 + 真实接口接线。
 *
 * 页面没有 DOM 测试环境，静态断言守的是「结构契约」：
 *   1) 账号池「用量」单元格是可点入口（button + 链接样式 + 跳到用量并带账号过滤）；
 *   2) 用量页有「只看账号：xxx」过滤条与「清除过滤」按钮，查询串带 account；
 *   3) 「按账号」表每行可点，跳日志并复用日志筛选输入；
 *   4) 日志页能显示「按账号筛选」以说明当前条件；
 *   5) 无参数时默认行为不变（过滤条件默认为空，查询串不带 account）。
 *
 * 第二段真网关：两个账号各打一次请求，带 account 过滤时结果只含该账号，
 * 账号不存在时返回 0 行而不是报错；不带过滤时仍是全量（默认行为不变）。
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const { MockUpstream } = require('./mock-upstream');

const TMP_DIR = path.join(os.tmpdir(), `aiwork-cross-links-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
fs.mkdirSync(TMP_DIR, { recursive: true });
process.on('exit', () => {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
});

const GW_PORT = 20100 + Math.floor(Math.random() * 300);
const KEY_ONE = 'sk-cross-link-acc-one';
const KEY_TWO = 'sk-cross-link-acc-two';
const ACC1_ID = 'acc-one';
const ACC2_ID = 'acc-two';
const ACC1_NAME = '账号甲';
const ACC2_NAME = '账号乙';
const MODEL = 'deepseek-flash';

function request(method, urlPath, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: GW_PORT, path: urlPath, method,
      headers, timeout: 15000,
    }, (res) => {
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
      const s = typeof body === 'string' ? body : JSON.stringify(body);
      req.setHeader('Content-Type', 'application/json');
      req.setHeader('Content-Length', Buffer.byteLength(s));
      req.write(s);
    }
    req.end();
  });
}

function okBody(model, content) {
  return {
    status: 200,
    body: {
      id: 'chatcmpl-' + model,
      model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  };
}

function assertStructure() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');

  // ---- 1. 账号池「用量」单元格是可点入口 ----
  // 用原生 button 做入口：键盘 Enter/空格天然可达，不必自己处理 keydown。
  assert(/const usageLink = document\.createElement\('button'\)/.test(html),
    '账号池「用量」单元格要用 button 作为可点入口（键盘可达）');
  assert(/usageLink\.type = 'button'/.test(html), '入口按钮必须显式 type=button，避免默认提交行为');
  assert(/usageLink\.className = 'usage-link'/.test(html), '入口要有链接样式类 usage-link');
  assert(/usageLink\.dataset\.account/.test(html), '入口要带账号标识，便于排查与测试定位');
  assert(/openUsageForAccount\(acc\.id/.test(html), '点击入口应跳到用量视图并带上该账号');
  assert(/\.usage-link/.test(html), '链接外观需要样式（hover/聚焦都要有反馈）');
  assert(/usage-link[^{]*:hover|usage-link:hover/.test(html), 'hover 要有视觉反馈');
  assert(/usage-link[^{]*:focus|usage-link:focus/.test(html), '键盘聚焦要有视觉反馈');

  // ---- 2. 用量页的账号过滤条 ----
  assert(/id="usageAccountFilter"/.test(html), '用量页要有账号过滤条容器');
  assert(/只看账号/.test(html), '过滤条要写明「只看账号：xxx」');
  assert(/id="usageAccountFilterName"/.test(html), '过滤条要显示当前账号名');
  assert(/id="btnUsageClearAccount"/.test(html), '过滤条要有「清除过滤」按钮');
  assert(/清除过滤/.test(html), '「清除过滤」文案必须在页面上');
  assert(/function clearUsageAccountFilter\(/.test(html), '清除过滤要有独立实现，供按钮与跳转复用');
  assert(/set\('account'/.test(html), '带过滤查询时，用量查询串必须带 account 参数');
  assert(/if \(state\.usageAccount\)/.test(html), '没有过滤条件时不能往查询串里塞 account（默认行为不变）');

  // ---- 3. 「按账号」表每行可点，跳日志 ----
  assert(/openLogsForAccount\(/.test(html), '从用量跳日志要有一个统一入口函数');
  assert(/usage-account-link/.test(html), '「按账号」表的账号列要有可点标记');
  assert(/openLogsForAccount\(raw/.test(html), '点击「按账号」行要用该行的账号跳日志');
  assert(/logFilterAccount'\)\.value/.test(html), '跳日志必须复用票 04 的筛选输入（logFilterAccount）');
  assert(/switchTab\('logs'\)/.test(html), '跳转要用 switchTab 切到日志视图');

  // ---- 4. 日志页能看出当前是按账号筛选 ----
  assert(/按账号筛选/.test(html), '日志页要显示当前账号筛选条件');
  assert(/state\.usageAccount/.test(html), '用量页过滤条件要存在页面状态里');

  // ---- 5. 无参数打开时默认行为不变 ----
  assert(/usageAccount: ''/.test(html), '过滤条件默认必须是空（无参数打开 = 全量）');
  assert(/RANGE_HOURS[^\n]*'7d': 168/.test(html), '默认时间范围仍是近 7 天');
  assert(/openUsageForAccount[\s\S]{0,500}applyUsageRange\('7d'\)/.test(html),
    '从账号池跳过去时必须把时间范围固定为近 7 天');
}

async function run() {
  assertStructure();

  const mock = new MockUpstream();
  const mockUrl = await mock.start(0);

  const configJson = JSON.stringify({
    config_protocol_version: '1.1',
    models: { 'aiwork-router': { models: [{ id: MODEL, name: 'DeepSeek Flash' }] } },
  }, null, 2);

  const accounts = [];
  for (const [id, name] of [[ACC1_ID, ACC1_NAME], [ACC2_ID, ACC2_NAME]]) {
    const dir = path.join(TMP_DIR, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.env'), `AGENTIX_CONFIG_MODELS_AIWORK_ROUTER_API_KEY=sk-${id}-upstream\n`);
    fs.writeFileSync(path.join(dir, 'config.json'), configJson);
    accounts.push({ id, name, stateDir: dir });
  }

  const dataDir = path.join(TMP_DIR, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'api-keys.json'), JSON.stringify({
    version: 1,
    keys: [
      {
        id: 'key-cross-a', token: KEY_ONE, name: 'cross-a',
        account_policy: { mode: 'explicit', accounts: [ACC1_ID] },
        created_at: new Date().toISOString(), revoked: false,
      },
      {
        id: 'key-cross-b', token: KEY_TWO, name: 'cross-b',
        account_policy: { mode: 'explicit', accounts: [ACC2_ID] },
        created_at: new Date().toISOString(), revoked: false,
      },
    ],
  }, null, 2));

  const gwProc = cp.fork(path.join(__dirname, '..', 'src', 'api-bridge.js'), [], {
    env: {
      ...process.env,
      PORT: String(GW_PORT), BIND: '127.0.0.1',
      UPSTREAM: 'direct',
      UPSTREAM_FALLBACK: '0',
      ROUTER_BASE_URL: mockUrl,
      UPSTREAM_ACCOUNTS: JSON.stringify(accounts),
      GATEWAY_DATA_DIR: dataDir,
      STATE_PATH: path.join(dataDir, 'usage-state.json'),
      USAGE_BUCKETS_PATH: path.join(dataDir, 'usage-buckets.json'),
      USAGE_BUCKETS_DEBOUNCE_MS: '30',
      AGENTIX_STATE_DIR: path.join(TMP_DIR, 'nonexistent-default-state'),
      QUIET: '1', LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let childLogs = '';
  gwProc.stdout.on('data', (d) => { childLogs += d; });
  gwProc.stderr.on('data', (d) => { childLogs += d; });

  let ready = false;
  for (let i = 0; i < 80; i++) {
    try { if ((await request('GET', '/healthz')).status === 200) { ready = true; break; } } catch (_) {}
    await new Promise((r) => setTimeout(r, 150));
  }
  assert(ready, `网桥未能在预期时间内启动。日志:\n${childLogs.slice(-1500)}`);

  const adminHeaders = (key) => ({ Authorization: `Bearer ${key}` });

  try {
    // ---- 造数据：账号甲一次，账号乙一次 ----
    mock.clear();
    mock.queueResponse('/v1/chat/completions', okBody(MODEL, 'from-acc-one'));
    mock.queueResponse('/v1/chat/completions', okBody(MODEL, 'from-acc-two'));

    const r1 = await request('POST', '/v1/chat/completions', {
      model: MODEL, messages: [{ role: 'user', content: 'one' }], stream: false,
    }, adminHeaders(KEY_ONE));
    assert.strictEqual(r1.status, 200, r1.text);
    const r2 = await request('POST', '/v1/chat/completions', {
      model: MODEL, messages: [{ role: 'user', content: 'two' }], stream: false,
    }, adminHeaders(KEY_TWO));
    assert.strictEqual(r2.status, 200, r2.text);
    await new Promise((r) => setTimeout(r, 400));

    const reader = adminHeaders(KEY_ONE);

    // ---- 1. 不带 account：默认全量（与改造前一致） ----
    const all = await request('GET', '/api/usage/buckets?hours=168&granularity=day', null, reader);
    assert.strictEqual(all.status, 200, all.text);
    assert.strictEqual(all.json.requests, 2, '不带过滤时应统计两个账号');
    assert.strictEqual(all.json.by_account.length, 2, '不带过滤时按账号应有两行');

    // ---- 2. 带 account：只统计该账号 ----
    for (const [id, other] of [[ACC1_ID, ACC2_ID], [ACC2_ID, ACC1_ID]]) {
      const one = await request(
        'GET', `/api/usage/buckets?hours=168&granularity=day&account=${encodeURIComponent(id)}`, null, reader,
      );
      assert.strictEqual(one.status, 200, `account=${id} 应正常返回：${one.text}`);
      assert.strictEqual(one.json.requests, 1, `account=${id} 只应统计该账号的 1 次请求`);
      assert.strictEqual(one.json.total_tokens, 15, 'token 应与该账号那次请求一致');
      assert.strictEqual(one.json.by_account.length, 1, '按账号表只应剩一行');
      assert.strictEqual(one.json.by_account[0].account, id, `by_account 应只含 ${id}`);
      assert(!one.json.by_account.some((row) => row.account === other), '不应混入其他账号');
      const sum = (rows, f) => rows.reduce((a, r) => a + r[f], 0);
      assert.strictEqual(sum(one.json.series, 'requests'), 1, '趋势合计也要只含该账号');
      assert.strictEqual(sum(one.json.by_model, 'requests'), 1, '按模型分组同样只含该账号');
    }

    // ---- 3. 账号已删除 / 改名：返回 0 行，不报错 ----
    const missing = await request(
      'GET', '/api/usage/buckets?hours=168&granularity=day&account=acc-does-not-exist', null, reader,
    );
    assert.strictEqual(missing.status, 200, '不存在的账号应返回 200 空结果，而不是 4xx/5xx');
    assert.strictEqual(missing.json.ok, true);
    assert.strictEqual(missing.json.requests, 0, '不存在的账号应统计为 0');
    assert.deepStrictEqual(missing.json.by_account, [], '不存在的账号不应产生分组行');

    // ---- 4. 跳日志的落点：按账号名筛选，条数正确 ----
    for (const [name, otherName] of [[ACC1_NAME, ACC2_NAME], [ACC2_NAME, ACC1_NAME]]) {
      const logs = await request('GET', '/api/logs?limit=50&account=' + encodeURIComponent(name), null, reader);
      assert.strictEqual(logs.status, 200, logs.text);
      assert.strictEqual(logs.json.entries.length, 1, `按「${name}」筛选应恰好一条`);
      assert.strictEqual(logs.json.entries[0].account.name, name);
      assert(!logs.json.entries.some((e) => e.account && e.account.name === otherName), '日志不应混入其他账号');
    }

    // ---- 5. 鉴权不变 ----
    const anon = await request('GET', `/api/usage/buckets?hours=168&account=${ACC1_ID}`);
    assert([401, 403].includes(anon.status), '带 account 也必须鉴权');
  } finally {
    await new Promise((resolve) => { gwProc.once('exit', resolve); gwProc.kill('SIGTERM'); });
    await mock.stop();
  }

  console.log('✓ [All Passed] 面板互跳：账号池→用量→日志，过滤/清除/空态 + 真网关 account 过滤');
}

run().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
