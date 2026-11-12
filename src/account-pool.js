'use strict';
/**
 * 上游账号池管理模块 (src/account-pool.js)
 *
 * 遵循 ADR-0001, ADR-0003 及 Issue #01 验证结论：
 * 1. 部署者显式配置每个账号独立的官方 CLI 状态目录 (AGENTIX_STATE_DIR)。
 * 2. 状态目录只读挂载与只读访问，网关绝不向账号目录写盘，也不自动扫描整机无关路径。
 * 3. 独立维护各账号凭据 (router_key) 与支持的模型列表。
 * 4. 凭据文件 (.env) 与模型配置 (config.json) 发生变更时热重载，无需重启网关。
 * 5. 凭据缺失或失效时，账号标记为不可用并给出明确的官方 CLI 恢复提示。
 * 6. 模型选择按账号核实可用性，仅在支持目标模型的账号之间调度。
 */

const fs = require('fs');
const path = require('path');
const { normalizeAccountScope, isAccountAllowed } = require('./credentials');

function readKeyFromEnvFile(envPath) {
  try {
    if (!fs.existsSync(envPath)) return null;
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx > 0) {
        const k = trimmed.slice(0, idx).trim();
        const v = trimmed.slice(idx + 1).trim();
        if (k === 'AGENTIX_CONFIG_MODELS_AIWORK_ROUTER_API_KEY') {
          return v.replace(/^['"]|['"]$/g, '');
        }
      }
    }
  } catch (_) {}
  return null;
}

function readModelsFromConfigFile(configPath) {
  try {
    if (!fs.existsSync(configPath)) return [];
    const content = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(content);
    const router = parsed && parsed.models && parsed.models['aiwork-router'];
    if (router && Array.isArray(router.models)) {
      return router.models.map((m) => ({
        id: String(m.id),
        name: String(m.name || m.id),
        context_window: m.context_window || null,
        multiplier: m.multiplier !== undefined ? m.multiplier : null,
        ratio: m.ratio || null,
        costTag: m.costTag || null,
        reasoning: Boolean(m.reasoning),
      }));
    }
  } catch (_) {}
  return [];
}

function readUserIdFromAuthFile(authPath) {
  try {
    if (!fs.existsSync(authPath)) return null;
    const content = fs.readFileSync(authPath, 'utf8');
    const parsed = JSON.parse(content);
    if (parsed && Array.isArray(parsed.entries) && parsed.entries[0] && parsed.entries[0].user_id) {
      return String(parsed.entries[0].user_id);
    }
    if (parsed && parsed.user_id) return String(parsed.user_id);
  } catch (_) {}
  return null;
}

function getFileMtimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch (_) {
    return 0;
  }
}

class AccountInstance {
  constructor({ id, name, stateDir, enabled = true, paused = false, source = 'mount', userId = null }) {
    this.id = String(id);
    this.name = String(name || id);
    this.stateDir = path.resolve(stateDir);
    this.enabled = Boolean(enabled);
    // 暂停选号：只是退出新会话的候选，账号仍可用（已绑定会话继续命中）。
    // 与 enabled=false（硬禁用）是两个独立状态位，见 ADR-0016。
    this.paused = Boolean(paused);
    this.source = source || 'mount';
    this.userId = userId || null;

    this.routerKey = null;
    this.models = [];
    this.modelIds = new Set();
    this.status = 'unready'; // 'ready' | 'credentials_missing' | 'not_logged_in' | 'disabled'
    this.recoveryHint = null;

    this.mtimes = {
      env: 0,
      config: 0,
    };
    this.lastCheckedAt = 0;

    this.reload();
  }

