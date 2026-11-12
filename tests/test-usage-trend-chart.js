'use strict';
/**
 * 票 05：趋势图的双轴组合图（Chart.js）。
 *
 * 两层断言：
 *   1. 静态契约：双轴、堆叠、紧凑刻度、横向网格、图例置顶、密集抽稀、实例销毁、
 *      无库时委托兜底——这些都是渲染配置里可被字符串钉住的事实。
 *   2. vm 实跑：把内联脚本塞进最小 DOM 桩，用一个会记录配置的 Chart 桩真的调用
 *      renderUsageChart，检查数据集映射、轴配置、tooltip 与销毁时机。
 *      Chart 桩刻意不提供 getContext：渲染层不许自己去拿 2d 上下文。
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

// 双轴：两个堆叠柱走 y，请求数折线走 y1
assert.strictEqual((BODY.match(/yAxisID:\s*'y'/g) || []).length, 2, '输入与输出两段柱都挂在左轴 y');
assert.strictEqual((BODY.match(/yAxisID:\s*'y1'/g) || []).length, 2, '请求数与失败数两条折线都挂在右轴 y1');
assert.strictEqual((BODY.match(/stack:\s*'tokens'/g) || []).length, 2, '两段柱必须同 stack 才能堆叠');
assert(/y:\s*\{[^}]*stacked:\s*true/.test(BODY), '左轴要允许堆叠');
// 两轴都从 0 起
assert((BODY.match(/beginAtZero:\s*true/g) || []).length >= 2, '左右两轴都要 beginAtZero');
// 左轴紧凑刻度 + 右轴整数刻度
assert(/callback:\s*\(v\)\s*=>\s*usageCompact\(v\)/.test(BODY), '左轴刻度要用 usageCompact');
assert(/y1:\s*\{[\s\S]{0,160}?precision:\s*0/.test(BODY), '右轴刻度应为整数');
// 只画横向网格：y 开、x 与 y1 关
assert(/x:\s*\{[\s\S]{0,80}?grid:\s*\{\s*display:\s*false\s*\}/.test(BODY), 'X 轴不画纵向网格线');
assert(/y1:\s*\{[\s\S]{0,200}?grid:\s*\{\s*display:\s*false\s*\}/.test(BODY), '右轴不重复画网格线');
assert(/y:\s*\{[\s\S]{0,160}?grid:\s*\{\s*display:\s*true/.test(BODY), '左轴要画横向网格线');
// 图例置顶（可点击是 Chart.js 默认行为）
assert(/legend:\s*\{\s*position:\s*'top'/.test(BODY), '图例必须置顶');
// 密集：超过 120 点时 X 轴最多 8 个刻度
assert(/maxTicksLimit:\s*dense\s*\?\s*8/.test(BODY), '密集时 X 轴要限制刻度数');
assert(/>\s*120/.test(BODY), '抽稀门槛是 120 点');
// tooltip 走票 02 的文案
assert(/usageTrendTooltip\(trendRows\[/.test(BODY), 'tooltip 要用 usageTrendTooltip + 原始行');
// 实例销毁 + 动态建 canvas
assert(/state\.usageChart\.destroy\(\)/.test(BODY), '重绘前必须销毁旧实例');
assert(/state\.usageChart\s*=\s*null/.test(BODY), '销毁后要清空引用');
assert(/createElement\('canvas'\)/.test(BODY), 'canvas 由渲染层自己创建');
assert(/new window\.Chart\(/.test(BODY), '用 window.Chart 守门后再实例化');

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

// 记录配置、记录 destroy 的 Chart 桩：没有 getContext，模拟 test-usage-range-select 的桩。
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
  + '\n;globalThis.__probe = { state, renderUsageChart, usageTrendSeries, usageTrendTooltip, usageCompact };\n'
  + inline.slice(closer);

vm.createContext(sandbox);
vm.runInContext(patched, sandbox, { filename: 'index.html#inline' });

const probe = sandbox.__probe;
assert(probe && probe.renderUsageChart, '内联脚本没有暴露 renderUsageChart');

const blankRow = (slot, prompt, completion, requests, errors) => ({
  slot, granularity: 'hour', scope: 'hour', requests, errors,
  prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion + 100,
  credits: 0, cache_hit: 0, cache_miss: 0, cache_hit_rate: 0.5,
  avg_latency_ms: 800, avg_tokens_per_second: 20, buckets: 1,
});

const series = [
  blankRow('2026-11-11T00:00', 1200, 340, 8, 0),
  blankRow('2026-11-11T01:00', 2500, 900, 15, 2),
  blankRow('2026-11-11T02:00', 0, 0, 0, 0),
];

probe.renderUsageChart(series);
assert.strictEqual(chartInstances.length, 1, '应创建一张图');
const chart = chartInstances[0];
assert.strictEqual(chart.config.type, 'bar', '组合图以 bar 为主类型');
const [dsPrompt, dsCompletion, dsRequests] = chart.config.data.datasets;
assert.strictEqual(chart.config.data.datasets.length, 4, '三个系列 + 06 的失败数折线');
assert.strictEqual(dsPrompt.label, '输入 token');
assert.strictEqual(dsCompletion.label, '输出 token');
assert.deepStrictEqual(Array.from(dsPrompt.data), [1200, 2500, 0], '输入柱直接取 prompt_tokens');
assert.deepStrictEqual(Array.from(dsCompletion.data), [340, 900, 0], '输出柱直接取 completion_tokens');
assert.deepStrictEqual(Array.from(dsRequests.data), [8, 15, 0], '请求数取 requests');
assert.strictEqual(dsRequests.type, 'line');
assert.strictEqual(dsRequests.yAxisID, 'y1');
assert.strictEqual(dsPrompt.stack, 'tokens');
assert.strictEqual(dsCompletion.stack, 'tokens');

const scales = chart.config.options.scales;
assert.strictEqual(scales.y.beginAtZero, true);
assert.strictEqual(scales.y1.beginAtZero, true);
assert.strictEqual(scales.y1.position, 'right');
assert.strictEqual(scales.x.grid.display, false, 'X 轴不画网格');
assert.strictEqual(scales.y.grid.display, true, 'Y 轴只画横向网格');
assert.strictEqual(scales.y1.grid.display, false, '右轴不重复画网格');
assert.strictEqual(scales.y.ticks.callback(1234567), '1.2M', '左轴刻度用紧凑数字');
assert.strictEqual(scales.y.ticks.callback(1500), '1.5k');
assert.strictEqual(chart.config.options.plugins.legend.position, 'top');
assert.strictEqual(scales.x.ticks.maxTicksLimit, undefined, '点数不多时交给自动抽稀');

// tooltip：一个时间点的全部字段，来自原始行（scope=day 会带「（全天）」）
const tipLines = chart.config.options.plugins.tooltip.callbacks.beforeBody([{ dataIndex: 1 }]);
assert.deepStrictEqual(tipLines, probe.usageTrendTooltip(series[1]), 'tooltip 必须走 02 的文案');
assert.strictEqual(tipLines[0], '2026-11-11T01:00');

// 密集：121 个点 → 最多 8 个 X 刻度
const denseSeries = [];
for (let i = 0; i < 121; i++) denseSeries.push(blankRow('2026-11-11T' + i, 10, 5, 1, 0));
probe.renderUsageChart(denseSeries);
assert.strictEqual(chartInstances.length, 2);
assert.strictEqual(chartInstances[1].config.options.scales.x.ticks.maxTicksLimit, 8, '超过 120 点时限 8 个刻度');
assert.strictEqual(chartInstances[0].destroyed, true, '重绘前要销毁上一张图');
assert.strictEqual(probe.state.usageChart, chartInstances[1]);

// 无 Chart：委托兜底柱子，不再建图
const box = elements.get('usageChart');
box.children.length = 0;
sandbox.window.Chart = undefined;
probe.renderUsageChart(series);
assert.strictEqual(chartInstances.length, 2, '没有 Chart 时不应实例化');
assert.strictEqual(box.children.length, 3, '应退回 DOM 柱子（每个时间点一根）');
assert.strictEqual(box.children[0].tagName, 'DIV');

process.removeAllListeners('unhandledRejection');
if (rejections.length) {
  for (const e of rejections) {
    const msg = String((e && e.message) || e);
    if (!/null|undefined|Cannot read|not a function/i.test(msg)) throw e;
  }
}

console.log('ok - 趋势图：双轴堆叠柱 + 请求数折线');
