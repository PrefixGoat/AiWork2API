'use strict';
/**
 * ADR-0021：tool_search 类型判定与消费留痕的公共接口单测。
 * seam：src/adapter-common.js 的模块导出（纯函数，无网络）。
 * 预期值来自 ADR-0021:23 的协议域划分与消费留痕要求，不是从实现反推的。
 */

const assert = require('assert');
const path = require('path');

const C = require(path.join(__dirname, '..', 'src', 'adapter-common.js'));

// ---- 1. 按接入协议域判定 tool_search 一族 ----
// Messages 域：只认 tool_search_tool_ 前缀（裸 tool_search 按 ADR 归 Responses）
assert.strictEqual(C.isToolSearchType('tool_search_tool_regex_20251119', 'messages'), true);
assert.strictEqual(C.isToolSearchType('tool_search_tool_bm25', 'messages'), true);
assert.strictEqual(C.isToolSearchType('tool_search', 'messages'), false, '裸 tool_search 不属 Messages 域');
assert.strictEqual(C.isToolSearchType('web_search', 'messages'), false);
// Responses 域：额外认裸 tool_search
assert.strictEqual(C.isToolSearchType('tool_search', 'responses'), true, '裸 tool_search 属 Responses 域');
assert.strictEqual(C.isToolSearchType('tool_search_tool_regex', 'responses'), true);
assert.strictEqual(C.isToolSearchType('web_search', 'responses'), false);
// 空值 / 非字符串 / 其他未知类型一律 false
for (const bad of ['', null, undefined, 42, 'computer_20241022', 'custom_shell']) {
  assert.strictEqual(C.isToolSearchType(bad, 'messages'), false, `isToolSearchType(${JSON.stringify(bad)})`);
}

console.log('ok - tool-search 公共判定：协议域划分（ADR-0021:23）');

// ---- 5. tool_choice 降级留痕日志：域校验与中性文案 ----
{
  const calls = [];
  const log = (...args) => calls.push(args);
  C.emitDegradedChoiceTrace(log, 'tool_search', 'messages');
  assert.strictEqual(calls.length, 1, '合法域必须输出一条日志');
  assert.strictEqual(calls[0][0], '[%s] tool_choice 降级不下发（目标不可用）: %s');
  assert.strictEqual(calls[0][1], 'messages');
  assert.strictEqual(calls[0][2], 'tool_search');
  C.emitDegradedChoiceTrace(log, 'x', 'unknown');
  assert.strictEqual(calls.length, 1, '未知域不得输出');
  C.emitDegradedChoiceTrace(log, null, 'messages');
  assert.strictEqual(calls.length, 1, '无目标不得输出');
}
console.log('ok - tool_choice 降级留痕日志：域校验与中性文案');

// ---- 2. 消费留痕按域分组去重（ADR-0021 统一约定 1）----
// 预期值来自规格约定的 notes 键名差异：Messages 有 consumedBlocks、
// Responses 有 consumedInput，不是从实现反推的。
const m = C.consumedTrace({
  consumedTools: ['tool_search_tool_regex', 'tool_search_tool_regex'],
  consumedBlocks: ['tool_reference', 'server_tool_use'],
  consumedFields: [],
}, 'messages');
assert.deepStrictEqual(m.tools, ['tool_search_tool_regex'], '重复项必须去重');
assert.deepStrictEqual(m.blocks, ['tool_reference', 'server_tool_use']);
assert.deepStrictEqual(m.fields, []);
assert.deepStrictEqual(m.input, [], '固定键集：非本域组为空数组，不隐式缺键');
// groups 用集合断言：只要求覆盖本域全部组，不把内部组顺序钉成对外契约
assert.deepStrictEqual([...m.groups].sort(), ['blocks', 'fields', 'tools'], '域描述符覆盖本域全部组（集合断言）');
assert.strictEqual(m.hasConsumed, true);

