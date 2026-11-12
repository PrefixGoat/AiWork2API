'use strict';
/**
 * 会话账号绑定与调度管理器 (src/session-router.js)
 *
 * 遵循 ADR-0003 与 Issue #05 规格要求：
 * 1. 候选账号筛选：同时校验调用凭据当前账号权限范围、目标模型支持、账号就绪状态、冷却状态与并发余量；
 * 2. 新会话轮询：对无既有绑定的新会话，在合格候选账号集合中执行确定性轮询；
 * 3. 会话账号绑定 (Sticky Session)：同一调用凭据下已有绑定的会话，优先复用该绑定；
 * 4. 权限与可用性动态约束：当权限收缩、原账号不可用或满载时，已有绑定自动失效并重新服从当前条件调度，严禁越权；
 * 5. 调用凭据命名空间隔离：以 (keyId, sessionId) 作为作用域，杜绝不同调用凭据使用同名会话发生串话或混淆；
 * 6. 并发控制：跟踪各账号当前执行中请求数，满载账号被暂时排除。
 */

const { normalizeAccountScope, isAccountAllowed } = require('./credentials');

/**
 * 模型级冷却复合键构造函数
 */
function compositeModelCooldownKey(accountId, modelId) {
  return `${accountId}::${modelId}`;
}

class SessionRouter {
  constructor(options = {}) {
    this.bindings = new Map(); // scopedSessionId -> { accountId, boundAt, lastUsedAt }
    this.activeRequests = new Map(); // accountId -> number
    this.keyActiveRequests = new Map(); // keyId -> number
    this.globalActiveRequests = 0;
    this.cooldowns = new Map(); // accountId -> cooldownUntilMs
    this.modelCooldowns = new Map(); // `${accountId}::${modelId}` -> cooldownUntilMs
    this.rrIndex = 0;
    this.timeOffsetMs = 0;
    this.maxConcurrency = options.maxConcurrency || Number(process.env.MAX_CONCURRENCY_PER_ACCOUNT || 10);
    this.maxConcurrencyPerKey = Number(options.maxConcurrencyPerKey || process.env.MAX_CONCURRENCY_PER_KEY || 10);
    this.maxGlobalConcurrency = Number(options.maxGlobalConcurrency || process.env.MAX_GLOBAL_CONCURRENCY || 100);
    this.sessionTtlMs = options.sessionTtlMs || Number(process.env.SESSION_BINDING_TTL_MS || 3600000); // 1 小时
    this.maxAccountAttempts = SessionRouter.parseMaxAccountAttempts(options.maxAccountAttempts || process.env.MAX_ACCOUNT_ATTEMPTS);
    // ADR-0013：设置页的三项调度参数必须按请求读取运行时配置。
    // 传函数而不是快照，配置一改下一次调度就生效，无需重启容器。
    this.settingsSource = typeof options.settings === 'function' ? options.settings : null;
  }

  _settings() {
    if (!this.settingsSource) return null;
    try {
      const s = this.settingsSource();
      return s && typeof s === 'object' ? s : null;
    } catch (_) {
      return null; // 配置读取异常时回落到构造参数，不影响调度可用性
    }
  }

  /** 单账号在途上限：设置页优先，其次构造参数/env */
  maxConcurrencyLimit() {
    const s = this._settings();
    const n = s ? Number(s.max_concurrency_per_account) : NaN;
    return Number.isFinite(n) && n > 0 ? n : this.maxConcurrency;
  }

  /** 会话粘性 TTL（毫秒）：设置页是秒，这里换算 */
  sessionTtlLimitMs() {
    const s = this._settings();
    const sec = s ? Number(s.session_binding_ttl_sec) : NaN;
    if (Number.isFinite(sec) && sec > 0) return sec * 1000;
    return this.sessionTtlMs;
  }

  /** 会话粘性路由是否启用 */
  sessionBindingEnabled() {
    const s = this._settings();
    if (s && typeof s.session_binding_enabled === 'boolean') return s.session_binding_enabled;
    return true;
  }

