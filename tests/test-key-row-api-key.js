'use strict';
/**
 * 票 06：API Key 行「不点显示也能复制」。
 *
 * 这张票的关键不是复制本身，而是**不降低安全性**：明文可以进剪贴板，但绝不能进 DOM。
 * 所以这里真跑一遍点击，按三条守：
 *   1) 点复制只发一次既有的取明文请求（/api/admin/keys/:id/token），把到手明文交给剪贴板；
 *   2) 明文没有被赋给任何元素的 textContent / title / data-*，提示文案里也没有明文；
 *   3) 取明文失败（会话过期、网络错误）时提示失败原因，绝不提示成功。
 * 另外钉住：已撤销的凭据照样能复制（复制不按状态拦），以及接线只加一行、不动「显示 / 隐藏」。
 *
 * 页面没有 DOM 测试环境，沿用 test-key-copy.js 的 vm 沙箱写法：把内联脚本放进最小 DOM 里，
 * 把待测函数从 IIFE 里探出来，其余用假元素替身。
 */

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
const inline = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1])
  .join('\n');
assert(inline.length > 1000, '没抓到页面内联脚本');

const PLAIN = 'sk-plain-0123456789abcdefSECRET';
const MASKED = 'sk-pl...cret';
const KEY_ID = 'key_abc';

