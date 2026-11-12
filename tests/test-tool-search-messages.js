'use strict';
/**
 * ADR-0021：Messages 适配器消费 Anthropic Tool Search 痕迹的单测。
 * seam：src/messages-adapter.js 的 translateRequest（纯函数，无网络）。
 *
 * 消费语义（与「丢弃」区分）：
 *   - tools[] 里 tool_search_tool_* 前缀类型：消费（不 400、进 consumedTools）
 *   - 工具定义 defer_loading：显式剥离并留痕（consumedFields）
 *   - 历史块 tool_reference / server_tool_use / tool_search_tool_result：消费
 *     （进 consumedBlocks，不进 droppedBlocks，纯块消息不残留空 user 消息）
 *   - 其余未知类型行为不变：unsupportedTools → 400、droppedBlocks 语义不变
 */

const assert = require('assert');
const path = require('path');
const { EventEmitter } = require('events');

const { translateRequest, createMessagesAdapter } = require(path.join(__dirname, '..', 'src', 'messages-adapter.js'));

// ---- 1. tools[]：tool_search_tool_* 消费，正常 function 工具保留 ----
{
  const r = translateRequest({
    model: 'm',
    tools: [
      { type: 'tool_search_tool_regex_20251119', name: 'tool_search_tool_regex' },
      { type: 'tool_search_tool_bm25', name: 'tool_search_tool_bm25' },
      {
        name: 'get_weather',
        description: '查天气',
        input_schema: { type: 'object', properties: { city: { type: 'string' } } },
      },
    ],
  }, {});
  assert.strictEqual(r.chat.tools.length, 1, 'tool_search 条目必须从 chat.tools 剔除');
  assert.strictEqual(r.chat.tools[0].function.name, 'get_weather');
  assert.deepStrictEqual(r.notes.unsupportedTools, [], 'tool_search 条目不得进 unsupportedTools（否则 400）');
  assert.ok(r.notes.consumedTools.includes('tool_search_tool_regex_20251119'), 'consumedTools 要留痕');
  assert.ok(r.notes.consumedTools.includes('tool_search_tool_bm25'), '不带日期后缀的变体同样消费');
}

// ---- 2. defer_loading：不出现在翻译结果，consumedFields 留痕 ----
{
  const r = translateRequest({
    tools: [{
      name: 'deferred_tool',
      description: 'x',
      input_schema: { type: 'object', properties: {} },
      defer_loading: true,
    }],
  }, {});
  assert.strictEqual(r.chat.tools.length, 1);
  assert.strictEqual(r.chat.tools[0].function.defer_loading, undefined, 'defer_loading 不得透传到翻译结果');
  assert.deepStrictEqual(r.notes.consumedFields, ['defer_loading']);
  // 白名单只拷贝协议内字段
  assert.deepStrictEqual(
    Object.keys(r.chat.tools[0]),
    ['type', 'function'],
    '函数工具只保留 type/function 两个键',
  );
}
{
  // defer_loading 不为 true 时不留痕
  const r = translateRequest({
    tools: [{ name: 't', input_schema: { type: 'object' }, defer_loading: false }],
  }, {});
  assert.deepStrictEqual(r.notes.consumedFields, []);
}

// ---- 3. user 历史块：tool_search_tool_result / tool_reference 消费 ----
{
  const r = translateRequest({
    messages: [{
      role: 'user',
      content: [
        { type: 'tool_search_tool_result', tool_use_id: 'srv_1', content: [] },
        { type: 'tool_reference', tool_name: 'some_mcp_tool' },
      ],
    }],
  }, {});
  assert.deepStrictEqual(r.notes.droppedBlocks, [], '检索痕迹块不得进 droppedBlocks（否则 400）');
  assert.ok(r.notes.consumedBlocks.includes('tool_search_tool_result'));
  assert.ok(r.notes.consumedBlocks.includes('tool_reference'));
  // 纯块消息不残留空 user 消息
  assert.deepStrictEqual(r.chat.messages, [], '消费后不应残留空消息');
}