  /**
   * 账号尝试上限校验（包含首次尝试，合法范围 1-10，明确默认值 2，ADR-0004 & US 28, US 29）
   */
  static parseMaxAccountAttempts(val) {
    const n = parseInt(val, 10);
    if (isNaN(n) || n < 1) return 2;
    if (n > 10) return 10;
    return n;
  }

  /**
   * 受控时钟机制：用于可编排模拟测试中跳跃时间，免除实际长延时 (AC 6)
   */
  now() {
    return Date.now() + this.timeOffsetMs;
  }

  fastForward(ms) {
    this.timeOffsetMs += Number(ms) || 0;
  }

  resetClock() {
    this.timeOffsetMs = 0;
  }

  /**
   * 生成以调用凭据内部 ID 为命名空间的会话标识符 (US 20, US 23, US 26)
   */
  makeScopedSessionId(keyId, rawSessionId) {
    const kId = String(keyId || 'anon').trim();
    const sId = String(rawSessionId || '').trim();
    return sId ? `${kId}::${sId}` : null;
  }

  /**
   * 同步重载发生变更的账号并清除其冷却 (消除重复恢复与冗余重载)
   */
  _syncReloadedAccounts(accountPool) {
    if (!accountPool || typeof accountPool.reloadIfChanged !== 'function') return;
    const reloaded = accountPool.reloadIfChanged();
    for (const acc of reloaded) {
      if (acc && acc.id) this.clearCooldown(acc.id);
    }
  }

  /**
   * 筛选符合条件的候选账号 (US 9, US 16, US 17, US 27, US 31)
   */
  getCandidates({ accountPool, targetModel, allowedAccounts = null, excludeAccountIds = null, checkConcurrency = true, skipReload = false, allowPaused = false }) {
    if (!accountPool) return [];
    if (!skipReload) {
      this._syncReloadedAccounts(accountPool);
    }
    const readyAccounts = accountPool.getReadyAccounts();
    const scope = normalizeAccountScope(allowedAccounts);
    const now = this.now();
    const maxConcurrency = this.maxConcurrencyLimit();

    const candidates = readyAccounts.filter((acc) => {
      // 0. 排除当前请求已经尝试过的账号（换号重试边界控制）
      if (Array.isArray(excludeAccountIds) && excludeAccountIds.includes(acc.id)) {
        return false;
      }

      // 0b. 暂停选号：不参与新会话的候选；已绑定会话的复用走 allowPaused。
      //     与「禁用」（enabled=false → 不再 ready）是两件事，见 ADR-0016。
      if (!allowPaused && acc.paused) return false;

      // 1. 账号访问范围策略过滤：不限制放行全部；指定集合（含空集=无账号权限）严格过滤
      if (!isAccountAllowed(scope, acc.id)) return false;

      // 2. 账号级模型支持校验
      if (targetModel && !acc.supportsModel(targetModel)) {
        return false;
      }

      // 3. 冷却状态检查（全账号与模型级作用域冷却）
      const coolUntil = this.cooldowns.get(acc.id) || 0;
      if (now < coolUntil) {
        return false;
      }
      if (targetModel) {
        const modelCoolUntil = this.modelCooldowns.get(compositeModelCooldownKey(acc.id, targetModel)) || 0;
        if (now < modelCoolUntil) {
          return false;
        }
      }

      // 4. 并发余量检查
      if (checkConcurrency) {
        const active = this.activeRequests.get(acc.id) || 0;
        if (active >= maxConcurrency) {
          return false;
        }
      }

      return true;
    });

    return candidates;
  }

