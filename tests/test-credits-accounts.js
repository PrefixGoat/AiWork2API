'use strict';

// 积分卡「按账号」分条：总额行的两个数（可用 / 总额）、逐账号条的顺序与配色、
// 失败账号的灰行与「未计入合计」提示。
// 做法与 test-usage-trend-series.js 一致：把页面内联脚本塞进 vm 沙箱跑一遍，
// 末尾追加探针把顶层函数挂到 globalThis.__probe 上，测的是页面里真正会跑的那份代码。

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
const inline = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)]
  .map(m => m[1])
  .join('\n');
assert(inline.length > 1000, '没抓到页面内联脚本');

// 能挂树的最小元素：appendChild 真记录子节点，closest 沿 parentNode 上溯，
// 这样断言的是「生成出来的 DOM 结构」，而不是桩里的几个字段。
function makeElement(tag) {
  let text = '';
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    className: '',
    title: '',
    hidden: false,
    dataset: {},
    style: {},
    children: [],
    parentNode: null,
    get textContent() { return text; },
    // 与真实 DOM 一致：写 textContent 会清空子节点
    set textContent(v) { text = String(v); this.children.length = 0; },
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
      toggle() {},
    },
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      return child;
    },
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    getAttribute() { return null; },
    removeAttribute() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest(sel) {
      const want = String(sel).replace(/^\./, '');
      let node = this;
      while (node) {
        if (String(node.className).split(/\s+/).includes(want)) return node;
        node = node.parentNode;
      }
      return null;
    },
    scrollIntoView() {},
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
    if (!elements.has(id)) elements.set(id, makeElement('div'));
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
  localStorage: {
    _v: new Map(),
    getItem(k) { return this._v.has(k) ? this._v.get(k) : null; },
    setItem(k, v) { this._v.set(k, String(v)); },
    removeItem(k) { this._v.delete(k); },
  },
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

const closer = inline.lastIndexOf('})();');
assert(closer > 0, '找不到内联脚本的 IIFE 结尾');
const patched = inline.slice(0, closer)
  + '\n;globalThis.__probe = { creditsTotalText, creditsAvailPct, creditsBarClass, paintCreditsAccounts };\n'
  + inline.slice(closer);

vm.createContext(sandbox);
vm.runInContext(patched, sandbox, { filename: 'index.html#inline' });

const probe = sandbox.__probe || {};
assert(typeof probe.creditsTotalText === 'function', '页面没有暴露 creditsTotalText');
assert(typeof probe.paintCreditsAccounts === 'function', '页面没有暴露 paintCreditsAccounts');
assert(typeof probe.creditsAvailPct === 'function', '页面没有暴露 creditsAvailPct');
assert(typeof probe.creditsBarClass === 'function', '页面没有暴露 creditsBarClass');
const { creditsTotalText, creditsAvailPct, creditsBarClass, paintCreditsAccounts } = probe;

const el = (id) => document.getElementById(id);

/* 1. 总额行：可用在前、总额在后；缺一个退化成一个数，全缺为 — */
assert.strictEqual(creditsTotalText(5600, 3343.2), '3,343.2 / 5,600', '总额行必须是「可用 / 总额」');
assert.strictEqual(creditsTotalText(5600, null), '5,600', '没有可用值时只显示总额');
assert.strictEqual(creditsTotalText(null, 3343.2), '—', '没有总额时显示 —');

/* 1b. 总条也按可用占比（与逐账号条同一套函数）：5600 用 2256.8 → 可用 59.7% */
const totalPct = creditsAvailPct(5600, 3343.2, 2256.8);
assert.ok(Math.abs(totalPct - 59.699999) < 1e-6, '总条宽度必须是可用占比');
assert.strictEqual(creditsBarClass(totalPct), 'dash-progress', '可用 60% 仍是绿色');
assert.strictEqual(creditsBarClass(creditsAvailPct(100, 30, 70)), 'dash-progress warn', '可用 30% 转黄');
assert.strictEqual(creditsBarClass(creditsAvailPct(100, 10, 90)), 'dash-progress danger', '可用 10% 转红');
assert.strictEqual(creditsAvailPct(0, 0, 0), null, '总额为 0 时不算占比');
assert.strictEqual(creditsAvailPct(100, null, 70), 30, '缺可用值时按总额减已用兜底');

/* 2. 三条账号：两个读取成功 + 一个失败 */
const overview = {
  ok: true,
  accounts: {
    acc_b: { ok: true, total: 300, used: 0.05, remaining: 299.95, all_remaining: 299.95, plan_name: 'Trial' },
    acc_a: { ok: true, total: 5300, used: 2256.75, remaining: 3043.25, all_remaining: 3043.25, plan_name: 'Teams' },
    acc_x: { ok: false, error: 'boom' },
  },
};
const poolAccounts = [
  { id: 'acc_a', name: 'acc_12fc2c11' },
  { id: 'acc_b', name: '' },
  { id: 'acc_x', name: 'acc_9b21e4a0' },
];

paintCreditsAccounts(overview, poolAccounts);

const wrap = el('dashCreditsAccts');
const list = el('dashCreditsAcctList');
const gap = el('dashCreditsGap');