// ---- 4. assistant 历史块：server_tool_use 消费，text 正常拼接 ----
{
  const r = translateRequest({
    messages: [{
      role: 'assistant',
      content: [
        { type: 'text', text: '让我搜一下。' },
        { type: 'server_tool_use', id: 'srv_1', name: 'tool_search_tool_regex', input: {} },
        { type: 'text', text: '找到了。' },
      ],
    }],
  }, {});
  assert.deepStrictEqual(r.notes.droppedBlocks, []);
  assert.ok(r.notes.consumedBlocks.includes('server_tool_use'));
  assert.strictEqual(r.chat.messages.length, 1);
  // text 块按既有语义拼接：只断言两段文本都在，不把拼接顺序/分隔符钉成契约
  assert.ok(r.chat.messages[0].content.includes('让我搜一下。'), '第一段 text 正常拼接');
  assert.ok(r.chat.messages[0].content.includes('找到了。'), '第二段 text 正常拼接');
}

// ---- 5. AC6 6b 语义不变：bash_20241022 仍进 unsupportedTools ----
{
  const r = translateRequest({ tools: [{ type: 'bash_20241022', name: 'bash' }] }, {});
  assert.deepStrictEqual(r.notes.unsupportedTools, ['bash_20241022'], 'bash 前缀仍必须 400');
  assert.deepStrictEqual(r.notes.consumedTools, []);
}

// ---- 6. 混合场景：tool_search 痕迹与 tool_use/tool_result 正常闭环共存，顺序不乱 ----
{
  const r = translateRequest({
    tools: [
      { type: 'tool_search_tool_regex_20251119', name: 'tool_search_tool_regex' },
      { name: 'mcp_search', input_schema: { type: 'object' }, defer_loading: true },
    ],
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '搜索工具。' },
          { type: 'tool_use', id: 'call_1', name: 'mcp_search', input: { q: 'x' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: '结果' },
          { type: 'tool_reference', tool_name: 'mcp_search' },
          { type: 'text', text: '继续' },
        ],
      },
    ],
  }, {});
  // 工具：只留 deferred 的正常 function，痕迹全部留痕
  assert.strictEqual(r.chat.tools.length, 1);
  assert.strictEqual(r.chat.tools[0].function.name, 'mcp_search');
  assert.deepStrictEqual(r.notes.consumedTools, ['tool_search_tool_regex_20251119']);
  assert.deepStrictEqual(r.notes.consumedFields, ['defer_loading']);
  assert.deepStrictEqual(r.notes.droppedBlocks, []);
  assert.deepStrictEqual(r.notes.unsupportedTools, []);
  assert.deepStrictEqual([...r.notes.consumedBlocks].sort(), ['tool_reference']);
  // 消息顺序：assistant(tool_calls) -> tool 结果 -> user 文本
  const msgs = r.chat.messages;
  assert.strictEqual(msgs.length, 3);
  assert.strictEqual(msgs[0].role, 'assistant');
  assert.strictEqual(msgs[0].tool_calls[0].id, 'call_1');
  assert.strictEqual(msgs[1].role, 'tool');
  assert.strictEqual(msgs[1].tool_call_id, 'call_1');
  assert.strictEqual(msgs[1].content, '结果');
  assert.strictEqual(msgs[2].role, 'user');
  assert.strictEqual(msgs[2].content, '继续');
  assert.strictEqual(r.notes.toolResults, 1);
}

// ---- 7. 其余未知类型行为不变：droppedBlocks 语义不受消费改动影响 ----
{
  const r = translateRequest({
    messages: [{
      role: 'user',
      content: [{ type: 'document', source: {} }],
    }],
  }, {});
  assert.deepStrictEqual(r.notes.droppedBlocks, ['user:document'], '非 tool_search 族仍按丢弃语义');
  assert.deepStrictEqual(r.notes.consumedBlocks, []);
}

// ---- 8. notes 键只增不删 ----
{
  const r = translateRequest({}, {});
  for (const key of ['droppedBlocks', 'unsupportedTools', 'toolResults', 'consumedTools', 'consumedBlocks', 'consumedFields']) {
    assert.ok(key in r.notes, `notes.${key} 必须存在（旧键不删、新键只增）`);
  }
}

