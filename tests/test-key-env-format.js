'use strict';

// 接入配置复制：ENV 档（票 09）。
//
// 这一档只往 COPY_FORMATS push 一项，不改下拉、按钮与预览。它的价值全在两段输出的口径上：
//   - OpenAI 套直接可用：BASE_URL 带 /v1；
//   - Claude Code 套整段注释：BASE_URL 不带 /v1（否则客户端会拼成 /v1/v1/messages），
//     变量名是 ANTHROPIC_AUTH_TOKEN 而不是 ANTHROPIC_API_KEY。
// 断言按「逐行」写，而不是拿实现再拼一遍，避免同构断言。
//
// 加载手法沿用 test-key-config-copy.js：把页面内联脚本真跑进 vm 沙箱。

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

// 把输出拆成行，顺便钉住「不含多余空白」——粘进 shell 后 env 能逐行读。
function linesOf(text) {
  assert.strictEqual(typeof text, 'string', 'format(ctx) 必须返回字符串');
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    assert.strictEqual(line, line.trim(), `第 ${i + 1} 行有多余的首尾空白：${JSON.stringify(line)}`);
  });
  return lines;
}

const CTX = {
  keyName: 'Cursor IDE',
  baseUrl: 'http://192.168.1.10:18080/v1',
  apiKey: 'sk-live-abcdefghijklwxyz',
  model: 'deepseek-flash',
  models: ['deepseek-flash', 'deepseek-v4.1-flash'],
};

// ---- 1. env 档存在，形状与其他档一致 ----
const envFmt = probe.formatById('env');
assert(envFmt && envFmt.id === 'env', '格式表里必须有 env 这一项');
assert.strictEqual(envFmt.label, 'ENV', 'env 档的下拉文案是 ENV');
assert.strictEqual(typeof envFmt.format, 'function', 'env 档必须有 format(ctx) 纯函数');