  /**
   * 核心调度：优先保持绑定，新会话轮询，权限收缩与换号时自动重调度 (US 19, US 24, US 25, US 30)
   */
  routeSession({ keyId, rawSessionId, targetModel, accountPool, allowedAccounts = null, excludeAccountIds = null }) {
    if (!accountPool) {
      return { ok: false, status: 503, code: 'no_available_accounts', message: '账号池未初始化' };
    }

    this._syncReloadedAccounts(accountPool);
    const readyAccounts = accountPool.getReadyAccounts();
    if (readyAccounts.length === 0) {
      const allAccs = accountPool.listAccounts();
      const firstHint = (allAccs.length > 0 && allAccs[0].recoveryHint)
        ? allAccs[0].recoveryHint
        : '状态目录缺失有效 router key。请先配置官方 CLI 状态目录或执行登录：dtcoder login';
      return {
        ok: false,
        status: 503,
        code: 'no_available_accounts',
        message: `直连模式未就绪：上游账号池中无就绪账号。${firstHint}`,
      };
    }

    // 1. 检索当前带并发检查与排除项的合格候选集合（暂停账号只从「新会话」候选里剔除）
    const candidates = this.getCandidates({ accountPool, targetModel, allowedAccounts, excludeAccountIds, checkConcurrency: true, skipReload: true });

    // 设置页关闭粘性路由时既不复用也不写入绑定，等同「每次请求都重新轮询」
    // scopedId 为 null 表示「本次不启用粘性作用域」（设置页关掉了粘性路由），
    // 调用方必须把它当作「无绑定」而不是空字符串会话 ID。
    const scopedId = this.sessionBindingEnabled() ? this.makeScopedSessionId(keyId, rawSessionId) : null;
    const now = this.now();

    // 2. 会话账号绑定粘性检查 (Sticky Session)。
    //    必须先于「候选为空」的判断：暂停选号会把账号从新会话候选里剔除，
    //    若先判空，已绑定的会话会连复用机会都没有就被判 404。
    if (scopedId && this.bindings.has(scopedId)) {
      const binding = this.bindings.get(scopedId);

      // 检查绑定是否超时过期
      if (now - binding.lastUsedAt > this.sessionTtlLimitMs()) {
        this.bindings.delete(scopedId);
      } else {
        // 关键安全点：校验原绑定的账号未在排除列表中且仍在合格候选里
        const isExcluded = Array.isArray(excludeAccountIds) && excludeAccountIds.includes(binding.accountId);
        if (!isExcluded) {
          let matched = candidates.find((a) => a.id === binding.accountId);
          if (!matched) {
            // 「暂停选号」只挡新会话：已绑定的会话继续用这个号，直到它被禁用/冷却/不再授权。
            const sticky = this.getCandidates({
              accountPool, targetModel, allowedAccounts, excludeAccountIds,
              checkConcurrency: true, skipReload: true, allowPaused: true,
            });
            matched = sticky.find((a) => a.id === binding.accountId);
          }
          if (matched) {
            binding.lastUsedAt = now;
            return {
              ok: true,
              account: matched,
              isNewSession: false,
              reusedBinding: true,
              scopedSessionId: scopedId,
            };
          }
        }
      }
    }

    // 3. 没有可复用的绑定：再判断候选是否为空，并区分「全忙」「全暂停」与「压根没有」
    if (candidates.length === 0) {
      const allWithoutConcurrency = this.getCandidates({ accountPool, targetModel, allowedAccounts, excludeAccountIds, checkConcurrency: false, skipReload: true });
      if (allWithoutConcurrency.length > 0) {
        return {
          ok: false,
          status: 503,
          code: 'all_accounts_busy',
          message: `当前支持模型 "${targetModel}" 的所有可用账号均已达到并发上限 (${this.maxConcurrencyLimit()})，请稍后重试。`,
        };
      }
      const pausedOnly = this.getCandidates({
        accountPool, targetModel, allowedAccounts, excludeAccountIds,
        checkConcurrency: false, skipReload: true, allowPaused: true,
      });
      if (pausedOnly.length > 0) {
        return {
          ok: false,
          status: 503,
          code: 'all_accounts_paused',
          message: `当前支持模型 "${targetModel}" 的账号全部处于「暂停选号」，已绑定的会话仍可继续，新会话请先恢复一个账号。`,
        };
      }
      return {
        ok: false,
        status: 404,
        code: 'no_account_supports_model',
        message: `当前就绪且授权的账号中，没有任何可用账号支持目标模型 "${targetModel}"。`,
      };
    }

    // 4. 无既有绑定，或原绑定账号被排除/不可用/不再被授权：在当前合格候选账号中执行确定性轮询 (Round-Robin)
    const selected = candidates[this.rrIndex % candidates.length];
    this.rrIndex = (this.rrIndex + 1) % candidates.length;

    // 5. 记录/更新会话绑定至新选中的可用账号
    if (scopedId) {
      this.bindings.set(scopedId, {
        accountId: selected.id,
        boundAt: now,
        lastUsedAt: now,
      });
      this._cleanupOldBindings();
    }

    return {
      ok: true,
      account: selected,
      isNewSession: true,
      reusedBinding: false,
      scopedSessionId: scopedId,
    };
  }

