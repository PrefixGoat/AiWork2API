'use strict';

// 票 10：curl 档 —— 粘进终端就能跑。
//
// 这一档只是往 COPY_FORMATS 里 push 的一项，按钮、下拉、预览都不动。
// 输出的价值全在「能直接粘」：地址不能多带 /v1、请求体要能被 JSON.parse 还原、
// 模型名里的引号不能让 shell 提前闭合引号。所以这里只测格式函数本身。
//
// 纯函数用 vm 沙箱把内联脚本真跑一遍，沿用 test-key-config-copy.js 的手法。

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
const inline = [...HTML.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1])
  .join('\n');
assert(inline.length > 1000, '没抓到页面内联脚本');

// ---- 最小 DOM：只够脚本初始化跑完，我们只关心纯函数 ----
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
const sandbox = {
  document,
  window: { isSecureContext: false, addEventListener() {}, matchMedia() { return { matches: false, addEventListener() {} }; } },
  navigator: { userAgent: 'node-test', clipboard: undefined },
  location: { href: 'http://192.168.1.10:18080/', host: '192.168.1.10:18080', hostname: '192.168.1.10', port: '18080', protocol: 'http:', origin: 'http://192.168.1.10:18080' },
  localStorage,
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
  + '\n;globalThis.__probe = { COPY_FORMATS, formatById, maskContext };\n'
  + inline.slice(closer);

vm.createContext(sandbox);
vm.runInContext(patched, sandbox, { filename: 'index.html#inline' });
const probe = sandbox.__probe;

function finish() {
  process.removeAllListeners('unhandledRejection');
  if (rejections.length) {
    for (const e of rejections) {
      const msg = String((e && e.message) || e);
      if (!/null|undefined|Cannot read|not a function/i.test(msg)) throw e;
    }
  }
}

const CTX = {
  keyName: 'Cursor IDE',
  baseUrl: 'http://192.168.1.10:18080/v1',
  apiKey: 'sk-live-abcdefghijklwxyz',
  model: 'deepseek-flash',
  models: ['deepseek-flash', 'deepseek-v4.1-flash'],
};

// 从命令里取回 -d 后面的请求体，按 shell 规则把引号还原，返回可直接 JSON.parse 的字符串。
function extractBody(text) {
  const idx = text.lastIndexOf('-d ');
  assert(idx > -1, '命令里必须有 -d 请求体');
  const raw = text.slice(idx + 3).trim();
  assert.strictEqual(raw[0], "'", '请求体必须用单引号包住，否则 JSON 里的双引号会打架');
  assert.strictEqual(raw[raw.length - 1], "'", '请求体结尾必须是闭合的单引号');
  // shell 里 '\'' 表示「结束单引号 + 转义的单引号 + 重新开单引号」，还原回一个单引号。
  return raw.slice(1, -1).replace(/'\\''/g, "'");
}

// ---- 1. curl 档存在，结构仍然是 { id, label, format } ----
const curlFmt = probe.formatById('curl');
assert(curlFmt && curlFmt.id === 'curl', '格式表里必须有 curl 这一项');
assert.strictEqual(curlFmt.label, 'curl', '下拉里显示的名字就是 curl');
assert.strictEqual(typeof curlFmt.format, 'function', 'curl 档必须有 format(ctx) 纯函数');
// 档位数会随后续格式增加，这里守的是「这张票只加了 curl 一项、没顺手塞别的、也没重复」，
// 不是「永远只有两档」——把总数写死会让每加一档都误报。
assert.strictEqual(
  probe.COPY_FORMATS.filter((f) => f.id === 'curl').length, 1, 'curl 档只能有一项');
assert.strictEqual(
  new Set(probe.COPY_FORMATS.map((f) => f.id)).size, probe.COPY_FORMATS.length, '档位 id 不能重复');
assert.strictEqual(probe.COPY_FORMATS[0].id, 'json', 'JSON 仍是默认档，位置不变');

// ---- 2. 地址口径：base_url 已带 /v1，只补 /chat/completions，不出现 /v1/v1 ----
{
  const text = curlFmt.format(CTX);
  assert(text.startsWith('curl -s '), '按 README 习惯用 curl -s，且命令以它开头');
  assert(
    text.includes('http://192.168.1.10:18080/v1/chat/completions'),
    'URL 必须是 base_url + /chat/completions'
  );
  assert(!/\/v1\/v1/.test(text), 'base_url 已带 /v1，不能再拼一次');
  assert(!/ANTHROPIC|OPENAI_/.test(text), 'curl 档里不该混进 ENV 的变量名');
  assert(text.includes('-H "Authorization: Bearer ' + CTX.apiKey + '"'), '鉴权头用真值 key');
  assert(text.includes('-H "Content-Type: application/json"'), '必须声明 JSON 请求体');
  // 多行续行：除最后一行外每行都以反斜杠结尾，读起来像 README 示例。
  const lines = text.split('\n');
  assert(lines.length >= 3, '按 README 的样子分三行写');
  for (let i = 0; i < lines.length - 1; i++) {
    assert(/\\$/.test(lines[i]), '除末行外每行都要以反斜杠续行');
  }
}

// ---- 3. 请求体是合法 JSON：模型对、消息是单轮 user、中文原样保留 ----
{
  const body = extractBody(curlFmt.format(CTX));
  assert(!/\\u[0-9a-fA-F]{4}/.test(body), '中文不应被转成 \\uXXXX 转义序列');
  assert(body.includes('你好'), '示例消息「你好」要原样出现在命令里');
  const parsed = JSON.parse(body); // 解析不了就是硬失败
  assert.deepStrictEqual(Object.keys(parsed).sort(), ['messages', 'model'], '请求体只该有 model 与 messages');
  assert.strictEqual(parsed.model, 'deepseek-flash', '模型用选定的那个');
  assert.deepStrictEqual(
    parsed.messages,
    [{ role: 'user', content: '你好' }],
    '消息是单轮 user，内容是「你好」'
  );
}

// ---- 4. 模型名含单引号：转成 '\''，命令不破且能还原 ----
{
  const odd = { ...CTX, model: "deepseek'flash" };
  const text = curlFmt.format(odd);
  assert(text.includes("'\\''"), "单引号必须转成 '\\'' 形式，否则 shell 会提前闭合引号");
  const parsed = JSON.parse(extractBody(text));
  assert.strictEqual(parsed.model, "deepseek'flash", '转义后模型名必须能原样还原');
}

// ---- 5. 模型名含双引号 / 反斜杠：仍在单引号里，JSON 自己转义，照样能还原 ----
{
  const odd = { ...CTX, model: 'deepseek"flash\\v2' };
  const parsed = JSON.parse(extractBody(curlFmt.format(odd)));
  assert.strictEqual(parsed.model, 'deepseek"flash\\v2', '双引号与反斜杠必须能原样还原');
}

// ---- 6. 模型列表为空：不抛错，模型沿用 ctx.model ----
{
  const empty = { ...CTX, models: [], model: 'automodel' };
  const parsed = JSON.parse(extractBody(curlFmt.format(empty)));
  assert.strictEqual(parsed.model, 'automodel', '清单为空时仍按 ctx.model 出命令');
  assert.deepStrictEqual(parsed.messages, [{ role: 'user', content: '你好' }], '模型清单不影响请求体');
}

// ---- 7. 预览：key 换成掩码后仍是同一档，输出里没有真 key ----
{
  const previewText = curlFmt.format(probe.maskContext(CTX));
  assert(!previewText.includes(CTX.apiKey), '预览里绝不能出现完整 key');
  assert(previewText.includes('…'), '预览里的 key 必须是掩码形态');
  assert(previewText.includes('/v1/chat/completions'), '预览除了 key 之外与复制路径同形');
}

// ---- 8. 静态：这一档是 push 上去的，且没有碰 innerHTML ----
{
  const start = HTML.indexOf('COPY_FORMATS.push(');
  assert(start > -1, 'curl 档应以 COPY_FORMATS.push(...) 的形式追加，不改数组本体');
  assert(start > HTML.indexOf('const COPY_FORMATS = ['), 'push 必须在格式表定义之后');
  assert(start < HTML.indexOf('function renderKeyCard('), 'push 应紧跟在格式表后面，别散落到别处');
  const slice = HTML.slice(start, HTML.indexOf('const COPY_FORMAT_STORAGE_KEY'));
  assert(/id: 'curl'/.test(slice), 'push 的项 id 必须是 curl');
  assert(!/innerHTML/.test(slice), '这一档只能用字符串拼接，不碰 innerHTML');
}

finish();
console.log('ok - curl 档：地址口径、请求体可解析、引号转义与空模型列表');
