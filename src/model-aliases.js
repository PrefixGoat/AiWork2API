'use strict';
/**
 * 精确模型别名与解析管理模块 (src/model-aliases.js)
 *
 * 遵循 ADR-0003 与 Issue #04 规格：
 * 1. 支持管理员配置精确的模型别名映射（客户端模型名 -> 实际模型名）。
 * 2. 别名解析仅决定目标实际模型，绝不触发执行模式切换。
 * 3. 废除未知模型静默兜底：请求的模型若既非已知真实模型亦未命中显式别名，
 *    三套协议（Chat Completions、Responses HTTP/WS、Messages）统一返回明确的 404 错误。
 * 4. 模型选择按账号核实可用性，不因某模型在全局池中存在就向不支持该模型的账号转发。
 */

const fs = require('fs');
const path = require('path');

class ModelAliasManager {
  constructor(options = {}) {
    this.dataDir = options.dataDir || path.join(__dirname, '..', 'data');
    this.aliasesFile = path.join(this.dataDir, 'model-aliases.json');
    this.rawEnvAliases = options.rawEnvAliases !== undefined
      ? options.rawEnvAliases
      : (process.env.MODEL_ALIASES || '');

    this.aliases = new Map(); // alias (lowercase) -> targetModel
    this.load();
  }

  load() {
    this.aliases.clear();

    // 1. 本地持久化文件优先
    if (fs.existsSync(this.aliasesFile)) {
      try {
        const raw = fs.readFileSync(this.aliasesFile, 'utf8');
        const data = JSON.parse(raw);
        if (data && typeof data.aliases === 'object' && data.aliases !== null) {
          for (const [k, v] of Object.entries(data.aliases)) {
            if (k && v) this.aliases.set(String(k).trim().toLowerCase(), String(v).trim());
          }
          if (this.aliases.size > 0) return;
        }
      } catch (_) {}
    }

    // 2. 环境变量解析：MODEL_ALIASES="gpt-4o=deepseek-flash,claude-3-5-sonnet=deepseek-flash"
    if (this.rawEnvAliases) {
      for (const part of String(this.rawEnvAliases).split(/[,\n]/)) {
        const p = part.trim();
        if (!p) continue;
        const idx = p.indexOf('=');
        if (idx > 0) {
          const k = p.slice(0, idx).trim().toLowerCase();
          const v = p.slice(idx + 1).trim();
          if (k && v) {
            this.aliases.set(k, v);
          }
        }
      }
    }
  }