  /**
   * 上游错误分类与账号状态更新 (ADR-0004 & US 35, US 36, US 37, US 38)
   */
  recordAccountError(accountPool, accountId, errorInfo = {}) {
    if (!accountId) return { action: 'none', penalty: false };
    const status = Number(errorInfo.statusCode || errorInfo.status || 0);
    const now = this.now();
    const modelId = errorInfo.modelId || null;
    const headers = errorInfo.headers || {};
    const body = errorInfo.body || {};

    // 1. 400 客户端参数错误：客户端责任，严禁处罚账号健康度 (US 37)
    if (status === 400) {
      return { action: 'none', penalty: false };
    }

    // 2. 401 凭据明确失效：标记为 needs_reauth，提供 CLI 恢复指引，暂停选择 (US 36)
    if (status === 401) {
      if (accountPool) {
        const acc = accountPool.getAccount(accountId);
        if (acc && typeof acc.recordError === 'function') {
          acc.recordError(errorInfo);
        }
      }
      this.setCooldown(accountId, 3600000); // 长期冷却兜底（1小时）
      return { action: 'needs_reauth', penalty: true, status: 401 };
    }

    // 3. 429 限流：解析 Retry-After，按确认范围（账号或模型）进入冷却 (US 35)
    if (status === 429) {
      let cooldownMs = 60000;
      const retryHeader = headers['retry-after'];
      if (retryHeader) {
        const s = parseInt(retryHeader, 10);
        if (!isNaN(s) && s > 0) {
          cooldownMs = Math.max(5000, s * 1000);
        } else {
          const parsedDate = Date.parse(retryHeader);
          if (!isNaN(parsedDate) && parsedDate > now) {
            cooldownMs = Math.max(5000, parsedDate - now);
          }
        }
      } else if (body?.error?.retry_after) {
        const s = Number(body.error.retry_after);
        if (!isNaN(s) && s > 0) cooldownMs = Math.max(5000, s * 1000);
      }

      const msg = String(body?.error?.message || '').toLowerCase();
      const isModelScoped = Boolean(modelId && (msg.includes('model') || (typeof modelId === 'string' && msg.includes(modelId.toLowerCase()))));
      if (isModelScoped) {
        this.setCooldown(accountId, cooldownMs, modelId);
        return { action: 'model_cooldown', scope: 'model', durationMs: cooldownMs, modelId };
      } else {
        this.setCooldown(accountId, cooldownMs);
        return { action: 'account_cooldown', scope: 'account', durationMs: cooldownMs };
      }
    }

    // 4. 408 超时或 403 模糊禁止：短期临时退避，不判定凭据永久失效 (US 38)
    if (status === 408 || status === 403) {
      const durationMs = 15000;
      this.setCooldown(accountId, durationMs);
      return { action: 'temporary_backoff', durationMs, status };
    }

    // 5. 5xx 或网络故障 (500, 502, 503, 504, ECONNRESET, ETIMEDOUT)：短期临时退避 (ADR-0004)
    if (status >= 500 || errorInfo.networkError || errorInfo.timeout) {
      const durationMs = 15000;
      this.setCooldown(accountId, durationMs);
      return { action: 'temporary_backoff', durationMs, status: status || 502 };
    }

    return { action: 'none', penalty: false };
  }

  acquireAccount(accountId) {
    if (!accountId) return;
    const cur = this.activeRequests.get(String(accountId)) || 0;
    this.activeRequests.set(String(accountId), cur + 1);
  }

  releaseAccount(accountId) {
    if (!accountId) return;
    const cur = this.activeRequests.get(String(accountId)) || 0;
    this.activeRequests.set(String(accountId), Math.max(0, cur - 1));
  }