// ---- 9. assistant 纯痕迹消息：消费后不残留 content:'' 空消息（与 user 分支对称） ----
{
  const r = translateRequest({
    messages: [
      { role: 'user', content: '搜一下' },
      { role: 'assistant', content: [{ type: 'server_tool_use', id: 'srv_9', name: 'tool_search_tool_regex', input: {} }] },
      { role: 'user', content: [{ type: 'tool_search_tool_result', tool_use_id: 'srv_9', content: [] }] },
      { role: 'assistant', content: [{ type: 'text', text: '搜到了' }] },
    ],
  }, {});
  assert.deepStrictEqual([...r.notes.consumedBlocks].sort(), ['server_tool_use', 'tool_search_tool_result'],
    '两类痕迹块都进 consumedBlocks（集合断言，不依赖 assistant/user 处理顺序）');
  assert.deepStrictEqual(r.notes.droppedBlocks, []);
  const roles = r.chat.messages.map((m) => m.role);
  assert.deepStrictEqual(roles, ['user', 'assistant'], '纯痕迹的 assistant/user 不得残留空消息');
  assert.strictEqual(r.chat.messages[1].content, '搜到了');
}

// ---- 10. server_tool_use 一律消费（ADR-0021:48），不进 droppedBlocks ----
{
  const r = translateRequest({
    messages: [{
      role: 'assistant',
      content: [{ type: 'server_tool_use', id: 'srv_10', name: 'web_search', input: {} }],
    }],
  }, {});
  assert.deepStrictEqual(r.notes.consumedBlocks, ['server_tool_use'], '三类历史块一律消费');
  assert.deepStrictEqual(r.notes.droppedBlocks, [], '消费不得进 droppedBlocks（否则 handle 会本地拒绝并返回 400）');
  assert.deepStrictEqual(r.chat.messages, [], '纯痕迹 assistant 不残留空消息');
}

// ---- 11. 裸 tool_search 在 Messages 侧不消费（ADR-0021:23 划归 Responses） ----
{
  const r = translateRequest({
    tools: [{ type: 'tool_search', name: 'tool_search' }, { name: 'real', input_schema: { type: 'object' } }],
  }, {});
  assert.strictEqual(r.chat.tools.length, 1);
  assert.strictEqual(r.chat.tools[0].function.name, 'real');
  assert.deepStrictEqual(r.notes.consumedTools, [], '前缀之外的裸类型不在 Messages 消费域');
  assert.ok(r.notes.unsupportedTools.includes('tool_search'), '裸类型按未知工具类型本地拒绝');
}

console.log('ok - tool-search 消费：tools 剔除 / defer_loading 剥离 / 历史块消费 / bash 仍 400 / 混合闭环 / droppedBlocks 语义不变 / 纯痕迹不残留空消息 / server_tool_use 一律消费 / 裸 tool_search 按 ADR 归 Responses / web_search 插曲无回归');

// ---- 12. 回归：web_search 插曲整体仍被拒绝（ADR-0021 只承诺消费检索插曲） ----
// 测试证据：server_tool_use 一律消费，但配对的 server tool result 不在消费集合，
// 仍按丢弃 → 400（与 ADR-0021「web_search 等没有可替代执行语义」的后果一致）。
// 第 10 组改为断言消费后，这条保证由此用例单独钉住。
{
  const r = translateRequest({
    messages: [
      { role: 'assistant', content: [{ type: 'server_tool_use', id: 'srv_12', name: 'web_search', input: {} }] },
      { role: 'user', content: [{ type: 'web_search_tool_result', tool_use_id: 'srv_12', content: [] }] },
    ],
  }, {});
  assert.deepStrictEqual(r.notes.consumedBlocks, ['server_tool_use'], 'server_tool_use 一律消费');
  assert.deepStrictEqual(r.notes.droppedBlocks, ['user:web_search_tool_result'],
    '配对的 server tool result 不在消费集合，仍按丢弃 → 400（整条插曲被拒）');
}

