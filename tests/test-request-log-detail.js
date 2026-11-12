'use strict';
/**
 * 回归测试：请求日志的「账号 / 模型 / 结果 / token / 换号次数」明细（工单 03）。
 *
 * 断言：
 *   1) 单账号成功：账号（可读名 + 短 id）、模型、结果=success、token 全部正确，换号 0 次；
 *   2) 换号后成功：账号是最终服务这次请求的那个，换号次数 >= 1，token 取自最终那一次；
 *   3) 上游报错：结果=upstream_error 且带错误摘要（<=200 字），日志里不出现 Authorization、
 *      请求体、响应正文；
 *   4) 流中断：结果=stream_error；
 *   5) 日志页表格有账号/模型/结果/token/耗时列，容器可横向滚动；
 *   6) 仍然只收 /v1 调用。
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const { MockUpstream } = require('./mock-upstream');

const TMP_DIR = path.join(os.tmpdir(), `aiwork-log-detail-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
fs.mkdirSync(TMP_DIR, { recursive: true });
process.on('exit', () => {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
});

const GW_PORT = 19400 + Math.floor(Math.random() * 300);
const INV_KEY = 'sk-log-detail-invocation-key';
const ACC1_KEY = 'sk-log-detail-acc1-key';
const ACC2_KEY = 'sk-log-detail-acc2-key';
const ACC1_NAME = '账号甲';
const ACC2_NAME = '账号乙';
const PROMPT_MARKER = 'PROMPT_MARKER_SHOULD_NOT_BE_LOGGED';

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

async function run() {
  const mock = new MockUpstream();
  const mockUrl = await mock.start(0);

  const acc1Dir = path.join(TMP_DIR, 'acc1');
  const acc2Dir = path.join(TMP_DIR, 'acc2');
  const configJson = JSON.stringify({
    config_protocol_version: '1.1',
    models: {
      'aiwork-router': {
        models: [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }],
      },
    },
  }, null, 2);
  for (const [dir, key] of [[acc1Dir, ACC1_KEY], [acc2Dir, ACC2_KEY]]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.env'), `AGENTIX_CONFIG_MODELS_AIWORK_ROUTER_API_KEY=${key}\n`);
    fs.writeFileSync(path.join(dir, 'config.json'), configJson);
  }

  const dataDir = path.join(TMP_DIR, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'api-keys.json'), JSON.stringify({
    version: 1,
    keys: [{
      id: 'key-log-detail-id',
      token: INV_KEY,
      name: 'log-detail-key',
      accountPolicy: { mode: 'all', allowedAccounts: [] },
      createdAt: Date.now(),
      revoked: false,
    }],
  }, null, 2));

  const gwProc = cp.fork(path.join(__dirname, '..', 'src', 'api-bridge.js'), [], {
    env: {
      ...process.env,
      PORT: String(GW_PORT), BIND: '127.0.0.1',
      UPSTREAM: 'direct',
      UPSTREAM_FALLBACK: '0',
      ROUTER_BASE_URL: mockUrl,
      UPSTREAM_ACCOUNTS: JSON.stringify([
        { id: 'acc-one', name: ACC1_NAME, stateDir: acc1Dir },
        { id: 'acc-two', name: ACC2_NAME, stateDir: acc2Dir },
      ]),
      GATEWAY_DATA_DIR: dataDir,
      STATE_PATH: path.join(dataDir, 'usage-state.json'),
      AGENTIX_STATE_DIR: path.join(TMP_DIR, 'nonexistent-default-state'),
      MAX_ACCOUNT_ATTEMPTS: '2',
      QUIET: '1', LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let childLogs = '';
  gwProc.stdout.on('data', (d) => { childLogs += d; });
  gwProc.stderr.on('data', (d) => { childLogs += d; });

  const auth = { Authorization: `Bearer ${INV_KEY}` };

  async function logsRaw(limit = 10) {
    const r = await request('GET', `/api/logs?limit=${limit}`, null, auth);
    assert.strictEqual(r.status, 200, `读取日志失败: ${r.status} ${r.text.slice(0, 200)}`);
    return r;
  }

  // 日志在响应 finish 时落盘，客户端拿到 body 后可能还差一拍，这里轮询等它出现。
  async function latestLogWhere(predicate, hint) {
    for (let i = 0; i < 40; i++) {
      const r = await logsRaw();
      const entries = r.json.entries || [];
      if (entries.length && predicate(entries[0])) return { entry: entries[0], raw: r.text, entries };
      await new Promise((res) => setTimeout(res, 50));
    }
    throw new Error(`等不到期望的日志记录：${hint}`);
  }

  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { if ((await request('GET', '/healthz')).status === 200) { ready = true; break; } } catch (_) {}
    await new Promise((r) => setTimeout(r, 150));
  }
  assert(ready, `网桥未能在预期时间内启动。日志:\n${childLogs.slice(-1500)}`);

  try {
    // ---- 1. 单账号成功 ----
    mock.clear();
    mock.queueResponse('/v1/chat/completions', {
      status: 200,
      body: {
        id: 'chatcmpl-log-ok',
        model: 'deepseek-flash',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    });
    const okRes = await request('POST', '/v1/chat/completions', {
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: 'hello' }],
      stream: false,
    }, auth);
    assert.strictEqual(okRes.status, 200, okRes.text);

    const ok = await latestLogWhere((e) => e.path === '/v1/chat/completions' && e.status === 200, '单账号成功');
    const okEntry = ok.entry;
    assert.ok(okEntry.account, `日志应有账号信息: ${JSON.stringify(okEntry)}`);
    assert.ok([ACC1_NAME, ACC2_NAME].includes(okEntry.account.name), `账号名应为可读名，实际 ${okEntry.account.name}`);
    assert.ok(okEntry.account.short && String(okEntry.account.short).length <= 8, '账号短 id 必须存在且足够短');
    assert(!JSON.stringify(okEntry).includes('acc-one') && !JSON.stringify(okEntry).includes('acc-two'),
      '日志不得写入完整内部账号 id');
    assert.strictEqual(okEntry.model, 'deepseek-flash', '应记录模型');
    assert.strictEqual(okEntry.outcome, 'success', '成功请求结果应为 success');
    assert.strictEqual(okEntry.attempts, 0, '首次即成功，换号次数应为 0');
    assert.strictEqual(okEntry.prompt_tokens, 10);
    assert.strictEqual(okEntry.completion_tokens, 5);
    assert.strictEqual(okEntry.total_tokens, 15);
    assert.strictEqual(okEntry.error, '', '成功请求不应有错误摘要');
    console.log('✓ 1 单账号成功：账号/模型/结果/token 正确，换号 0 次');

    // ---- 2. 换号后成功 ----
    mock.clear();
    mock.queueResponse('/v1/chat/completions', {
      status: 500,
      body: { error: { message: 'first account exploded', type: 'server_error' } },
    });
    mock.queueResponse('/v1/chat/completions', {
      status: 200,
      body: {
        id: 'chatcmpl-log-failover',
        model: 'deepseek-flash',
        choices: [{ index: 0, message: { role: 'assistant', content: 'second account ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 22, completion_tokens: 7, total_tokens: 29 },
      },
    });
    const foRes = await request('POST', '/v1/chat/completions', {
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: 'failover please' }],
      stream: false,
    }, auth);
    assert.strictEqual(foRes.status, 200, foRes.text);

    const recorded = mock.getRecordedRequests('/v1/chat/completions');
    assert.strictEqual(recorded.length, 2, '应当发生一次换号（共 2 次上游请求）');
    const servingKey = recorded[1].headers.authorization;
    const servingName = servingKey.includes(ACC1_KEY) ? ACC1_NAME : ACC2_NAME;

    const fo = await latestLogWhere((e) => e.path === '/v1/chat/completions' && e.outcome === 'success'
      && e.prompt_tokens === 22, '换号后成功');
    assert.strictEqual(fo.entry.account.name, servingName, '账号必须是最终服务这次请求的那个');
    assert.ok(fo.entry.attempts >= 1, `换号次数至少为 1，实际 ${fo.entry.attempts}`);
    assert.strictEqual(fo.entry.outcome, 'success', '换号后成功，结果仍为 success');
    assert.strictEqual(fo.entry.completion_tokens, 7, 'token 应取自最终成功的那个账号');
    assert.strictEqual(fo.entry.total_tokens, 29);
    console.log('✓ 2 换号后成功：账号为最终服务者，换号次数 >= 1');

    // ---- 3. 上游报错 ----
    mock.clear();
    mock.queueResponse('/v1/chat/completions', {
      status: 400,
      body: { error: { message: 'Invalid parameter temperature=999', type: 'invalid_request_error' } },
    });
    const badRes = await request('POST', '/v1/chat/completions', {
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: PROMPT_MARKER }],
      temperature: 999,
      stream: false,
    }, auth);
    assert.strictEqual(badRes.status, 400, badRes.text);

    const bad = await latestLogWhere((e) => e.path === '/v1/chat/completions' && e.status === 400, '上游报错');
    assert.strictEqual(bad.entry.outcome, 'upstream_error', '上游报错结果应为 upstream_error');
    assert.ok(bad.entry.error && bad.entry.error.length > 0, '失败请求必须带错误摘要');
    assert.ok(bad.entry.error.length <= 200, `错误摘要最多 200 字，实际 ${bad.entry.error.length}`);
    assert.ok(bad.entry.error.includes('Invalid parameter'), `错误摘要应说明上游原因: ${bad.entry.error}`);
    assert.strictEqual(bad.entry.attempts, 0, '400 不换号，换号次数应为 0');

    for (const secret of [INV_KEY, ACC1_KEY, ACC2_KEY, PROMPT_MARKER]) {
      assert(!bad.raw.includes(secret), `日志响应泄露了敏感内容: ${secret.slice(0, 12)}...`);
    }
    console.log('✓ 3 上游报错：结果与错误摘要正确，日志不含凭据/请求体/响应正文');

    // ---- 4. 流中断 ----
    mock.clear();
    mock.queueResponse('/v1/chat/completions', {
      sseEvents: [
        { data: { choices: [{ delta: { content: 'partial text' } }] } },
        { delayMs: 30, abort: true },
      ],
    });
    const brokenRes = await request('POST', '/v1/chat/completions', {
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: 'stream please' }],
      stream: true,
    }, auth);
    assert.strictEqual(brokenRes.status, 200);
    assert.ok(brokenRes.text.includes('stream_interrupted'), '中断流应下发 stream_interrupted 帧');

    const broken = await latestLogWhere((e) => e.path === '/v1/chat/completions' && e.outcome === 'stream_error', '流中断');
    assert.ok(broken.entry.error && broken.entry.error.length > 0, '流中断也应留下错误摘要');
    console.log('✓ 4 流中断：结果为 stream_error');

    // ---- 5. 页面表格 ----
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
    // 静态 <thead> 与 LOG_COLUMNS 是两份真源：按顺序逐列比对，任何一边改了列名/列序/列数都会立刻红。
    const colsStart = html.indexOf('const LOG_COLUMNS = [');
    const colsEnd = html.indexOf('async function loadLogs(');
    assert(colsStart > 0 && colsEnd > colsStart, '日志表应有集中的列定义 LOG_COLUMNS');
    const colLabels = [...html.slice(colsStart, colsEnd).matchAll(/label: '([^']*)'/g)].map((m) => m[1]);
    const rowsAt = html.indexOf('id="logRows"');
    assert(rowsAt > 0, '日志表应有 #logRows');
    const headStart = html.lastIndexOf('<thead>', rowsAt) + '<thead>'.length;
    const headEnd = html.indexOf('</thead>', headStart);
    assert(headStart > 0 && headEnd > headStart, '日志表应有 <thead>');
    const headLabels = [...html.slice(headStart, headEnd).matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)]
      .map((m) => m[1].trim());
    assert.deepStrictEqual(headLabels, colLabels,
      `日志表头必须与 LOG_COLUMNS 的 label 逐列一致（顺序与数量都要相同）: 表头=${headLabels.join('/')} 定义=${colLabels.join('/')}`);
    assert(/overflow-x\s*:\s*auto/.test(html), '日志表格容器必须可横向滚动');
    assert(/outcome|outcomeLabel|outcomeText/.test(html), '页面应把结果分类渲染成可读文本');
    console.log('✓ 5 日志页表格：表头与 LOG_COLUMNS 逐列一致，可横向滚动');

    // ---- 6. 只收 /v1 ----
    const all = await logsRaw(50);
    const noise = (all.json.entries || []).filter((e) => !String(e.path || '').startsWith('/v1'));
    assert.strictEqual(noise.length, 0, `日志只应记录 /v1 调用，混入了: ${JSON.stringify(noise.slice(0, 3))}`);
    assert.strictEqual(all.json.capacity, 200, '容量仍应为 200');
    console.log('✓ 6 只记录 /v1，容量保持 200');

    console.log('\n✓ [All Passed] 请求日志明细：账号/模型/结果/token/换号次数');
  } finally {
    gwProc.kill('SIGTERM');
    await mock.stop();
  }
}

run().catch((err) => {
  console.error('测试失败:', err.message);
  process.exit(1);
});
