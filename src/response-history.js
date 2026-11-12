'use strict';
/**
 * 服务端内存历史续接管理器 (ResponseHistoryManager)
 * 对应 ADR-0003 与 Issue #08
 *
 * 核心契约:
 * 1. 可选启用：默认关闭 (enabled: false)。未启用时，依赖 previous_response_id
 *    或 GET /v1/responses/:id 的请求直接返回明确错误 (400 history_disabled)，
 *    绝对不静默当成新会话处理。
 * 2. 纯内存不落盘：进程重启后历史自动清空，不承诺跨重启恢复；重启后缺失历史明确报错 (404 response_not_found)。
 * 3. 调用凭据严格隔离：每条响应历史记录均绑定唯一的内部调用凭据 ID (keyId)。不同调用凭据
 *    严禁读取或续接彼此的历史；越权访问严格返回 404 response_not_found（不泄漏历史 ID 存在性）。
 * 4. 流式与非流式语义完全一致：无论以何种传输完成生成，均完整存储规范化输入、assistant 回复正文及工具调用上下文。
 * 5. 有界容量与 TTL 淘汰：受最大条目 (maxEntries) 与过期时间 (ttlSec) 约束，超出时按 LRU / TTL 自动清理。
 */

function clone(obj) {
  if (obj === undefined || obj === null) return obj;
  try {
    return JSON.parse(JSON.stringify(obj));
  } catch {
    return obj;
  }
}

class ResponseHistoryManager {
  constructor(options = {}) {
    this.enabled = !!options.enabled;
    this.maxEntries = Math.max(1, Number(options.maxEntries || 500));
    this.ttlMs = Math.max(1000, Number(options.ttlSec || 3600) * 1000);
    this.log = typeof options.log === 'function' ? options.log : () => {};
    this.store = new Map(); // id -> ResponseEntry
  }

  get size() {
    this.prune();
    return this.store.size;
  }

  /**
   * 记录已完成的响应轮次（非流式与流式均在完成时调用）
   */
  record({ id, keyId, model, messages, output, usage, store }) {
    if (!this.enabled || store === false) return;
    if (!id || !keyId) return;

    this.prune();

    // LRU 淘汰：若容量已满，剔除最旧的一条
    while (this.store.size >= this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey) this.store.delete(oldestKey);
      else break;
    }

    const now = Date.now();
    const entry = {
      id,
      keyId,
      model: model || '',
      messages: Array.isArray(messages) ? clone(messages) : [],
      output: Array.isArray(output) ? clone(output) : [],
      usage: clone(usage) || null,
      createdAt: now,
      expiresAt: now + this.ttlMs,
    };

    this.store.set(id, entry);
    this.log('[history] 记录响应历史 id=%s keyId=%s messages=%d output=%d (容量: %d/%d)',
      id, keyId, entry.messages.length, entry.output.length, this.store.size, this.maxEntries);
  }

  /**
   * 按 ID 与 keyId 获取历史条目（严格校验启用状态、存在性、TTL 与凭据归属）
   */
  get(id, keyId) {
    if (!this.enabled) {
      return {
        ok: false,
        status: 400,
        code: 'history_disabled',
        message: 'Server-side response history continuation is not enabled',
      };
    }

    if (!id || typeof id !== 'string') {
      return {
        ok: false,
        status: 400,
        code: 'invalid_request_error',
        message: 'Missing or invalid response ID',
      };
    }

    this.prune();

    const entry = this.store.get(id);
    if (!entry || Date.now() > entry.expiresAt) {
      return {
        ok: false,
        status: 404,
        code: 'response_not_found',
        message: `Response '${id}' not found or has expired`,
      };
    }

    // 调用凭据归属检查：不同 Key 绝不能越权读取或续接
    if (entry.keyId !== keyId) {
      this.log('[history] 拒绝跨调用凭据访问历史 id=%s entryKey=%s requestKey=%s', id, entry.keyId, keyId);
      return {
        ok: false,
        status: 404,
        code: 'response_not_found',
        message: `Response '${id}' not found or has expired`,
      };
    }

    return { ok: true, entry: clone(entry) };
  }

  /**
   * 清理过期条目
   */
  prune() {
    const now = Date.now();
    for (const [id, entry] of this.store.entries()) {
      if (now > entry.expiresAt) {
        this.store.delete(id);
      }
    }
  }

  /**
   * 清空全部条目（测试与重置使用）
   */
  clear() {
    this.store.clear();
  }
}

module.exports = { ResponseHistoryManager };
