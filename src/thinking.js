'use strict';
/**
 * 思考强度统一档位层（ADR-0022）。
 *
 * 三种客户端方言说的是同一件事——「让模型先打草稿、草稿写多用心」：
 *   OpenAI chat   → reasoning_effort: "high"
 *   Codex         → reasoning: { effort: "high" }
 *   Anthropic     → thinking: { type: "enabled", budget_tokens: 8000 }
 *
 * 网关把它们先归一成内部六档，再翻成上游方言（DeepSeek 式 low/high/max
 * 加 thinking 开关）。档位顺序：off < minimal < low < medium < high < xhigh。
 *
 * 纯函数、零依赖、无网络；只做映射。边界事实（出处见 ADR-0022）：
 * - DeepSeek 官方会归一化外来档位（minimal→low、medium→high），但那张表会把
 *   xhigh 压成 high；这里保持档位有序性，xhigh→max。
 * - Anthropic budget_tokens 最小 1024，且必须小于 max_tokens——分桶在此之上。
 * - 「关闭思考」在各家是三个词：none（gpt-5.1）/ minimal（gpt-5）/ disabled（Anthropic）。
 */

const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];

// 各档位的参考 token 预算（文档口径与数值分桶用）
const LEVEL_BUDGET = { minimal: 1024, low: 2048, medium: 8192, high: 16384, xhigh: 32768 };

// 同一档位在各家文档里的不同写法
const EFFORT_SYNONYMS = {
  off: ['off', 'none', 'disabled', 'disable', 'false'],
  minimal: ['minimal'],
  low: ['low'],
  medium: ['medium', 'mid'],
  high: ['high'],
  xhigh: ['xhigh', 'max', 'ultra', 'highest'],
};

/** effort 字符串 → 内部档位；不认识的词返回 null（调用方决定原样透传）。 */
function levelFromEffort(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (!v) return null;
  for (const [lvl, words] of Object.entries(EFFORT_SYNONYMS)) {
    if (words.includes(v)) return lvl;
  }
  return null;
}

/**
 * Anthropic budget_tokens → 最近档。
 * 参考值 [1024,2048,8192,16384,32768] 的中点分桶（1536/5120/12288/24576）。
 */
function levelFromBudget(n) {
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n <= 1536) return 'minimal';
  if (n <= 5120) return 'low';
  if (n <= 12288) return 'medium';
  if (n <= 24576) return 'high';
  return 'xhigh';
}

/** Anthropic thinking 对象 → 档位；不是对象/不认识的 type 返回 null。 */
function levelFromThinking(thinking) {
  if (!thinking || typeof thinking !== 'object') return null;
  if (thinking.type === 'disabled') return 'off';
  if (thinking.type !== 'enabled') return null;
  if (Number.isFinite(thinking.budget_tokens)) return levelFromBudget(thinking.budget_tokens);
  return 'medium'; // enabled 但没给预算：取中档
}

// 出站（DeepSeek 方言）：档位 → reasoning_effort 词。
const UPSTREAM_EFFORT = { minimal: 'low', low: 'low', medium: 'high', high: 'high', xhigh: 'max' };

/** 档位 → 上游参数。off → 只给关闭开关；档位缺失返回 null（不注入）。 */
function upstreamThinking(level) {
  if (level === 'off') return { thinking: { type: 'disabled' } };
  const effort = UPSTREAM_EFFORT[level];
  if (!effort) return null;
  return { reasoning_effort: effort, thinking: { type: 'enabled' } };
}

/** 档位 → CLI --thinking-level 合法值（agent 路径）；xhigh 用 adaptive 表达。 */
function cliThinking(level) {
  if (level === 'xhigh') return 'adaptive';
  return LEVELS.includes(level) ? level : null;
}

/**
 * 从 OpenAI 形状的请求体解析客户端表达的档位。
 * 返回 { kind: 'level'|'raw'|'none', value }：
 *   level —— 认识的档位词（reasoning_effort 与 thinking 两种来源，effort 优先）；
 *   raw   —— 客户端给了我们不认识的词，原样保留，交给上游自己的归一化；
 *   none  —— 客户端什么都没表达。
 */
function inboundLevel(body) {
  if (!body || typeof body !== 'object') return { kind: 'none', value: null };
  if (typeof body.reasoning_effort === 'string' && body.reasoning_effort.trim()) {
    const lvl = levelFromEffort(body.reasoning_effort);
    if (lvl) return { kind: 'level', value: lvl };
    return { kind: 'raw', value: body.reasoning_effort.trim() };
  }
  const fromThinking = levelFromThinking(body.thinking);
  if (fromThinking) return { kind: 'level', value: fromThinking };
  return { kind: 'none', value: null };
}

/**
 * 把请求体里的思考参数改写成上游方言（原位修改 body）。
 * 返回 { applied, level, raw }：applied=false 表示客户端没表达、请求体未动。
 */
function applyUpstream(body) {
  const inbound = inboundLevel(body);
  const hasEffort = Object.prototype.hasOwnProperty.call(body || {}, 'reasoning_effort');
  const hasThinking = Object.prototype.hasOwnProperty.call(body || {}, 'thinking');
  if (inbound.kind === 'none' && !hasEffort && !hasThinking) {
    return { applied: false, level: null, raw: false };
  }
  delete body.reasoning_effort;
  delete body.thinking;
  if (inbound.kind === 'raw') {
    body.reasoning_effort = inbound.value;
    return { applied: true, level: null, raw: true };
  }
  const out = upstreamThinking(inbound.value);
  if (out && out.reasoning_effort) body.reasoning_effort = out.reasoning_effort;
  if (out && out.thinking) body.thinking = out.thinking;
  return { applied: true, level: inbound.value, raw: false };
}

/**
 * 上游 400 是否在拒绝思考参数（摘参数重试一次的判据）。
 * 只在我们确实带过思考参数时才调用；匹配不到宁可放过，不误伤普通 400。
 */
function looksLikeThinkingReject(text) {
  const s = String(text || '');
  if (!s) return false;
  if (/reasoning_effort|budget_tokens|thinking/i.test(s)) return true;
  if (/(unknown|unexpected|unrecognized|unsupported|invalid)[^\n]{0,60}param/i.test(s)) return true;
  return false;
}

module.exports = {
  LEVELS,
  LEVEL_BUDGET,
  levelFromEffort,
  levelFromBudget,
  levelFromThinking,
  upstreamThinking,
  cliThinking,
  inboundLevel,
  applyUpstream,
  looksLikeThinkingReject,
};
