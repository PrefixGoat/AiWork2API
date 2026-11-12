'use strict';

// 一键复制接入配置（JSON）+ 格式选择 + 可折叠预览（票 08）。
//
// 这张票的价值不在 JSON 本身，而在「格式档」这层结构：09（ENV）、10（curl）
// 只往格式表里 push 一项，不许改按钮、下拉和预览逻辑。所以这里除了断言输出口径，
// 还要钉住三件结构性的事：
//   1) 格式化是与 DOM 无关的纯函数，能被单测直接调用；
//   2) 格式表是一个数组，追加一项就能被下拉与复制按钮认出来；
//   3) 预览走「掩码后的 ctx」，剪贴板走真值；折叠时不渲染内容。
//
// 页面没有 DOM 测试环境：纯函数用 vm 沙箱把内联脚本真跑一遍，
// 结构用静态断言（沿用 test-key-reveal.js / test-key-card-layout.js 的写法）。

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
const inline = [...HTML.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1])
  .join('\n');
assert(inline.length > 1000, '没抓到页面内联脚本');

// ---- 最小 DOM：够脚本初始化跑完，也够跑通 renderKeyCard 与复制按钮 ----
function classesOf(el) {
  return String(el.className || '').split(/\s+/).filter(Boolean);
}

function findAll(root, cls, out = []) {
  for (const child of root.children) {
    if (classesOf(child).includes(cls)) out.push(child);
    findAll(child, cls, out);
  }
  return out;
}

function findFirst(root, cls) {
  for (const child of root.children) {
    if (classesOf(child).includes(cls)) return child;
    const deep = findFirst(child, cls);
    if (deep) return deep;
  }
  return null;
}

function makeElement(tag) {
  const el = {
    nodeType: 1,
    tagName: String(tag || 'div').toUpperCase(),
    id: '',
    value: '',
    innerHTML: '',
    checked: false,
    disabled: false,
    hidden: false,
    className: '',
    title: '',
    parentNode: null,
    dataset: {},
    style: {},
    attrs: {},
    options: [],
    children: [],
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
    querySelector(sel) { return findFirst(el, String(sel).replace(/^\./, '')); },
    querySelectorAll(sel) { return findAll(el, String(sel).replace(/^\./, '')); },
    addEventListener() {},
    removeEventListener() {},
    setAttribute(k, v) { el.attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(el.attrs, k) ? el.attrs[k] : null; },
    removeAttribute(k) { delete el.attrs[k]; },
    focus() {},
    select() {},
    click() { if (typeof el.onclick === 'function') return el.onclick(); return undefined; },
    getBoundingClientRect() { return { width: 0, height: 0, top: 0, left: 0 }; },
  };
  el.classList = {
    add(c) { const s = new Set(classesOf(el)); s.add(c); el.className = [...s].join(' '); },
    remove(c) { el.className = classesOf(el).filter((x) => x !== c).join(' '); },
    toggle() {},
    contains(c) { return classesOf(el).includes(c); },
  };
  let text = '';
  Object.defineProperty(el, 'textContent', {
    get() { return text + el.children.map((c) => c.textContent).join(''); },
    set(v) { text = v == null ? '' : String(v); el.children.length = 0; },
  });
  return el;
}

function makeFragment() {
  const frag = makeElement('fragment');
  frag.nodeType = 11;
  return frag;
}

const elements = new Map();
const document = {
  hidden: false,
  readyState: 'loading',
  getElementById(id) {
    if (!elements.has(id)) {
      const el = makeElement('div');
      el.id = id;
      elements.set(id, el);
    }
    return elements.get(id);
  },
  querySelectorAll() { return []; },
  querySelector() { return null; },
  createElement(tag) { return makeElement(tag); },
  createDocumentFragment() { return makeFragment(); },
  addEventListener() {},
  removeEventListener() {},
  execCommand: () => false,
  body: makeElement('body'),
  documentElement: makeElement('html'),
};