{
  const lines = linesOf(envFmt.format(CTX));

  // ---- 2. OpenAI 套：可直接 source，BASE_URL 带 /v1 ----
  const openaiBase = lines.filter((l) => l.startsWith('OPENAI_BASE_URL='));
  assert.strictEqual(openaiBase.length, 1, 'OPENAI_BASE_URL 必须恰好一行且不被注释');
  assert.strictEqual(openaiBase[0], 'OPENAI_BASE_URL=http://192.168.1.10:18080/v1', 'OPENAI_BASE_URL 必须带 /v1');
  assert.strictEqual(
    lines.filter((l) => l.startsWith('OPENAI_API_KEY='))[0],
    'OPENAI_API_KEY=sk-live-abcdefghijklwxyz',
    'OPENAI_API_KEY 必须是真 key'
  );
  assert.strictEqual(
    lines.filter((l) => l.startsWith('OPENAI_MODEL='))[0],
    'OPENAI_MODEL=deepseek-flash',
    'OPENAI_MODEL 用 ctx.model'
  );

  // ---- 3. Anthropic 套：整段注释，BASE_URL 不带 /v1 ----
  const anthBase = lines.filter((l) => /^#\s*ANTHROPIC_BASE_URL=/.test(l));
  assert.strictEqual(anthBase.length, 1, 'ANTHROPIC_BASE_URL 必须恰好一行且在注释里');
  assert.strictEqual(anthBase[0], '# ANTHROPIC_BASE_URL=http://192.168.1.10:18080', 'ANTHROPIC_BASE_URL 不能带 /v1');
  assert(
    lines.every((l) => !/^ANTHROPIC_/.test(l)),
    'Anthropic 三行必须整段注释掉，不允许有未注释的 ANTHROPIC_ 行'
  );

  // ---- 4. 变量名是 AUTH_TOKEN，不能写成 API_KEY ----
  const authLines = lines.filter((l) => /ANTHROPIC_AUTH_TOKEN=/.test(l));
  assert.strictEqual(authLines.length, 1, '必须给 ANTHROPIC_AUTH_TOKEN 一行');
  assert.strictEqual(authLines[0], '# ANTHROPIC_AUTH_TOKEN=sk-live-abcdefghijklwxyz', 'AUTH_TOKEN 必须有值且在注释里');
  assert(
    lines.every((l) => !/ANTHROPIC_API_KEY/.test(l)),
    '不能出现 ANTHROPIC_API_KEY（Claude Code 认的是 AUTH_TOKEN）'
  );
  assert.strictEqual(
    lines.filter((l) => /^#\s*ANTHROPIC_MODEL=/.test(l))[0],
    '# ANTHROPIC_MODEL=deepseek-flash',
    'ANTHROPIC_MODEL 用 ctx.model 且在注释里'
  );

  // ---- 5. 两段都有能看懂用途的注释；Anthropic 的注释写明两个坑 ----
  const comments = lines.filter((l) => l.startsWith('#'));
  assert(comments.length >= 2, '两段各自都要有说明用途的注释行');
  assert(
    comments.some((l) => /OpenAI/.test(l)),
    'OpenAI 段要有说明用途的注释（提到 OpenAI）'
  );
  assert(
    comments.some((l) => /Claude|Anthropic/i.test(l)),
    'Anthropic 段要有说明用途的注释（提到 Claude / Anthropic）'
  );
  // 「说明注释」不是变量赋值行：找一行既提 AUTH_TOKEN、又不是 `# KEY=值` 的说明文字。
  const anthComment = comments.find((l) => /AUTH_TOKEN/.test(l) && !/^#\s*\S+=/.test(l));
  assert(anthComment, 'Anthropic 段要有一行说明文字，讲清为什么用 AUTH_TOKEN');
  assert(/\/v1/.test(anthComment), 'Anthropic 说明必须写明 BASE_URL 不带 /v1');
  assert(/AUTH_TOKEN/.test(anthComment), 'Anthropic 说明必须写明变量名是 AUTH_TOKEN');

  // ---- 6. 两段之间空一行，方便分段阅读 ----
  assert(/\n\n/.test(lines.join('\n')), '两段之间要空一行');

  // ---- 7. 复制与预览同形：只有 key 变掩码，其余字段一致 ----
  const previewText = envFmt.format(probe.maskContext(CTX));
  assert(!previewText.includes(CTX.apiKey), '预览里不能出现完整 key');
  const previewLines = linesOf(previewText);
  assert(
    previewLines.filter((l) => l === '# ANTHROPIC_BASE_URL=http://192.168.1.10:18080').length === 1,
    '预览的 ANTHROPIC_BASE_URL 同样不带 /v1'
  );
  assert(
    previewLines.filter((l) => l === 'OPENAI_BASE_URL=http://192.168.1.10:18080/v1').length === 1,
    '预览的 OPENAI_BASE_URL 同样带 /v1'
  );
}

// ---- 8. 模型名含特殊字符时不破 ----
{
  const odd = { ...CTX, model: 'claude-3.5-sonnet@2024+beta_1' };
  const lines = linesOf(envFmt.format(odd));
  assert.strictEqual(
    lines.filter((l) => l.startsWith('OPENAI_MODEL='))[0],
    'OPENAI_MODEL=claude-3.5-sonnet@2024+beta_1',
    '模型名里的 . - @ + _ 必须原样保留'
  );
  assert.strictEqual(
    lines.filter((l) => /^#\s*ANTHROPIC_MODEL=/.test(l))[0],
    '# ANTHROPIC_MODEL=claude-3.5-sonnet@2024+beta_1',
    'Anthropic 段的模型名同样原样保留'
  );
}

// ---- 9. models 为空数组：不抛错，也不需要 models ----
{
  const empty = { ...CTX, models: [], model: 'automodel' };
  const text = envFmt.format(empty);
  const lines = linesOf(text);
  assert.strictEqual(
    lines.filter((l) => l.startsWith('OPENAI_MODEL='))[0],
    'OPENAI_MODEL=automodel',
    'models 为空时仍只用 ctx.model'
  );
  assert(!/models/.test(text), 'ENV 档不用 models 列表，不应出现在输出里');
}

// ---- 10. 静态：只 push 了一项，没动按钮/下拉/预览 ----
{
  assert(
    /COPY_FORMATS\.push\(\{\s*id:\s*'env'/.test(HTML),
    'env 档必须是 COPY_FORMATS.push(...) 追加的，不在数组字面量里'
  );
  const regionStart = HTML.indexOf('COPY_FORMATS = [');
  const regionEnd = HTML.indexOf('function renderKeyCard(');
  const REGION = HTML.slice(regionStart, regionEnd);
  assert(/COPY_FORMATS\.forEach/.test(REGION), '下拉仍应由格式表生成');
  assert(/maskContext\(/.test(REGION), '预览仍应走掩码后的 ctx');
  assert(!/innerHTML/.test(REGION), '新逻辑只能用 createElement / textContent');
}

finish();
console.log('ok - ENV 档：OpenAI 套带 /v1，Anthropic 套整段注释且不带 /v1、用 AUTH_TOKEN');