  save() {
    try {
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
      }
      const data = {
        version: 1,
        aliases: Object.fromEntries(this.aliases.entries()),
      };
      fs.writeFileSync(this.aliasesFile, JSON.stringify(data, null, 2), 'utf8');
    } catch (_) {}
  }

  listAliases() {
    return Object.fromEntries(this.aliases.entries());
  }

  setAlias(alias, targetModel) {
    if (!alias || !targetModel) throw new Error('别名 (alias) 与目标模型 (target) 均为必填字段');
    const key = String(alias).trim().toLowerCase();
    const val = String(targetModel).trim();
    this.aliases.set(key, val);
    this.save();
    return { alias: key, target: val };
  }

  removeAlias(alias) {
    const key = String(alias).trim().toLowerCase();
    const deleted = this.aliases.delete(key);
    if (deleted) this.save();
    return deleted;
  }

  /**
   * 精确解析客户端请求的模型名 (US 39, US 40)
   * @param {string} requestedModel - 客户端传入的模型名
   * @param {AccountPool} accountPool - 账号池实例
   * @param {{ids: string[], unrestricted: boolean}|string[]|null} allowedAccountIds - 账号访问范围（原样透传给账号池，由其边界归一）
   * @returns {{ ok: boolean, actualModel?: string, aliasUsed?: string|null, eligibleAccounts?: AccountInstance[], status?: number, code?: string, message?: string, availableModels?: string[] }}
   */
  resolveModel(requestedModel, accountPool, allowedAccountIds = null) {
    accountPool.reloadIfChanged();
    const readyAccounts = accountPool.getReadyAccounts();
    if (readyAccounts.length === 0) {
      const allAccs = accountPool.listAccounts();
      const firstHint = (allAccs.length > 0 && allAccs[0].recoveryHint)
        ? allAccs[0].recoveryHint
        : '上游账号池中无就绪账号。请先配置官方 CLI 状态目录或执行登录：dtcoder login';
      return {
        ok: false,
        status: 503,
        code: 'no_available_accounts',
        message: `直连模式未就绪：上游账号池中无就绪账号。${firstHint}`,
        availableModels: [],
      };
    }

    const rawName = String(requestedModel == null ? '' : requestedModel).trim();
    const availableModelIds = accountPool.getAllAvailableModelIds();
    const availableList = availableModelIds;
    const lower = rawName.toLowerCase();

    // 若未传入模型名，或传入了 automodel / auto / default
    const isAutoOrEmpty = !rawName || lower === 'automodel' || lower === 'auto' || lower === 'default';
    if (isAutoOrEmpty) {
      if (this.aliases.has(lower)) {
        const targetModel = this.aliases.get(lower);
        const eligible = accountPool.getEligibleAccounts(targetModel, allowedAccountIds);
        if (eligible.length === 0) {
          return {
            ok: false,
            status: 403,
            code: 'no_account_supports_model',
            message: `当前账号权限范围内无账号支持别名目标模型 "${targetModel}"`,
            availableModels: availableList,
          };
        }
        return {
          ok: true,
          actualModel: targetModel,
          aliasUsed: rawName,
          eligibleAccounts: eligible,
        };
      }

      if (availableModelIds.includes(rawName)) {
        const eligible = accountPool.getEligibleAccounts(rawName, allowedAccountIds);
        if (eligible.length > 0) {
          return {
            ok: true,
            actualModel: rawName,
            aliasUsed: null,
            eligibleAccounts: eligible,
          };
        }
      }

      if (availableList.length === 0) {
        return {
          ok: false,
          status: 503,
          code: 'no_available_accounts',
          message: '当前上游账号池中无可用模型',
          availableModels: [],
        };
      }
      return {
        ok: false,
        status: 404,
        code: 'model_not_found',
        message: `未知模型 "${rawName || 'undefined'}"。未命中真实模型或显式别名映射。可用的模型见 GET /v1/models。`,
        availableModels: availableList,
      };
    }

    let targetModel = rawName;
    let aliasUsed = null;

    // 1. 别名映射匹配
    if (this.aliases.has(lower)) {
      targetModel = this.aliases.get(lower);
      aliasUsed = rawName;
    } else if (availableModelIds.includes(rawName)) {
      targetModel = rawName;
    } else if (rawName.includes('/') && availableModelIds.includes(rawName.split('/').pop())) {
      targetModel = rawName.split('/').pop();
    } else {
      // 未知模型且未命中显式别名：严禁静默回落默认模型！(US 40)
      return {
        ok: false,
        status: 404,
        code: 'model_not_found',
        message: `未知模型 "${rawName}"。该模型既非上游已知真实模型，亦未命中任何显式配置的模型别名。可用的模型见 GET /v1/models。`,
        requestedModel: rawName,
        availableModels: availableList,
      };
    }

    // 2. 检查解析出的目标实际模型在账号池中是否存在
    if (!availableModelIds.includes(targetModel)) {
      return {
        ok: false,
        status: 404,
        code: 'model_not_found',
        message: `别名 "${rawName}" 映射的目标实际模型 "${targetModel}" 在当前上游账号池中不存在。`,
        requestedModel: rawName,
        targetModel,
        availableModels: availableList,
      };
    }

    // 3. 校验账号级模型支持及凭据权限范围 (US 9)
    const eligibleAccounts = accountPool.getEligibleAccounts(targetModel, allowedAccountIds);
    if (eligibleAccounts.length === 0) {
      return {
        ok: false,
        status: 404,
        code: 'no_account_supports_model',
        message: `当前就绪且授权的账号中，没有任何账号支持目标模型 "${targetModel}"。`,
        requestedModel: rawName,
        targetModel,
        availableModels: availableList,
      };
    }

    return {
      ok: true,
      actualModel: targetModel,
      aliasUsed,
      eligibleAccounts,
    };
  }
}

module.exports = {
  ModelAliasManager,
};
