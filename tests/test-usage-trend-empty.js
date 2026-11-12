'use strict';
/**
 * 票 07：趋势图的两个「图不该以空白收场」的场景。
 *
 * 1. 图表库不可用：`window.Chart` 缺失，或 `<script onerror>` 已把
 *    `window.__chartLoadFailed` 置为真，都必须退回纯 DOM 柱子。
 *    后者漏判过一次——脚本带 defer 写在 <head>，onerror 可能晚于内联脚本执行。
 * 2. 这段时间 0 请求：不实例化 Chart（不画空坐标轴），容器里给一句空态文案。
 * 3. 两种状态来回切换时，旧 canvas / 旧空态节点都不能残留。
 *
 * 用 vm 把内联脚本塞进最小 DOM 桩真跑，Chart 桩与
 * test-usage-range-select.js 一样只有 constructor / destroy / update（没有 getContext）。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
const inline = [...HTML.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)]
  .map(m => m[1])
  .join('\n');
assert(inline.length > 1000, '没抓到页面内联脚本');

function makeElement(tag) {
  const el = {
    id: tag,
    tagName: String(tag).toUpperCase(),
    value: '',
    innerHTML: '',
    title: '',
    className: '',
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
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i > -1) this.children.splice(i, 1);
    },
    addEventListener() {},
    removeEventListener() {},
    setAttribute(k, v) { this[k] = v; },
    getAttribute() { return null; },
    removeAttribute() {},
    focus() {},
    click() {},
    getBoundingClientRect() { return { width: 0, height: 0, top: 0, left: 0 }; },
  };
  // 页面用 textContent = '' 清空容器；桩里也把子节点一并清掉，
  // 否则「切到空态后 canvas 是否残留」就测不出来了。
  let text = '';
  Object.defineProperty(el, 'textContent', {
    get() { return text; },
    set(v) {
      text = v === null || v === undefined ? '' : String(v);
      if (text === '') el.children.length = 0;
    },
  });
  return el;
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

// 只记录实例，不提供 getContext：渲染层必须把绘制交给 Chart.js 自己。
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
  window: {
    addEventListener() {},
    matchMedia() { return { matches: false, addEventListener() {} }; },
    Chart: ChartStub,
  },
  navigator: { userAgent: 'node-test', clipboard: { writeText() {} } },
  location: { href: 'http://127.0.0.1:18080/', origin: 'http://127.0.0.1:18080' },
  localStorage: {
    _v: new Map(),
    getItem(k) { return this._v.has(k) ? this._v.get(k) : null; },
    setItem(k, v) { this._v.set(k, String(v)); },
    removeItem(k) { this._v.delete(k); },
  },
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
  + '\n;globalThis.__probe = { state, renderUsageChart };\n'
  + inline.slice(closer);

vm.createContext(sandbox);
vm.runInContext(patched, sandbox, { filename: 'index.html#inline' });

const probe = sandbox.__probe;
assert(probe && probe.renderUsageChart, '内联脚本没有暴露 renderUsageChart');

const box = document.getElementById('usageChart');
const empties = () => box.children.filter(c => c.className === 'usage-chart-empty');
const bars = () => box.children.filter(c => /^bar\b/.test(c.className));
const canvases = () => box.children.filter(c => c.tagName === 'CANVAS');

const row = (slot, requests, errors) => ({
  slot, granularity: 'hour', scope: 'hour', requests, errors,
  prompt_tokens: requests * 100, completion_tokens: requests * 20,
  total_tokens: requests * 120, credits: 0,
  cache_hit: 0, cache_miss: 0, cache_hit_rate: 0,
  avg_latency_ms: 800, avg_tokens_per_second: 20, buckets: requests,
});

const withData = [row('2026-11-11T00:00', 8, 0), row('2026-11-11T01:00', 15, 2)];
const noData = [row('2026-11-11T00:00', 0, 0), row('2026-11-11T01:00', 0, 0)];

// ---- 1. 有数据：正常建图，作为切换场景的起点 ----
probe.renderUsageChart(withData);
assert.strictEqual(chartInstances.length, 1, '有数据时应实例化一张图');
assert.strictEqual(canvases().length, 1, '有数据时容器里应有 canvas');
assert.strictEqual(empties().length, 0, '有数据时不该有空态');
// 图表路径：容器自己承担 role=img，canvas 不再重复声明，避免嵌套。
assert.strictEqual(box.role, 'img', '图表在时容器应为 role=img');
assert.strictEqual(canvases()[0].role, undefined, 'canvas 不应再带 role，避免与容器嵌套');

// ---- 2. 0 请求：不建图，给空态，且上一张图被销毁、canvas 不残留 ----
probe.renderUsageChart(noData);
assert.strictEqual(chartInstances.length, 1, '0 请求时不应再实例化 Chart（不画空坐标轴）');
assert.strictEqual(chartInstances[0].destroyed, true, '切到空态前要销毁上一张图');
assert.strictEqual(probe.state.usageChart, null, '销毁后要清空实例引用');
assert.strictEqual(canvases().length, 0, '上一张图的 canvas 必须从容器里清掉');
assert.strictEqual(empties().length, 1, '容器里应有且只有一个 .usage-chart-empty');
const emptyText = empties()[0].textContent;
assert(emptyText && emptyText.trim().length > 0, '空态文案不能是空的');
assert(/没有用量记录/.test(emptyText), '空态文案要与页面其它空态一个口径');

// ---- 3. 空态 → 有数据：空态移除，图正常重建 ----
probe.renderUsageChart(withData);
assert.strictEqual(chartInstances.length, 2, '回到有数据时应重建一张图');
assert.strictEqual(empties().length, 0, '空态节点不能残留到有数据状态');
assert.strictEqual(canvases().length, 1, '重建后 canvas 应回到容器里');

// ---- 4. 库加载失败（onerror 置位）：即使有 Chart 也要退回柱子 ----
sandbox.window.__chartLoadFailed = true;
probe.renderUsageChart(withData);
assert.strictEqual(chartInstances.length, 2, '__chartLoadFailed 为真时不应再实例化 Chart');
assert.strictEqual(chartInstances[1].destroyed, true, '退回柱子前要销毁上一张图');
assert.strictEqual(bars().length, withData.length, '每个时间点一根 DOM 柱子');
assert.strictEqual(bars()[0].tagName, 'DIV');
assert.strictEqual(canvases().length, 0, '柱子路径不应留下 canvas');
assert.strictEqual(box.role, 'list', '柱子路径容器应为 role=list（柱子是 listitem）');

// ---- 4b. 库不可用 + 0 请求：不是空白容器，同样给空态 ----
probe.renderUsageChart(noData);
assert.strictEqual(chartInstances.length, 2, '兜底路径 0 请求时也不实例化 Chart');
assert.strictEqual(bars().length, 0, '0 请求时不该画柱子');
assert.strictEqual(empties().length, 1, '兜底路径在 0 请求时也要给空态，不能留白');
assert(/没有用量记录/.test(empties()[0].textContent), '兜底空态文案与主路径同口径');

// ---- 5. window.Chart 缺失：同样退回柱子 ----
sandbox.window.__chartLoadFailed = false;
sandbox.window.Chart = undefined;
probe.renderUsageChart(withData);
assert.strictEqual(chartInstances.length, 2, 'window.Chart 缺失时不应实例化');
assert.strictEqual(bars().length, withData.length, '每个时间点一根 DOM 柱子');

process.removeAllListeners('unhandledRejection');
if (rejections.length) {
  for (const e of rejections) {
    const msg = String((e && e.message) || e);
    if (!/null|undefined|Cannot read|not a function/i.test(msg)) throw e;
  }
}

console.log('ok - 趋势图：库不可用退回柱子，0 请求给空态，切换不残留');
