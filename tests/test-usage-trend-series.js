'use strict';

// 趋势数据的整形与 tooltip 文案：两个纯函数，不碰 DOM、不读全局状态。
// 做法与 test-usage-range-select.js 一致：把页面内联脚本塞进 vm 沙箱跑一遍，
// 末尾追加探针把新函数挂到 globalThis.__probe 上，然后直接调用断言。
// 这样测到的是页面里真正会跑的那份代码，而不是另抄一份。

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
const inline = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)]
  .map(m => m[1])
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
  body: makeElement('body'),
  documentElement: makeElement('html'),
};

const noop = () => 0;
const sandbox = {
  document,
  window: { addEventListener() {}, matchMedia() { return { matches: false, addEventListener() {} }; } },
  navigator: { userAgent: 'node-test', clipboard: { writeText() {} } },
  location: { href: 'http://127.0.0.1:18080/', origin: 'http://127.0.0.1:18080' },
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
  toast: () => {},
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;

const rejections = [];
process.on('unhandledRejection', (e) => rejections.push(e));

const closer = inline.lastIndexOf('})();');
assert(closer > 0, '找不到内联脚本的 IIFE 结尾');
const patched = inline.slice(0, closer)
  + '\n;globalThis.__probe = { usageTrendSeries, usageTrendTooltip, usageCompact };\n'
  + inline.slice(closer);

vm.createContext(sandbox);
vm.runInContext(patched, sandbox, { filename: 'index.html#inline' });

const probe = sandbox.__probe;
assert(probe && probe.usageTrendSeries, '内联脚本没有暴露 usageTrendSeries');
assert(probe.usageTrendTooltip, '找不到 usageTrendTooltip');
assert(probe.usageCompact, '找不到 usageCompact');

const { usageTrendSeries, usageTrendTooltip, usageCompact } = probe;

// 沙箱里的数组带着沙箱自己的 Array.prototype，deepStrictEqual 会因原型不同判不等，
// 统一先转成本地数组再比。
const plain = (a) => Array.prototype.slice.call(a);

// 一个正常的小时点：两个 token 段之和 150，而 total_tokens 故意给了个不同的数，
// 用来钉住「柱高只由输入+输出决定，不许拿 total_tokens 去凑」。
function hourPoint(over) {
  return Object.assign({
    slot: '2026-11-10T09',
    granularity: 'hour',
    scope: 'hour',
    requests: 12,
    errors: 1,
    prompt_tokens: 100,
    completion_tokens: 50,
    total_tokens: 999999,
    credits: 0.5,
    cache_hit: 8,
    cache_miss: 4,
    cache_hit_rate: 0.666,
    avg_latency_ms: 640,
    avg_tokens_per_second: 30,
    buckets: 12,
  }, over || {});
}

// 1) 空数组：四条线都是空数组，不抛错。
{
  const out = usageTrendSeries([]);
  assert.deepStrictEqual(plain(out.labels), [], '空数组应该给出空轴标签');
  for (const key of ['prompt', 'completion', 'requests', 'errors']) {
    assert.deepStrictEqual(plain(out[key]), [], `空数组时 ${key} 应为空`);
  }
}
// 非数组输入也不该炸（接口没回来 series 是常见情形）。
{
  const out = usageTrendSeries(null);
  assert.deepStrictEqual(plain(out.labels), [], 'series 为 null 时应退回空数组');
}

// 2) 单点：轴标签与四条线各一个元素，且 prompt/completion 原样保留，
//    不能被 total_tokens（999999）顶替或修正。
{
  const src = hourPoint();
  const out = usageTrendSeries([src]);
  assert.deepStrictEqual(plain(out.labels), ['2026-11-10T09'], '轴标签应取 slot');
  assert.deepStrictEqual(plain(out.prompt), [100], '输入段必须是 prompt_tokens');
  assert.deepStrictEqual(plain(out.completion), [50], '输出段必须是 completion_tokens');
  assert.deepStrictEqual(plain(out.requests), [12], '请求数应取 requests');
  assert.deepStrictEqual(plain(out.errors), [1], '失败数应取 errors');
  assert.strictEqual(out.prompt[0] + out.completion[0], 150, '柱高必须由输入+输出构成');
  // 守卫：total_tokens 与两段之和不一致时，不许为了「对上总数」而调整任何一段。
  assert.notStrictEqual(src.total_tokens, src.prompt_tokens + src.completion_tokens,
    '测试数据必须保持 total_tokens 与两段之和不一致');
  assert.strictEqual(out.prompt[0], src.prompt_tokens, 'total_tokens 更大时也不许改 prompt');
  assert.strictEqual(out.completion[0], src.completion_tokens, 'total_tokens 更大时也不许改 completion');
  // total 数组已删：tooltip 直接用原始点的 total_tokens，整形结果不再重复产出它。
  assert.strictEqual(out.total, undefined, 'usageTrendSeries 不应再产出 total 字段');
}

// 3) 含 0 值的时间片：0 就是 0，不能变成 null/NaN，也不能少一个点。
{
  const out = usageTrendSeries([
    hourPoint({ slot: '2026-11-10T10', requests: 0, errors: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }),
    hourPoint({ slot: '2026-11-10T11' }),
  ]);
  assert.strictEqual(out.labels.length, 2, '0 值点也要占一个轴标签');
  assert.strictEqual(out.prompt[0], 0, '0 token 应保持 0');
  assert.strictEqual(out.requests[0], 0, '0 请求应保持 0');
  assert.strictEqual(out.errors[0], 0, '0 失败应保持 0');
  assert.ok(out.prompt.every(n => Number.isFinite(n)), '整形结果里不许漏 NaN');
}

// 4) 四条数组与轴标签等长（多点混合 scope 也要成立）。
{
  const series = [
    hourPoint({ slot: '2026-11-10T00' }),
    hourPoint({ slot: '2026-11-09', scope: 'day', granularity: 'day' }),
    hourPoint({ slot: '2026-11-10T01', prompt_tokens: null, completion_tokens: null }),
  ];
  const out = usageTrendSeries(series);
  for (const key of ['prompt', 'completion', 'requests', 'errors']) {
    assert.strictEqual(out[key].length, out.labels.length, `${key} 与轴标签必须等长`);
    assert.strictEqual(out[key].length, series.length, `${key} 长度应等于点数`);
  }
  assert.strictEqual(out.prompt[2], 0, '缺字段的段按 0 处理');
}

// 5) tooltip 字段顺序：时间 → 输入 → 输出 → 合计 token → 请求数 · 失败数 → 缓存命中率 → 平均延迟 → 估算消耗。
{
  const lines = usageTrendTooltip(hourPoint());
  assert.ok(Array.isArray(lines), 'tooltip 应返回若干行文本');
  assert.ok(lines.length >= 8, 'tooltip 至少八行，一行一个字段');
  const order = ['2026-11-10T09', '输入', '输出', '合计', '请求', '缓存命中', '平均延迟', '估算'];
  let cursor = -1;
  for (const token of order) {
    const idx = lines.findIndex((line, i) => i > cursor && String(line).includes(token));
    assert.ok(idx > cursor, `「${token}」没出现在上一字段之后，字段顺序被改了`);
    cursor = idx;
  }
  assert.ok(/估算/.test(String(lines[lines.length - 1])), '估算消耗必须标注「估算」');
}

// 6) 紧凑数字：1234 → 1.2k，3400000 → 3.4M，999 原样，null → —。
{
  assert.strictEqual(usageCompact(1234), '1.2k', '1234 应写成 1.2k');
  assert.strictEqual(usageCompact(3400000), '3.4M', '3400000 应写成 3.4M');
  assert.strictEqual(usageCompact(999), '999', '千位以下不压缩');
  assert.strictEqual(usageCompact(0), '0', '0 应写成 0');
  assert.strictEqual(usageCompact(null), '—', 'null 应显示 —');

  const lines = usageTrendTooltip(hourPoint({ prompt_tokens: 1234, completion_tokens: 3400000, total_tokens: 3401234 }));
  const joined = lines.join('\n');
  assert.ok(joined.includes('1.2k'), 'tooltip 里 1234 应写成 1.2k');
  assert.ok(joined.includes('3.4M'), 'tooltip 里 3400000 应写成 3.4M');
  assert.ok(!joined.includes('1,234'), '紧凑写法里不能再混入千分位');
}

// 7) scope === 'day' 的时间要标「（全天）」，不能和小时点说成同一件事。
{
  const dayLines = usageTrendTooltip(hourPoint({ slot: '2026-11-09', scope: 'day', granularity: 'day' }));
  assert.ok(String(dayLines[0]).includes('（全天）'), '整日汇总的时间行必须带「（全天）」');
  const hourLines = usageTrendTooltip(hourPoint({ slot: '2026-11-10T09', scope: 'hour' }));
  assert.ok(!String(hourLines[0]).includes('（全天）'), '小时点不该被标成全天');
}

// 8) 缓存命中率为 null 时显示「—」，不是 0%。
{
  const lines = usageTrendTooltip(hourPoint({ cache_hit_rate: null, cache_hit: null, cache_miss: null }));
  const line = lines.find(l => String(l).includes('缓存命中'));
  assert.ok(line, 'tooltip 必须有缓存命中率一行');
  assert.ok(String(line).includes('—'), '缓存命中率缺失时应显示 —');
  assert.ok(!String(line).includes('0.0%') && !String(line).includes('0%'), '缓存命中率缺失时不能显示 0%');
}

// 9) 平均延迟为 null 时同样显示「—」，不能是 0 ms。
{
  const lines = usageTrendTooltip(hourPoint({ avg_latency_ms: null }));
  const line = lines.find(l => String(l).includes('平均延迟'));
  assert.ok(line, 'tooltip 必须有平均延迟一行');
  assert.ok(String(line).includes('—'), '平均延迟缺失时应显示 —');
  assert.ok(!/0\s*ms/.test(String(line)), '平均延迟缺失时不能显示 0 ms');
}

// 10) 中文与多行 slot 不被改写、不抛错（slot 理论上不含换行，但别在我们这儿炸）。
{
  const slot = '2026-11-10 09时\n（测试）';
  const lines = usageTrendTooltip(hourPoint({ slot }));
  assert.strictEqual(lines[0], slot, 'slot 应原样出现在时间行里');
  const shaped = usageTrendSeries([hourPoint({ slot })]);
  assert.deepStrictEqual(plain(shaped.labels), [slot], '轴标签应原样保留中文 slot');
  const daySlot = '二〇二六年十一月九日';
  const dayLines = usageTrendTooltip(hourPoint({ slot: daySlot, scope: 'day' }));
  assert.strictEqual(dayLines[0], daySlot + '（全天）', '中文 slot 后面也要能接上（全天）');
}

// 11) 全 0 的点不该把 tooltip 弄成 null/undefined 字样。
{
  const lines = usageTrendTooltip(hourPoint({
    requests: 0, errors: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
    cache_hit_rate: 0, avg_latency_ms: 0, credits: 0,
  }));
  const joined = lines.join('\n');
  assert.ok(!/null|undefined|NaN/.test(joined), 'tooltip 里不能漏出 null/undefined/NaN');
  assert.ok(joined.includes('0'), '全 0 的点应当显示 0 而不是空白');
}

process.removeAllListeners('unhandledRejection');
if (rejections.length) {
  for (const e of rejections) {
    const msg = String((e && e.message) || e);
    if (!/null|undefined|Cannot read|not a function/i.test(msg)) throw e;
  }
}

console.log('ok - 用量趋势：数据整形与 tooltip 文案');
