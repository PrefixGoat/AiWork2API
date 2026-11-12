'use strict';
/**
 * 接口地址行可复制，并在「本机打开但监听在别处」时补一句口径提示。
 *
 * 契约（见该功能的验收清单 Base URL 复制与提示条目）：
 *   1) 复制出去的值固定是 location.origin + '/v1'；
 *   2) 页面用回环地址（127.0.0.1 / localhost / ::1）打开，而 /api/settings 的
 *      bind_address 主机部分不是回环地址时，地址行下方出现一句提示，
 *      写明「只在本机可用」并给出实际监听地址；
 *   3) 从局域网 IP 或域名访问时不提示；
 *   4) 读不到设置 / 字段缺失不提示，且不影响复制；
 *   5) 文案不写死端口，跟着实际配置走；提示不改复制出去的值。
 *
 * 页面没有 DOM 测试环境：这里把内联脚本放进最小 DOM 里真跑（同 test-key-copy.js），
 * 每个用例用一份新的沙箱，避免提示缓存在用例之间串味。
 */

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
const inline = [...HTML.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1])
  .join('\n');
assert(inline.length > 1000, '没抓到页面内联脚本');

const closer = inline.lastIndexOf('})();');
assert(closer > 0, '找不到内联脚本的 IIFE 结尾');
const PATCHED = inline.slice(0, closer)
  + '\n;globalThis.__probe = { attachBaseUrlRow, keyRow, splitBindHost, splitBindPort, listeningAddressLabel, isLoopbackHost };\n'
  + inline.slice(closer);

// ---- 最小 DOM：够 keyRow 造行、够 attachBaseUrlRow 挂按钮与提示 ----
function makeClassList(el) {
  const read = () => el.className.split(/\s+/).filter(Boolean);
  const write = (set) => { el.className = Array.from(set).join(' '); };
  return {
    add(...cs) { const s = new Set(read()); cs.forEach((c) => s.add(c)); write(s); },
    remove(...cs) { const s = new Set(read()); cs.forEach((c) => s.delete(c)); write(s); },
    contains(c) { return read().includes(c); },
    toggle(c, on) {
      const want = on === undefined ? !read().includes(c) : !!on;
      if (want) this.add(c); else this.remove(c);
    },
  };
}

function matches(el, sel) {
  if (sel.startsWith('.')) return el.classList.contains(sel.slice(1));
  return el.tagName === sel.toUpperCase();
}

function makeElement(tag) {
  const el = {
    nodeType: 1,
    tagName: String(tag || 'div').toUpperCase(),
    id: '',
    value: '',
    checked: false,
    disabled: false,
    hidden: false,
    textContent: '',
    title: '',
    className: '',
    parentNode: null,
    children: [],
    options: [],
    dataset: {},
    style: {},
    attrs: {},
    onclick: null,
  };
  el.classList = makeClassList(el);
  el.appendChild = (child) => {
    if (!child) return child;
    if (child.nodeType === 11) {
      child.children.slice().forEach((c) => el.appendChild(c));
      child.children.length = 0;
      return child;
    }
    el.children.push(child);
    child.parentNode = el;
    return child;
  };
  el.removeChild = (child) => {
    el.children = el.children.filter((c) => c !== child);
    child.parentNode = null;
    return child;
  };
  el.setAttribute = (k, v) => { el.attrs[k] = String(v); };
  el.getAttribute = (k) => (Object.prototype.hasOwnProperty.call(el.attrs, k) ? el.attrs[k] : null);
  el.removeAttribute = (k) => { delete el.attrs[k]; };
  el.querySelectorAll = (sel) => {
    const out = [];
    const walk = (node) => node.children.forEach((c) => {
      if (matches(c, sel)) out.push(c);
      walk(c);
    });
    walk(el);
    return out;
  };
  el.querySelector = (sel) => { const all = el.querySelectorAll(sel); return all.length ? all[0] : null; };
  el.addEventListener = () => {};
  el.removeEventListener = () => {};
  el.focus = () => {};
  el.select = () => {};
  el.setSelectionRange = () => {};
  el.click = () => { if (el.onclick) el.onclick(); };
  el.getBoundingClientRect = () => ({ width: 0, height: 0, top: 0, left: 0 });
  return el;
}

