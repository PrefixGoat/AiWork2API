'use strict';

// 复制入口与取值入口：局域网 http（非安全上下文）下「复制命令」必须真能用，
// 且页面里所有复制点都走同一个函数。这里把页面内联脚本放进最小 DOM 里真跑：
//   - 安全上下文走 navigator.clipboard.writeText；
//   - 没有接口 / 写入被拒时落到 textarea + execCommand('copy')；
//   - 两条都失败返回 false，而不是抛错或误报成功。
// 顺带验证两个取值函数（取明文 token、取该凭据可调的模型）的请求形状与降级。

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
const inline = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1])
  .join('\n');
assert(inline.length > 1000, '没抓到页面内联脚本');

// ---- 最小 DOM：只够 copyText 的兜底路径与脚本初始化 ----
const createdTextareas = [];
function makeTextarea() {
  const ta = {
    tagName: 'TEXTAREA',
    value: '',
    parentNode: null,
    style: {},
    attrs: {},
    focusOpts: null,
    selected: false,
    range: null,
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
    focus(opts) { this.focusOpts = opts || null; },
    select() { this.selected = true; },
    setSelectionRange(a, b) { this.range = [a, b]; },
    remove() {},
    addEventListener() {},
  };
  createdTextareas.push(ta);
  return ta;
}

function makeElement(id) {
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
}

const elements = new Map();
const body = makeElement('body');
body.appendChild = (child) => { child.parentNode = body; body.children.push(child); };
body.removeChild = (child) => { child.parentNode = null; body.children = body.children.filter((c) => c !== child); };

const document = {
  hidden: false,
  readyState: 'loading',
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  },
  querySelectorAll() { return []; },
  querySelector() { return null; },
  createElement(tag) { return tag === 'textarea' ? makeTextarea() : makeElement(tag); },
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
    writeText(t) {
      if (clipboard.mode === 'missing') throw new Error('不该走到这里');
      if (clipboard.mode === 'reject') return Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
      clipboard.text = t;
      return Promise.resolve();
    },
  },
};

const window = {
  isSecureContext: true,
  addEventListener() {},
  matchMedia() { return { matches: false, addEventListener() {} }; },
};
const location = { href: 'http://192.168.1.10:18080/', host: '192.168.1.10:18080', hostname: '192.168.1.10', port: '18080', protocol: 'http:', origin: 'http://192.168.1.10:18080' };

const localStorage = {
  _v: new Map([['aw_admin_token', 'adm-token-from-store']]),
  getItem(k) { return this._v.has(k) ? this._v.get(k) : null; },
  setItem(k, v) { this._v.set(k, String(v)); },
  removeItem(k) { this._v.delete(k); },
};

const fetchCalls = [];
let fetchImpl = () => new Promise(() => {});

const noop = () => 0;
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
  toast: () => {},
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;

const rejections = [];
process.on('unhandledRejection', (e) => rejections.push(e));

const closer = inline.lastIndexOf('})();');
assert(closer > 0, '找不到内联脚本的 IIFE 结尾');
const patched = inline.slice(0, closer)
  + '\n;globalThis.__probe = { copyText, fetchKeyToken, fetchKeyModels, copyPortCommand, portCommand, renderPortFields };\n'
  + inline.slice(closer);

vm.createContext(sandbox);
vm.runInContext(patched, sandbox, { filename: 'index.html#inline' });
const probe = sandbox.__probe;

function resetClipboard() {
  clipboard.text = null;
  clipboard.mode = 'ok';
  createdTextareas.length = 0;
  navigator.clipboard = {
    writeText(t) {
      if (clipboard.mode === 'missing') throw new Error('不该走到这里');
      if (clipboard.mode === 'reject') return Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
      clipboard.text = t;
      return Promise.resolve();
    },
  };
  document.execCommand = () => false;
}