// 每次场景都新起一个沙箱：提示队列有内部状态（TOAST_BUSY），共用一个上下文会互相污染。
function loadPage(fetchImpl) {
  const created = [];
  const writes = []; // 所有落到 DOM 的写入：textContent / title / data-* / 属性
  const elements = new Map();
  const fetchCalls = [];
  const clipboard = { text: null, mode: 'ok' };

  function record(kind, name, value) {
    writes.push({ kind, name, value: value == null ? '' : String(value) });
  }

  function makeEl(tag) {
    const el = {
      tagName: String(tag).toUpperCase(),
      value: '',
      innerHTML: '',
      disabled: false,
      hidden: false,
      className: '',
      id: '',
      attrs: {},
      style: {},
      parentNode: null,
      children: [],
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      appendChild(child) { if (child) { child.parentNode = el; el.children.push(child); } return child; },
      removeChild(child) { el.children = el.children.filter((c) => c !== child); return child; },
      querySelector(sel) {
        if (!sel || sel[0] !== '.') return null;
        const want = sel.slice(1);
        const stack = el.children.slice();
        while (stack.length) {
          const node = stack.shift();
          const cls = node.className ? String(node.className).split(/\s+/) : [];
          if (cls.includes(want)) return node;
          if (node.children) stack.push(...node.children);
        }
        return null;
      },
      querySelectorAll() { return []; },
      addEventListener() {},
      removeEventListener() {},
      setAttribute(k, v) { el.attrs[k] = String(v); record('attr', k, v); },
      getAttribute(k) { return Object.prototype.hasOwnProperty.call(el.attrs, k) ? el.attrs[k] : null; },
      removeAttribute(k) { delete el.attrs[k]; },
      focus() {},
      click() { if (typeof el.onclick === 'function') return el.onclick(); return undefined; },
      getBoundingClientRect() { return { width: 0, height: 0, top: 0, left: 0 }; },
    };
    let text = '';
    Object.defineProperty(el, 'textContent', {
      enumerable: true,
      get() { return text; },
      set(v) { text = String(v); record('textContent', tag, text); },
    });
    let title = '';
    Object.defineProperty(el, 'title', {
      enumerable: true,
      get() { return title; },
      set(v) { title = String(v); record('title', tag, title); },
    });
    el.dataset = new Proxy({}, {
      set(target, prop, v) { target[prop] = String(v); record('dataset', String(prop), v); return true; },
      get(target, prop) { return target[prop]; },
    });
    created.push(el);
    return el;
  }

  const body = makeEl('body');
  const document = {
    hidden: false,
    readyState: 'loading',
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeEl(id));
      return elements.get(id);
    },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    createElement(tag) { return tag === 'textarea' ? makeEl('textarea') : makeEl(tag); },
    createDocumentFragment() { return makeEl('#fragment'); },
    addEventListener() {},
    removeEventListener() {},
    execCommand() { return false; },
    body,
    documentElement: makeEl('html'),
  };

  const navigator = {
    userAgent: 'node-test',
    clipboard: {
      writeText(t) {
        if (clipboard.mode === 'reject') return Promise.reject(new Error('denied'));
        clipboard.text = String(t);
        return Promise.resolve();
      },
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
    _v: new Map([['aw_admin_token', 'adm-token-from-store']]),
    getItem(k) { return this._v.has(k) ? this._v.get(k) : null; },
    setItem(k, v) { this._v.set(k, String(v)); },
    removeItem(k) { this._v.delete(k); },
  };

  const noop = () => 0;
  const sandbox = {
    document, window, navigator, location, localStorage,
    fetch: (url, opts) => {
      fetchCalls.push({ url: String(url), opts: opts || {} });
      return fetchImpl(String(url), opts || {});
    },
    Chart: class { constructor() {} destroy() {} update() {} },
    setInterval: noop, setTimeout: noop, clearInterval: noop, clearTimeout: noop,
    requestAnimationFrame: noop,
    console, URLSearchParams, URL, Date, Math, JSON, Number, String, Object, Array, Promise, Error,
    isFinite, parseFloat, parseInt, encodeURIComponent, decodeURIComponent,
    crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000000' },
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  const rejections = [];
  const onRejection = (e) => rejections.push(e);
  process.on('unhandledRejection', onRejection);

  const closer = inline.lastIndexOf('})();');
  assert(closer > 0, '找不到内联脚本的 IIFE 结尾');
  const patched = inline.slice(0, closer)
    + '\n;globalThis.__probe = { attachApiKeyCopyButton, keyRow, addKeyRowAction, copyText, fetchKeyToken };\n'
    + inline.slice(closer);

  vm.createContext(sandbox);
  vm.runInContext(patched, sandbox, { filename: 'index.html#inline' });
  process.removeListener('unhandledRejection', onRejection);

  return {
    probe: sandbox.__probe,
    writes,
    created,
    fetchCalls,
    clipboard,
    rejections,
    toastText() {
      const el = elements.get('toast');
      return el ? el.textContent : '';
    },
  };
}

function okFetch(calls) {
  return async (url) => {
    assert.strictEqual(url, `/api/admin/keys/${KEY_ID}/token`, '取明文只能走既有的按需查看端点');
    calls.push(url);
    return { ok: true, status: 200, json: async () => ({ ok: true, token: PLAIN }) };
  };
}

async function main() {
  // ---- 1. 复制路径：现取明文 → 交给剪贴板；DOM 里只有掩码 ----
  {
    const fetched = [];
    const page = loadPage(okFetch(fetched));
    const { probe } = page;
    assert(typeof probe.attachApiKeyCopyButton === 'function', '页面里缺少 API Key 行的接线函数 attachApiKeyCopyButton');

    const row = probe.keyRow('API Key', MASKED);
    const k = { id: KEY_ID, token: MASKED, revoked: false, name: 'Cursor' };
    probe.attachApiKeyCopyButton(row, k);

    const btn = row.querySelector('.key-row-ops').children[0];
    assert(btn && btn.tagName === 'BUTTON', 'API Key 行的操作位应有一个复制按钮');
    assert.strictEqual(btn.disabled, false, '按钮初始应可点');

    await btn.onclick();

    assert.strictEqual(fetched.length, 1, '点一次复制应只取一次明文');
    assert.strictEqual(page.fetchCalls[0].opts.headers.Authorization, 'Bearer adm-token-from-store', '取明文必须带管理头');
    assert.strictEqual(page.clipboard.text, PLAIN, '剪贴板里应是完整明文 key');

    const leaked = page.writes.filter((w) => w.value.includes(PLAIN));
    assert.strictEqual(leaked.length, 0,
      `明文进了 DOM：${leaked.map((w) => w.kind + ':' + w.name).join(', ')}`);
    assert(!page.toastText().includes(PLAIN), '提示文案里不得回显明文');
  }

  // ---- 2. 成功提示要写明复制的是明文密钥 ----
  {
    const page = loadPage(okFetch([]));
    const row = page.probe.keyRow('API Key', MASKED);
    page.probe.attachApiKeyCopyButton(row, { id: KEY_ID, token: MASKED, revoked: false });
    await row.querySelector('.key-row-ops').children[0].onclick();
    const msg = page.toastText();
    assert(/已复制/.test(msg), `成功提示应说明复制成功，实际「${msg}」`);
    assert(/明文/.test(msg), `成功提示必须写明复制的是明文密钥，实际「${msg}」`);
  }

  // ---- 3. 取明文失败：报原因，不误报成功 ----
  {
    const page = loadPage(async () => ({
      ok: false, status: 401, json: async () => ({ error: { message: '会话已过期' } }),
    }));
    const row = page.probe.keyRow('API Key', MASKED);
    page.probe.attachApiKeyCopyButton(row, { id: KEY_ID, token: MASKED, revoked: false });
    const btn = row.querySelector('.key-row-ops').children[0];
    await btn.onclick();

    const msg = page.toastText();
    assert(!/已复制/.test(msg), `取明文失败时不得提示成功，实际「${msg}」`);
    assert(/失败/.test(msg), `取明文失败时提示应说明失败，实际「${msg}」`);
    assert(/会话已过期/.test(msg), `失败提示应带上服务端原因，实际「${msg}」`);
    assert.strictEqual(page.clipboard.text, null, '取明文失败时不得往剪贴板写任何东西');
    assert.strictEqual(btn.disabled, false, '失败后按钮要恢复可点，不能卡住');
  }

  // ---- 4. 网络异常同样不误报成功 ----
  {
    const page = loadPage(async () => { throw new Error('network down'); });
    const row = page.probe.keyRow('API Key', MASKED);
    page.probe.attachApiKeyCopyButton(row, { id: KEY_ID, token: MASKED, revoked: false });
    await row.querySelector('.key-row-ops').children[0].onclick();
    const msg = page.toastText();
    assert(!/已复制/.test(msg), `网络异常时不得提示成功，实际「${msg}」`);
    assert(/失败/.test(msg), `网络异常时要提示失败，实际「${msg}」`);
  }

  // ---- 5. 已撤销的凭据仍能复制明文 ----
  {
    const page = loadPage(okFetch([]));
    const row = page.probe.keyRow('API Key', MASKED);
    page.probe.attachApiKeyCopyButton(row, { id: KEY_ID, token: MASKED, revoked: true });
    const btn = row.querySelector('.key-row-ops').children[0];
    assert.strictEqual(btn.disabled, false, '已撤销的凭据不按状态禁用复制');
    await btn.onclick();
    assert.strictEqual(page.clipboard.text, PLAIN, '已撤销的凭据也应复制出明文 key');
    assert(/已复制/.test(page.toastText()), '已撤销的凭据复制成功应有提示');
  }

  // ---- 6. 连续复制不出异常，按钮不卡死 ----
  {
    const page = loadPage(okFetch([]));
    const row = page.probe.keyRow('API Key', MASKED);
    page.probe.attachApiKeyCopyButton(row, { id: KEY_ID, token: MASKED, revoked: false });
    const btn = row.querySelector('.key-row-ops').children[0];
    await btn.onclick();
    await btn.onclick();
    assert.strictEqual(page.clipboard.text, PLAIN, '再点一次仍应把明文写进剪贴板');
    assert.strictEqual(btn.disabled, false, '两次复制后按钮仍可用');
    assert.strictEqual(page.rejections.length, 0, '复制链路不应产生未处理的 Promise 拒绝');
  }

  // ---- 7. 静态接线：只在 tokenRow 之后加一行，不碰「显示 / 隐藏」 ----
  {
    const start = html.indexOf('function renderKeyCard(');
    assert(start > -1, '找不到 renderKeyCard()');
    const end = html.indexOf('\n  }\n', start);
    const card = html.slice(start, end);

    const tokenRowAt = card.indexOf("const tokenRow = keyRow('API Key'");
    const wireAt = card.indexOf('attachApiKeyCopyButton(tokenRow, k)');
    assert(tokenRowAt > -1, 'API Key 行应由 tokenRow 声明');
    assert(wireAt > tokenRowAt, '接线必须写在 tokenRow 声明之后');

    const wireLines = card.split('\n').filter((l) => l.includes('attachApiKeyCopyButton'));
    assert.strictEqual(wireLines.length, 1, `renderKeyCard 里只应有一行 attachApiKeyCopyButton 接线，实际 ${wireLines.length} 行`);

    // 「显示 / 隐藏」的既有行为：收起时把明文抹回掩码，不能被这次改动碰到。
    assert(/tokenEl\.textContent = tokenEl\.dataset\.masked/.test(card), '收起时抹掉明文的逻辑不得改动');
    assert(/aria-label', '显示完整 Key'/.test(card), '「显示完整 Key」入口不得改动');

    // 逻辑都在新函数里，且落在 addKeyRowAction 之后、renderKeyCard 之前。
    const fnAt = html.indexOf('function attachApiKeyCopyButton(');
    assert(fnAt > -1, '缺少 attachApiKeyCopyButton 函数');
    assert(fnAt > html.indexOf('function addKeyRowAction('), 'attachApiKeyCopyButton 应放在 addKeyRowAction 之后');
    assert(fnAt < start, 'attachApiKeyCopyButton 应放在 renderKeyCard 之前');

    const fnEnd = html.indexOf('\n  }\n', fnAt);
    const body = html.slice(fnAt, fnEnd);
    assert(!/innerHTML/.test(body), '不得用 innerHTML 拼结构');
    assert(!/revoked/.test(body), '复制不应按凭据状态拦');

    assert(!/\.innerHTML\s*=/.test(html), '全页不得用 innerHTML 赋值构建 DOM');
  }

  console.log('ok - API Key 行：现取明文直接进剪贴板，明文不进 DOM；成功提示写明明文，失败不误报');
}

main().catch((err) => {
  console.error('测试失败:', err.message);
  process.exit(1);
});