function loadPage(opts) {
  const port = opts.port || '18080';
  const elements = new Map();
  const clipboard = { text: null };
  const fetchCalls = [];

  const document = {
    hidden: false,
    readyState: 'complete',
    createElement: (tag) => makeElement(tag),
    createDocumentFragment: () => {
      const frag = makeElement('#fragment');
      frag.nodeType = 11;
      return frag;
    },
    getElementById(id) {
      if (!elements.has(id)) {
        const el = makeElement('div');
        el.id = id;
        elements.set(id, el);
      }
      return elements.get(id);
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
    execCommand: () => false,
    body: makeElement('body'),
    documentElement: makeElement('html'),
  };

  const location = {
    href: `http://${opts.hostname}:${port}/`,
    host: `${opts.hostname}:${port}`,
    hostname: opts.hostname,
    port,
    protocol: 'http:',
    origin: `http://${opts.hostname}:${port}`,
  };

  const navigator = {
    userAgent: 'node-test',
    clipboard: { writeText(t) { clipboard.text = t; return Promise.resolve(); } },
  };
  const window = { isSecureContext: true, addEventListener: () => {}, matchMedia: () => ({ matches: false, addEventListener: () => {} }) };
  const localStorage = {
    _v: new Map([['aw_admin_token', 'adm-token']]),
    getItem(k) { return this._v.has(k) ? this._v.get(k) : null; },
    setItem(k, v) { this._v.set(k, String(v)); },
    removeItem(k) { this._v.delete(k); },
  };

  const sandbox = {
    document,
    window,
    navigator,
    location,
    localStorage,
    Chart: class { constructor() {} destroy() {} update() {} },
    fetch: (url) => {
      fetchCalls.push(String(url));
      if (opts.reject) return Promise.reject(new Error('network down'));
      if (opts.status && opts.status !== 200) {
        return Promise.resolve({ ok: false, status: opts.status, json: async () => ({ error: { message: 'denied' } }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => (opts.body === undefined ? { settings: {} } : opts.body) });
    },
    setInterval: () => 0,
    setTimeout: () => 0,
    clearInterval: () => {},
    clearTimeout: () => {},
    requestAnimationFrame: () => 0,
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

  vm.createContext(sandbox);
  vm.runInContext(PATCHED, sandbox, { filename: 'index.html#inline' });

  return {
    document,
    navigator,
    clipboard,
    fetchCalls,
    probe: sandbox.__probe,
    el: (id) => document.getElementById(id),
    toastText: () => String((elements.get('toast') || {}).textContent || ''),
    makeRow: (label, value) => sandbox.__probe.keyRow(label, value),
    wire: (row) => sandbox.__probe.attachBaseUrlRow(row),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const hintsOf = (row) => row.querySelectorAll('.key-row-hint');
const buttonOf = (row) => {
  const ops = row.querySelector('.key-row-ops');
  assert(ops, '接口地址行缺少操作位');
  const btns = ops.querySelectorAll('button');
  assert.strictEqual(btns.length, 1, '接口地址行右侧应有一个复制按钮');
  return btns[0];
};

// ---- 静态：接线只在 baseRow 之后加一行调用，地址口径不动 ----
{
  const start = HTML.indexOf('function renderKeyCard(');
  const end = HTML.indexOf('\n  }\n', start);
  const card = HTML.slice(start, end);
  assert(/const baseRow = keyRow\('接口地址', location\.origin \+ '\/v1'\);/.test(card),
    '接口地址行仍应是 location.origin + /v1');
  assert(/const baseRow = [^\n]*\n\s+attachBaseUrlRow\(baseRow\);\n/.test(card),
    '只允许在 baseRow 声明之后加一行 attachBaseUrlRow(baseRow) 调用');

  const hintCss = HTML.match(/\.key-row-hint\{[^}]*\}/);
  assert(hintCss, '缺少 .key-row-hint 样式');
  assert(/grid-column:2\s*\/\s*-1/.test(hintCss[0]), '提示应跨在值列下方，不挤占标签列');
  assert(HTML.indexOf('.key-row-hint{') > HTML.indexOf('.key-row-ops{'),
    '提示样式应追加在既有 .key-row* 规则之后');
  assert(!/\.innerHTML\s*=/.test(HTML), '不得用 innerHTML 赋值构建 DOM');
}

async function main() {
  // ---- 1. 复制出去的是当前访问地址 + /v1 ----
  {
    const page = loadPage({ hostname: '192.168.1.10', body: { settings: { bind_address: '0.0.0.0:18080' } } });
    const row = page.makeRow('接口地址', 'http://192.168.1.10:18080/v1');
    page.wire(row);
    await tick();
    const btn = buttonOf(row);
    assert.strictEqual(btn.tagName, 'BUTTON', '复制入口应是按钮');
    assert.strictEqual(btn.textContent, '复制', '按钮文案应为「复制」');
    await btn.onclick();
    assert.strictEqual(page.clipboard.text, 'http://192.168.1.10:18080/v1', '复制的必须是当前访问地址 + /v1');
    assert.strictEqual(page.toastText(), '接口地址已复制', '复制成功要明确提示');
  }

  // ---- 2. 复制失败必须报失败，不能误报成功 ----
  {
    const page = loadPage({ hostname: '127.0.0.1', body: { settings: { bind_address: '127.0.0.1' } } });
    page.navigator.clipboard.writeText = () => Promise.reject(new Error('denied'));
    page.document.execCommand = () => false;
    const row = page.makeRow('接口地址', '');
    page.wire(row);
    await tick();
    await buttonOf(row).onclick();
    assert(/失败/.test(page.toastText()), `复制失败要提示失败，实际「${page.toastText()}」`);
  }

  // ---- 3. 本机打开 + 监听非回环 → 提示出现，写明实际监听地址，且不改值 ----
  {
    const page = loadPage({ hostname: '127.0.0.1', port: '18080', body: { settings: { bind_address: '0.0.0.0:18080' } } });
    const row = page.makeRow('接口地址', 'http://127.0.0.1:18080/v1');
    page.wire(row);
    await tick();
    const hints = hintsOf(row);
    assert.strictEqual(hints.length, 1, '本机打开而监听在 0.0.0.0 时应出现一条提示');
    const text = hints[0].textContent;
    assert(/只在本机可用/.test(text), `提示要说明只在本机可用，实际「${text}」`);
    assert(/局域网|远端/.test(text), '提示要说明局域网/远端客户端要换主机名');
    assert(text.includes('18080'), `提示要写出实际端口，实际「${text}」`);
    // 0.0.0.0 是「监听所有网卡」的通配地址，不是任何客户端能连的主机名。
    // 提示里一旦出现它，用户就会照着去填，然后连不上——这里明确禁止。
    assert(!text.includes('0.0.0.0'), `监听 0.0.0.0 时不能把它当成可填写的主机名，实际「${text}」`);
    assert(/局域网 IP/.test(text), `监听所有网卡时要让人填本机局域网 IP，实际「${text}」`);
    assert.strictEqual(hints[0].parentNode, row, '提示应挂在接口地址行下方');
    assert.strictEqual(row.querySelector('.key-row-value').textContent, 'http://127.0.0.1:18080/v1',
      '提示不能改动这一行显示的地址');
    const btn = buttonOf(row);
    await btn.onclick();
    assert.strictEqual(page.clipboard.text, 'http://127.0.0.1:18080/v1', '有提示时复制的仍是本机地址');
  }

  // ---- 4. localhost / ::1 打开同样算「本机」 ----
  for (const hostname of ['localhost', '::1']) {
    const page = loadPage({ hostname, body: { settings: { bind_address: '192.168.1.10:18080' } } });
    const row = page.makeRow('接口地址', '');
    page.wire(row);
    await tick();
    const hints = hintsOf(row);
    assert.strictEqual(hints.length, 1, `从 ${hostname} 打开而监听在 192.168.1.10 时应提示`);
    assert(hints[0].textContent.includes('192.168.1.10:18080'), '提示要带实际监听地址');
  }

  // ---- 5. 本机打开、监听的也是回环 → 不提示 ----
  {
    const page = loadPage({ hostname: '127.0.0.1', body: { settings: { bind_address: '127.0.0.1:18080' } } });
    const row = page.makeRow('接口地址', '');
    page.wire(row);
    await tick();
    assert.strictEqual(hintsOf(row).length, 0, '监听回环地址时不该提示');
  }

  // ---- 6. 从局域网 IP 或域名访问 → 不提示，也不必去读设置 ----
  for (const hostname of ['192.168.1.10', 'aiwork.example.com']) {
    const page = loadPage({ hostname, body: { settings: { bind_address: '0.0.0.0:18080' } } });
    const row = page.makeRow('接口地址', '');
    page.wire(row);
    await tick();
    assert.strictEqual(hintsOf(row).length, 0, `从 ${hostname} 访问时不该提示`);
    assert.strictEqual(page.fetchCalls.length, 0, `从 ${hostname} 访问时不该为提示多打一次设置接口`);
  }

  // ---- 7. 读不到设置 / 字段缺失 → 不提示，复制照常可用 ----
  for (const opts of [
    { hostname: '127.0.0.1', status: 401 },
    { hostname: '127.0.0.1', reject: true },
    { hostname: '127.0.0.1', body: { settings: {} } },
    { hostname: '127.0.0.1', body: null },
  ]) {
    const page = loadPage(opts);
    const row = page.makeRow('接口地址', '');
    page.wire(row);
    await tick();
    assert.strictEqual(hintsOf(row).length, 0, '读不到监听地址时不该提示');
    await buttonOf(row).onclick();
    assert.strictEqual(page.clipboard.text, 'http://127.0.0.1:18080/v1', '读不到设置也不能影响复制');
  }

  // ---- 8. 文案不写死端口，跟着实际配置走 ----
  {
    const page = loadPage({ hostname: '127.0.0.1', port: '18080', body: { settings: { bind_address: '0.0.0.0:19999' } } });
    const row = page.makeRow('接口地址', '');
    page.wire(row);
    await tick();
    const text = hintsOf(row)[0].textContent;
    assert(text.includes('19999'), `提示要用配置里的监听端口，实际「${text}」`);
    assert(!text.includes('18080'), `提示不得写死当前访问端口，实际「${text}」`);
    assert(!text.includes('0.0.0.0'), `监听 0.0.0.0 时不能把它当成可填写的主机名，实际「${text}」`);
  }

  // ---- 9. 判回环只看主机部分；0.0.0.0 / 机器地址 / :: 都算非回环 ----
  for (const bind of ['0.0.0.0', '192.168.1.10', '::']) {
    const page = loadPage({ hostname: '127.0.0.1', port: '18080', body: { settings: { bind_address: bind } } });
    const row = page.makeRow('接口地址', '');
    page.wire(row);
    await tick();
    assert.strictEqual(hintsOf(row).length, 1, `监听 ${bind} 时应提示`);
  }

  // ---- 9b. 具体的非通配监听地址要写进提示（只有通配地址才不许写） ----
  {
    const page = loadPage({ hostname: '127.0.0.1', port: '18080', body: { settings: { bind_address: '192.168.1.10:18080' } } });
    const row = page.makeRow('接口地址', '');
    page.wire(row);
    await tick();
    const text = hintsOf(row)[0].textContent;
    assert(text.includes('192.168.1.10:18080'), `具体监听地址要写进提示，实际「${text}」`);
  }

  // ---- 10. 多张卡共用一次设置读取，每张卡各自拿到提示 ----
  {
    const page = loadPage({ hostname: '127.0.0.1', body: { settings: { bind_address: '0.0.0.0:18080' } } });
    const rows = [];
    for (let i = 0; i < 3; i++) {
      const row = page.makeRow('接口地址', '');
      page.wire(row);
      rows.push(row);
    }
    await tick();
    assert.strictEqual(page.fetchCalls.filter((u) => u === '/api/settings').length, 1,
      '设置只该读一次，不能每张卡都打一遍');
    rows.forEach((row, i) => {
      assert.strictEqual(hintsOf(row).length, 1, `第 ${i + 1} 张卡也该有提示`);
    });
  }

  // ---- 11. host[:port] 解析：方括号 IPv6、裸 IPv6、IPv4 都不能按最后一个冒号切 ----
  {
    const page = loadPage({ hostname: '127.0.0.1', port: '18080', body: { settings: {} } });
    const { splitBindHost, splitBindPort, listeningAddressLabel, isLoopbackHost } = page.probe;

    const cases = [
      { bind: '::1', host: '::1', port: '', loopback: true, label: '[::1]:18080' },
      { bind: '[::1]', host: '::1', port: '', loopback: true, label: '[::1]:18080' },
      { bind: '[::1]:18080', host: '::1', port: '18080', loopback: true, label: '[::1]:18080' },
      { bind: 'fe80::1', host: 'fe80::1', port: '', loopback: false, label: '[fe80::1]:18080' },
      { bind: '0.0.0.0:18080', host: '0.0.0.0', port: '18080', loopback: false, label: '0.0.0.0:18080' },
      { bind: '127.0.0.1', host: '127.0.0.1', port: '', loopback: true, label: '127.0.0.1:18080' },
    ];

    for (const c of cases) {
      assert.strictEqual(splitBindHost(c.bind), c.host, `${c.bind} 的主机部分解析错误`);
      assert.strictEqual(splitBindPort(c.bind), c.port, `${c.bind} 的端口部分解析错误`);
      assert.strictEqual(isLoopbackHost(splitBindHost(c.bind)), c.loopback,
        `${c.bind} 的回环判断错误`);
      assert.strictEqual(listeningAddressLabel(c.bind), c.label, `${c.bind} 的展示地址错误`);
    }

    // 回环监听（含 ::1）不该弹「只在本机可用」——解析错了就会把 ::1 判成非回环。
    for (const bind of ['::1', '[::1]', '[::1]:18080', '127.0.0.1']) {
      const p = loadPage({ hostname: '127.0.0.1', port: '18080', body: { settings: { bind_address: bind } } });
      const row = p.makeRow('接口地址', '');
      p.wire(row);
      await tick();
      assert.strictEqual(hintsOf(row).length, 0, `监听 ${bind} 时不该提示「只在本机可用」`);
    }

    // 非回环 IPv6 要提示，并且展示地址带方括号，主机与端口分得清。
    {
      const p = loadPage({ hostname: '127.0.0.1', port: '18080', body: { settings: { bind_address: 'fe80::1' } } });
      const row = p.makeRow('接口地址', '');
      p.wire(row);
      await tick();
      const hints = hintsOf(row);
      assert.strictEqual(hints.length, 1, '监听 fe80::1 时应提示');
      assert(hints[0].textContent.includes('[fe80::1]:18080'),
        `IPv6 展示地址必须带方括号与端口，实际「${hints[0].textContent}」`);
    }
  }

  console.log('ok - 接口地址：复制 origin+/v1、成功/失败提示、本机口径提示按访问来源与监听地址判定');
}

main().catch((err) => {
  console.error('测试失败:', err.message);
  process.exit(1);
});