// ---- 13. 公共判定在 translateRequest 接缝生效（第二层接缝证据）----
// 预期来自 ADR-0021:23：Messages 域只认 tool_search_tool_ 前缀，裸类型
// 归 Responses；判定收敛到 adapter-common 后该行为在适配器接缝处必须不变。
{
  const r = translateRequest({
    tools: [
      { type: 'tool_search', name: 'tool_search' },
      { type: 'tool_search_tool_bm25' },
      { name: 'real', input_schema: { type: 'object' } },
    ],
  }, {});
  assert.strictEqual(r.chat.tools.length, 1, '只剩正常 function 工具');
  assert.strictEqual(r.chat.tools[0].function.name, 'real');
  assert.deepStrictEqual(r.notes.consumedTools, ['tool_search_tool_bm25'], 'Messages 域只消费前缀变体');
  assert.ok(r.notes.unsupportedTools.includes('tool_search'), '裸类型在 Messages 域仍本地拒绝');
}

// ---- 14. tool_choice 指向被消费工具：不下发并留痕----
// 目标 function 已被 tool_search 消费、不在 chat.tools 中；照译会让上游收到
// 不存在的 function 并回 400（与 ADR-0021「开箱即用」后果相悖）。改为不下发，
// 并在 notes.degradedToolChoice 留痕，由 handle 层打日志——不静默。
{
  const r = translateRequest({
    tools: [
      { type: 'tool_search_tool_bm25', name: 'tool_search_tool_bm25' },
      { name: 'real', input_schema: { type: 'object' } },
    ],
    tool_choice: { type: 'tool', name: 'tool_search_tool_bm25', disable_parallel_tool_use: true },
  }, {});
  assert.strictEqual('tool_choice' in r.chat, false, '指向被消费工具的 tool_choice 不得下发（上游无该 function，必 400）');
  assert.strictEqual(r.notes.degradedToolChoice, 'tool_search_tool_bm25', '丢弃必须留痕到 notes');
  assert.strictEqual(r.chat.tools.length, 1, '被消费工具不出现在 tools');
  assert.strictEqual(r.chat.parallel_tool_calls, false, 'disable_parallel_tool_use 仍生效');

  // 客户端笔误（未声明且未被消费）：保持原样下发，交上游按未知 function 拒绝——不静默吞掉
  const typo = translateRequest({
    tools: [{ name: 'real', input_schema: { type: 'object' } }],
    tool_choice: { type: 'tool', name: 'no_such_tool' },
  }, {});
  assert.deepStrictEqual(
    typo.chat.tool_choice,
    { type: 'function', function: { name: 'no_such_tool' } },
    '笔误不得被当作「被消费」丢弃',
  );
  assert.strictEqual(typo.notes.degradedToolChoice, null, '笔误不写丢弃留痕');
}

// ---- 15. 工具全被消费：不下发 tool_choice / parallel_tool_calls ----
// 工具全被消费后 tools 为空，此时仍下发 tool_choice 会被上游按「无 tools 却指定
// tool_choice」拒绝（400 unknown_parameter / invalid_request）。回退策略：整段
// tool_choice 与 disable_parallel_tool_use 不下发，请求仍按纯文本对话成功。
// 已知限制：客户端指定的工具被消费后，tool_choice 的意图随之丢失。
{
  const allConsumed = [{ type: 'tool_search_tool_regex_20251119', name: 'tool_search_tool_regex' }];
  const cases = [
    { type: 'auto' },
    { type: 'any' },
    { type: 'none' },
    { type: 'tool', name: 'chosen' },
    { type: 'auto', disable_parallel_tool_use: true },
  ];
  for (const tc of cases) {
    const r = translateRequest({ model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: allConsumed, tool_choice: tc }, {});
    assert.strictEqual(r.chat.tools, undefined, '工具全被消费时不设置 chat.tools');
    assert.ok(r.notes.consumedTools.includes('tool_search_tool_regex_20251119'), '工具确实被消费');
    assert.strictEqual(
      'tool_choice' in r.chat, false,
      `工具全被消费时不得下发 tool_choice(${tc.type})：无 tools 携带 tool_choice 会被上游拒绝`,
    );
    assert.strictEqual(
      'parallel_tool_calls' in r.chat, false,
      '工具全被消费时不得下发 parallel_tool_calls（它依附于 tools 语义）',
    );
    assert.strictEqual(r.chat.messages.length, 1, '请求其余部分仍正常翻译，可继续成功发出');
    const expectedDegraded = tc.type === 'any' ? 'any' : (tc.type === 'tool' ? 'chosen' : null);
    assert.strictEqual(
      r.notes.degradedToolChoice, expectedDegraded,
      `全消费时 tool_choice 降级必须留痕(${tc.type})`,
    );
  }

  // 有工具存在时四类语义与 disable_parallel_tool_use 完全不变。
  const withTool = [{ name: 'real', input_schema: { type: 'object' } }];
  const kept = [
    ['auto', { type: 'auto' }, 'auto'],
    ['any', { type: 'any' }, 'required'],
    ['none', { type: 'none' }, 'none'],
    ['tool', { type: 'tool', name: 'real' }, { type: 'function', function: { name: 'real' } }],
  ];
  for (const [label, tc, expected] of kept) {
    const r = translateRequest({ tools: withTool, tool_choice: tc }, {});
    assert.deepStrictEqual(r.chat.tool_choice, expected, `有工具时 tool_choice(${label}) 照常翻译`);
  }
  const keptParallel = translateRequest({ tools: withTool, tool_choice: { type: 'auto', disable_parallel_tool_use: true } }, {});
  assert.strictEqual(keptParallel.chat.parallel_tool_calls, false, '有工具时 disable_parallel_tool_use 照常生效');

  // 无 tools 且无消费：不记降级（避免伪降级）
  const noTools = translateRequest({ tool_choice: { type: 'any' } }, {});
  assert.strictEqual(noTools.notes.degradedToolChoice, null, '无消费不得记降级');
}

