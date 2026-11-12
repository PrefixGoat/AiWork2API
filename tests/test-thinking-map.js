'use strict';
/**
 * ADR-0022：思考强度统一档位层的映射单测。
 * seam：src/thinking.js 的模块导出（纯函数，无网络）。
 * 预期值来自确认过的映射表（A–I 档位表），不是从实现反推的。
 */

const assert = require('assert');
const path = require('path');

const T = require(path.join(__dirname, '..', 'src', 'thinking.js'));

// ---- 1. effort 词 → 档位 ----
for (const [word, expect] of [
  ['none', 'off'], ['off', 'off'], ['disabled', 'off'], ['NONE', 'off'],
  ['minimal', 'minimal'], ['low', 'low'], ['medium', 'medium'], ['mid', 'medium'],
  ['high', 'high'], ['xhigh', 'xhigh'], ['max', 'xhigh'], ['ultra', 'xhigh'], ['highest', 'xhigh'],
  [' low ', 'low'],
]) {
  assert.strictEqual(T.levelFromEffort(word), expect, `levelFromEffort(${JSON.stringify(word)})`);
}
for (const bad of ['turbo', '', '  ', 'auto', 42, null, undefined]) {
  assert.strictEqual(T.levelFromEffort(bad), null, `levelFromEffort(${JSON.stringify(bad)}) 必须返回 null`);
}

// ---- 2. budget_tokens 数值分桶（边界：中点 1536/5120/12288/24576） ----
for (const [n, expect] of [
  [100, 'minimal'], [1024, 'minimal'], [1536, 'minimal'], [1537, 'low'],
  [2048, 'low'], [5120, 'low'], [5121, 'medium'], [8000, 'medium'],
  [12288, 'medium'], [12289, 'high'], [16384, 'high'], [24576, 'high'],
  [24577, 'xhigh'], [32768, 'xhigh'], [999999, 'xhigh'],
]) {
  assert.strictEqual(T.levelFromBudget(n), expect, `levelFromBudget(${n})`);
}
for (const bad of [0, -5, NaN, '8000', null]) {
  assert.strictEqual(T.levelFromBudget(bad), null, `levelFromBudget(${JSON.stringify(bad)}) 必须返回 null`);
}

// ---- 3. Anthropic thinking 对象 → 档位 ----
assert.strictEqual(T.levelFromThinking({ type: 'disabled' }), 'off');
assert.strictEqual(T.levelFromThinking({ type: 'enabled', budget_tokens: 8000 }), 'medium');
assert.strictEqual(T.levelFromThinking({ type: 'enabled', budget_tokens: 16384 }), 'high');
assert.strictEqual(T.levelFromThinking({ type: 'enabled' }), 'medium', 'enabled 无预算取中档');
assert.strictEqual(T.levelFromThinking({ type: 'foo' }), null);
assert.strictEqual(T.levelFromThinking(null), null);
assert.strictEqual(T.levelFromThinking('enabled'), null);

// ---- 4. 出站：档位 → DeepSeek 方言 ----
assert.deepStrictEqual(T.upstreamThinking('off'), { thinking: { type: 'disabled' } },
  'off 档只给关闭开关，不带 effort');
assert.strictEqual(T.upstreamThinking('off').reasoning_effort, undefined);
assert.deepStrictEqual(T.upstreamThinking('minimal'), { reasoning_effort: 'low', thinking: { type: 'enabled' } });
assert.deepStrictEqual(T.upstreamThinking('low'), { reasoning_effort: 'low', thinking: { type: 'enabled' } });
assert.deepStrictEqual(T.upstreamThinking('medium'), { reasoning_effort: 'high', thinking: { type: 'enabled' } });
assert.deepStrictEqual(T.upstreamThinking('high'), { reasoning_effort: 'high', thinking: { type: 'enabled' } });
assert.deepStrictEqual(T.upstreamThinking('xhigh'), { reasoning_effort: 'max', thinking: { type: 'enabled' } });
assert.strictEqual(T.upstreamThinking(null), null);
assert.strictEqual(T.upstreamThinking(undefined), null);

