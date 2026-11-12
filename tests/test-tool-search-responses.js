'use strict';
/**
 * ADR-0021 / Issue 02：Responses 适配器消费 Tool Search 痕迹的纯函数单测。
 * seam：src/responses-adapter.js 的 translateRequest（无网络、无网关进程）。
 *
 * 消费语义：
 *   - tools[] 里的 tool_search / tool_search_tool_* 条目 → 不 400，进 notes.consumedTools；
 *   - input items 里的 tool_search_call / tool_search_output / tool_reference → 不 400，
 *     进 notes.consumedInput，不残留空消息；
 *   - 工具条目上的 defer_loading 显式剥离，进 notes.consumedFields；
 *   - 其余未知工具类型仍进 unsupportedTools（handle 400 unsupported_tool_type），
 *     未知 input 类型仍进 unknownInput（handle 400 unsupported_input_type）。
 */

const assert = require('assert');
const path = require('path');

const { translateRequest } = require(path.join(__dirname, '..', 'src', 'responses-adapter.js'));

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ---- 1. tools 含 {type:'tool_search'} + 正常 function → 只剩 function，不 400 ----
{
  const { chat, notes } = translateRequest({
    model: 'm1',
    input: 'hi',
    tools: [
      { type: 'tool_search' },
      { type: 'function', name: 'get_weather', description: '查天气', parameters: { type: 'object', properties: {} } },
    ],
  });
  assert.strictEqual(chat.tools.length, 1, 'tool_search 必须被消费，翻译后只剩 function');
  assert.strictEqual(chat.tools[0].function.name, 'get_weather');
  assert.strictEqual(notes.unsupportedTools.length, 0, 'tool_search 不得进 unsupportedTools');
  assert.ok(notes.consumedTools.includes('tool_search'), 'consumedTools 必须记录 tool_search');
  assert.strictEqual(notes.droppedTools.length, 0, '消费不是丢弃，不进 droppedTools');
  ok('tool_search 条目消费：不 400、进 consumedTools');
}

// ---- 2. tool_search_tool_* 客户端变体（含日期后缀）一律消费 ----
for (const variant of ['tool_search_tool_regex', 'tool_search_tool_bm25', 'tool_search_tool_regex_20251119']) {
  const { chat, notes } = translateRequest({
    model: 'm1',
    input: 'hi',
    tools: [{ type: variant }],
  });
  assert.strictEqual((chat.tools || []).length, 0, `${variant} 必须被消费`);
  assert.strictEqual(notes.unsupportedTools.length, 0, `${variant} 不得进 unsupportedTools`);
  assert.deepStrictEqual(notes.consumedTools, [variant], `${variant} 必须进 consumedTools`);
}
ok('tool_search_tool_regex / bm25 / 日期后缀变体全部消费');

// ---- 3. defer_loading 显式剥离并进 consumedFields ----
{
  // 扁平结构
  const a = translateRequest({
    model: 'm1',
    input: 'hi',
    tools: [{ type: 'function', name: 'f1', defer_loading: true }],
  });
  assert.strictEqual(a.chat.tools.length, 1);
  assert.strictEqual(a.chat.tools[0].function.defer_loading, undefined, 'defer_loading 必须被剥离');
  assert.ok(a.notes.consumedFields.includes('defer_loading'), 'consumedFields 必须记录 defer_loading');

  // 嵌套结构
  const b = translateRequest({
    model: 'm1',
    input: 'hi',
    tools: [{ type: 'function', function: { name: 'f2', defer_loading: true } }],
  });
  assert.strictEqual(b.chat.tools[0].function.defer_loading, undefined);
  assert.ok(b.notes.consumedFields.includes('defer_loading'));

  // 未携带 defer_loading 时不留痕
  const c = translateRequest({
    model: 'm1',
    input: 'hi',
    tools: [{ type: 'function', name: 'f3' }],
  });
  assert.strictEqual(c.notes.consumedFields.length, 0, '无 defer_loading 不得虚报 consumedFields');
}
ok('defer_loading 剥离 + consumedFields 留痕（扁平/嵌套/无该字段三态）');