async function main() {
  assert(probe && typeof probe.copyText === 'function', '页面里没有统一的 copyText 入口');
  assert(typeof probe.fetchKeyToken === 'function', '页面里没有 fetchKeyToken');
  assert(typeof probe.fetchKeyModels === 'function', '页面里没有 fetchKeyModels');

  // ---- 1. 安全上下文：优先用浏览器剪贴板，不碰兜底 ----
  resetClipboard();
  window.isSecureContext = true;
  {
    const ok = await probe.copyText('第一行\n第二行 中文');
    assert.strictEqual(ok, true, 'writeText 成功时应返回 true');
    assert.strictEqual(clipboard.text, '第一行\n第二行 中文', '写进剪贴板的应原样带上换行与中文');
    assert.strictEqual(createdTextareas.length, 0, '安全上下文下不该创建兜底 textarea');
  }

  // ---- 2. 局域网 http：navigator.clipboard 不存在，必须走兜底 ----
  resetClipboard();
  window.isSecureContext = false;
  navigator.clipboard = undefined;
  {
    let copied = null;
    document.execCommand = (cmd) => { if (cmd === 'copy') { copied = createdTextareas[createdTextareas.length - 1].value; return true; } return false; };
    const ok = await probe.copyText('局域网下的命令 --host 18080');
    assert.strictEqual(ok, true, '兜底路径成功时应返回 true');
    assert.strictEqual(copied, '局域网下的命令 --host 18080', 'execCommand 复制到的应是原文');
    assert.strictEqual(createdTextareas.length, 1, '应创建且只创建一个兜底 textarea');
    const ta = createdTextareas[0];
    assert.strictEqual(ta.getAttribute('readonly'), '', 'textarea 必须 readonly，否则移动端会弹键盘');
    assert.strictEqual(ta.style.position, 'fixed', 'textarea 必须脱离文档流，避免页面跳动');
    assert.strictEqual(ta.style.opacity, '0', 'textarea 必须不可见');
    assert.strictEqual(ta.focusOpts && ta.focusOpts.preventScroll, true, 'focus 必须 preventScroll，否则会滚动页面');
    assert.strictEqual(ta.selected, true, '必须 select() 选中内容');
    assert.strictEqual(ta.range && ta.range[0], 0, 'setSelectionRange 起点必须是 0');
    assert.strictEqual(ta.range && ta.range[1], '局域网下的命令 --host 18080'.length, '必须显式 setSelectionRange 覆盖全串');
    assert.strictEqual(ta.parentNode, null, '复制完必须把 textarea 从 DOM 上摘掉');
  }

  // ---- 3. 接口在但写入被拒（权限拒绝 / 文档失焦）：落到兜底，不误报 ----
  resetClipboard();
  window.isSecureContext = true;
  clipboard.mode = 'reject';
  {
    let called = false;
    document.execCommand = () => { called = true; return true; };
    const ok = await probe.copyText('被拒也要复制出去');
    assert.strictEqual(called, true, 'writeText 被拒后必须继续尝试兜底');
    assert.strictEqual(ok, true, '兜底成功时应返回 true');
    assert.strictEqual(createdTextareas.length, 1, '兜底应创建 textarea');
  }

  // ---- 4. 两条路径都失败：返回 false，且不抛错 ----
  resetClipboard();
  window.isSecureContext = false;
  navigator.clipboard = undefined;
  {
    document.execCommand = () => false;
    assert.strictEqual(await probe.copyText('x'), false, 'execCommand 返回 false 时应返回 false');
    resetClipboard();
    document.execCommand = () => { throw new Error('boom'); };
    assert.strictEqual(await probe.copyText('x'), false, 'execCommand 抛错时也应返回 false 而不是把异常甩给调用方');
  }

  // ---- 5. 取明文 token：复用按需查看接口，带管理头 ----
  fetchCalls.length = 0;
  fetchImpl = async (url) => {
    assert.strictEqual(url, '/api/admin/keys/key_abc/token', '取明文必须走既有的按需查看端点');
    return { ok: true, status: 200, json: async () => ({ ok: true, token: 'sk-plain-123' }) };
  };
  {
    const token = await probe.fetchKeyToken('key_abc');
    assert.strictEqual(token, 'sk-plain-123', '应返回明文 token');
    assert.strictEqual(fetchCalls.length, 1, '取明文只应发一次请求');
    const headers = fetchCalls[0].opts.headers || {};
    assert.strictEqual(headers.Authorization, 'Bearer adm-token-from-store', '必须带管理头');
  }

  // 401/403 之类要让调用方知道失败，不能返回假 token
  fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: '会话已过期' } }) });
  {
    let failed = null;
    try { await probe.fetchKeyToken('key_abc'); } catch (e) { failed = e; }
    assert(failed, '取明文失败必须抛错');
    assert(/会话已过期/.test(failed.message), '抛错应带上服务端原因');
  }

  // ---- 6. 取模型：先取明文，再用该 token 调 /v1/models ----
  fetchCalls.length = 0;
  fetchImpl = async (url, opts) => {
    if (url === '/api/admin/keys/key_abc/token') {
      return { ok: true, status: 200, json: async () => ({ ok: true, token: 'sk-plain-123' }) };
    }
    if (url === '/v1/models') {
      assert.strictEqual((opts.headers || {}).Authorization, 'Bearer sk-plain-123', '/v1/models 必须用该凭据自己的 token');
      return { ok: true, status: 200, json: async () => ({ object: 'list', data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4.1-flash' }] }) };
    }
    throw new Error('意外的请求 ' + url);
  };
  {
    const models = await probe.fetchKeyModels('key_abc');
    assert.strictEqual(JSON.stringify(models), JSON.stringify(['deepseek-flash', 'deepseek-v4.1-flash']), '应返回模型 id 数组');
  }

  // 账号权限为空 → 服务端 403 → 空数组，不抛错
  fetchImpl = async (url) => {
    if (url === '/api/admin/keys/key_abc/token') {
      return { ok: true, status: 200, json: async () => ({ ok: true, token: 'sk-plain-123' }) };
    }
    return { ok: false, status: 403, json: async () => ({ error: { code: 'no_accounts_permitted', message: 'no accounts permitted for this api key' } }) };
  };
  {
    const models = await probe.fetchKeyModels('key_abc');
    assert.strictEqual(Array.isArray(models) && models.length, 0, '无账号权限应返回空数组而不是抛错');
  }

  // 其它错误照常抛：别把网络故障说成「没有模型」
  fetchImpl = async (url) => {
    if (url === '/api/admin/keys/key_abc/token') {
      return { ok: true, status: 200, json: async () => ({ ok: true, token: 'sk-plain-123' }) };
    }
    return { ok: false, status: 500, json: async () => ({ error: { message: 'internal' } }) };
  };
  {
    let failed = null;
    try { await probe.fetchKeyModels('key_abc'); } catch (e) { failed = e; }
    assert(failed, '500 必须抛错，不能静默降到空列表');
  }

  // ---- 7. 设置页「复制命令」已经改走统一入口 ----
  {
    resetClipboard();
    window.isSecureContext = false;
    navigator.clipboard = undefined;
    document.execCommand = () => true;
    probe.renderPortFields(true, 8080);
    elements.get('setHostPort').value = '18080';
    elements.get('setListenPort').value = '8080';
    let copied = null;
    document.execCommand = () => { copied = createdTextareas[createdTextareas.length - 1].value; return true; };
    await probe.copyPortCommand();
    assert(copied, '局域网下点「复制命令」必须真的把命令放进剪贴板');
    assert(copied.includes('--host 18080'), `复制内容应是当前输入框里的命令，实际 ${copied}`);
  }

  // ---- 8. 静态：全页只有一处直接碰剪贴板，兜底不能删 ----
  {
    // 注释里提一句不算「第二处调用」，只数真正的代码行。
    const codeOnly = html.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    const hits = codeOnly.match(/navigator\.clipboard/g) || [];
    assert.strictEqual(hits.length, 1, `页面里只应有一个复制入口，实际出现 ${hits.length} 次 navigator.clipboard`);
    assert(/document\.execCommand\(\s*['"]copy['"]\s*\)/.test(html), '残留 execCommand 兜底路径');

    const lines = html.split('\n');
    const idx = lines.findIndex((l) => /document\.execCommand\(\s*['"]copy['"]\s*\)/.test(l));
    const near = lines.slice(Math.max(0, idx - 5), idx + 1).join('\n');
    assert(/\/\//.test(near) && /局域网|非安全上下文|http/.test(near),
      '兜底分支旁必须有一行注释说明为什么不能删');
  }

  process.removeAllListeners('unhandledRejection');
  if (rejections.length) {
    for (const e of rejections) {
      const msg = String((e && e.message) || e);
      if (!/null|undefined|Cannot read|not a function/i.test(msg)) throw e;
    }
  }

  console.log('ok - 复制入口：安全上下文优先、局域网 http 兜底、双失败返回 false；取明文与取模型走同一入口');
}

main().catch((err) => {
  console.error('测试失败:', err.message);
  process.exit(1);
});