const localStorage = {
  _v: new Map(),
  getItem(k) { return this._v.has(k) ? this._v.get(k) : null; },
  setItem(k, v) { this._v.set(k, String(v)); },
  removeItem(k) { this._v.delete(k); },
};

const noop = () => 0;
const clipboard = { text: null };
const fetchCalls = [];
let fetchImpl = () => new Promise(() => {});

const sandbox = {
  document,
  window: { isSecureContext: true, addEventListener() {}, matchMedia() { return { matches: false, addEventListener() {} }; } },
  navigator: {
    userAgent: 'node-test',
    clipboard: { writeText(t) { clipboard.text = String(t); return Promise.resolve(); } },
  },
  location: { href: 'http://192.168.1.10:18080/', host: '192.168.1.10:18080', hostname: '192.168.1.10', port: '18080', protocol: 'http:', origin: 'http://192.168.1.10:18080' },
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
  toast: () => {},
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;

const rejections = [];
process.on('unhandledRejection', (e) => rejections.push(e));

const closer = inline.lastIndexOf('})();');
assert(closer > 0, '找不到内联脚本的 IIFE 结尾');
const patched = inline.slice(0, closer)
  + '\n;globalThis.__probe = { COPY_FORMATS, formatById, pickModel, maskKey, maskContext, loadFormatChoice, saveFormatChoice, renderKeyCard,'
  + ' resetToasts: () => { TOAST_QUEUE.length = 0; TOAST_BUSY = false; } };\n'
  + inline.slice(closer);

vm.createContext(sandbox);
vm.runInContext(patched, sandbox, { filename: 'index.html#inline' });
const probe = sandbox.__probe;

function finish() {
  process.removeAllListeners('unhandledRejection');
  if (rejections.length) {
    // 只允许 init 阶段因为 DOM 桩不完整产生的拒绝，别的一律暴露出来。
    for (const e of rejections) {
      const msg = String((e && e.message) || e);
      if (!/null|undefined|Cannot read|not a function/i.test(msg)) throw e;
    }
  }
}

// ---- 1. 格式表：数组 + 每项 { id, label, format(ctx) }，JSON 是其中一项 ----
assert(Array.isArray(probe.COPY_FORMATS), 'COPY_FORMATS 必须是数组，否则后面两张票没法 push');
assert(probe.COPY_FORMATS.length >= 1, '格式表不能为空');
probe.COPY_FORMATS.forEach((f) => {
  assert(typeof f.id === 'string' && f.id, '格式项必须有字符串 id');
  assert(typeof f.label === 'string' && f.label, '格式项必须有 label');
  assert.strictEqual(typeof f.format, 'function', '格式项必须有 format(ctx) 纯函数');
});

const jsonFmt = probe.formatById('json');
assert(jsonFmt && jsonFmt.id === 'json', '格式表里必须有 json 这一项');
assert.strictEqual(probe.formatById('not-a-format'), probe.COPY_FORMATS[0], '未知格式应回落到第一项，而不是抛错');

const CTX = {
  keyName: 'Cursor IDE',
  baseUrl: 'http://192.168.1.10:18080/v1',
  apiKey: 'sk-live-abcdefghijklwxyz',
  model: 'deepseek-flash',
  models: ['deepseek-flash', 'deepseek-v4.1-flash'],
};

// ---- 2. JSON 档：七个键、口径正确、能被 JSON.parse ----
{
  const text = jsonFmt.format(CTX);
  assert.strictEqual(typeof text, 'string', 'format(ctx) 必须返回字符串');
  const parsed = JSON.parse(text); // 解析不了就是硬失败
  assert.deepStrictEqual(
    Object.keys(parsed).sort(),
    ['api_key', 'base_url', 'endpoints', 'key_name', 'model', 'models', 'provider'],
    'JSON 顶层键必须正好是规格里的七个'
  );
  assert.strictEqual(parsed.provider, 'aiwork', 'provider 固定为 aiwork');
  assert.strictEqual(parsed.key_name, 'Cursor IDE', 'key_name 应取凭据展示名');
  assert.strictEqual(parsed.base_url, 'http://192.168.1.10:18080/v1', 'base_url 必须是带 /v1 的接口地址');
  assert.strictEqual(parsed.api_key, CTX.apiKey, 'api_key 必须是真值');
  assert.strictEqual(parsed.model, 'deepseek-flash', 'model 应是具体模型名');
  assert.deepStrictEqual(parsed.models, CTX.models, 'models 原样带上');
  assert.deepStrictEqual(
    parsed.endpoints,
    {
      chat_completions: '/v1/chat/completions',
      responses: '/v1/responses',
      messages: '/v1/messages',
    },
    'endpoints 只给三条，值是相对路径'
  );
}

// ---- 3. 中文、多行、引号、反斜杠都原样保留，不被转成 \\uXXXX ----
{
  const odd = {
    keyName: '中文名 "引号" \\ 反斜杠',
    baseUrl: 'http://192.168.1.10:18080/v1',
    apiKey: 'sk-odd',
    model: 'deepseek-flash',
    models: ['deepseek-flash'],
  };
  const text = jsonFmt.format(odd);
  assert(!/\\u[0-9a-fA-F]{4}/.test(text), '中文不应被转成 \\uXXXX 转义序列');
  assert(text.includes('中文名'), '中文必须原样出现在输出里');
  assert.strictEqual(JSON.parse(text).key_name, odd.keyName, '引号与反斜杠必须能原样还原');

  const multi = { ...odd, keyName: '第一行\n第二行\t结尾' };
  const multiText = jsonFmt.format(multi);
  assert.strictEqual(JSON.parse(multiText).key_name, '第一行\n第二行\t结尾', '多行名称必须能原样还原');
}

// ---- 4. 模型列表为空：models 是空数组，不抛错 ----
{
  const empty = { ...CTX, models: [], model: 'automodel' };
  const parsed = JSON.parse(jsonFmt.format(empty));
  assert.deepStrictEqual(parsed.models, [], '模型列表为空时 models 应是空数组');
  assert.strictEqual(parsed.model, 'automodel', '模型列表为空时 model 退回 automodel');
}

// ---- 5. 模型挑选：回落模型优先，不在清单里取第一个，清单为空用 automodel ----
{
  const pick = probe.pickModel;
  assert.strictEqual(typeof pick, 'function', '缺少模型挑选函数 pickModel');
  assert.strictEqual(pick('deepseek-flash', ['deepseek-flash', 'x']), 'deepseek-flash', '回落模型在清单里时应直接用它');
  assert.strictEqual(pick('not-in-list', ['a', 'b']), 'a', '回落模型不在该凭据可调范围内时取清单第一个');
  assert.strictEqual(pick('', ['a', 'b']), 'a', '没读到回落模型时取清单第一个');
  assert.strictEqual(pick('deepseek-flash', []), 'automodel', '清单为空时退回 automodel');
  assert.strictEqual(pick(null, null), 'automodel', '清单缺失也不能抛错');
}

// ---- 6. 预览掩码：不出现完整 key，长 key 保留首尾 ----
{
  const mask = probe.maskKey;
  assert.strictEqual(typeof mask, 'function', '缺少预览掩码函数 maskKey');
  const masked = mask('sk-abc1234567wxyz');
  assert.strictEqual(masked, 'sk-abc…wxyz', '掩码应保留首 6 位与末 4 位');
  assert(!mask('sk-abc1234567wxyz').includes('1234567'), '掩码不能露出中段');
  assert.strictEqual(mask('short'), 'sho…', '长度不足以留首尾时只留前 3 位，中段仍然藏住');
  assert.strictEqual(mask(''), '');

  // 9–11 位的 key 最容易出事：旧实现首 6 + 末 4 会把整串拼回来。
  // 每个长度都必须满足：掩码不等于原值，且原值不会被完整包含。
  for (const key of ['abcdefgh', 'abcdefghi', 'abcdefghij', 'abcdefghijk', 'abcdefghijkl']) {
    const out = mask(key);
    assert.notStrictEqual(out, key, `${key.length} 位 key 的掩码不能等于原值`);
    assert(!out.includes(key), `${key.length} 位 key 的掩码不能包含完整原值`);
    assert(out.includes('…'), `${key.length} 位 key 的掩码必须带省略号`);
    assert(key.length - (out.replace('…', '').length) >= 2,
      `${key.length} 位 key 的掩码至少要藏住 2 位，实际「${out}」`);
  }

  // 预览就是把掩码后的 ctx 喂给同一个 format：输出里不能出现真 key。
  const previewText = jsonFmt.format(probe.maskContext(CTX));
  assert(!previewText.includes(CTX.apiKey), '预览里绝不能出现完整 key');
  assert(previewText.includes('…'), '预览里的 key 必须是掩码形态');
  assert.strictEqual(JSON.parse(previewText).model, 'deepseek-flash', '除 key 之外的字段预览应保持原样');
}

// ---- 7. 格式选择持久化：键名 aw_copy_fmt，刷新后仍是上次选的 ----
{
  assert.strictEqual(typeof probe.saveFormatChoice, 'function', '缺少格式选择的保存函数');
  assert.strictEqual(typeof probe.loadFormatChoice, 'function', '缺少格式选择的读取函数');
  probe.saveFormatChoice('json');
  assert.strictEqual(localStorage.getItem('aw_copy_fmt'), 'json', '格式选择必须写进 aw_copy_fmt');
  assert.strictEqual(probe.loadFormatChoice(), 'json', '应读回上次选的格式');
  localStorage.setItem('aw_copy_fmt', 'bogus-format');
  assert.strictEqual(probe.loadFormatChoice(), 'json', '存了个不存在的格式时应回落默认档，而不是让下拉变空');
  localStorage.removeItem('aw_copy_fmt');
  assert.strictEqual(probe.loadFormatChoice(), 'json', '没存过时默认 JSON');
}

// ---- 8. 加一档只需 push 一项：下拉、复制都认 ----
{
  const before = probe.COPY_FORMATS.length;
  probe.COPY_FORMATS.push({ id: 'tmp-env', label: '临时档', format: (ctx) => 'KEY=' + ctx.apiKey });
  try {
    assert.strictEqual(probe.formatById('tmp-env').format({ apiKey: 'v' }), 'KEY=v', 'push 进去的格式应能被查到并调用');
    assert.strictEqual(probe.COPY_FORMATS.length, before + 1, '格式表应可直接追加');
  } finally {
    probe.COPY_FORMATS.pop();
  }
}

// ---- 9. 静态：结构、预览掩码、撤销禁用、CSS 前缀 ----
{
  const regionStart = HTML.indexOf('COPY_FORMATS');
  const regionEnd = HTML.indexOf('function renderKeyCard(');
  assert(regionStart > -1 && regionEnd > regionStart, '格式表与接入配置复制逻辑应放在 renderKeyCard 之前');
  const REGION = HTML.slice(regionStart, regionEnd);
  const REGION_CODE = REGION.replace(/^\s*\/\/.*$/gm, '');

  assert(/COPY_FORMATS\s*=\s*\[/.test(REGION), '格式表应是数组字面量，便于 push');
  assert(/新增一档/.test(REGION), '格式表旁要有「新增一档只需 push 一项」的注释，供后续票据照做');
  assert(/COPY_FORMATS\.forEach/.test(REGION), '下拉选项必须由格式表生成，否则加档还要改下拉');
  assert(/COPY_FORMAT_STORAGE_KEY\s*=\s*'aw_copy_fmt'/.test(REGION), 'localStorage 键名必须收敛成一个常量 aw_copy_fmt');
  assert(/localStorage\.getItem\(COPY_FORMAT_STORAGE_KEY\)/.test(REGION), '读格式选择必须走 aw_copy_fmt');
  assert(/localStorage\.setItem\(COPY_FORMAT_STORAGE_KEY/.test(REGION), '写格式选择必须走 aw_copy_fmt');

  assert(/maskContext\(/.test(REGION_CODE), '预览必须走掩码后的 ctx');
  assert(/pre\.textContent = ''/.test(REGION_CODE), '折叠预览时必须清空内容，不能只是藏起来');
  assert(/pre\.hidden = true/.test(REGION_CODE), '预览默认折叠');
  assert(/title = '凭据已撤销/.test(REGION_CODE), '已撤销的凭据要在按钮上说明原因');
  assert(/btnCopy\.disabled = true/.test(REGION_CODE), '已撤销的凭据要禁用复制按钮');
  assert(!/innerHTML/.test(REGION), '新逻辑只能用 createElement / textContent');

  // 预览只能从掩码 ctx 生成：真 ctx 只允许进复制路径。
  const copyCall = REGION_CODE.indexOf('copyText(');
  assert(copyCall > -1, '复制按钮必须走统一入口 copyText');
  assert(REGION_CODE.indexOf('format(ctx)') > -1 || /format\(ctx\)/.test(REGION_CODE), '复制路径应把真 ctx 交给 format');
}

// ---- 10. 静态：renderKeyCard 只多了一行调用，行结构原样 ----
{
  const cardStart = HTML.indexOf('function renderKeyCard(');
  const cardEnd = HTML.indexOf('\n  }\n', cardStart);
  const CARD = HTML.slice(cardStart, cardEnd);
  const calls = CARD.match(/addConfigCopyControls\(/g) || [];
  assert.strictEqual(calls.length, 1, `renderKeyCard 里只应加一行接入配置复制接线，实际 ${calls.length} 行`);

  const actionsAt = CARD.indexOf("actions.className = 'key-card-actions'");
  const callAt = CARD.indexOf(calls[0]);
  assert(actionsAt > -1 && callAt > actionsAt, '接入配置复制接线必须在 .key-card-actions 组装完之后');

  // 六个行变量与顺序不许动
  const rows = ['名称', '接口地址', 'API Key', '模型', 'ID', '账号范围'];
  const positions = rows.map((label) => {
    const idx = CARD.indexOf(`keyRow('${label}'`);
    assert(idx > -1, `卡片缺少「${label}」行`);
    return idx;
  });
  assert(positions.every((v, i) => i === 0 || v > positions[i - 1]), '六行顺序被改动');

  // 既有操作按钮不受影响
  assert(/btnEdit/.test(CARD) && /修改/.test(CARD), '编辑按钮要保留');
  assert(/btnRevoke/.test(CARD) && /撤销/.test(CARD), '撤销按钮要保留');
}

// ---- 11. 静态：CSS 只新增 key-cfg- 前缀，不动既有选择器 ----
{
  assert(/\.key-cfg-preview\{/.test(HTML), '缺少预览区样式 .key-cfg-preview');
  assert(/\.key-cfg-select\{/.test(HTML), '缺少格式下拉样式 .key-cfg-select');
  assert(/\.key-card-actions\{display:flex;gap:6px;margin-top:8px\}/.test(HTML), '不允许改 .key-card-actions 这行样式');
}

// ---- 12/13. 行为：真跑 renderKeyCard，点「复制接入配置」观察请求与提示 ----
function makeKey(id, extra) {
  return Object.assign({
    id,
    name: '凭据 ' + id,
    token: 'sk-abc...wxyz',
    created_at: Date.now(),
    revoked: false,
    account_policy: { mode: 'all', accounts: [] },
    stats: { requests: 1 },
  }, extra || {});
}

function configCopyButton(card) {
  const wrap = findFirst(card, 'key-cfg-wrap');
  assert(wrap, '卡片操作区里找不到接入配置复制区');
  const btn = wrap.children.find((c) => c.tagName === 'BUTTON' && c.textContent === '复制接入配置');
  assert(btn, '找不到「复制接入配置」按钮');
  return btn;
}

function resetFlow() {
  probe.resetToasts();
  document.getElementById('toast').textContent = '';
  clipboard.text = null;
  fetchCalls.length = 0;
}

function routeFetch(routes) {
  fetchImpl = async (url) => {
    const hit = routes[url];
    if (!hit) throw new Error('意外的请求 ' + url);
    return hit();
  };
}

async function behavioral() {
  // ---- 12. 一次复制只取一次明文（模型复用同一份 token） ----
  {
    resetFlow();
    routeFetch({
      '/api/admin/keys/key_cfg/token': () => ({ ok: true, status: 200, json: async () => ({ ok: true, token: 'sk-plain-cfg' }) }),
      '/v1/models': () => ({ ok: true, status: 200, json: async () => ({ object: 'list', data: [{ id: 'deepseek-flash' }] }) }),
      '/api/fallback': () => ({ ok: true, status: 200, json: async () => ({ current: 'deepseek-flash' }) }),
    });

    const card = probe.renderKeyCard(makeKey('key_cfg'));
    await configCopyButton(card).onclick();

    const tokenCalls = fetchCalls.filter((c) => c.url === '/api/admin/keys/key_cfg/token');
    assert.strictEqual(tokenCalls.length, 1,
      `一次复制接入配置只应取一次明文，实际 ${tokenCalls.length} 次`);
    assert(clipboard.text && clipboard.text.includes('sk-plain-cfg'), '剪贴板里应是含明文 Key 的配置');
    assert(clipboard.text.includes('deepseek-flash'), '剪贴板里应带上该凭据可用的模型');
    assert(!/没有可用模型/.test(document.getElementById('toast').textContent),
      '有可用模型时提示不该说接上去调不通');
  }

  // ---- 13. 无账号权限：照样复制成功，但明确提示接上去调不通 ----
  {
    resetFlow();
    routeFetch({
      '/api/admin/keys/key_none/token': () => ({ ok: true, status: 200, json: async () => ({ ok: true, token: 'sk-plain-none' }) }),
      '/v1/models': () => ({ ok: false, status: 403, json: async () => ({ error: { code: 'no_accounts_permitted', message: 'no accounts permitted' } }) }),
      '/api/fallback': () => ({ ok: true, status: 200, json: async () => ({ current: '' }) }),
    });

    const card = probe.renderKeyCard(makeKey('key_none'));
    await configCopyButton(card).onclick();

    const msg = document.getElementById('toast').textContent;
    assert(/已复制/.test(msg), `无账号权限的凭据也应复制成功，实际「${msg}」`);
    assert(/没有可用模型/.test(msg), `提示要说明没有可用模型，实际「${msg}」`);
    assert(/调不通/.test(msg), `提示要说明接上去调不通，实际「${msg}」`);
    assert(clipboard.text && clipboard.text.includes('sk-plain-none'), '剪贴板里仍应是完整配置');
    assert(clipboard.text.includes('automodel'), '没有可用模型时 model 退回 automodel');
    assert.strictEqual(fetchCalls.filter((c) => c.url === '/api/admin/keys/key_none/token').length, 1,
      '无账号权限时同样只应取一次明文');
  }
}

behavioral().then(() => {
  finish();
  console.log('ok - 接入配置复制：JSON 档口径、格式表可追加、掩码边界、复制只取一次明文、无模型提示');
}).catch((err) => {
  console.error('测试失败:', err.message);
  process.exit(1);
});

