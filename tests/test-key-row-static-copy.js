'use strict';
/**
 * 名称、ID、账号范围三行可复制。
 *
 * 守住的东西：
 *   1) 三行各有一个「复制」按钮，接线只在 renderKeyCard 里各一行调用，不重排、不碰别的行；
 *   2) 剪贴板里放的是页面上显示的那串人读文本（账号范围是「指定: a, b」，不是策略 JSON）；
 *   3) 值为空的行不出现按钮，而不是出现一个禁用按钮；
 *   4) 复制失败有明确提示，不误报成功；
 *   5) 复制只写剪贴板，不发请求。
 *
 * 静态断言参照 test-key-card-layout.js，行为断言参照 test-key-copy.js 的 vm 沙箱写法。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');

// 取某个顶层（缩进两格）函数的函数体：从声明处到同缩进的收尾大括号。
function fnBody(name){
  const start = HTML.indexOf(`function ${name}(`);
  assert(start > -1, `页面里找不到函数 ${name}()`);
  const end = HTML.indexOf('\n  }\n', start);
  return HTML.slice(start, end === -1 ? undefined : end);
}

const CARD = fnBody('renderKeyCard');
const CARD_CODE = CARD.replace(/^\s*\/\/.*$/gm, '');

// ---- 1. 三行各自接线：调用紧跟在自己那一行的声明之后 ----
const ROWS = [
  ['const nameRow = keyRow(\'名称\'', '名称'],
  ['const idRow = keyRow(\'ID\'', 'ID'],
  ['const scopeRow = keyRow(\'账号范围\'', '账号范围'],
];

for (const [decl, label] of ROWS){
  const declIdx = CARD_CODE.indexOf(decl);
  assert(declIdx > -1, `renderKeyCard 里找不到「${label}」行的声明`);
  const callIdx = CARD_CODE.indexOf(`attachStaticCopyButton(`, declIdx);
  assert(callIdx > -1, `「${label}」行声明之后没有接线调用`);

  // 这一行声明与下一次行声明之间，必须出现且只出现一次接线调用。
  const nextDecl = CARD_CODE.slice(declIdx).search(/\n    const \w+Row = keyRow\(/);
  const windowEnd = nextDecl > -1 ? declIdx + nextDecl : CARD_CODE.length;
  const slice = CARD_CODE.slice(declIdx, windowEnd);
  const calls = slice.match(/attachStaticCopyButton\(/g) || [];
  assert.strictEqual(calls.length, 1, `「${label}」行附近应恰好有一次接线调用，实际 ${calls.length} 次`);
  assert(callIdx < windowEnd, `「${label}」行的接线调用落到了下一行之后`);
}

// 接线调用只在这三处出现，别的行不许被顺手接上。
const totalCalls = (CARD_CODE.match(/attachStaticCopyButton\(/g) || []).length;
assert.strictEqual(totalCalls, 3, `renderKeyCard 里应只有三处接线调用，实际 ${totalCalls} 处`);
assert(!/attachStaticCopyButton\(baseRow/.test(CARD_CODE), '接口地址行的复制属于别的票据，不要接');
assert(!/attachStaticCopyButton\(tokenRow/.test(CARD_CODE), 'API Key 行的复制属于别的票据，不要接');
assert(!/attachStaticCopyButton\(modelRow/.test(CARD_CODE), '模型行的复制属于别的票据，不要接');

// ---- 2. 不越界：本票据只在 renderKeyCard 里加三行调用 ----
assert(!/addKeyRowAction\(/.test(CARD_CODE), 'renderKeyCard 里不应直接调 addKeyRowAction，按钮逻辑放进 attachStaticCopyButton 函数里');
assert(!/copyText\(/.test(CARD_CODE), 'renderKeyCard 里不应出现复制实现，文案与逻辑归 attachStaticCopyButton 函数');
assert(!/\.innerHTML\s*=/.test(HTML), '不得用 innerHTML 赋值构建 DOM');

// ---- 3. 复制走统一入口，不重复实现剪贴板 ----
const codeOnly = HTML.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
assert.strictEqual((codeOnly.match(/navigator\.clipboard/g) || []).length, 1,
  '复制入口应保持唯一，不要在 attachStaticCopyButton 里另开一条剪贴板路径');

const WIRE = fnBody('attachStaticCopyButton');
assert(/copyText\(/.test(WIRE), '复制必须复用页面统一的 copyText');
assert(/addKeyRowAction\(/.test(WIRE), '按钮应通过 addKeyRowAction 放进操作位');
assert(!/fetch\(/.test(WIRE), '复制不应发任何请求');
assert(/toast\(/.test(WIRE), '复制结果必须给用户可见提示');

// ---- 4. 行为：真跑页面脚本，用最小 DOM 驱动三行 ----
const inline = [...HTML.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1])
  .join('\n');
assert(inline.length > 1000, '没抓到页面内联脚本');

function makeElement(tag){
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    className: '',
    textContent: '',
    value: '',
    title: '',
    disabled: false,
    hidden: false,
    checked: false,
    dataset: {},
    style: {},
    attrs: {},
    options: [],
    children: [],
    parentNode: null,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild(child){ child.parentNode = el; el.children.push(child); return child; },
    removeChild(child){ el.children = el.children.filter((c) => c !== child); child.parentNode = null; },
    querySelector(sel){
      const cls = String(sel).replace(/^\./, '');
      return el.children.find((c) => String(c.className).split(/\s+/).indexOf(cls) > -1) || null;
    },
    querySelectorAll(){ return []; },
    setAttribute(k, v){ el.attrs[k] = String(v); },
    getAttribute(k){ return Object.prototype.hasOwnProperty.call(el.attrs, k) ? el.attrs[k] : null; },
    removeAttribute(k){ delete el.attrs[k]; },
    addEventListener() {},
    removeEventListener() {},
    focus() {},
    select() {},
    setSelectionRange() {},
    click() {},
    remove() {},
    getBoundingClientRect(){ return { width: 0, height: 0, top: 0, left: 0 }; },
  };
  return el;
}

const elements = new Map();
const body = makeElement('body');
const document = {
  hidden: false,
  readyState: 'loading',
  getElementById(id){
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  },
  querySelectorAll(){ return []; },
  querySelector(){ return null; },
  createElement(tag){ return makeElement(tag); },
  createDocumentFragment(){ return makeElement('fragment'); },
  addEventListener() {},
  removeEventListener() {},
  execCommand: () => false,
  body,
  documentElement: makeElement('html'),
};

const clipboard = { text: null, mode: 'ok' };
const navigator = {
  userAgent: 'node-test',
  clipboard: {
    writeText(t){
      if (clipboard.mode === 'reject') return Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
      clipboard.text = t;
      return Promise.resolve();
    },
  },
};

const window = {
  isSecureContext: true,
  addEventListener() {},
  matchMedia(){ return { matches: false, addEventListener() {} }; },
};
const location = {
  href: 'http://192.168.1.10:18080/', host: '192.168.1.10:18080', hostname: '192.168.1.10',
  port: '18080', protocol: 'http:', origin: 'http://192.168.1.10:18080',
};

const localStorage = {
  _v: new Map([['aw_admin_token', 'adm-token-from-store']]),
  getItem(k){ return this._v.has(k) ? this._v.get(k) : null; },
  setItem(k, v){ this._v.set(k, String(v)); },
  removeItem(k){ this._v.delete(k); },
};

const fetchCalls = [];
const noop = () => 0;
const sandbox = {
  document,
  window,
  navigator,
  location,
  localStorage,
  fetch: (url, opts) => { fetchCalls.push({ url: String(url), opts: opts || {} }); return new Promise(() => {}); },
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
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;

const rejections = [];
process.on('unhandledRejection', (e) => rejections.push(e));

const closer = inline.lastIndexOf('})();');
assert(closer > 0, '找不到内联脚本的 IIFE 结尾');
const patched = inline.slice(0, closer)
  + '\n;globalThis.__probe = { copyText, keyRow, attachStaticCopyButton,'
  + ' resetToasts: () => { TOAST_QUEUE.length = 0; TOAST_BUSY = false; } };\n'
  + inline.slice(closer);

vm.createContext(sandbox);
vm.runInContext(patched, sandbox, { filename: 'index.html#inline' });
const probe = sandbox.__probe;
const toastEl = document.getElementById('toast');

function buildRow(label, value){
  const row = probe.keyRow(label, value);
  probe.attachStaticCopyButton(row, label);
  return row;
}

function opsOf(row){ return row.querySelector('.key-row-ops'); }

function resetClipboard(){
  clipboard.text = null;
  clipboard.mode = 'ok';
  document.execCommand = () => false;
  probe.resetToasts();
  toastEl.textContent = '';
}

async function main(){
  assert(probe && typeof probe.attachStaticCopyButton === 'function', '页面里没有 attachStaticCopyButton');
  assert(typeof probe.keyRow === 'function', '页面里没有 keyRow');

  // ---- 4.1 名称：复制的是值节点里那串文本，提示带字段名 ----
  resetClipboard();
  {
    const row = buildRow('名称', 'Cursor IDE');
    const btn = opsOf(row).children[0];
    assert(btn, '名称行应出现复制按钮');
    assert.strictEqual(btn.textContent, '复制', '按钮文案应为「复制」');
    assert(/sm/.test(btn.className), '按钮应复用现有的 .sm 样式');
    assert.strictEqual(btn.getAttribute('aria-label'), '复制名称', '按钮需要可读的 aria-label');
    await btn.onclick();
    assert.strictEqual(clipboard.text, 'Cursor IDE', '剪贴板应是名称原文');
    assert(/名称 已复制/.test(toastEl.textContent), `成功提示应带上字段名，实际「${toastEl.textContent}」`);
    assert.strictEqual(fetchCalls.length, 0, '复制不应发起任何请求');
  }

  // ---- 4.2 ID ----
  resetClipboard();
  {
    const row = buildRow('ID', 'key_7c1f');
    const btn = opsOf(row).children[0];
    assert(btn, 'ID 行应出现复制按钮');
    await btn.onclick();
    assert.strictEqual(clipboard.text, 'key_7c1f', '剪贴板应是 ID 原文');
    assert(/ID 已复制/.test(toastEl.textContent), `ID 成功提示应带字段名，实际「${toastEl.textContent}」`);
    assert.strictEqual(fetchCalls.length, 0, '复制 ID 不应发请求');
  }

  // ---- 4.3 账号范围：复制人读描述，不是策略 JSON ----
  resetClipboard();
  {
    const row = buildRow('账号范围', '指定: a, b');
    const btn = opsOf(row).children[0];
    assert(btn, '账号范围行应出现复制按钮');
    await btn.onclick();
    assert.strictEqual(clipboard.text, '指定: a, b', '账号范围应复制人读描述');
    assert(!/^\{/.test(clipboard.text), '账号范围不能复制成 JSON');
    assert(!/mode|accounts/.test(clipboard.text), '账号范围不能泄漏策略字段名');
    assert(/账号范围 已复制/.test(toastEl.textContent), `账号范围成功提示应带字段名，实际「${toastEl.textContent}」`);
  }

  // ---- 4.4 空值：不出现按钮，而不是禁用按钮 ----
  for (const label of ['名称', 'ID', '账号范围']){
    resetClipboard();
    const row = buildRow(label, '');
    const ops = opsOf(row);
    assert.strictEqual(ops.children.length, 0, `「${label}」为空时操作位应完全为空`);
    assert(!ops.children.some((c) => c.disabled), `「${label}」为空时不应出现禁用按钮`);
  }

  // ---- 4.5 复制失败：明确失败提示，不误报成功 ----
  resetClipboard();
  window.isSecureContext = true;
  clipboard.mode = 'reject';
  document.execCommand = () => false;
  {
    const row = buildRow('名称', 'Cursor IDE');
    await opsOf(row).children[0].onclick();
    const msg = toastEl.textContent;
    assert(/复制失败/.test(msg), `复制失败必须提示失败，实际「${msg}」`);
    assert(!/已复制/.test(msg), '复制失败时不能出现「已复制」');
    assert(/名称/.test(msg), '失败提示也要说清是哪个字段');
  }

  // 局域网 http：navigator.clipboard 不存在时仍应复制成功，且不误报失败
  resetClipboard();
  window.isSecureContext = false;
  navigator.clipboard = undefined;
  {
    let copied = null;
    document.execCommand = (cmd) => { if (cmd !== 'copy') return false; copied = '兜底路径'; return true; };
    const row = buildRow('ID', 'key_local');
    await opsOf(row).children[0].onclick();
    assert(copied, '非安全上下文下应走兜底复制');
    assert(/ID 已复制/.test(toastEl.textContent), '兜底成功也应报成功');
  }

  process.removeAllListeners('unhandledRejection');
  if (rejections.length){
    for (const e of rejections){
      const msg = String((e && e.message) || e);
      if (!/null|undefined|Cannot read|not a function/i.test(msg)) throw e;
    }
  }

  console.log('✓ [All Passed] 名称 / ID / 账号范围三行可复制：空值不出按钮、失败不误报、复制不发请求');
}

main().catch((err) => {
  console.error('测试失败:', err.message);
  process.exit(1);
});