// ---- 4. input items：tool_search_call / tool_search_output / tool_reference 消费 ----
{
  const { chat, notes } = translateRequest({
    model: 'm1',
    input: [
      { type: 'message', role: 'user', content: '找一下工具' },
      { type: 'tool_search_call', id: 'ts1' },
      { type: 'tool_search_output', id: 'ts2', output: 'found' },
      { type: 'tool_reference', tool_name: 'mcp__x__y' },
      { type: 'message', role: 'assistant', content: '好的' },
    ],
  });
  assert.strictEqual(notes.unknownInput.length, 0, '三种痕迹不得进 unknownInput');
  assert.strictEqual(notes.consumedInput.length, 3);
  for (const t of ['tool_search_call', 'tool_search_output', 'tool_reference']) {
    assert.ok(notes.consumedInput.includes(t), `consumedInput 必须含 ${t}`);
  }
  // 不残留空消息：只有两条 message 各自翻成一条
  assert.strictEqual(chat.messages.length, 2);
  assert.strictEqual(chat.messages[0].role, 'user');
  assert.strictEqual(chat.messages[1].role, 'assistant');
}
ok('tool_search_call / tool_search_output / tool_reference 进 consumedInput，不残留空消息');

// ---- 5. AC6 语义不变：web_search 仍进 unsupportedTools；未知 input 仍进 unknownInput ----
{
  const a = translateRequest({
    model: 'm1',
    input: 'hi',
    tools: [{ type: 'web_search' }, { type: 'computer_use' }],
  });
  assert.deepStrictEqual([...new Set(a.notes.unsupportedTools)], ['web_search', 'computer_use'],
    '非 tool_search 一族必须照旧进 unsupportedTools');
  assert.strictEqual(a.notes.consumedTools.length, 0);

  const b = translateRequest({
    model: 'm1',
    input: [{ type: 'message', role: 'user', content: 'x' }, { type: 'item_reference', id: 'r1' }],
  });
  assert.ok(b.notes.unknownInput.includes('item_reference'), '未知 input 类型必须照旧进 unknownInput');
  assert.strictEqual(b.notes.consumedInput.length, 0);
}
ok('web_search / computer_use 仍 400 语义（unsupportedTools）；未知 input 仍进 unknownInput');

// ---- 6. 混合场景：function_call 闭环 + tool_search 痕迹穿插，消息顺序不乱 ----
{
  const { chat, notes } = translateRequest({
    model: 'm1',
    input: [
      { type: 'message', role: 'user', content: '帮我查天气' },
      { type: 'tool_search_call', id: 'ts_a' },
      { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"北京"}' },
      { type: 'tool_search_output', id: 'ts_b' },
      { type: 'function_call_output', call_id: 'call_1', output: '晴 25 度' },
      { type: 'message', role: 'assistant', content: '北京今天晴，25 度。' },
    ],
    tools: [
      { type: 'tool_search' },
      { type: 'function', name: 'get_weather', parameters: { type: 'object', properties: {} } },
    ],
  });
  assert.strictEqual(notes.unknownInput.length, 0);
  assert.strictEqual(notes.unsupportedTools.length, 0);
  assert.strictEqual(notes.consumedInput.length, 2);
  assert.ok(notes.consumedTools.includes('tool_search'));

  // 期望顺序：user → assistant(tool_calls) → tool → assistant
  const roles = chat.messages.map((m) => m.role);
  assert.deepStrictEqual(roles, ['user', 'assistant', 'tool', 'assistant'], '消息顺序不得因消费而错乱');
  assert.strictEqual(chat.messages[1].tool_calls.length, 1);
  assert.strictEqual(chat.messages[1].tool_calls[0].id, 'call_1');
  assert.strictEqual(chat.messages[2].tool_call_id, 'call_1');
  assert.strictEqual(chat.messages[2].content, '晴 25 度');
  assert.strictEqual(chat.tools.length, 1, '翻译后只剩 function 工具');
}
ok('混合场景：闭环消息顺序不乱，痕迹被消费');

// ---- 7. notes 只增不删：旧键仍在 ----
{
  const { notes } = translateRequest({ model: 'm1', input: 'hi' });
  for (const key of ['droppedTools', 'unsupportedTools', 'customTools', 'unknownInput', 'previousResponseId']) {
    assert.ok(key in notes, `旧键 ${key} 必须保留`);
  }
  for (const key of ['consumedTools', 'consumedInput', 'consumedFields']) {
    assert.ok(key in notes, `新键 ${key} 必须存在`);
  }
}
ok('notes 旧键保留、新键 consumedTools/consumedInput/consumedFields 就位');