  reload() {
    this.lastCheckedAt = Date.now();
    if (!this.enabled) {
      this.status = 'disabled';
      this.routerKey = null;
      this.models = [];
      this.modelIds.clear();
      this.recoveryHint = '账号已被管理员禁用';
      return;
    }

    const envPath = path.join(this.stateDir, '.env');
    const configPath = path.join(this.stateDir, 'config.json');
    const authPath = path.join(this.stateDir, 'auth.json');

    this.mtimes.env = getFileMtimeMs(envPath);
    this.mtimes.config = getFileMtimeMs(configPath);

    const key = readKeyFromEnvFile(envPath);
    const models = readModelsFromConfigFile(configPath);
    const parsedUserId = readUserIdFromAuthFile(authPath);
    if (parsedUserId && !this.userId) {
      this.userId = parsedUserId;
    }
    // 动态账号的展示名存在 auth.json 里：首次启动（还没有 accounts.json）或
    // accounts.json 里仍是目录名时，用它恢复名字，否则重命名一重启就丢。
    if (this.source === 'dynamic' && this.name === this.id) {
      try {
        const authData = JSON.parse(fs.readFileSync(authPath, 'utf8'));
        if (authData && authData.name) this.name = String(authData.name);
      } catch (_) {}
    }

    this.routerKey = key;
    this.models = models;
    this.modelIds = new Set(models.map((m) => m.id));

    if (!key) {
      this.status = 'credentials_missing';
      this.recoveryHint = `官方 CLI 未登录或凭据缺失。请在对应目录下执行登录恢复：AGENTIX_STATE_DIR="${this.stateDir}" dtcoder login (或 aiworkcn login)`;
    } else {
      this.status = 'ready';
      this.recoveryHint = null;
    }
  }

  recordError(errorInfo = {}) {
    const status = Number(errorInfo.statusCode || errorInfo.status || 0);
    if (status === 401) {
      this.status = 'needs_reauth';
      this.recoveryHint = `状态目录 (${this.stateDir}) 凭据已失效或被上游拒绝 (401)。请重新在对应目录执行登录：dtcoder login`;
    }
  }

  get ready() {
    return this.status === 'ready';
  }

  isChanged() {
    if (!this.enabled) return false;
    const envPath = path.join(this.stateDir, '.env');
    const configPath = path.join(this.stateDir, 'config.json');
    const curEnvMtime = getFileMtimeMs(envPath);
    const curConfigMtime = getFileMtimeMs(configPath);
    return curEnvMtime !== this.mtimes.env || curConfigMtime !== this.mtimes.config;
  }

  supportsModel(modelId) {
    if (!modelId) return false;
    const target = String(modelId).trim();
    if (this.modelIds.has(target)) return true;
    if (target.includes('/') && this.modelIds.has(target.split('/').pop())) return true;
    return false;
  }

  toJSON(options = {}) {
    const mask = Boolean(options.mask);
    let maskedKey = this.routerKey;
    if (mask && maskedKey) {
      maskedKey = maskedKey.length > 8 ? maskedKey.slice(0, 3) + '...' + maskedKey.slice(-4) : '***';
    }
    return {
      id: this.id,
      name: this.name,
      stateDir: this.stateDir,
      source: this.source,
      userId: this.userId,
      enabled: this.enabled,
      paused: this.paused,
      status: this.status,
      ready: this.status === 'ready',
      routerKey: maskedKey,
      modelsCount: this.models.length,
      models: [...this.models],
      recoveryHint: this.recoveryHint,
      lastCheckedAt: this.lastCheckedAt,
    };
  }
}

class AccountPool {
  constructor(options = {}) {
    this.dataDir = options.dataDir || path.join(__dirname, '..', 'data');
    this.accountsFile = path.join(this.dataDir, 'accounts.json');
    this.dynamicAccountsDir = path.join(this.dataDir, 'accounts');
    this.rawEnvAccounts = options.upstreamAccounts !== undefined
      ? options.upstreamAccounts
      : (process.env.UPSTREAM_ACCOUNTS || process.env.AIWORK_ACCOUNTS || '');
    this.defaultStateDir = options.defaultStateDir || process.env.AGENTIX_STATE_DIR || '';

    this.accounts = new Map(); // id -> AccountInstance
    this.onAccountReloaded = null;
    this.load();
  }

