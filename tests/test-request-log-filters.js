'use strict';
/**
 * 回归测试：请求日志筛选（工单 04）。
 *
 * 服务端 /api/logs 的筛选语义：
 *   1) account / model / q 为「包含匹配且大小写不敏感」；q 匹配路径、模型与错误摘要；
 *   2) outcome / status 为精确匹配；
 *   3) from / to 为闭区间，支持 unix 秒与 ISO 8601，两者都带边界那条记录；
 *   4) 多条件取交集；limit 在过滤之后生效，命中数 matched 不受 limit 影响；
 *   5) 非法时间 / 状态码 / 未知 outcome 返回 400 与可读说明，不产生 500；
 *   6) 无匹配时返回 200 且 entries 为空（页面显示空态文案，不是空白表格）；
 *   7) 未带凭据被网关拒绝的请求记 client_error（「请求被拒」），不该算成上游故障。
 *
 * 页面断言：筛选栏控件齐全、结果下拉含「请求被拒」、无匹配时渲染空态文案。
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const { MockUpstream } = require('./mock-upstream');

const TMP_DIR = path.join(os.tmpdir(), `aiwork-log-filters-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
fs.mkdirSync(TMP_DIR, { recursive: true });
process.on('exit', () => {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
});

const GW_PORT = 19700 + Math.floor(Math.random() * 300);
const KEY_A = 'sk-log-filter-acc-one-key';
const KEY_B = 'sk-log-filter-acc-two-key';
const ACC1_NAME = '账号甲';
const ACC2_NAME = '账号乙';
const MODEL_FLASH = 'deepseek-flash';
const MODEL_PRO = 'deepseek-pro';

function request(method, urlPath, { body = null, headers = {} } = {}) {
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

async function run() {
  const mock = new MockUpstream();
  const mockUrl = await mock.start(0);

  const configJson = JSON.stringify({
    config_protocol_version: '1.1',
    models: {
      'aiwork-router': {
        models: [
          { id: MODEL_FLASH, name: 'DeepSeek Flash' },
          { id: MODEL_PRO, name: 'DeepSeek Pro' },
        ],
      },
    },
  }, null, 2);

  const accountDirs = {};
  for (const [id, name] of [['acc-one', ACC1_NAME], ['acc-two', ACC2_NAME]]) {
    const dir = path.join(TMP_DIR, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.env'), `AGENTIX_CONFIG_MODELS_AIWORK_ROUTER_API_KEY=sk-${id}-upstream\n`);
    fs.writeFileSync(path.join(dir, 'config.json'), configJson);
    accountDirs[id] = { id, name, stateDir: dir };
  }

  const dataDir = path.join(TMP_DIR, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'api-keys.json'), JSON.stringify({
    version: 1,
    keys: [
      {
        id: 'key-filter-a', token: KEY_A, name: 'filter-a',
        account_policy: { mode: 'explicit', accounts: ['acc-one'] },
        created_at: new Date().toISOString(), revoked: false,
      },
      {
        id: 'key-filter-b', token: KEY_B, name: 'filter-b',
        account_policy: { mode: 'explicit', accounts: ['acc-two'] },
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
      UPSTREAM_ACCOUNTS: JSON.stringify(Object.values(accountDirs)),
      GATEWAY_DATA_DIR: dataDir,
      STATE_PATH: path.join(dataDir, 'usage-state.json'),
      AGENTIX_STATE_DIR: path.join(TMP_DIR, 'nonexistent-default-state'),
      QUIET: '1', LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let childLogs = '';
  gwProc.stdout.on('data', (d) => { childLogs += d; });
  gwProc.stderr.on('data', (d) => { childLogs += d; });

  const authA = { Authorization: `Bearer ${KEY_A}` };
  const authB = { Authorization: `Bearer ${KEY_B}` };

  async function getLogs(query = '') {
    const r = await request('GET', '/api/logs' + (query ? '?' + query : ''), { headers: authA });
    return r;
  }

  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { if ((await request('GET', '/healthz')).status === 200) { ready = true; break; } } catch (_) {}
    await new Promise((r) => setTimeout(r, 150));
  }
  assert(ready, `网桥未能在预期时间内启动。日志:\n${childLogs.slice(-1500)}`);

  try {
    // ---- 造 4 条记录：两个账号 × 两个模型，其中一条 400 上游错误 ----
    mock.clear();
    mock.queueResponse('/v1/chat/completions', okBody(MODEL_FLASH, 'a-flash-ok'));
    mock.queueResponse('/v1/chat/completions', okBody(MODEL_PRO, 'b-pro-ok'));
    mock.queueResponse('/v1/chat/completions', {
      status: 400,
      body: { error: { message: 'Invalid parameter temperature=999', type: 'invalid_request_error' } },
    });
    mock.queueResponse('/v1/chat/completions', okBody(MODEL_PRO, 'a-pro-ok'));

    const r1 = await request('POST', '/v1/chat/completions', {
      headers: authA,
      body: { model: MODEL_FLASH, messages: [{ role: 'user', content: 'one' }], stream: false },
    });
    assert.strictEqual(r1.status, 200, r1.text);
    const r2 = await request('POST', '/v1/chat/completions', {
      headers: authB,
      body: { model: MODEL_PRO, messages: [{ role: 'user', content: 'two' }], stream: false },
    });
    assert.strictEqual(r2.status, 200, r2.text);
    const r3 = await request('POST', '/v1/chat/completions', {
      headers: authB,
      body: { model: MODEL_FLASH, messages: [{ role: 'user', content: 'three' }], temperature: 999, stream: false },
    });
    assert.strictEqual(r3.status, 400, r3.text);
    const r4 = await request('POST', '/v1/chat/completions', {
      headers: authA,
      body: { model: MODEL_PRO, messages: [{ role: 'user', content: 'four' }], stream: false },
    });
    assert.strictEqual(r4.status, 200, r4.text);

    // 日志在响应 finish 后落盘，等 4 条都到齐。
    let all = [];
    for (let i = 0; i < 40; i++) {
      const r = await getLogs('limit=50');
      assert.strictEqual(r.status, 200, r.text);
      all = r.json.entries || [];
      if (all.length >= 4) break;
      await new Promise((res) => setTimeout(res, 50));
    }
    assert.strictEqual(all.length, 4, `应恰好有 4 条代理调用记录，实际 ${all.length}: ${JSON.stringify(all.map((e) => [e.account, e.model, e.outcome]))}`);

    const byAccount = (name) => all.filter((e) => e.account && e.account.name === name);
    const acc1 = byAccount(ACC1_NAME);
    const acc2 = byAccount(ACC2_NAME);
    assert.strictEqual(acc1.length, 2, '账号甲应有 2 条记录');
    assert.strictEqual(acc2.length, 2, '账号乙应有 2 条记录');

    const expectAccounts = (res, expected, hint) => {
      assert.strictEqual(res.status, 200, `${hint}: ${res.text.slice(0, 200)}`);
      assert.deepStrictEqual(
        res.json.entries.map((e) => e.t + '|' + e.path + '|' + e.status).sort(),
        expected.map((e) => e.t + '|' + e.path + '|' + e.status).sort(),
        `${hint}: 返回的记录不符合预期`,
      );
      assert.strictEqual(res.json.matched, expected.length, `${hint}: matched 应为 ${expected.length}`);
    };

    // ---- 1. 单条件筛选 ----
    const accFiltered = await getLogs('account=' + encodeURIComponent('账号甲'));
    expectAccounts(accFiltered, acc1, 'account=账号甲');
    assert(!accFiltered.json.entries.some((e) => e.account && e.account.name === ACC2_NAME), '账号筛选不应混入其他账号');

    // 短 id 与子串也能命中（包含匹配）
    const shortRef = acc1[0].account.short;
    const shortFiltered = await getLogs('account=' + shortRef);
    expectAccounts(shortFiltered, acc1, 'account=短 id');

    const modelFiltered = await getLogs('model=' + MODEL_PRO);
    expectAccounts(modelFiltered, all.filter((e) => e.model === MODEL_PRO), 'model=deepseek-pro');

    const outcomeFiltered = await getLogs('outcome=upstream_error');
    expectAccounts(outcomeFiltered, all.filter((e) => e.outcome === 'upstream_error'), 'outcome=upstream_error');

    const statusFiltered = await getLogs('status=400');
    expectAccounts(statusFiltered, all.filter((e) => Number(e.status) === 400), 'status=400');
    console.log('✓ 1 单条件：账号（含短 id）/模型/结果/状态各自生效');

    // ---- 2. 大小写不敏感（模型 + 关键字） ----
    const upperModel = await getLogs('model=' + MODEL_PRO.toUpperCase());
    expectAccounts(upperModel, all.filter((e) => e.model === MODEL_PRO), 'model 大写应命中');

    const upperQ = await getLogs('q=CHAT/COMPLETIONS');
    expectAccounts(upperQ, all, 'q 大写应命中全部路径');

    const keywordModel = await getLogs('q=DEEPSEEK-PRO');
    expectAccounts(keywordModel, all.filter((e) => e.model === MODEL_PRO), 'q 匹配模型名（大小写不敏感）');

    const keywordError = await getLogs('q=' + encodeURIComponent('INVALID PARAMETER'));
    expectAccounts(keywordError, all.filter((e) => e.outcome === 'upstream_error'), 'q 匹配错误摘要（大小写不敏感）');
    console.log('✓ 2 大小写不敏感：模型、路径、错误摘要');

    // ---- 3. 多条件取交集 ----
    const combo = await getLogs('account=' + encodeURIComponent('账号甲') + '&model=' + MODEL_PRO);
    expectAccounts(combo, acc1.filter((e) => e.model === MODEL_PRO), '账号甲 + 模型取交集');

    const combo2 = await getLogs('account=' + encodeURIComponent('账号乙') + '&outcome=upstream_error');
    expectAccounts(combo2, acc2.filter((e) => e.outcome === 'upstream_error'), '账号乙 + 结果取交集');

    const combo3 = await getLogs('q=chat&outcome=success&model=' + MODEL_FLASH);
    expectAccounts(
      combo3,
      all.filter((e) => e.outcome === 'success' && e.model === MODEL_FLASH),
      '三个条件取交集',
    );
    console.log('✓ 3 组合条件取交集');

    // ---- 4. 时间区间：闭区间，ISO 与 unix 秒都带边界那条 ----
    const boundary = all[all.length - 1]; // 最早的一条，便于保证 from 边界
    const boundaryMs = Date.parse(boundary.t);
    assert(Number.isFinite(boundaryMs), '记录时间戳必须可解析');

    const isoFrom = await getLogs('from=' + encodeURIComponent(boundary.t));
    assert.strictEqual(isoFrom.status, 200, isoFrom.text);
    assert(isoFrom.json.entries.some((e) => e.t === boundary.t), 'from 等于记录时间时应包含该记录（闭区间下界）');
    assert.strictEqual(isoFrom.json.matched, all.filter((e) => Date.parse(e.t) >= boundaryMs).length, 'from 边界命中数不符');

    const isoTo = await getLogs('to=' + encodeURIComponent(boundary.t));
    assert.strictEqual(isoTo.status, 200, isoTo.text);
    assert(isoTo.json.entries.some((e) => e.t === boundary.t), 'to 等于记录时间时应包含该记录（闭区间上界）');
    assert.strictEqual(isoTo.json.matched, all.filter((e) => Date.parse(e.t) <= boundaryMs).length, 'to 边界命中数不符');

    const unixSec = Math.floor(boundaryMs / 1000);
    const unixTo = await getLogs('to=' + unixSec);
    assert.strictEqual(unixTo.status, 200, unixTo.text);
    assert(unixTo.json.entries.some((e) => e.t === boundary.t), 'unix 秒作为 to 上界时应包含同一秒的记录');

    const exactRange = await getLogs('from=' + encodeURIComponent(boundary.t) + '&to=' + encodeURIComponent(boundary.t));
    assert.strictEqual(exactRange.status, 200, exactRange.text);
    assert.strictEqual(exactRange.json.matched, all.filter((e) => e.t === boundary.t).length, '起止相同时应恰好命中该时刻的记录');
    console.log('✓ 4 时间范围闭区间：ISO 与 unix 秒的边界记录都被包含');

    // ---- 5. limit 在过滤之后生效，matched 不受影响 ----
    const limited = await getLogs('model=' + MODEL_PRO + '&limit=1');
    assert.strictEqual(limited.status, 200, limited.text);
    assert.strictEqual(limited.json.entries.length, 1, 'limit=1 应只返回 1 条');
    assert.strictEqual(limited.json.matched, all.filter((e) => e.model === MODEL_PRO).length, 'matched 应反映过滤后的命中总数');
    assert.strictEqual(limited.json.capacity, 200, '容量上限不变');
    console.log('✓ 5 limit 作用于过滤之后，matched 为命中总数');

    // ---- 6. 非法参数：400 + 可读说明，不是 500 ----
    for (const [query, hint] of [
      ['from=not-a-date', '非法 from'],
      ['to=' + encodeURIComponent('2026-13-45'), '非法 to'],
      ['status=abc', '非法 status'],
      ['status=999', '越界 status'],
      ['outcome=bogus', '未知 outcome'],
      ['from=2026-01-02T00:00:00Z&to=2026-01-01T00:00:00Z', 'from 晚于 to'],
    ]) {
      const bad = await getLogs(query);
      assert.strictEqual(bad.status, 400, `${hint} 应返回 400，实际 ${bad.status}: ${bad.text.slice(0, 200)}`);
      assert(bad.json && bad.json.error && bad.json.error.message, `${hint} 应带可读错误说明`);
      assert(!/Internal Server Error/i.test(bad.text), `${hint} 不应产生 500`);
    }
    console.log('✓ 6 非法筛选值返回 400 与可读说明');

    // ---- 7. 空结果 ----
    const empty = await getLogs('account=' + encodeURIComponent('不存在的账号'));
    assert.strictEqual(empty.status, 200, empty.text);
    assert.deepStrictEqual(empty.json.entries, [], '无匹配时 entries 应为空数组');
    assert.strictEqual(empty.json.matched, 0, '无匹配时 matched 应为 0');
    assert.strictEqual(empty.json.total, 4, 'total 仍应是缓冲区里的记录数');
    console.log('✓ 7 空结果：200 + 空 entries + matched 0');

    // ---- 7b. 网关自己拒掉的请求记 client_error，不是上游错误 ----
    const noAuth = await request('POST', '/v1/chat/completions', {
      body: { model: MODEL_PRO, messages: [{ role: 'user', content: 'no auth' }], stream: false },
    });
    assert.strictEqual(noAuth.status, 401, `未带凭据应 401，实际 ${noAuth.status} ${noAuth.text}`);

    let rejected = null;
    for (let i = 0; i < 40; i++) {
      const r = await getLogs('outcome=client_error');
      assert.strictEqual(r.status, 200, r.text);
      if ((r.json.entries || []).length) { rejected = r.json.entries[0]; break; }
      await new Promise((res) => setTimeout(res, 50));
    }
    assert(rejected, '未带凭据的请求必须以 outcome=client_error 出现在日志里');
    assert.strictEqual(rejected.status, 401);
    assert.strictEqual(rejected.account, null, '从未选中账号，account 必须为空');
    assert.strictEqual(rejected.key, null, '没有凭据就没有凭据标识');
    assert.strictEqual(rejected.outcome, 'client_error', '网关侧拒绝不能记成上游故障');

    const stillUpstream = await getLogs('outcome=upstream_error');
    assert.strictEqual(stillUpstream.json.matched, 1, '上游错误只应剩最初那一条，不能被 client_error 混入');
    console.log('✓ 7b 未带凭据 → outcome=client_error、account 为空；上游错误计数不受影响');

    // ---- 8. 页面：筛选栏 + 空态文案 ----
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
    for (const id of ['logFilterAccount', 'logFilterModel', 'logFilterOutcome', 'logFilterQ', 'logFilterFrom', 'logFilterTo', 'btnLogClearFilters']) {
      assert(new RegExp(`id="${id}"`).test(html), `页面缺少筛选控件 #${id}`);
    }
    for (const v of ['success', 'upstream_error', 'stream_error', 'client_error', 'client_abort']) {
      assert(new RegExp(`<option[^>]*value="${v}"`).test(html), `结果下拉缺少 ${v} 选项`);
    }
    assert(/没有匹配/.test(html), '无匹配时应显示空态文案');
    assert(/清除条件/.test(html), '页面应提供「清除条件」按钮');
    console.log('✓ 8 日志页：筛选栏、结果选项（含「请求被拒」）、空态文案、清除条件齐全');

    console.log('\n✓ [All Passed] 请求日志筛选');
  } finally {
    gwProc.kill('SIGTERM');
    await mock.stop();
  }
}

run().catch((err) => {
  console.error('测试失败:', err.message);
  process.exit(1);
});
