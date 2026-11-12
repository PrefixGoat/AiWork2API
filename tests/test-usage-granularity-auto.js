'use strict';

// 用量趋势粒度三档：自动 / 按小时 / 按天。
// 自动按窗口长度算（≤48 小时用小时，否则用天），但发给服务端的永远是 hour/day。
// 同 test-usage-range-select.js：把内联脚本塞进最小 DOM 桩里真跑，不用字符串匹配猜行为。

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');

// 1) 静态标记：三档都在，自动默认高亮。
const granBlock = (html.match(/<div class="usage-range" id="usageGranularity"[\s\S]*?<\/div>/) || [])[0];
assert(granBlock, '找不到粒度按钮组 #usageGranularity');
const granButtons = [...granBlock.matchAll(/<button\b[^>]*data-gran="([^"]+)"[^>]*>/g)];
assert.deepStrictEqual(
  granButtons.map(m => m[1]),
  ['auto', 'hour', 'day'],
  '粒度按钮应从「自动」开始，共三档'
);
assert(/class="[^"]*\bon\b[^"]*"/.test(granButtons[0][0]), '自动档应默认高亮');
assert(!/class="[^"]*\bon\b[^"]*"/.test(granButtons.find(m => m[1] === 'day')[0]), '按天不该再默认高亮');
// 首屏不靠运行时补 aria-pressed：三档状态直接写在标记上。
assert(/aria-pressed="true"/.test(granButtons[0][0]), '自动档静态标记应为 aria-pressed=true');
assert(/aria-pressed="false"/.test(granButtons.find(m => m[1] === 'hour')[0]), '按小时静态标记应为 aria-pressed=false');
assert(/aria-pressed="false"/.test(granButtons.find(m => m[1] === 'day')[0]), '按天静态标记应为 aria-pressed=false');

const inline = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)]
  .map(m => m[1])
  .join('\n');
assert(inline.length > 1000, '没抓到页面内联脚本');