assert.strictEqual(wrap.hidden, false, '有数据时必须显示分条');
assert.strictEqual(list.children.length, 3, '三个账号都要有一条');

// 总额降序：5300 → 300，读取失败的排最后
assert.deepStrictEqual(
  list.children.map(r => r.dataset.accountId),
  ['acc_a', 'acc_b', 'acc_x'],
  '按总额降序，失败账号排最后',
);

// 名称：优先 pool 的 name，为空时回退账号 id
assert.strictEqual(list.children[0].children[0].children[0].textContent, 'acc_12fc2c11', '优先显示 pool 里的名称');
assert.strictEqual(list.children[1].children[0].children[0].textContent, 'acc_b', 'name 为空时回退 id');

// 数值：剩余 / 总额
const topA = list.children[0].children[0];
assert.strictEqual(topA.children[1].textContent, 'Teams', '显示套餐名');
assert.strictEqual(topA.children[2].textContent, '3,043.25', '显示剩余值');
assert.strictEqual(topA.children[2].children[0].textContent, ' / 5,300', '剩余后面跟总额');

// 进度条按「可用占比」填充：3043.25 / 5300 ≈ 57.42%（绿条＝还能用多少）
const barA = list.children[0].children[1];
assert.strictEqual(barA.className, 'dash-progress', '可用 57% 不触发告警配色');
assert.ok(String(barA.children[0].style.width).startsWith('57.4'), '填充宽度必须是可用占比');

// 失败账号：灰行 + 读取失败 + 空条
const rowX = list.children[2];
assert.ok(rowX.className.indexOf('bad') >= 0, '失败账号要有坏态样式');
assert.strictEqual(rowX.children[0].children[1].textContent, '读取失败', '失败账号标注读取失败');
assert.strictEqual(rowX.children[0].children[2].textContent, '—', '失败账号数值留空');

// 未计入合计提示
assert.strictEqual(gap.hidden, false, '有账号读取失败时必须给未计入提示');
assert.ok(/1 个账号未计入/.test(gap.textContent), '提示要说明几个账号未计入');

/* 3. 配色阈值：可用见底才告警（可用 ≤15% 红、≤40% 黄） */
paintCreditsAccounts({
  ok: true,
  accounts: { acc_h: { ok: true, total: 100, used: 90, remaining: 10, all_remaining: 10, plan_name: 'Hot' } },
}, [{ id: 'acc_h', name: 'hot' }]);
const hotBar = el('dashCreditsAcctList').children[0].children[1];
assert.ok(/danger/.test(hotBar.className), '可用只剩 10% 必须用 danger 配色');
assert.ok(String(hotBar.children[0].style.width).startsWith('10'), '红条长度就是可用占比');

paintCreditsAccounts({
  ok: true,
  accounts: { acc_w: { ok: true, total: 100, used: 70, remaining: 30, all_remaining: 30, plan_name: 'Warn' } },
}, [{ id: 'acc_w', name: 'warn' }]);
const warnBar = el('dashCreditsAcctList').children[0].children[1];
assert.ok(/warn/.test(warnBar.className), '可用剩 30% 必须用 warn 配色');
assert.ok(!/danger/.test(warnBar.className), '可用剩 30% 不应直接转红');

/* 4. 单账号不隐藏（设计要求：与总条重复也保留） */
assert.strictEqual(el('dashCreditsAccts').hidden, false, '单账号时也要显示分条');

/* 4b. 名称与 id 相同时显示完整 id（设计要求：不截断） */
paintCreditsAccounts({
  ok: true,
  accounts: { 'acc_3ef508cb-dd0c-11': { ok: true, total: 300, used: 1, remaining: 299, all_remaining: 299, plan_name: 'Trial' } },
}, [{ id: 'acc_3ef508cb-dd0c-11', name: 'acc_3ef508cb-dd0c-11' }]);
assert.strictEqual(
  el('dashCreditsAcctList').children[0].children[0].children[0].textContent,
  'acc_3ef508cb-dd0c-11',
  'name 等于 id 时必须显示完整 id，不得截断',
);

/* 5. 无数据 / 读取失败整表：收起分条并清空提示 */
paintCreditsAccounts(null, null);
assert.strictEqual(el('dashCreditsAccts').hidden, true, '没有积分数据时收起分条');
assert.strictEqual(el('dashCreditsAcctList').children.length, 0, '收起时要清空节点');
assert.strictEqual(el('dashCreditsGap').hidden, true, '收起时提示也要隐藏');

paintCreditsAccounts({ ok: false, accounts: {}, error: 'reauth_required' }, []);
assert.strictEqual(el('dashCreditsAccts').hidden, true, '整体不可用时收起分条');

/* 6. 点击委托已挂上（实际跳转由 switchTab 负责，不在本测试范围） */
paintCreditsAccounts(overview, poolAccounts);
assert.strictEqual(typeof el('dashCreditsAcctList').onclick, 'function', '分条容器要挂上点击委托');

console.log('✓ 积分卡按账号分条：总额两值 / 排序 / 名称完整显示 / 配色 / 失败态 / 未计入提示（共 6 组断言）通过');
