'use strict';
/**
 * 票 06：失败请求数折线，零值不画点。
 *
 * 这条线的作用是让「请求数没掉、失败线翘起来」这个形状自己说话。所以本套件钉住四件事：
 *   1. 它是红色虚线、走右轴 y1（与请求数同轴，量级可比）。
 *   2. 失败数为 0 的时间点半径为 0，且数据集里是 null 不是 0（spanGaps 不跳过 0），
 *      线段靠 spanGaps 跨过去连到下一个非零点。
 *   3. 整段区间零失败时数据集整体 hidden——图上不留一条贴着底部的零线（图例项仍在）。
 *   4. 它与其它系列互不干扰：其它数据集的 hidden 一律为假，图例没被整体关掉。
 *
 * 断言分两层：静态字符串钉住配置写在哪，vm 实跑钉住真实传进 Chart 的那份配置。
 * Chart 桩刻意不提供 getContext——渲染层不许自己去拿 2d 上下文。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');

// ---- 静态契约 ----
const start = HTML.indexOf('function renderUsageChart(');
assert(start > -1, '缺少 renderUsageChart()');
const end = HTML.indexOf('function usageMetricColumns(', start);
assert(end > start, '找不到 renderUsageChart 的函数体边界');
const BODY = HTML.slice(start, end);

assert(/label:\s*'失败数'/.test(BODY), '数据集标签必须是「失败数」');
assert(/borderColor:\s*'#dc2626'/.test(BODY), '失败数折线要用红色 #dc2626');
assert(/borderDash:\s*\[\s*4\s*,\s*3\s*\]/.test(BODY), '失败数折线要是虚线 [4, 3]');
assert(/spanGaps:\s*true/.test(BODY), '零值点必须靠 spanGaps 跨过去，不能断成碎片');
assert(/hidden:\s*!hasError/.test(BODY), '整段零失败时数据集要整体 hidden');
assert(/hasError\s*=\s*data\.errors\.some\(/.test(BODY), 'hidden 的判据是「是否存在非零失败」');
assert(/pointRadius:\s*errorDots/.test(BODY), 'pointRadius 要传逐点数组');
assert(/data\.errors\.map\(/.test(BODY), '逐点半径必须与 errors 一一对应');
assert(/Number\(v\)\s*>\s*0\s*\?\s*2\s*:\s*0/.test(BODY), '非零失败给半径 2，零值给 0');
// 与请求数同轴、同量级
assert.strictEqual((BODY.match(/yAxisID:\s*'y1'/g) || []).length, 2, '请求数与失败数都挂在右轴 y1');
assert.strictEqual((BODY.match(/yAxisID:\s*'y'/g) || []).length, 2, '左轴仍是输入与输出两段柱，未受影响');
// 图例不能被关掉：失败数要能单独隐藏/打开
assert(!/legend:\s*\{[^}]*display:\s*false/.test(BODY), '图例必须保留，失败数才能单独隐藏');

// ---- vm 实跑 ----
const inline = [...HTML.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)]
  .map(m => m[1])
  .join('\n');
assert(inline.length > 1000, '没抓到页面内联脚本');

function makeElement(tag) {
  return {
    id: tag,
    tagName: String(tag).toUpperCase(),
    value: '',
    textContent: '',
    innerHTML: '',
    title: '',
    disabled: false,
    hidden: false,
    checked: false,
    dataset: {},
    style: {},
    options: [],
    children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    appendChild(child) { this.children.push(child); return child; },
    removeChild() {},
    addEventListener() {},
    removeEventListener() {},
    setAttribute(k, v) { this[k] = v; },
    getAttribute() { return null; },
    removeAttribute() {},
    focus() {},
    click() {},
    getBoundingClientRect() { return { width: 0, height: 0, top: 0, left: 0 }; },
  };
}

const elements = new Map();
const document = {
  hidden: false,
  readyState: 'loading',
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  },
  querySelectorAll() { return []; },
  querySelector() { return null; },
  createElement(tag) { return makeElement(tag); },
  addEventListener() {},
  removeEventListener() {},
  body: makeElement('body'),
  documentElement: makeElement('html'),
};

// 只记录配置的 Chart 桩：没有 getContext，和 test-usage-range-select 一致。
const chartInstances = [];
class ChartStub {
  constructor(el, config) {
    this.el = el;
    this.config = config;
    this.destroyed = false;
    chartInstances.push(this);
  }
  destroy() { this.destroyed = true; }
  update() {}
}

const noop = () => 0;
const sandbox = {
  document,
  window: { addEventListener() {}, matchMedia() { return { matches: false, addEventListener() {} }; }, Chart: ChartStub },
  navigator: { userAgent: 'node-test', clipboard: { writeText() {} } },
  location: { href: 'http://127.0.0.1:18080/', origin: 'http://127.0.0.1:18080' },
  localStorage: { _v: new Map(), getItem(k) { return this._v.has(k) ? this._v.get(k) : null; }, setItem(k, v) { this._v.set(k, String(v)); }, removeItem(k) { this._v.delete(k); } },
  fetch: () => new Promise(() => {}),
  Chart: ChartStub,
  setInterval: noop,
  setTimeout: noop,
  clearInterval: noop,
  clearTimeout: noop,
  requestAnimationFrame: noop,
  console,
  URLSearchParams,
  URL,
  Date,
  Math,
  JSON,
  Number,
  String,
  Object,
  Array,
  Promise,
  Error,
  isFinite,
  parseFloat,
  parseInt,
  encodeURIComponent,
  decodeURIComponent,
  crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000000' },
  toast: () => {},
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;

const rejections = [];
process.on('unhandledRejection', (e) => rejections.push(e));

const closer = inline.lastIndexOf('})();');
assert(closer > 0, '找不到内联脚本的 IIFE 结尾');
const patched = inline.slice(0, closer)
  + '\n;globalThis.__probe = { state, renderUsageChart, usageTrendTooltip };\n'
  + inline.slice(closer);

vm.createContext(sandbox);
vm.runInContext(patched, sandbox, { filename: 'index.html#inline' });

const probe = sandbox.__probe;
assert(probe && probe.renderUsageChart, '内联脚本没有暴露 renderUsageChart');

function row(slot, requests, errors) {
  return {
    slot, granularity: 'hour', scope: 'hour', requests, errors,
    prompt_tokens: 100, completion_tokens: 50, total_tokens: 150,
    credits: 0, cache_hit: 0, cache_miss: 0, cache_hit_rate: 0.5,
    avg_latency_ms: 800, avg_tokens_per_second: 20, buckets: 1,
  };
}

const plain = (a) => Array.prototype.slice.call(a);
const errorsOf = (chart) => chart.config.data.datasets.find(d => d.label === '失败数');

// 1) 混合零值：失败 [0, 2, 0] —— 零值点半径为 0，非零点为 2，线段不断。
{
  probe.renderUsageChart([
    row('2026-11-11T00:00', 8, 0),
    row('2026-11-11T01:00', 15, 2),
    row('2026-11-11T02:00', 0, 0),
  ]);
  assert.strictEqual(chartInstances.length, 1, '应创建一张图');
  const chart = chartInstances[0];
  const datasets = chart.config.data.datasets;
  assert.strictEqual(datasets.length, 4, '失败折线是第四条数据集');

  const dsErrors = errorsOf(chart);
  assert(dsErrors, '缺少「失败数」数据集');
  assert.strictEqual(dsErrors.type, 'line', '失败数是折线');
  assert.strictEqual(dsErrors.yAxisID, 'y1', '失败数与请求数共用右轴');
  assert.deepStrictEqual(plain(dsErrors.data), [null, 2, null], '非正失败数必须映射为 null，0 不能进数据集');
  assert.strictEqual(dsErrors.borderColor, '#dc2626', '失败数折线是红色');
  assert.strictEqual(dsErrors.borderWidth, 1.5);
  assert.deepStrictEqual(plain(dsErrors.borderDash), [4, 3], '失败数折线是虚线');
  assert.strictEqual(dsErrors.spanGaps, true, '零值点要被跨过去');
  assert.strictEqual(dsErrors.fill, false);
  assert.strictEqual(dsErrors.tension, 0);
  assert.strictEqual(dsErrors.hidden, false, '有失败时不能隐藏');
  assert(Array.isArray(dsErrors.pointRadius), 'pointRadius 必须是逐点数组');
  assert.deepStrictEqual(plain(dsErrors.pointRadius), [0, 2, 0], '零失败不画点，非零画 2px 点');
  assert.strictEqual(dsErrors.pointHoverRadius, 3);

  // spanGaps 只跳过 null/NaN，不会跳过 0：零值必须是 null，否则每个零值点都会把线
  // 拽回基线再弹起来，正好是 ADR 第 3 条要消灭的那条贴着底的零线。
  assert.ok(!plain(dsErrors.data).includes(0), '数据集里不许出现 0（0 会被画成基线点）');
  assert.ok(plain(dsErrors.data).every(v => v === null || Number.isFinite(v)),
    '数据里只允许 null 或有效数字');

  // 其它系列不受影响：都没有 hidden，图例整体可见。
  for (const ds of datasets) {
    if (ds === dsErrors) continue;
    assert.ok(!ds.hidden, `「${ds.label}」不该被连带隐藏`);
  }
  assert.notStrictEqual(chart.config.options.plugins.legend.display, false, '图例必须可用，失败数要能单独隐藏');

  // tooltip 同时给出请求数与失败数（这是一条线，但读者要能对上两条读数）。
  const tip = chart.config.options.plugins.tooltip.callbacks.beforeBody([{ dataIndex: 1 }]);
  const joined = tip.join('\n');
  assert.ok(/请求\s*15/.test(joined), 'tooltip 要给出请求数');
  assert.ok(/失败\s*2/.test(joined), 'tooltip 要给出失败数');
}

// 2) 全零区间：整条线不占视觉（hidden），但数据集与图例项仍在。
{
  probe.renderUsageChart([
    row('2026-11-11T00:00', 8, 0),
    row('2026-11-11T01:00', 15, 0),
    row('2026-11-11T02:00', 22, 0),
  ]);
  const chart = chartInstances[1];
  const dsErrors = errorsOf(chart);
  assert.strictEqual(dsErrors.hidden, true, '整段零失败时这条线要整体隐藏');
  assert.deepStrictEqual(plain(dsErrors.data), [null, null, null], '全零时 data 必须全是 null（不能是 0）');
  assert.deepStrictEqual(plain(dsErrors.pointRadius), [0, 0, 0], '全零时没有任何点');
  assert.strictEqual(chart.config.data.datasets.length, 4, '隐藏不等于移除：图例项要保留');
}

// 3) 全部时间片都有失败：折线完整可见，不断线。
{
  probe.renderUsageChart([
    row('2026-11-11T00:00', 8, 1),
    row('2026-11-11T01:00', 15, 3),
    row('2026-11-11T02:00', 22, 1),
  ]);
  const chart = chartInstances[2];
  const dsErrors = errorsOf(chart);
  assert.strictEqual(dsErrors.hidden, false, '每片都有失败时不能隐藏');
  assert.deepStrictEqual(plain(dsErrors.data), [1, 3, 1], '每片都有失败时数据原样保留');
  assert.deepStrictEqual(plain(dsErrors.pointRadius), [2, 2, 2], '每个点都画 2px');
}

// 4) 密集模式：点半径全归零避免糊成一片，但仍是数组，且线本身还在。
{
  const denseSeries = [];
  for (let i = 0; i < 121; i++) denseSeries.push(row('2026-11-11T' + i, 5, i % 3 === 0 ? 1 : 0));
  probe.renderUsageChart(denseSeries);
  const chart = chartInstances[3];
  const dsErrors = errorsOf(chart);
  assert(Array.isArray(dsErrors.pointRadius), '密集模式下 pointRadius 仍是数组');
  assert.strictEqual(plain(dsErrors.pointRadius).length, 121, '逐点半径长度与点数一致');
  assert.ok(plain(dsErrors.pointRadius).every(r => r === 0), '密集模式不画点');
  assert.strictEqual(dsErrors.spanGaps, true);
  assert.strictEqual(dsErrors.hidden, false, '密集与否不影响隐藏判据');
}

process.removeAllListeners('unhandledRejection');
if (rejections.length) {
  for (const e of rejections) {
    const msg = String((e && e.message) || e);
    if (!/null|undefined|Cannot read|not a function/i.test(msg)) throw e;
  }
}

console.log('ok - 趋势图：失败请求数折线，零值不画点');
