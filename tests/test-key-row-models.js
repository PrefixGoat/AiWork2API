'use strict';

// 模型行：按需读取 + 复制清单（票 07）。
//
// 要守住的是「不在渲染卡片时给每张卡各打一次 /v1/models」这条，以及读写失败时
// 只影响自己这一行、一张卡。所以这里把页面内联脚本放进最小 DOM 里真跑一遍
// renderKeyCard，再用「点按钮」这个公开动作观察行为，而不是去翻内部变量：
//   1) 渲染后不发任何请求，行值保持占位；
//   2) 第一次点复制才读模型（先用该凭据的 token 调 /v1/models）；
//   3) 同一张卡重复点不再重复拉取；
//   4) 剪贴板是每行一个模型名，无引号无逗号；
//   5) 空集合：行显示「无可用模型」、不出现复制按钮，并在卡片上说明调不通；
//   6) 读取失败：该行降级为「读取失败」，其它行与其它卡不受影响。

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
const inline = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1])
  .join('\n');
assert(inline.length > 1000, '没抓到页面内联脚本');

// ---- 最小 DOM：够 keyRow / renderKeyCard 用 ----
function classesOf(el) {
  return String(el.className || '').split(/\s+/).filter(Boolean);
}

function findFirst(root, cls) {
  for (const child of root.children) {
    if (classesOf(child).includes(cls)) return child;
    const deep = findFirst(child, cls);
    if (deep) return deep;
  }
  return null;
}

function findAll(root, cls, out = []) {
  for (const child of root.children) {
    if (classesOf(child).includes(cls)) out.push(child);
    findAll(child, cls, out);
  }
  return out;
}

function makeEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    nodeType: 1,
    children: [],
    parentNode: null,
    attrs: {},
    dataset: {},
    style: {},
    _text: '',
    className: '',
    disabled: false,
    type: '',
    onclick: null,
    appendChild(child) {
      // DocumentFragment 落地时展开成子节点，和浏览器一致。
      if (child && child.nodeType === 11) {
        for (const node of child.children.slice()) el.appendChild(node);
        child.children.length = 0;
        return child;
      }
      child.parentNode = el;
      el.children.push(child);
      return child;
    },
    removeChild(child) {
      el.children = el.children.filter((c) => c !== child);
      child.parentNode = null;
      return child;
    },
    remove() { if (el.parentNode) el.parentNode.removeChild(el); },
    setAttribute(k, v) { el.attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(el.attrs, k) ? el.attrs[k] : null; },
    querySelector(sel) { return findFirst(el, sel.replace(/^\./, '')); },
    querySelectorAll(sel) { return findAll(el, sel.replace(/^\./, '')); },
    addEventListener() {},
    removeEventListener() {},
    focus() {},
    select() {},
  };
  el.classList = {
    add(c) { const s = new Set(classesOf(el)); s.add(c); el.className = [...s].join(' '); },
    remove(c) { el.className = classesOf(el).filter((x) => x !== c).join(' '); },
    toggle() {},
    contains(c) { return classesOf(el).includes(c); },
  };
  Object.defineProperty(el, 'textContent', {
    get() { return el._text + el.children.map((c) => c.textContent).join(''); },
    set(v) { el._text = v == null ? '' : String(v); el.children.length = 0; },
  });
  return el;
}

function makeFragment() {
  const frag = makeEl('fragment');
  frag.nodeType = 11;
  return frag;
}

const elements = new Map();
function stubById(id) {
  if (!elements.has(id)) elements.set(id, makeEl('div'));
  return elements.get(id);
}

const body = makeEl('body');
const document = {
  hidden: false,
  readyState: 'loading',
  getElementById(id) { return stubById(id); },
  querySelectorAll() { return []; },
  querySelector() { return null; },
  createElement(tag) { return makeEl(tag); },
  createDocumentFragment() { return makeFragment(); },
  addEventListener() {},
  removeEventListener() {},
  execCommand: () => false,
  body,
  documentElement: makeEl('html'),
};