  getActiveRequests(accountId) {
    return this.activeRequests.get(String(accountId)) || 0;
  }

  acquireKey(keyId) {
    if (this.globalActiveRequests >= this.maxGlobalConcurrency) {
      return {
        ok: false,
        status: 503,
        code: 'global_concurrency_limit_exceeded',
        message: `网关全局并发与排队已达上限 (${this.maxGlobalConcurrency})，请稍后重试`,
      };
    }
    const k = String(keyId || 'default');
    const cur = this.keyActiveRequests.get(k) || 0;
    if (cur >= this.maxConcurrencyPerKey) {
      return {
        ok: false,
        status: 429,
        code: 'concurrency_limit_exceeded',
        message: `当前调用凭据在途请求已达到并发上限 (${this.maxConcurrencyPerKey})`,
      };
    }
    this.keyActiveRequests.set(k, cur + 1);
    this.globalActiveRequests += 1;
    return { ok: true };
  }

  releaseKey(keyId) {
    const k = String(keyId || 'default');
    const cur = this.keyActiveRequests.get(k) || 0;
    if (cur > 0) {
      this.keyActiveRequests.set(k, cur - 1);
    }
    if (this.globalActiveRequests > 0) {
      this.globalActiveRequests -= 1;
    }
  }

  getKeyActiveRequests(keyId) {
    return this.keyActiveRequests.get(String(keyId || 'default')) || 0;
  }

  getGlobalActiveRequests() {
    return this.globalActiveRequests;
  }

  setCooldown(accountId, durationMs = 60000, modelId = null) {
    if (!accountId) return;
    const until = this.now() + Number(durationMs);
    if (modelId) {
      this.modelCooldowns.set(compositeModelCooldownKey(accountId, modelId), until);
    } else {
      this.cooldowns.set(String(accountId), until);
    }
  }

  clearCooldown(accountId, modelId = null) {
    if (!accountId) return;
    if (modelId) {
      this.modelCooldowns.delete(compositeModelCooldownKey(accountId, modelId));
    } else {
      this.cooldowns.delete(String(accountId));
    }
  }

  isCooledDown(accountId, modelId = null) {
    const now = this.now();
    const until = this.cooldowns.get(String(accountId)) || 0;
    if (now < until) return true;
    if (modelId) {
      const modelUntil = this.modelCooldowns.get(compositeModelCooldownKey(accountId, modelId)) || 0;
      if (now < modelUntil) return true;
    }
    return false;
  }

  getCooldownRemaining(accountId, modelId = null) {
    const now = this.now();
    const until = this.cooldowns.get(String(accountId)) || 0;
    let rem = Math.max(0, until - now);
    if (modelId) {
      const modelUntil = this.modelCooldowns.get(compositeModelCooldownKey(accountId, modelId)) || 0;
      rem = Math.max(rem, Math.max(0, modelUntil - now));
    }
    return rem;
  }

  getBinding(keyId, rawSessionId) {
    const scopedId = this.makeScopedSessionId(keyId, rawSessionId);
    return scopedId ? (this.bindings.get(scopedId) || null) : null;
  }

  clearBinding(keyId, rawSessionId) {
    const scopedId = this.makeScopedSessionId(keyId, rawSessionId);
    if (scopedId) this.bindings.delete(scopedId);
  }

  clearAllBindings() {
    this.bindings.clear();
    this.activeRequests.clear();
    this.keyActiveRequests.clear();
    this.globalActiveRequests = 0;
    this.cooldowns.clear();
    this.modelCooldowns.clear();
    this.timeOffsetMs = 0;
    this.rrIndex = 0;
  }

  _cleanupOldBindings() {
    if (this.bindings.size <= 2000) return;
    const now = this.now();
    // TTL 只取一次：绑定表能到 2000+ 条，每条都去 settingsSource() 会把整份配置复制 2000 次。
    const ttlMs = this.sessionTtlLimitMs();
    for (const [k, v] of this.bindings.entries()) {
      if (now - v.lastUsedAt > ttlMs) {
        this.bindings.delete(k);
      }
    }
  }
}

module.exports = {
  SessionRouter,
};
