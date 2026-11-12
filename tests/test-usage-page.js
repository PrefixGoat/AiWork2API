'use strict';
/**
 * 用量页面（Issue #08）：结构契约 + 真实接口接线。
 *
 * 页面没有 DOM 测试环境，静态断言守的是「结构契约」而不是实现：
 * 时间范围控件、KPI 容器与标签、趋势图与粒度切换、三张分组表及列名、
 * 空态、估算说明，以及请求 URL 必须带 hours 或 from/to。
 *
 * 第二段起真网关：发一次真实请求，再用页面同样的鉴权头直接读
 * /api/usage/buckets?hours=168（页面默认近 7 天窗口），证明页面拿得到数据。
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwork-usage-page-'));
process.on('exit', () => {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
});

const ROUTER_KEY = 'sk-router-usage-page-0001';
const CLIENT_KEY = 'sk-usage-page-client';
const PORT = 18600 + Math.floor(Math.random() * 200);

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
        data: [{ id: 'deepseek-flash', name: 'deepseek-flash', ratio: '0.2x', tags: 'Low cost' }],
      });
    }
    if (req.url.startsWith('/v1/dashboard/billing/usage')) return json(res, 200, { object: 'list', total_usage: 12.5 });
    if (req.url.startsWith('/v1/dashboard/billing/subscription')) return json(res, 200, { hard_limit_usd: 100 });
    if (req.url.startsWith('/v1/chat/completions') && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(body); } catch (_) {}
        json(res, 200, {
          id: 'chatcmpl-usage-page-1',
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

function gatewayEnv(routerBaseUrl) {
  const accDir = path.join(TMP_DIR, 'acc1');
  fs.mkdirSync(accDir, { recursive: true });
  fs.writeFileSync(path.join(accDir, '.env'), `AGENTIX_CONFIG_MODELS_AIWORK_ROUTER_API_KEY=${ROUTER_KEY}\n`);
  fs.writeFileSync(path.join(accDir, 'config.json'), JSON.stringify({
    models: {
      'aiwork-router': {
        models: [{ id: 'deepseek-flash', name: 'deepseek-flash', multiplier: 0.2, ratio: '0.2x' }],
      },
    },
  }));

  const dataDir = path.join(TMP_DIR, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'api-keys.json'), JSON.stringify({
    version: 1,
    keys: [{
      id: 'key-usage-page',
      token: CLIENT_KEY,
      name: 'usage-page-client',
      accountPolicy: { mode: 'all', allowedAccounts: [] },
      createdAt: Date.now(),
      revoked: false,
    }],
  }, null, 2));

  return {
    ...process.env,
    PORT: String(PORT),
    BIND: '127.0.0.1',
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
  await new Promise((resolve) => { proc.once('exit', resolve); proc.kill(signal); });
}

function dayStr(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function assertStructure() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');

  // ---- 1. 时间范围：今天 / 近 7 天 / 近 30 天 / 自定义，默认近 7 天 ----
  assert(/data-view="usage"/.test(html), '用量视图容器必须存在');
  for (const range of ['today', '7d', '30d', 'custom']) {
    assert(new RegExp(`data-range="${range}"`).test(html), `时间范围缺少「${range}」`);
  }
  assert(/class="[^"]*\bon\b[^"]*"\s+data-range="7d"/.test(html)
    || /data-range="7d"[^>]*class="[^"]*\bon\b/.test(html), '默认时间范围应是近 7 天');
  assert(/id="usageFrom"/.test(html) && /id="usageTo"/.test(html), '自定义范围要有起止日期输入');
  assert(/id="btnUsageApply"/.test(html), '自定义范围要有「应用」按钮');
  // 「应用」也必须走 applyUsageRange，否则切到自定义后分段按钮的高亮与 aria-pressed 会对不上。
  assert(/btnUsageApply'\)\.onclick = \(\) => \{[\s\S]{0,500}?applyUsageRange\('custom'\)/.test(html),
    '「应用」按钮必须经 applyUsageRange 同步分段状态');
  // 7 天仍是滚动小时窗口；「今天」改为本地自然日（from 零点 → to 此刻），
  // 不能再折算成滚动 24 小时，否则会把昨天傍晚算进来。
  assert(new RegExp("['\"]?7d['\"]?\\s*:\\s*168").test(html), '7d 应折算成 168 小时');
  assert(/state\.usageRange === 'today'[\s\S]{0,260}getFullYear\(\)/.test(html), '今天必须从本地零点算起');
  // 「近 30 天」折算成多少小时不看页面字面量：由下面的真实请求核对窗口跨度。

  // ---- 2. 请求 URL 必须带 hours 或 from/to ----
  assert(/function usageQuery\(/.test(html), '需要一个集中的查询串构造函数');
  assert(/'\/api\/usage\/buckets\?'/.test(html), '用量页应打 /api/usage/buckets');
  assert(/set\('hours'/.test(html), '滚动窗口要用 hours 参数');
  assert(/set\('from'/.test(html) && /set\('to'/.test(html), '自定义区间要用 from/to');

  // ---- 3. KPI 行：八项 ----
  assert(/id="usageKpi"/.test(html), 'KPI 容器必须存在');
  for (const label of ['请求数', '失败率', '输入 token', '输出 token', '缓存命中率', '平均延迟', '平均吐字速率', '估算消耗']) {
    assert(html.includes(label), `KPI 缺少「${label}」`);
  }
  assert(/function usageNum\(/.test(html), '需要统一的数值格式化（无样本给 —，不出 NaN）');

  // ---- 4. 趋势图 + 粒度切换 ----
  assert(/id="usageChart"/.test(html), '趋势图容器必须存在');
  assert(/data-gran="hour"/.test(html) && /data-gran="day"/.test(html), '趋势图要能切按小时/按天');
  // scope=day 的是整日汇总，文案必须写明「全天」。兜底柱子路径复用 usageSlotText，
  // 不再自己复制一份 scope→文案的映射（「（全天）」行为由 test-usage-trend-series.js 覆盖）。
  const barsStart = html.indexOf('function renderUsageChartBars(');
  const barsEnd = html.indexOf('function renderUsageChartEmpty(', barsStart);
  assert(barsStart > -1 && barsEnd > barsStart, '找不到兜底柱子渲染函数的使用文案区域');
  const barsBody = html.slice(barsStart, barsEnd);
  assert(/usageSlotText\(r\)/.test(barsBody), '兜底柱子路径必须调用 usageSlotText 生成时间文案');
  assert(!/r\.scope === 'day'/.test(barsBody), '兜底路径不应再重复 scope→「（全天）」的映射');
  // 柱子不参与 Tab 序列：几十根柱子逐个可聚焦只会把键盘用户困在图表里。
  assert(!/\.tabIndex\s*=\s*0/.test(html.slice(html.indexOf('function renderUsageChartBars('), html.indexOf('function usageMetricColumns('))),
    '趋势柱不应再设 tabIndex');

  // ---- 5. 三张分组表：列定义驱动（表头/单元格/空行 colspan 同源） ----
  const tables = [
    ['usageModelTable', '模型'],
    ['usageAccountTable', '账号'],
    ['usageKeyTable', '凭据'],
  ];
  for (const [id] of tables) {
    assert(html.indexOf(`id="${id}"`) > 0, `分组表 ${id} 必须存在`);
  }
  // 列只定义一次：表头由 JS 按定义生成，静态 HTML 不再手写 <th>；
  // 单元格与空行 colspan 也从同一份定义推导，改列序不会再出现表头/数据错位。
  const defsStart = html.indexOf('function usageMetricColumns(');
  const defsEnd = html.indexOf('function renderUsageTable(');
  assert(defsStart > 0 && defsEnd > defsStart, '三张表应有集中的列定义（usageMetricColumns / USAGE_TABLES）');
  const colDefs = html.slice(defsStart, defsEnd);
  for (const [id, firstCol] of tables) {
    assert(colDefs.includes(`tableId: '${id}'`), `列定义缺少 ${id}`);
    assert(colDefs.includes(`label: '${firstCol}'`), `${id} 首列应是「${firstCol}」`);
  }
  for (const col of ['请求', '失败', 'token', '估算消耗', '倍率']) {
    assert(colDefs.includes(`label: '${col}'`), `列定义缺少「${col}」列`);
  }
  for (const [id] of tables) {
    const idx = html.indexOf(`id="${id}"`);
    const markup = html.slice(idx, html.indexOf('</table>', idx));
    assert(!/<th\b/.test(markup), `${id} 的表头必须由列定义生成，不能再手写 <th>`);
  }
  assert(!/cols:\s*\d/.test(html), '不应再写死分组表列数');
  assert(/td\.colSpan = columns\.length/.test(html), '空行 colspan 必须由列定义推导');
  assert(/for \(const col of columns\)[\s\S]{0,240}?createElement\('th'\)/.test(html),
    '表头单元格必须按列定义生成');

  // ---- 5b. 票 09：账号池为空时不触发「账号消失」回退 ----
  assert(/function usageAccountPoolReady\(\)\{[\s\S]{0,260}?pool\.length > 0/.test(html),
    '池子为空（仪表盘未加载）时不能触发回退，否则会误清用户的账号过滤');

  // ---- 6. 空态 / 估算说明 / 与积分卡的区分 ----
  assert(/id="usageEmpty"/.test(html), '空账本要有空态容器');
  assert(/暂无/.test(html), '空态要给文案而不是空白');
  assert(/估算，不是账单/.test(html), '估算消耗旁必须标注「估算，不是账单」');
  assert(/权威/.test(html) && /积分/.test(html), '要说明积分卡是权威值、这里是本地估算');

  // ---- 7. 最近会话保留在页面底部 ----
  assert(/id="sessions"/.test(html), '最近会话区块不能删');
  assert(/最近会话/.test(html), '最近会话标题要保留');
  assert(/id="btnReset"/.test(html), '重置本地统计的入口要保留');

  // ---- 8. 窄屏：表格横向滚动，KPI 换行 ----
  assert(/\.usage-table/.test(html), '分组表要有自己的样式');
  assert(/@media[^{]*max-width[^{]*\{[\s\S]{0,400}usage-kpi/.test(html), 'KPI 在窄屏要降列数');
}

async function assertLiveApi() {
  await startRouter();
  const env = gatewayEnv(`http://127.0.0.1:${routerServer.address().port}`);
  await startGateway(env);
  try {
    // 页面在未启用管理口令时用调用凭据读（getAdminHeaders 的兜底路径）。
    const pageHeaders = { Authorization: `Bearer ${CLIENT_KEY}` };

    const chat = await request('POST', '/v1/chat/completions', {
      headers: pageHeaders,
      body: { model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 },
    });
    assert.strictEqual(chat.status, 200, `请求应成功，实际 ${chat.status}: ${chat.text}`);
    await new Promise((r) => setTimeout(r, 300));

    // 页面默认窗口：近 7 天 = 168 小时
    const week = await request('GET', '/api/usage/buckets?hours=168&granularity=day', { headers: pageHeaders });
    assert.strictEqual(week.status, 200, `用量页默认窗口读不到：${week.status} ${week.text}`);
    assert.strictEqual(week.json.ok, true);
    assert.strictEqual(week.json.requests, 1, '近 7 天窗口应包含刚发的这次请求');
    assert.strictEqual(week.json.total_tokens, 20, 'token 与上游 usage 一致');
    assert.strictEqual(week.json.by_model.length, 1, '按模型应有一行');
    const modelRow = week.json.by_model[0];
    assert.strictEqual(modelRow.model, 'deepseek-flash');
    assert.strictEqual(modelRow.requests, 1);
    assert.strictEqual(modelRow.total_tokens, 20);
    assert(Array.isArray(modelRow.rates) && modelRow.rates.length === 1, '按模型表要能显示倍率');
    assert(week.json.by_account.length === 1 && week.json.by_key.length === 1, '账号/凭据各一行');
    const sum = (rows, f) => rows.reduce((a, r) => a + r[f], 0);
    assert.strictEqual(sum(week.json.series, 'requests'), week.json.requests, '趋势合计必须等于 KPI 请求数');
    assert.strictEqual(sum(week.json.series, 'total_tokens'), week.json.total_tokens, '趋势 token 合计必须等于 KPI');
    assert.ok(week.json.credits > 0, '估算消耗应有值');
    // 均值要么是数字要么是 null（无样本），不会是 NaN 或 0 冒充「没数据」
    assert(week.json.cache_hit_rate === null
      || (typeof week.json.cache_hit_rate === 'number' && week.json.cache_hit_rate >= 0 && week.json.cache_hit_rate <= 1),
    `缓存命中率应是 0..1 或 null，实际 ${week.json.cache_hit_rate}`);
    for (const field of ['avg_latency_ms', 'avg_tokens_per_second']) {
      assert(week.json[field] === null || (typeof week.json[field] === 'number' && Number.isFinite(week.json[field])),
        `${field} 应是数字或 null，实际 ${week.json[field]}`);
    }

    // 今天窗口（24 小时）
    const today = await request('GET', '/api/usage/buckets?hours=24&granularity=hour', { headers: pageHeaders });
    assert.strictEqual(today.status, 200, today.text);
    assert.strictEqual(today.json.requests, 1, '今天窗口也应有这次请求');
    assert.strictEqual(today.json.granularity, 'hour');

    // 近 30 天窗口：页面把它折成 hours=720，这里真发一次核对窗口跨度确实约 30 天。
    const month = await request('GET', '/api/usage/buckets?hours=720&granularity=day', { headers: pageHeaders });
    assert.strictEqual(month.status, 200, `近 30 天窗口读不到：${month.status} ${month.text}`);
    assert.strictEqual(month.json.mode, 'hours');
    assert.strictEqual(month.json.hours, 720, '近 30 天应是 720 小时');
    const spanHours = (Date.parse(month.json.to_time) - Date.parse(month.json.from_time)) / 3600000;
    assert(spanHours >= 719 && spanHours <= 720,
      `近 30 天窗口的跨度应约 720 小时，实际 ${spanHours}`);
    assert.strictEqual(month.json.requests, 1, '近 30 天窗口应包含这次请求');

    // 自定义区间（页面的 from/to 形态）
    const ranged = await request(
      'GET',
      `/api/usage/buckets?from=${dayStr(-6)}&to=${dayStr(0)}&granularity=day`,
      { headers: pageHeaders },
    );
    assert.strictEqual(ranged.status, 200, `自定义区间读不到：${ranged.status} ${ranged.text}`);
    assert.strictEqual(ranged.json.mode, 'range');
    assert.strictEqual(ranged.json.requests, 1, '自定义区间应覆盖今天');

    const anon = await request('GET', '/api/usage/buckets?hours=168');
    assert([401, 403].includes(anon.status), '未鉴权不应读到用量');
  } finally {
    await stopGateway('SIGTERM');
    if (routerServer) routerServer.close();
  }
}

async function run() {
  assertStructure();
  await assertLiveApi();
  console.log('✓ [All Passed] 用量页面：范围/KPI/趋势/三表/空态/估算说明 + 真实接口接线');
}

run().catch((err) => {
  console.error('测试失败:', err && err.stack || err);
  if (gw) { try { gw.kill('SIGKILL'); } catch (_) {} }
  if (routerServer) routerServer.close();
  process.exit(1);
});