  load() {
    this.accounts.clear();

    // 1. 优先从环境变量 UPSTREAM_ACCOUNTS 解析
    if (this.rawEnvAccounts) {
      const parsed = this._parseEnvAccounts(this.rawEnvAccounts);
      for (const item of parsed) {
        const inst = new AccountInstance({ ...item, source: 'mount' });
        this.accounts.set(inst.id, inst);
      }
    }

    // 2. 尝试从本地持久化数据 accounts.json 加载
    if (this.accounts.size === 0 && fs.existsSync(this.accountsFile)) {
      try {
        const raw = fs.readFileSync(this.accountsFile, 'utf8');
        const data = JSON.parse(raw);
        if (Array.isArray(data.accounts)) {
          for (const acc of data.accounts) {
            if (acc && acc.id && acc.stateDir) {
              const inst = new AccountInstance(acc);
              // 自愈：早期版本的 accounts.json 没写 source，会把动态账号降级成只读挂载。
              // 目录就落在动态账号根下，就该按动态账号对待。
              if (inst.stateDir.startsWith(path.resolve(this.dynamicAccountsDir) + path.sep)) {
                inst.source = 'dynamic';
              }
              this.accounts.set(inst.id, inst);
            }
          }
        }
      } catch (_) {}
    }

    // 3. 回退到 AGENTIX_STATE_DIR 单账号接入
    //    仅当状态目录真实存在时才创建：compose 可能只声明了 AGENTIX_STATE_DIR 却没有
    //    挂载卷，此时凭空造出的 default 账号永远 credentials_missing，管理面板里既无法
    //    恢复（镜像不含官方 CLI）又会误导排障。目录存在但暂无凭据时仍创建，以便运行时
    //    写入 .env 后由热重载纳管（ADR-0006 双源账号共存）。
    if (this.accounts.size === 0 && this.defaultStateDir && fs.existsSync(this.defaultStateDir)) {
      const inst = new AccountInstance({
        id: 'default',
        name: 'Default Account',
        stateDir: this.defaultStateDir,
        enabled: true,
        source: 'mount',
      });
      this.accounts.set(inst.id, inst);
    }

    // 4. 双源共存：加载动态账号目录 (/data/accounts/<id>)
    if (fs.existsSync(this.dynamicAccountsDir)) {
      try {
        const entries = fs.readdirSync(this.dynamicAccountsDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const accId = entry.name;
          const stateDir = path.join(this.dynamicAccountsDir, accId);
          if (this.accounts.has(accId)) continue;
          const inst = new AccountInstance({
            id: accId,
            name: accId,
            stateDir,
            enabled: true,
            source: 'dynamic',
          });
          this.accounts.set(accId, inst);
        }
      } catch (_) {}
    }
  }

