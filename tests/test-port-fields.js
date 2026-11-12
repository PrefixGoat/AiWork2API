'use strict';

// 设置页的端口三件套：监听 IP / 容器内端口 / 容器外端口。
// 把页面内联脚本放进最小 DOM 里真跑，验证「容器里给命令、本机部署无感」这条分叉，
// 以及复制出来的命令确实是当前输入框里的值（不是写死的字符串）。

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
const inline = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1])
  .join('\n');
assert(inline.length > 1000, '没抓到页面内联脚本');

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
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    getAttribute() { return null; },
    focus() {},
    click() {},
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
  body: makeElement('body'),
};

const noop = () => 0;
const sandbox = {
  document,
  window: { addEventListener() {}, matchMedia() { return { matches: false, addEventListener() {} }; } },
  navigator: { userAgent: 'node-test', clipboard: { writeText() { return Promise.resolve(); } } },
  // 浏览器里从 18080 打开这个页面 —— 也就是「容器外端口」应该是多少
  location: { href: 'http://127.0.0.1:18080/', host: '127.0.0.1:18080', hostname: '127.0.0.1', port: '18080', protocol: 'http:' },
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
};
sandbox.globalThis = sandbox;

process.on('unhandledRejection', () => {});

const closer = inline.lastIndexOf('})();');
assert(closer > 0, '找不到内联脚本的 IIFE 结尾');
const patched = inline.slice(0, closer)
  + '\n;globalThis.__probe = { state, splitBind, accessPort, accessTarget, renderBindEffective, renderPortFields, portCommand, updatePortCommand };\n'
  + inline.slice(closer);

vm.createContext(sandbox);
vm.runInContext(patched, sandbox, { filename: 'index.html#inline' });
const probe = sandbox.__probe;
assert(probe && probe.renderPortFields, '页面没有暴露端口相关函数');

const $ = (id) => document.getElementById(id);

// 1) 地址拆分：配置里仍是 host[:port]，展示层要能拆开
assert.deepStrictEqual(
  { ...probe.splitBind('0.0.0.0') },
  { host: '0.0.0.0', port: null },
  '只有主机时应 port=null'
);
assert.deepStrictEqual(
  { ...probe.splitBind('127.0.0.1:9000') },
  { host: '127.0.0.1', port: '9000' },
  '带端口时应拆出端口'
);
assert.deepStrictEqual({ ...probe.splitBind('') }, { host: '', port: null }, '空值不能炸');

// 2) 容器里：外端口可编辑、预填当前访问端口、给命令
probe.renderPortFields(true, 8080);
assert.strictEqual($('setHostPort').disabled, false, '容器里外端口应该是可编辑的');
assert.strictEqual($('setHostPort').value, '18080', '应预填你现在访问用的端口');
assert.notStrictEqual($('btnCopyPortCmd').style.display, 'none', '容器里必须给复制命令的按钮');
assert(/宿主机上访问用的端口/.test($('hostPortNote').textContent), '要说明外端口归 compose 管');

// 3) 命令跟着输入走，不是写死的
$('setListenPort').value = '9000';
$('setHostPort').value = '18081';
probe.updatePortCommand();
assert.strictEqual(probe.portCommand(), './scripts/set-port.sh --host 18081 --container 9000',
  '命令必须带上当前的内外端口');
assert.strictEqual($('portCmd').textContent, './scripts/set-port.sh --host 18081 --container 9000',
  '页面展示的命令要与复制内容一致');

// 4) 本机部署：外端口跟随内端口、不可编辑、没有命令按钮
probe.renderPortFields(false, 9000);
assert.strictEqual($('setHostPort').disabled, true, '没有容器映射时外端口不该能改');
assert.strictEqual($('setHostPort').value, '9000', '外端口应等于内端口');
assert.strictEqual($('btnCopyPortCmd').style.display, 'none', '本机部署不该让人去跑脚本');
assert(/内外是同一个端口/.test($('hostPortNote').textContent), '要说清为什么不能改');

// 5) 本机部署下即使改了内端口，命令也只提内端口（没有 --host）
$('setListenPort').value = '9100';
probe.updatePortCommand();
assert.strictEqual(probe.portCommand(), './scripts/set-port.sh --container 9100',
  '本机部署不需要 --host');

// 6) 「当前生效」必须把容器内、容器外两个端口都写出来，不能只甩一个 :8080 让人猜
probe.renderPortFields(true, 8080);
probe.renderBindEffective('0.0.0.0:8080', '0.0.0.0', 8080);
{
  const text = $('bindEffective').textContent;
  assert(/容器内 0\.0\.0\.0:8080/.test(text), `要写明容器内端口：${text}`);
  assert(/容器外 127\.0\.0\.1:18080/.test(text), `要写明容器外端口：${text}`);
}

// 7) 本机部署没有容器映射，不要硬编一个「容器外」
probe.renderPortFields(false, 8080);
probe.renderBindEffective('0.0.0.0:8080', '0.0.0.0', 8080);
{
  const text = $('bindEffective').textContent;
  assert(/容器内 0\.0\.0\.0:8080/.test(text), `仍要写明容器内端口：${text}`);
  assert(!/容器外/.test(text) && /本机部署/.test(text), `本机部署不该出现容器外：${text}`);
}

console.log('ok - 端口三件套：地址拆分 / 容器里给命令 / 本机部署跟随 / 命令跟输入走 / 内外都写明白');