function makeElement(id) {
  const attrs = new Map();
  const classes = new Set();
  return {
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
    classList: {
      add(c) { classes.add(c); },
      remove(c) { classes.delete(c); },
      toggle(c, on) { if (on) classes.add(c); else classes.delete(c); },
      contains(c) { return classes.has(c); },
    },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    appendChild() {},
    removeChild() {},
    addEventListener() {},
    removeEventListener() {},
    setAttribute(k, v) { attrs.set(k, String(v)); },
    getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
    removeAttribute(k) { attrs.delete(k); },
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

const rejections = [];
process.on('unhandledRejection', (e) => rejections.push(e));

const closer = inline.lastIndexOf('})();');
assert(closer > 0, '找不到内联脚本的 IIFE 结尾');
const patched = inline.slice(0, closer)
  + '\n;globalThis.__probe = { state, applyUsageRange, usageQuery, setUsageGran, usageWindow };\n'
  + inline.slice(closer);

vm.createContext(sandbox);
vm.runInContext(patched, sandbox, { filename: 'index.html#inline' });

const probe = sandbox.__probe;
assert(probe && probe.state, '内联脚本没有暴露 state');

const query = () => new URLSearchParams(probe.usageQuery().split('?')[1]);
const granOf = () => query().get('granularity');

// 2) 默认档位是自动，并且自动档下 7 天算出按天。
assert.strictEqual(probe.state.usageGran, 'auto', '默认粒度应为自动');
probe.applyUsageRange('7d');
assert.strictEqual(granOf(), 'day', '自动档下近 7 天应按天');

// 3) 今天 → 小时，7 天 / 30 天 → 天（沿用原有两条断言的口径）。
probe.applyUsageRange('today');
assert.strictEqual(granOf(), 'hour', '自动档下今天应按小时');
for (const [range, hours] of [['7d', '168'], ['30d', '720']]) {
  probe.applyUsageRange(range);
  assert.strictEqual(query().get('hours'), hours, `${range} 应折算成 ${hours} 小时`);
  assert.strictEqual(granOf(), 'day', `自动档下 ${range} 应按天`);
}

// 4) 自定义范围按跨度算：12 小时 → 小时，5 天 → 天。
document.getElementById('usageFrom').value = '2026-11-10T00:00';
document.getElementById('usageTo').value = '2026-11-10T12:00';
probe.applyUsageRange('custom');
assert.strictEqual(granOf(), 'hour', '自动档下 12 小时的自定义范围应按小时');

document.getElementById('usageFrom').value = '2026-11-05T00:00';
document.getElementById('usageTo').value = '2026-11-10T00:00';
probe.applyUsageRange('custom');
assert.strictEqual(granOf(), 'day', '自动档下 5 天的自定义范围应按天');

// 4b) 跨度正好 0 小时（同一起止时刻）仍按小时：0 不能被当成「没有窗口」退回按天。
document.getElementById('usageFrom').value = '2026-11-10T00:00';
document.getElementById('usageTo').value = '2026-11-10T00:00';
probe.applyUsageRange('custom');
assert.strictEqual(granOf(), 'hour', '0 小时跨度属于「≤48 小时」，应按小时');

// 5) 手动选小时/天后，改范围不得覆盖用户选择。
probe.setUsageGran('hour');
probe.applyUsageRange('7d');
assert.strictEqual(probe.state.usageGran, 'hour', '手动选小时后再切 7 天，选择不该被顶掉');
assert.strictEqual(granOf(), 'hour', '手动选小时后再切 7 天，请求仍按小时');

probe.setUsageGran('day');
probe.applyUsageRange('today');
assert.strictEqual(probe.state.usageGran, 'day', '手动选按天后再切今天，选择不该被顶掉');
assert.strictEqual(granOf(), 'day', '手动选按天后再切今天，请求仍按天');

// 6) 切回自动后恢复按窗口算。
probe.setUsageGran('auto');
probe.applyUsageRange('today');
assert.strictEqual(granOf(), 'hour', '切回自动后今天应按小时');

// 7) 任何情况下请求串里都不能出现 granularity=auto（服务端会 400）。
for (const range of ['today', '7d', '30d']) {
  for (const gran of ['auto', 'hour', 'day']) {
    probe.setUsageGran(gran);
    probe.applyUsageRange(range);
    const raw = probe.usageQuery();
    assert(!/granularity=auto/.test(raw), `${range}/${gran} 的请求串泄漏了 granularity=auto：${raw}`);
    if (gran === 'auto') {
      assert(['hour', 'day'].includes(granOf()), `${range} 的自动档应解析成 hour 或 day`);
    }
  }
}

// 8) 三段按钮的高亮与 aria-pressed 随状态同步。
const granBox = document.getElementById('usageGranularity');
const fakeButtons = ['auto', 'hour', 'day'].map((gran) => {
  const btn = makeElement('button');
  btn.dataset = { gran };
  btn.setAttribute('data-gran', gran);
  return btn;
});
granBox.querySelectorAll = (sel) => (sel === '[data-gran]' ? fakeButtons : []);
probe.setUsageGran('hour');
const byGran = Object.fromEntries(fakeButtons.map(b => [b.dataset.gran, b]));
assert.strictEqual(byGran.hour.getAttribute('aria-pressed'), 'true', '选中的档位 aria-pressed=true');
assert.strictEqual(byGran.auto.getAttribute('aria-pressed'), 'false', '未选中的档位 aria-pressed=false');
assert(byGran.hour.classList.contains('on'), '选中的档位应带 .on');
assert(!byGran.day.classList.contains('on'), '未选中的档位不应带 .on');

process.removeAllListeners('unhandledRejection');
if (rejections.length) {
  for (const e of rejections) {
    const msg = String((e && e.message) || e);
    if (!/null|undefined|Cannot read|not a function/i.test(msg)) throw e;
  }
}

console.log('ok - 用量趋势粒度：自动为默认的三档，请求只发 hour/day');