// ---- 5. CLI 档位（agent 路径） ----
assert.strictEqual(T.cliThinking('off'), 'off');
assert.strictEqual(T.cliThinking('minimal'), 'minimal');
assert.strictEqual(T.cliThinking('high'), 'high');
assert.strictEqual(T.cliThinking('xhigh'), 'adaptive', 'CLI 不认识 xhigh，用 adaptive 表达最接近');
assert.strictEqual(T.cliThinking('bogus'), null);

// ---- 6. 入站解析：effort 优先，其次 thinking 对象 ----
assert.deepStrictEqual(T.inboundLevel({ reasoning_effort: 'high' }), { kind: 'level', value: 'high' });
assert.deepStrictEqual(T.inboundLevel({ reasoning_effort: 'none' }), { kind: 'level', value: 'off' });
assert.deepStrictEqual(T.inboundLevel({ reasoning_effort: 'turbo' }), { kind: 'raw', value: 'turbo' });
assert.deepStrictEqual(T.inboundLevel({ thinking: { type: 'enabled', budget_tokens: 8000 } }),
  { kind: 'level', value: 'medium' });
assert.deepStrictEqual(T.inboundLevel({ thinking: { type: 'disabled' } }), { kind: 'level', value: 'off' });
assert.deepStrictEqual(T.inboundLevel({}), { kind: 'none', value: null });
assert.deepStrictEqual(T.inboundLevel({ reasoning_effort: '' }), { kind: 'none', value: null });
assert.deepStrictEqual(T.inboundLevel({ reasoning_effort: 'low', thinking: { type: 'disabled' } }),
  { kind: 'level', value: 'low' }, '两种都给时 effort 优先');
assert.deepStrictEqual(T.inboundLevel(null), { kind: 'none', value: null });

// ---- 7. applyUpstream：原位改写成上游方言 ----
{
  const b = { model: 'deepseek-flash', reasoning_effort: 'medium' };
  const r = T.applyUpstream(b);
  assert.strictEqual(r.applied, true);
  assert.strictEqual(r.level, 'medium');
  assert.deepStrictEqual(b, { model: 'deepseek-flash', reasoning_effort: 'high', thinking: { type: 'enabled' } });
}
{
  const b = { reasoning_effort: 'none' };
  const r = T.applyUpstream(b);
  assert.strictEqual(r.level, 'off');
  assert.deepStrictEqual(b, { thinking: { type: 'disabled' } }, 'off 档不残留 effort 字段');
}
{
  const b = { reasoning_effort: 'turbo' };
  const r = T.applyUpstream(b);
  assert.strictEqual(r.applied, true);
  assert.strictEqual(r.raw, true);
  assert.deepStrictEqual(b, { reasoning_effort: 'turbo' }, '不认识的词原样透传，让上游自己归一');
}
{
  const b = { model: 'x', messages: [] };
  const r = T.applyUpstream(b);
  assert.strictEqual(r.applied, false, '客户端没表达就不注入，请求体原样');
  assert.deepStrictEqual(b, { model: 'x', messages: [] });
}
{
  const b = { reasoning_effort: null };
  const r = T.applyUpstream(b);
  assert.strictEqual(r.applied, true);
  assert.deepStrictEqual(b, {}, '空的 effort 字段清掉，不带垃圾参数');
}
{
  const b = { thinking: { type: 'enabled', budget_tokens: 32768 } };
  T.applyUpstream(b);
  assert.strictEqual(b.reasoning_effort, 'max');
  assert.deepStrictEqual(b.thinking, { type: 'enabled' });
}

// ---- 8. 400 摘参数判据 ----
assert.strictEqual(T.looksLikeThinkingReject('Invalid parameter: reasoning_effort is not supported'), true);
assert.strictEqual(T.looksLikeThinkingReject('{"error":{"message":"thinking is not supported for this model"}}'), true);
assert.strictEqual(T.looksLikeThinkingReject('unknown parameter: foo'), true);
assert.strictEqual(T.looksLikeThinkingReject('max_tokens must be greater than 0'), false);
assert.strictEqual(T.looksLikeThinkingReject(''), false);
assert.strictEqual(T.looksLikeThinkingReject(null), false);

// ---- 9. 导出契约 ----
assert.deepStrictEqual(T.LEVELS, ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);
assert.strictEqual(T.LEVEL_BUDGET.medium, 8192);

console.log('ok - 思考档位映射：同义词 / 分桶边界 / 出站方言 / CLI / 入站解析 / 原位改写 / 400 判据');