const r = C.consumedTrace({
  consumedTools: ['tool_search'],
  consumedInput: ['tool_search_call', 'tool_search_call'],
  consumedFields: ['defer_loading'],
}, 'responses');
assert.deepStrictEqual(r.tools, ['tool_search']);
assert.deepStrictEqual(r.input, ['tool_search_call'], '重复项必须去重');
assert.deepStrictEqual(r.fields, ['defer_loading']);
assert.deepStrictEqual(r.blocks, [], '固定键集：非本域组为空数组');
assert.deepStrictEqual([...r.groups].sort(), ['fields', 'input', 'tools'], '域描述符覆盖本域全部组（集合断言）');
assert.strictEqual(r.hasConsumed, true);

// 空 / 缺键 notes：不出日志、不抛错
for (const domain of ['messages', 'responses']) {
  const empty = C.consumedTrace({}, domain);
  assert.strictEqual(empty.hasConsumed, false);
  assert.deepStrictEqual(empty.tools, []);
  assert.deepStrictEqual(empty.fields, []);
  // groups 恒为数组即可，组数是内部结构，不钉死为 3 的契约
  assert.ok(Array.isArray(empty.groups), 'groups 始终是数组（组数属内部结构，不钉死为契约）');
}

console.log('ok - tool-search 公共留痕：按域分组去重');

// ---- 3. 消费日志构造（公共接口，log 由参数注入）----
// 预期格式来自 ADR-0021 后果节的消费留痕要求（`log('[...tool-search] consumed ...')`）
// 与两协议 notes 键名差异，不从实现反推。
{
  const calls = [];
  const collect = (...args) => calls.push(args);
  C.emitConsumedTrace(collect, {
    consumedTools: ['tool_search_tool_regex', 'tool_search_tool_regex'],
    consumedBlocks: ['tool_reference'],
    consumedFields: [],
  }, 'messages');
  assert.strictEqual(calls.length, 1, '有消费必须打一条日志');
  assert.ok(calls[0][0].includes('[messages] tool-search consumed'));
  assert.ok(calls[0][0].includes('blocks=[%s]'), 'Messages 域日志键名是 blocks');
  // 格式化参数改用集合/行为断言：不再钉死参数个数、组顺序与空组的空串占位
  // （内部格式化细节，非对外契约）；只断言去重后的值进入参数、文案含全部组占位符。
  const mFmt = String(calls[0][0]);
  const mArgs = calls[0].slice(1).map(String);
  assert.ok(mFmt.includes('tools=[%s]') && mFmt.includes('blocks=[%s]') && mFmt.includes('fields=[%s]'),
    'messages 域日志文案含本域全部组的占位符');
  assert.ok(mArgs.includes('tool_search_tool_regex'), '去重后的 tools 值进入格式化参数');
  assert.ok(mArgs.includes('tool_reference'), 'blocks 值进入格式化参数');

  calls.length = 0;
  C.emitConsumedTrace(collect, {
    consumedTools: ['tool_search'],
    consumedInput: ['tool_search_call'],
    consumedFields: ['defer_loading'],
  }, 'responses');
  assert.strictEqual(calls.length, 1);
  assert.ok(calls[0][0].includes('[responses] tool-search consumed'));
  assert.ok(calls[0][0].includes('input=[%s]'), 'Responses 域日志键名是 input');
  const rFmt = String(calls[0][0]);
  const rArgs = calls[0].slice(1).map(String);
  assert.ok(rFmt.includes('tools=[%s]') && rFmt.includes('input=[%s]') && rFmt.includes('fields=[%s]'),
    'responses 域日志文案含本域全部组的占位符');
  for (const v of ['tool_search', 'tool_search_call', 'defer_loading']) {
    assert.ok(rArgs.includes(v), `去重后的 ${v} 值进入格式化参数`);
  }

  // 守卫也收敛在公共接口：无消费时不打日志
  calls.length = 0;
  C.emitConsumedTrace(collect, {}, 'messages');
  C.emitConsumedTrace(collect, {}, 'responses');
  assert.strictEqual(calls.length, 0, '空 notes 不得打日志');
}

console.log('ok - tool-search 公共留痕：日志构造与守卫');