const clipboard = { text: null };
const navigator = {
  userAgent: 'node-test',
  clipboard: {
    writeText(t) { clipboard.text = t; return Promise.resolve(); },
  },
};

const window = {
  isSecureContext: true,
  addEventListener() {},
  matchMedia() { return { matches: false, addEventListener() {} }; },
};
const location = {
  href: 'http://192.168.1.10:18080/', host: '192.168.1.10:18080',
  hostname: '192.168.1.10', port: '18080', protocol: 'http:',
  origin: 'http://192.168.1.10:18080',
};

const localStorage = {
  _v: new Map([['aw_admin_token', 'adm-token']]),
  getItem(k) { return this._v.has(k) ? this._v.get(k) : null; },
  setItem(k, v) { this._v.set(k, String(v)); },
  removeItem(k) { this._v.delete(k); },
};

const fetchCalls = [];
let fetchImpl = async () => { throw new Error('本用例不该发请求'); };

const noop = () => 0;
const toasts = [];
const sandbox = {
  document,
  window,
  navigator,
  location,
  localStorage,
  fetch: (url, opts) => {
    fetchCalls.push({ url: String(url), opts: opts || {} });
    return fetchImpl(String(url), opts || {});
  },
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
  toast: (m) => { toasts.push(String(m)); },
  prompt: () => null,
  confirm: () => false,
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;

const closer = inline.lastIndexOf('})();');
assert(closer > 0, '找不到内联脚本的 IIFE 结尾');
const patched = inline.slice(0, closer)
  + '\n;globalThis.__probe = { renderKeyCard };\n'
  + inline.slice(closer);

vm.createContext(sandbox);
vm.runInContext(patched, sandbox, { filename: 'index.html#inline' });
const probe = sandbox.__probe;

// ---- 夹具 ----
function makeKey(id, extra) {
  return Object.assign({
    id,
    name: '凭据 ' + id,
    token: 'sk-abc...wxyz',
    created_at: Date.now(),
    revoked: false,
    account_policy: { mode: 'all', accounts: [] },
    stats: { requests: 3 },
  }, extra || {});
}

function rowOf(card, label) {
  return findAll(card, 'key-row')
    .find((el) => el.children[0] && el.children[0].textContent === label) || null;
}

function modelRow(card) {
  const row = rowOf(card, '模型');
  assert(row, '卡片里找不到模型行');
  return row;
}

function valueOf(row) {
  const val = row.querySelector('.key-row-value');
  assert(val, '行里找不到值节点');
  return val.textContent;
}

function copyButtonOf(row) {
  return row.querySelector('.key-row-ops').children[0] || null;
}

// 让 fetch 按 /v1/models 的结果返回；token 端点固定成功。
function routeFetch(models, opts) {
  const options = opts || {};
  fetchImpl = async (url) => {
    if (url.startsWith('/api/admin/keys/')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, token: 'sk-plain-1' }) };
    }
    if (url === '/v1/models') {
      if (options.status) {
        return { ok: false, status: options.status, json: async () => ({ error: { message: 'boom' } }) };
      }
      return { ok: true, status: 200, json: async () => ({ object: 'list', data: models.map((id) => ({ id })) }) };
    }
    throw new Error('意外的请求 ' + url);
  };
}

