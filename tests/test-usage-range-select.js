'use strict';

// 用量页的时间范围选择：不是拿源码做字符串匹配，而是把页面里的内联脚本放进
// 一个最小 DOM 桩里真跑一遍，点「今天」之后看状态与请求参数。
// 之前这里出过 bug：范围白名单只列了 7d/30d，点「今天」被静默改回「近 7 天」。

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
const inline = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)]
  .map(m => m[1])
  .join('\n');
assert(inline.length > 1000, '没抓到页面内联脚本');

function makeElement(id) {
  const el = {
    id,
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
    appendChild() {},
    removeChild() {},
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    getAttribute() { return null; },
    removeAttribute() {},
    focus() {},
    click() {},
    getBoundingClientRect() { return { width: 0, height: 0, top: 0, left: 0 }; },
  };
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

const noop = () => 0;
const sandbox = {
  document,
  window: { addEventListener() {}, matchMedia() { return { matches: false, addEventListener() {} }; } },
  navigator: { userAgent: 'node-test', clipboard: { writeText() {} } },
  location: { href: 'http://127.0.0.1:18080/', origin: 'http://127.0.0.1:18080' },
  localStorage: { _v: new Map(), getItem(k) { return this._v.has(k) ? this._v.get(k) : null; }, setItem(k, v) { this._v.set(k, String(v)); }, removeItem(k) { this._v.delete(k); } },
  fetch: () => new Promise(() => {}),
  Chart: class { constructor() {} destroy() {} update() {} },
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

// 页面末尾的 init 会立刻发请求；给 fetch 一个永不 resolve 的 Promise，
// 并吞掉随之而来的未处理拒绝，我们只关心它之前的纯状态机。
const rejections = [];
process.on('unhandledRejection', (e) => rejections.push(e));

// 整段脚本包在 (function(){ ... })() 里，探针必须插在闭包内部才能拿到 state。
const closer = inline.lastIndexOf('})();');
assert(closer > 0, '找不到内联脚本的 IIFE 结尾');
const patched = inline.slice(0, closer)
  + '\n;globalThis.__probe = { state, applyUsageRange, usageWindow, usageQuery, RANGE_HOURS };\n'
  + inline.slice(closer);

vm.createContext(sandbox);
vm.runInContext(patched, sandbox, { filename: 'index.html#inline' });

const probe = sandbox.__probe;
assert(probe && probe.state, '内联脚本没有暴露 state');
assert(probe.applyUsageRange, '找不到 applyUsageRange');

// 1) 四个按钮点下去，状态都要停在点中的那个上。
for (const range of ['today', '7d', '30d', 'custom']) {
  probe.applyUsageRange(range);
  assert.strictEqual(
    probe.state.usageRange,
    range,
    `点了「${range}」之后状态被改成了「${probe.state.usageRange}」`
  );
}

// 2) 「今天」不能退化成滚动小时窗口：要带 from/to，且不带 hours。
probe.applyUsageRange('today');
const q = new URLSearchParams(probe.usageQuery().split('?')[1]);
assert(q.get('from') && q.get('to'), '「今天」必须发 from/to，而不是 hours');
assert.strictEqual(q.get('hours'), null, '「今天」不该再带 hours 参数');
const from = new Date(q.get('from'));
const to = new Date(q.get('to'));
assert.strictEqual(from.getHours(), 0, '「今天」的起点必须是本地零点');
assert.strictEqual(from.getMinutes(), 0, '「今天」的起点必须是本地零点');
assert.strictEqual(from.getDate(), to.getDate(), '「今天」的起点与终点必须是同一天');
assert.strictEqual(q.get('granularity'), 'hour', '「今天」默认按小时看');

// 3) 7 天/30 天仍是滚动小时窗口，粒度回到天。
for (const [range, hours] of [['7d', '168'], ['30d', '720']]) {
  probe.applyUsageRange(range);
  const qq = new URLSearchParams(probe.usageQuery().split('?')[1]);
  assert.strictEqual(qq.get('hours'), hours, `${range} 应折算成 ${hours} 小时`);
  assert.strictEqual(qq.get('from'), null, `${range} 不该带 from`);
  assert.strictEqual(qq.get('granularity'), 'day', `${range} 默认按天看`);
}

// 4) 传进来一个不认识的范围，回落到 7 天，而不是把页面卡在空白状态。
probe.applyUsageRange('bogus');
assert.strictEqual(probe.state.usageRange, '7d', '未知范围应回落到近 7 天');

process.removeAllListeners('unhandledRejection');
if (rejections.length) {
  // 只允许 init 阶段因为 DOM 桩不完整产生的拒绝，别的一律暴露出来。
  for (const e of rejections) {
    const msg = String((e && e.message) || e);
    if (!/null|undefined|Cannot read|not a function/i.test(msg)) throw e;
  }
}

console.log('ok - 用量时间范围：今天/7 天/30 天/自定义 选择与查询参数');