// ---- 8. 公共判定在 translateRequest 接缝生效（第二层接缝证据）----
// 预期来自 ADR-0021:23：Responses 域同时认裸 tool_search 与前缀变体；
// 判定收敛到 adapter-common 后，该行为在适配器接缝处必须不变。
{
  const { chat, notes } = translateRequest({
    model: 'm1', input: 'hi',
    tools: [
      { type: 'tool_search' },
      { type: 'tool_search_tool_regex_20251119' },
      { type: 'function', name: 'real', parameters: { type: 'object' } },
    ],
  });
  assert.strictEqual(chat.tools.length, 1, '两个 tool_search 条目都被消费，只剩 function');
  assert.strictEqual(chat.tools[0].function.name, 'real');
  assert.deepStrictEqual([...notes.consumedTools].sort(), ['tool_search', 'tool_search_tool_regex_20251119']);
  assert.deepStrictEqual(notes.unsupportedTools, [], '消费不进 unsupportedTools');
}
// ---- 9. tool_choice：目标被消费时不下发并留痕；指向已声明工具时照发 ----
{
  const consumed = translateRequest({
    model: 'm1',
    input: 'hi',
    tools: [
      { type: 'tool_search' },
      { type: 'function', name: 'real', parameters: { type: 'object' } },
    ],
    tool_choice: { type: 'function', name: 'tool_search' },
  });
  assert.strictEqual('tool_choice' in consumed.chat, false, '指向被消费工具的 tool_choice 不得下发');
  assert.strictEqual(consumed.notes.degradedToolChoice, 'tool_search', '丢弃必须留痕');
  assert.strictEqual(consumed.chat.tools.length, 1, '被消费工具不出现在 tools');

  const kept = translateRequest({
    model: 'm1',
    input: 'hi',
    tools: [{ type: 'function', name: 'real', parameters: { type: 'object' } }],
    tool_choice: { type: 'function', name: 'real' },
  });
  assert.deepStrictEqual(kept.chat.tool_choice, { type: 'function', function: { name: 'real' } }, '指向已声明工具时照发');

  // 笔误（未声明且未被消费）：原样下发，交上游按未知 function 拒绝——不静默吞掉
  const typo = translateRequest({
    model: 'm1',
    input: 'hi',
    tools: [{ type: 'function', name: 'real', parameters: { type: 'object' } }],
    tool_choice: { type: 'function', name: 'no_such_tool' },
  });
  assert.deepStrictEqual(typo.chat.tool_choice, { type: 'function', function: { name: 'no_such_tool' } }, '笔误不得被当作降级丢弃');
  assert.strictEqual(typo.notes.degradedToolChoice, null, '笔误不写降级留痕');
}

ok('tool_choice 降级与笔误透传');

// ---- 10. tools 全消费：required / 具名 记降级；无消费不记 ----
{
  const allConsumed = [{ type: 'tool_search' }];
  const reqd = translateRequest({ model: 'm1', input: 'hi', tools: allConsumed, tool_choice: { type: 'function' } });
  assert.strictEqual(reqd.notes.degradedToolChoice, 'required', '全消费时 required 意图必须留痕');
  assert.strictEqual('tool_choice' in reqd.chat, false, '全消费时不得下发 tool_choice');
  const named = translateRequest({ model: 'm1', input: 'hi', tools: allConsumed, tool_choice: { type: 'function', name: 'tool_search' } });
  assert.strictEqual(named.notes.degradedToolChoice, 'tool_search', '全消费时具名目标必须留痕');
  const none = translateRequest({ model: 'm1', input: 'hi', tool_choice: { type: 'function', name: 'x' } });
  assert.strictEqual(none.notes.degradedToolChoice, null, '无消费不得记降级（避免伪降级）');
}

ok('tools 全消费的降级留痕与无消费不记');
ok('公共判定在 translateRequest 接缝生效（Responses 域认裸类型与前缀变体）');

console.log(`\ntest-tool-search-responses: ${passed} 组断言全部通过`);