// ---- 4. notes 列表去重拼接（条款 3：两适配器不得各写一份）----
// 预期来自通用契约「Set 去重 → 逗号拼接 → 可选 limit 截断」的手工算例，
// 与 7 处既有调用点的行为约定一致，不是从实现反推。
{
  assert.strictEqual(C.dedupeJoin(['a', 'a', 'b']), 'a, b');
  assert.strictEqual(C.dedupeJoin(['x', 'x']), 'x');
  assert.strictEqual(C.dedupeJoin([]), '');
  assert.strictEqual(C.dedupeJoin(null), '');
  assert.strictEqual(C.dedupeJoin(undefined), '');
  assert.strictEqual(C.dedupeJoin(['a', 'b', 'c', 'd'], 2), 'a, b', 'limit 截断');
  assert.strictEqual(C.dedupeJoin(['a', 'a', 'b', 'c'], 8), 'a, b, c', '去重先于截断');
}

console.log('ok - tool-search 公共去重拼接：dedupeJoin');

// ---- 5. 未实现工具类型的本地拒绝：守卫 / 文案 / 错误码（条款 3）----
// seam：src/adapter-common.js 的模块导出（纯函数）。
// 预期来自两适配器既有 400 文案、Issue #07 / US-46 契约与 spec「错误文案不动」约定，
// 不是从实现反推。共享件收敛判定与文案，两个适配器只保留发送载体差异。
{
  const hit = C.unsupportedToolsError({ unsupportedTools: ['web_search', 'web_search', 'computer_use'] });
  assert.deepStrictEqual(hit, {
    message: '不支持的工具类型: web_search, computer_use。网关不提供未实现工具的静默兜底。',
    code: 'unsupported_tool_type',
  }, '去重拼接 + 固定文案 + 固定 code');

  // 守卫：空 / 缺键 / 非数组 / notes 为空，一律不触发本地拒绝
  for (const bad of [{}, { unsupportedTools: [] }, { unsupportedTools: null }, null, undefined]) {
    assert.strictEqual(C.unsupportedToolsError(bad), null, '无 unsupportedTools 不得触发本地拒绝');
  }
}

console.log('ok - tool-search 公共本地拒绝：unsupportedToolsError 守卫/文案/错误码');

// ---- 6. defer_loading 消费留痕写入侧（条款 3）----
// seam：src/adapter-common.js 的模块导出（纯函数）。
// 预期来自 ADR-0021 决定 2 与两适配器既有三态行为（扁平 / 嵌套 / 无字段，false 不虚报）：
// Messages 域是扁平工具条目，Responses 域的函数工具允许 {function:{...}} 嵌套。
// 不是从实现反推。domain 显式表达扁平 / 嵌套字段检查的差异。
{
  function fields(tool, domain) {
    const notes = { consumedFields: [] };
    C.consumeDeferLoading(tool, notes, domain);
    return notes.consumedFields;
  }

  // Messages 域：扁平条目
  assert.deepStrictEqual(fields({ defer_loading: true }, 'messages'), ['defer_loading']);
  assert.deepStrictEqual(fields({ defer_loading: false }, 'messages'), [], 'false 不虚报');
  assert.deepStrictEqual(fields({}, 'messages'), [], '无字段不虚报');
  assert.deepStrictEqual(fields({ function: { defer_loading: true } }, 'messages'), [],
    'Messages 扁平结构只看条目上的字段，不认嵌套');

  // Responses 域：条目或嵌套 function 上的字段都认
  assert.deepStrictEqual(fields({ defer_loading: true }, 'responses'), ['defer_loading']);
  assert.deepStrictEqual(fields({ type: 'function', function: { name: 'f', defer_loading: true } }, 'responses'),
    ['defer_loading'], '嵌套 function 上的 defer_loading 也要留痕');
  assert.deepStrictEqual(fields({ type: 'function', function: { name: 'f', defer_loading: false } }, 'responses'),
    [], 'false 不虚报');
  assert.deepStrictEqual(fields({ type: 'function', function: { name: 'f' } }, 'responses'),
    [], '无字段不虚报');

  // notes 缺失 / t 非对象不抛错（写入侧守卫）
  C.consumeDeferLoading({ defer_loading: true }, null, 'responses');
  C.consumeDeferLoading(null, { consumedFields: [] }, 'responses');
}

console.log('ok - tool-search 公共消费留痕写入：consumeDeferLoading 扁平/嵌套/无字段/false 三态+域差异');