  _parseEnvAccounts(raw) {
    const list = [];
    if (!raw || !String(raw).trim()) return list;

    // 尝试 JSON 格式
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map((item, idx) => ({
          id: item.id || `acc-${idx + 1}`,
          name: item.name || item.id || `Account ${idx + 1}`,
          stateDir: item.stateDir || item.state_dir,
          enabled: item.enabled !== false,
        })).filter((x) => Boolean(x.stateDir));
      }
    } catch (_) {}

    // 逗号分隔格式：acc1=/path/to/dir1,acc2=/path/to/dir2
    for (const part of String(raw).split(/[,\n]/)) {
      const p = part.trim();
      if (!p) continue;
      const idx = p.indexOf('=');
      if (idx > 0) {
        const id = p.slice(0, idx).trim();
        const dir = p.slice(idx + 1).trim();
        if (id && dir) {
          list.push({ id, name: id, stateDir: dir, enabled: true });
        }
      } else {
        const dir = p;
        const id = path.basename(dir) || 'account';
        list.push({ id, name: id, stateDir: dir, enabled: true });
      }
    }
    return list;
  }

  save() {
    try {
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
      }
      const data = {
        version: 1,
        accounts: Array.from(this.accounts.values()).map((a) => ({
          id: a.id,
          name: a.name,
          stateDir: a.stateDir,
          enabled: a.enabled,
          paused: a.paused,
          // source 必须落盘：否则重启后动态账号被当成只读挂载（积分读不到、不能删除）。
          source: a.source,
          userId: a.userId,
        })),
      };
      fs.writeFileSync(this.accountsFile, JSON.stringify(data, null, 2), 'utf8');
    } catch (_) {}
  }

  reloadIfChanged() {
    const reloaded = [];
    // 检查动态账号目录是否有新增子目录
    if (fs.existsSync(this.dynamicAccountsDir)) {
      try {
        const entries = fs.readdirSync(this.dynamicAccountsDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const accId = entry.name;
          if (!this.accounts.has(accId)) {
            const stateDir = path.join(this.dynamicAccountsDir, accId);
            const inst = new AccountInstance({
              id: accId,
              name: accId,
              stateDir,
              enabled: true,
              source: 'dynamic',
            });
            this.accounts.set(accId, inst);
            reloaded.push(inst);
          }
        }
      } catch (_) {}
    }

    for (const [id, acc] of this.accounts.entries()) {
      if (acc.source === 'dynamic' && !fs.existsSync(acc.stateDir)) {
        this.accounts.delete(id);
        continue;
      }
      if (acc.isChanged()) {
        acc.reload();
        reloaded.push(acc);
        if (typeof this.onAccountReloaded === 'function') {
          try { this.onAccountReloaded(acc); } catch (_) {}
        }
      }
    }
    return reloaded;
  }

  getAccount(id) {
    return this.accounts.get(String(id)) || null;
  }

  listAccounts(options = {}) {
    return Array.from(this.accounts.values()).map((a) => a.toJSON(options));
  }

  getReadyAccounts() {
    return Array.from(this.accounts.values()).filter((a) => a.status === 'ready' && a.routerKey);
  }

  hasReadyAccounts() {
    return this.getReadyAccounts().length > 0;
  }

  /**
   * 按目标模型和客户端账号权限筛选候选账号 (US 9, US 16, US 17)
   * @param {string} targetModel - 经别名解析后的实际模型名
   * @param {{ids: string[], unrestricted: boolean}|string[]|null} allowedAccountIds - 账号访问范围：
   *   结构对象；历史数组按「指定集合」兼容；缺省 null 在边界归一为不限制
   * @returns {AccountInstance[]}
   */
  getEligibleAccounts(targetModel, allowedAccountIds = null) {
    this.reloadIfChanged();
    const scope = normalizeAccountScope(allowedAccountIds);
    const readyAccounts = this.getReadyAccounts();
    return readyAccounts.filter((acc) => {
      // 1. 权限过滤：指定集合（含空集=无账号权限）严格按集合过滤；不限制放行全部
      if (!isAccountAllowed(scope, acc.id)) return false;
      // 2. 账号级模型支持过滤
      if (targetModel && !acc.supportsModel(targetModel)) {
        return false;
      }
      return true;
    });
  }

  getAllAvailableModels(allowedAccountIds = null) {
    this.reloadIfChanged();
    const modelMap = new Map();
    const scope = normalizeAccountScope(allowedAccountIds);
    for (const acc of this.getReadyAccounts()) {
      if (!isAccountAllowed(scope, acc.id)) continue;
      for (const m of acc.models) {
        if (!modelMap.has(m.id)) {
          modelMap.set(m.id, {
            ...m,
            supportedAccounts: [acc.id],
          });
        } else {
          modelMap.get(m.id).supportedAccounts.push(acc.id);
        }
      }
    }
    return Array.from(modelMap.values());
  }

  getAllAvailableModelIds() {
    this.reloadIfChanged();
    const ids = new Set();
    for (const acc of this.getReadyAccounts()) {
      for (const mId of acc.modelIds) {
        ids.add(mId);
      }
    }
    // 条款 4：集合返回同质数组（不得把 Set 泄漏给调用方）
    return Array.from(ids);
  }

  addAccount({ id, name, stateDir, enabled = true }) {
    if (!id || !stateDir) throw new Error('账号 id 与 stateDir 均为必填字段');
    const accId = String(id).trim();
    if (this.accounts.has(accId)) throw new Error(`账号 id "${accId}" 已存在`);
    const inst = new AccountInstance({ id: accId, name, stateDir, enabled });
    this.accounts.set(accId, inst);
    this.save();
    return inst;
  }

  updateAccount(id, updates = {}) {
    const acc = this.getAccount(id);
    if (!acc) throw new Error(`账号 "${id}" 不存在`);
    if (updates.name !== undefined) acc.name = String(updates.name).trim();
    if (updates.stateDir !== undefined) {
      acc.stateDir = path.resolve(updates.stateDir);
      acc.reload();
    }
    if (updates.enabled !== undefined) {
      acc.enabled = Boolean(updates.enabled);
      acc.reload();
    }
    if (updates.paused !== undefined) {
      acc.paused = Boolean(updates.paused);
    }
    this.save();
    return acc;
  }

  removeAccount(id) {
    const accId = String(id).trim();
    if (!this.accounts.has(accId)) throw new Error(`账号 "${accId}" 不存在`);
    const removed = this.accounts.get(accId);
    if (removed.source === 'mount') {
      throw new Error(`只读挂载账号受到保护，不可在网页端删除: ${accId}`);
    }
    this.accounts.delete(accId);
    if (removed.source === 'dynamic' && fs.existsSync(removed.stateDir)) {
      try {
        fs.rmSync(removed.stateDir, { recursive: true, force: true });
      } catch (_) {}
    }
    this.save();
    return removed;
  }
}

module.exports = {
  AccountInstance,
  AccountPool,
  readKeyFromEnvFile,
  readModelsFromConfigFile,
};