// ---- 16. assistant 分支的 tool_reference 同样被消费（ADR-0021:48：两处都认）----
{
  const r = translateRequest({
    messages: [{
      role: 'assistant',
      content: [
        { type: 'text', text: '引用工具。' },
        { type: 'tool_reference', tool_name: 'mcp__x__y' },
      ],
    }],
  }, {});
  assert.deepStrictEqual(r.notes.droppedBlocks, [], 'assistant 侧 tool_reference 不进 droppedBlocks');
  assert.ok(r.notes.consumedBlocks.includes('tool_reference'), 'assistant 侧 tool_reference 进 consumedBlocks');
  assert.strictEqual(r.chat.messages.length, 1, '只保留一条 assistant 消息');
  assert.ok(r.chat.messages[0].content.includes('引用工具。'), '同条消息的 text 正常保留');
}

// ---- 17. 纯痕迹 assistant 混 thinking：thinking 回传、痕迹消费、不残留空消息 ----
{
  const r = translateRequest({
    messages: [{
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '我在检索…', signature: 'sig' },
        { type: 'server_tool_use', id: 'srv_17', name: 'tool_search_tool_regex', input: {} },
        { type: 'redacted_thinking', data: 'cipher' },
      ],
    }],
  }, {});
  assert.ok(r.notes.consumedBlocks.includes('server_tool_use'), '痕迹块被消费');
  assert.deepStrictEqual(r.notes.droppedBlocks, [], 'thinking / redacted_thinking 均不进 droppedBlocks');
  assert.strictEqual(r.chat.messages.length, 1, '混 thinking 时保留一条带 reasoning_content 的 assistant');
  assert.strictEqual(r.chat.messages[0].reasoning_content, '我在检索…', 'thinking 明文按 ADR-0022 回传');
}

// ---- 18. 畸形 tools 元素：不抛错，正常工具仍可用，非法工具被本地拒绝 ----
{
  const r = translateRequest({
    tools: [
      null,
      'not-an-object',
      42,
      { name: 'no_schema' },                          // 缺 input_schema
      { type: 'mystery', input_schema: {} },           // 缺 name
      { name: 'ok', input_schema: { type: 'object' } }, // 正常
    ],
  }, {});
  assert.strictEqual(r.chat.tools.length, 1, '畸形元素不影响正常工具翻译');
  assert.strictEqual(r.chat.tools[0].function.name, 'ok');
  assert.ok(r.notes.unsupportedTools.length >= 2, '缺 name / input_schema 的对象进 unsupportedTools');
  assert.ok(r.notes.droppedBlocks.some((b) => b.startsWith('tool:')), '非法工具按丢弃语义留痕（会触发本地拒绝）');
  assert.ok(!r.notes.unsupportedTools.includes('not-an-object'), '非对象元素被忽略，不虚报 unsupportedTools');
}