async function main() {
  // ---- 1. 渲染不发请求，行值保持占位 ----
  fetchCalls.length = 0;
  routeFetch(['deepseek-flash']);
  const card = probe.renderKeyCard(makeKey('key_a'));
  assert.strictEqual(fetchCalls.length, 0, '渲染卡片时不得请求模型（打开列表页会变成每卡一次）');
  assert.strictEqual(valueOf(modelRow(card)), '点复制时读取', '未点复制前模型行应保持「点复制时读取」占位');

  // ---- 2. 第一次点复制才读模型 ----
  clipboard.text = null;
  const btn = copyButtonOf(modelRow(card));
  assert(btn, '模型行应有复制入口');
  await btn.onclick();
  const urls = fetchCalls.map((c) => c.url);
  assert.strictEqual(urls.filter((u) => u === '/v1/models').length, 1,
    `点复制后应恰好读一次模型，实际 ${JSON.stringify(urls)}`);
  assert(urls.some((u) => u.startsWith('/api/admin/keys/key_a/token')),
    '读模型必须先取该凭据自己的明文 token');
  assert.strictEqual(valueOf(modelRow(card)), '1 个可用', '读到后行值应变成「N 个可用」');

  // ---- 3. 复制内容是每行一个模型名，无引号无逗号 ----
  routeFetch(['deepseek-flash', 'deepseek-v4.1-flash', 'qwq-32b']);
  fetchCalls.length = 0;
  clipboard.text = null;
  const card2 = probe.renderKeyCard(makeKey('key_b'));
  await copyButtonOf(modelRow(card2)).onclick();
  assert.strictEqual(clipboard.text, 'deepseek-flash\ndeepseek-v4.1-flash\nqwq-32b',
    `剪贴板应是换行分隔的模型名，实际 ${JSON.stringify(clipboard.text)}`);
  assert(!/["',]/.test(clipboard.text), '清单里不该出现引号或逗号');
  assert.strictEqual(valueOf(modelRow(card2)), '3 个可用');

  // ---- 4. 同一张卡重复点不重复拉取 ----
  fetchCalls.length = 0;
  clipboard.text = null;
  await copyButtonOf(modelRow(card2)).onclick();
  await copyButtonOf(modelRow(card2)).onclick();
  assert.strictEqual(fetchCalls.length, 0, '已读过的卡片再点复制不应再发请求');
  assert.strictEqual(clipboard.text, 'deepseek-flash\ndeepseek-v4.1-flash\nqwq-32b', '二次复制内容应一致');
  // 只点过 key_b，key_a 的缓存不该被这一次点击影响（它仍是 1 个）。
  assert.strictEqual(valueOf(modelRow(card)), '1 个可用', '别的卡片的行值不该被这一次点击改掉');

  // ---- 5. 空集合：无可用模型、无复制按钮、卡片上有解释 ----
  routeFetch([], { status: 403 });
  fetchCalls.length = 0;
  const emptyCard = probe.renderKeyCard(makeKey('key_empty'));
  const emptyRow = modelRow(emptyCard);
  await copyButtonOf(emptyRow).onclick();
  assert.strictEqual(valueOf(emptyRow), '无可用模型', '无账号权限时行值应为「无可用模型」');
  assert.strictEqual(copyButtonOf(emptyRow), null, '无可用模型时不该留下复制按钮');
  assert(/调不通/.test(emptyCard.textContent), '卡片上要说明这份配置接上去调不通');
  assert.strictEqual(fetchCalls.filter((c) => c.url === '/v1/models').length, 1, '只应读一次');

  // ---- 6. 读取失败：只降级自己这一行 ----
  routeFetch([], { status: 500 });
  fetchCalls.length = 0;
  const failCard = probe.renderKeyCard(makeKey('key_fail'));
  const failRow = modelRow(failCard);
  await copyButtonOf(failRow).onclick();
  assert.strictEqual(valueOf(failRow), '读取失败', '失败时该行应降级为「读取失败」');
  assert.strictEqual(valueOf(rowOf(failCard, '名称')), '凭据 key_fail', '失败不该影响其它行的值');
  assert(failCard.textContent.includes('正常'), '失败不该影响卡片其它内容');
  assert(copyButtonOf(failRow), '失败后复制入口应保留，用户可重试');

  // 重试成功：失败不缓存，下次点击应重新读
  routeFetch(['deepseek-flash']);
  fetchCalls.length = 0;
  await copyButtonOf(failRow).onclick();
  assert.strictEqual(fetchCalls.filter((c) => c.url === '/v1/models').length, 1, '失败后重试必须重新读模型');
  assert.strictEqual(valueOf(failRow), '1 个可用', '重试成功后行值应恢复');

  console.log('ok - 模型行：渲染不预取、点复制才读、结果缓存、清单换行分隔、空集合与失败各自降级');
}

main().catch((err) => {
  console.error('测试失败:', err.message);
  process.exit(1);
});