// ---- 19. handle 级：tool-search 消费日志与 400 拒绝日志可区分 ----
// 统一约定 1「消费与丢弃/本地拒绝在日志里可区分」的绿态证据。此前四个
// tool-search 测试都停在纯函数 translateRequest 接缝，到不了 handle；这里注入
// log stub 直接调 createMessagesAdapter().handle，用假 req/res 复现两条路径，
// 断言：消费走 tool-search consumed 日志并继续，本地拒绝走「拒绝不支持的内容
// 块类型」日志并 400，两者日志互不串台。不 fork 网关、不占端口、可重复执行。
async function handleLevelLogDistinction() {
  function fakeReq(bodyObj) {
    const req = new EventEmitter();
    const payload = Buffer.from(JSON.stringify(bodyObj), 'utf8');
    req.headers = { 'content-length': payload.length };
    setImmediate(() => {
      req.emit('data', payload);
      req.emit('end');
    });
    return req;
  }

  function fakeRes() {
    return {
      statusCode: 200, headersSent: false, writableEnded: false, body: null,
      setHeader() {}, removeHeader() {}, getHeader() { return undefined; },
      writeHead(code) { this.statusCode = code; this.headersSent = true; return this; },
      write() { return true; },
      end(chunk) { this.writableEnded = true; this.body = chunk; return this; },
    };
  }

  async function runHandle(bodyObj) {
    const logs = [];
    const adapter = createMessagesAdapter({
      log: (...args) => logs.push(args),
      run: () => {}, // 不真发上游：消费日志在调 run 之前已经产生
      // 不注入 resolveModel / checkModel：跳过模型校验分支
    });
    const res = fakeRes();
    await adapter.handle(fakeReq(bodyObj), res, 'test-key');
    return { logs, res };
  }

  const flatten = (logs) => logs.map((a) => a.map(String).join(' ')).join('\n');

  // 消费路径：工具含 tool_search 变体 + 历史 tool_reference 块，droppedBlocks 为空
  const consumed = await runHandle({
    model: 'm',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [
        { type: 'text', text: 'ok' },
        { type: 'tool_reference', tool_name: 'mcp__x' },
      ] },
    ],
    tools: [{ type: 'tool_search_tool_regex_20251119', name: 'tool_search_tool_regex' }],
  });
  const consumedText = flatten(consumed.logs);
  assert.ok(consumedText.includes('tool-search consumed'), '消费路径必须打 tool-search consumed 日志');
  assert.ok(!consumedText.includes('拒绝不支持的内容块类型'), '消费路径不得打本地拒绝日志');
  assert.notStrictEqual(consumed.res.statusCode, 400, '消费路径不得被本地拒绝中断');

  // 本地拒绝路径：含一个不支持的内容块，droppedBlocks 非空 → handle 400
  const rejected = await runHandle({
    model: 'm',
    messages: [{ role: 'user', content: [{ type: 'document', source: {} }] }],
  });
  const rejectedText = flatten(rejected.logs);
  assert.ok(rejectedText.includes('拒绝不支持的内容块类型'), '本地拒绝路径必须打拒绝日志');
  assert.ok(!rejectedText.includes('tool-search consumed'), '本地拒绝路径不得打消费日志');
  assert.strictEqual(rejected.res.statusCode, 400, '本地拒绝路径返回 400');

  // 两条路径的日志行文案确实不同（可区分），而非同一条日志
  assert.notStrictEqual(
    consumed.logs.find((a) => String(a[0]).includes('tool-search consumed'))[0],
    rejected.logs.find((a) => String(a[0]).includes('拒绝不支持的内容块类型'))[0],
    '消费日志与本地拒绝日志是两条不同文案',
  );

  console.log('ok - handle 级：tool-search consumed 日志与 400 拒绝日志可区分（统一约定 1 绿态证据）');
}

handleLevelLogDistinction().catch((err) => {
  console.error('❌ handle 级日志可区分断言失败:', err.stack || err.message);
  process.exitCode = 1;
});
