'use strict';
/**
 * 管理凭据与调用凭据核心模块 (src/credentials.js)
 *
 * 遵循 ADR-0002 决策：
 * 1. 管理凭据（管理口令、浏览器会话）与调用凭据（API Keys）严格分离。
 * 2. 无通用默认口令，支持首次设置、口令校验、有时限的会话及口令变更后使既有会话全部失效。
 * 3. 调用凭据具备不可被展示名称替代的稳定内部身份 (id)，支持创建、展示名称修改、独立撤销及账号策略控制。
 * 4. 账号策略显式配置为 "all" 或 "explicit"；当 "explicit" 账号集合为空时明确表示无任何账号访问权限，绝不降级为全部账号。
 * 5. 撤销凭据后，后续 HTTP 及 WebSocket 调用立即拒绝。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = crypto.createHash('sha256').update(a).digest();
  const bufB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(bufA, bufB);
}

function parseCookies(req) {
  const header = (req && req.headers && req.headers.cookie) || '';
  const cookies = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    const val = part.slice(i + 1).trim();
    try {
      cookies[key] = decodeURIComponent(val);
    } catch {
      cookies[key] = val;
    }
  }
  return cookies;
}

function serializeAdminCookie(token, maxAgeSec = 86400) {
  if (!token) {
    return 'aiwork_admin_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
  }
  return `aiwork_admin_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`;
}

class AdminAuthManager {
  constructor(options = {}) {
    this.dataDir = options.dataDir || path.join(__dirname, '..', 'data');
    this.authFile = path.join(this.dataDir, 'admin-auth.json');
    this.envPassword = options.adminPassword !== undefined ? options.adminPassword : (process.env.ADMIN_PASSWORD || '');
    this.cachedHash = null;
    this.cachedSalt = null;
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.authFile)) {
        const raw = fs.readFileSync(this.authFile, 'utf8');
        const data = JSON.parse(raw);
        if (data && data.passwordHash && data.salt) {
          this.cachedHash = data.passwordHash;
          this.cachedSalt = data.salt;
        }
      }
    } catch {
      // 忽略损坏的本地文件，等待重新设置
    }
  }

  isConfigured() {
    return Boolean((this.envPassword && this.envPassword.trim()) || this.cachedHash);
  }

  verifyPassword(inputPassword) {
    if (!this.isConfigured() || typeof inputPassword !== 'string' || !inputPassword) {
      return false;
    }
    // 优先校验环境变量中显式配置的口令
    if (this.envPassword && this.envPassword.trim()) {
      return timingSafeEqualStr(inputPassword, this.envPassword.trim());
    }
    // 其次校验本地保存的盐值哈希
    if (this.cachedHash && this.cachedSalt) {
      const computed = crypto.scryptSync(inputPassword, this.cachedSalt, 32).toString('hex');
      return timingSafeEqualStr(computed, this.cachedHash);
    }
    return false;
  }

  setPassword(newPassword) {
    if (typeof newPassword !== 'string' || newPassword.length < 4) {
      throw new Error('管理口令长度至少为 4 个字符');
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(newPassword, salt, 32).toString('hex');
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
    const record = {
      passwordHash: hash,
      salt,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(this.authFile, JSON.stringify(record, null, 2), 'utf8');
    this.cachedHash = hash;
    this.cachedSalt = salt;
    // 显式重置 env 引用，让新口令及指纹变更生效
    this.envPassword = '';
  }

  getPasswordFingerprint() {
    if (this.envPassword && this.envPassword.trim()) {
      return crypto.createHash('sha256').update('env:' + this.envPassword.trim()).digest('hex');
    }
    if (this.cachedHash) {
      return crypto.createHash('sha256').update('hash:' + this.cachedHash).digest('hex');
    }
    return 'unconfigured';
  }
}

class AdminSessionStore {
  constructor(options = {}) {
    this.ttlSec = Number(options.ttlSec || process.env.ADMIN_SESSION_TTL_SEC || 86400);
    this.sessions = new Map(); // token -> { token, createdAt, expiresAt, fingerprint }
  }

  createSession(fingerprint) {
    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    const expiresAt = now + this.ttlSec * 1000;
    const session = {
      token,
      createdAt: now,
      expiresAt,
      fingerprint,
    };
    this.sessions.set(token, session);
    return session;
  }

  validateSession(token, currentFingerprint) {
    if (!token || typeof token !== 'string') {
      return { valid: false, reason: 'missing_token' };
    }
    const session = this.sessions.get(token);
    if (!session) {
      return { valid: false, reason: 'not_found' };
    }
    if (Date.now() > session.expiresAt) {
      this.sessions.delete(token);
      return { valid: false, reason: 'expired' };
    }
    if (session.fingerprint !== currentFingerprint) {
      this.sessions.delete(token);
      return { valid: false, reason: 'password_changed' };
    }
    return { valid: true, session };
  }

  destroySession(token) {
    return this.sessions.delete(token);
  }

  destroyAllSessions() {
    this.sessions.clear();
  }
}

/**
 * 统一解析并校验账号访问策略 (Issue #08 / US 47, Code Review Std-2)
 * @param {object|null|undefined} rawPolicy
 * @returns {{ mode: 'all'|'explicit', accounts: string[] }}
 */
function parseAccountPolicy(rawPolicy) {
  if (!rawPolicy || typeof rawPolicy !== 'object') {
    return { mode: 'all', accounts: [] };
  }
  const rawMode = String(rawPolicy.mode || '').trim().toLowerCase();
  let mode;
  if (rawMode === 'explicit' || rawMode === 'custom') {
    mode = 'explicit';
  } else if (rawMode === 'all' || !rawMode) {
    mode = 'all';
  } else {
    throw new Error(`不支持的账号访问策略模式: "${rawPolicy.mode}"。仅支持 "all" 或 "explicit" (支持别名 "custom")。`);
  }
  const accounts = Array.isArray(rawPolicy.accounts)
    ? rawPolicy.accounts.map(String).map((s) => s.trim()).filter(Boolean)
    : [];
  return { mode, accounts };
}

/** account_policy 形状守卫：非对象（含数组）一律拒绝，避免被解析成 all。 */
function assertAccountPolicyShape(policy) {
  if (policy != null && (typeof policy !== 'object' || Array.isArray(policy))) {
    throw new Error('account_policy 必须是对象（{ mode, accounts }）');
  }
}

/** mode 归一：null/空串 → 'unset'；all/explicit/custom → 原语义；其它 → 'invalid'。 */
function normalizePolicyMode(mode) {
  const m = mode == null ? '' : String(mode).trim().toLowerCase();
  if (m === '') return 'unset';
  if (m === 'all' || m === 'explicit' || m === 'custom') return m;
  return 'invalid';
}

/** 仅给 allowed_accounts 而 mode 未设置时推导为 explicit；显式 mode 一律尊重。 */
function derivePolicyMode(mode, hasAccounts) {
  if (!hasAccounts) return mode;
  // 全放行时名单由写入侧清空，不会留下 all+名单；此处只处理「未设置 mode」
  return normalizePolicyMode(mode) === 'unset' ? 'explicit' : mode;
}

/** 加载既有 key 的策略：加载期一律不抛错，单条坏数据只 fail-closed 自身。 */
function resolveLoadedPolicy(k) {
  if (k.account_policy != null) {
    if (typeof k.account_policy !== 'object' || Array.isArray(k.account_policy)) {
      return { mode: 'explicit', accounts: [] };
    }
    const norm = normalizePolicyMode(k.account_policy.mode);
    if (norm === 'invalid') return { mode: 'explicit', accounts: [] };
    const accounts = Array.isArray(k.account_policy.accounts) ? k.account_policy.accounts : [];
    // 显式给了空名单（字段存在但为空）：与写侧一致按「无账号权限」处理，不得降级为 all
    if (norm === 'unset' && k.account_policy.accounts !== undefined && accounts.length === 0) {
      return { mode: 'explicit', accounts: [] };
    }
    // 存量：旧版 createKey 缺省落 all 却带了名单 → 推导 explicit（收紧）。
    // 新写入的全放行会清空名单，因此不会误伤「all + []」。
    if (norm === 'all' && accounts.length > 0) {
      return parseAccountPolicy({ mode: 'explicit', accounts });
    }
    return parseAccountPolicy(k.account_policy);
  }
  const normLegacy = normalizePolicyMode(k.accounts_access_mode);
  if (normLegacy === 'invalid') return { mode: 'explicit', accounts: [] };
  const legacyAccounts = Array.isArray(k.allowed_accounts) ? k.allowed_accounts : [];
  if (normLegacy === 'all' && legacyAccounts.length > 0) {
    return parseAccountPolicy({ mode: 'explicit', accounts: legacyAccounts });
  }
  return parseAccountPolicy({ mode: k.accounts_access_mode, accounts: k.allowed_accounts });
}

class KeyStore {
  constructor(options = {}) {
    this.dataDir = options.dataDir || path.join(__dirname, '..', 'data');
    this.keysFile = path.join(this.dataDir, 'api-keys.json');
    this.rawEnvKeys = options.rawEnvKeys !== undefined ? options.rawEnvKeys : (process.env.API_KEYS || process.env.API_TOKEN || '');
    this.keys = new Map(); // id -> Key
    this.tokenIndex = new Map(); // token -> id
    this.load();
  }

  load() {
    this.keys.clear();
    this.tokenIndex.clear();

    if (fs.existsSync(this.keysFile)) {
      try {
        const raw = fs.readFileSync(this.keysFile, 'utf8');
        const data = JSON.parse(raw);
        const list = Array.isArray(data) ? data : (Array.isArray(data.keys) ? data.keys : null);
        if (list) {
          for (const k of list) {
            // 逐条隔离：单条坏数据不得中断其余 key 的加载（更不得让 env 种子覆写整份文件）
            try {
              this._registerKey(k);
            } catch (_) {}
          }
          // 老版本按默认 umask 写成 0644，明文 Key 同机可读；启动时顺手收紧一次。
          try { fs.chmodSync(this.keysFile, 0o600); } catch (_) {}
          return;
        }
      } catch {
        // 读取错误时降级尝试 env
      }
    }

    // 首次启动时若本地文件不存在，由环境变量种子初始化
    if (this.rawEnvKeys) {
      const seeded = this._parseEnvKeys(this.rawEnvKeys);
      for (const k of seeded) {
        this._registerKey(k);
      }
      this.save();
    }
  }

  _parseEnvKeys(raw) {
    const list = [];
    for (const part of String(raw).split(/[,\n]/)) {
      const p = part.trim();
      if (!p) continue;
      const i = p.indexOf(':');
      let token = p, name = '';
      if (i > 0) {
        const a = p.slice(0, i).trim(), b = p.slice(i + 1).trim();
        if (/^sk-/.test(a)) { token = a; name = b; }
        else if (/^sk-/.test(b)) { token = b; name = a; }
        else { token = a; name = b; }
      }
      if (!name) name = 'key-' + token.replace(/^sk-/, '').slice(-4);
      const id = 'key_' + crypto.createHash('md5').update(token).digest('hex').slice(0, 12);
      list.push({
        id,
        name,
        token,
        created_at: new Date().toISOString(),
        revoked: false,
        account_policy: {
          mode: 'all',
          accounts: [],
        },
        stats: {
          requests: 0,
          tokens: 0,
          cached: 0,
          last_used_at: null,
        },
      });
    }
    return list;
  }

  _registerKey(k) {
    if (!k || !k.id || !k.token) return;
    const normalized = {
      id: String(k.id),
      name: String(k.name || k.id),
      token: String(k.token),
      created_at: k.created_at || new Date().toISOString(),
      revoked: Boolean(k.revoked),
      account_policy: resolveLoadedPolicy(k),
      stats: {
        requests: Number((k.stats && k.stats.requests) || 0),
        tokens: Number((k.stats && k.stats.tokens) || 0),
        cached: Number((k.stats && k.stats.cached) || 0),
        spent: Number((k.stats && k.stats.spent) || 0),
        // null 表示「这份历史数据没有分方向计数」，读取方应回落到会话聚合；
        // 0 表示确定为零（重新统计过）。两者不能混为一谈。
        input: (k.stats && k.stats.input != null) ? Number(k.stats.input) : null,
        output: (k.stats && k.stats.output != null) ? Number(k.stats.output) : null,
        last_used_at: (k.stats && (k.stats.last_used_at || k.stats.lastUsedAt)) || null,
      },
    };
    this.keys.set(normalized.id, normalized);
    this.tokenIndex.set(normalized.token, normalized.id);
  }

  save() {
    try {
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
      }
      const data = {
        version: 1,
        keys: Array.from(this.keys.values()),
      };
      // 原子写：resetAllStats 会在运行期触发落盘，直接 writeFileSync 截断原文件后
      // 若进程被杀/磁盘满，下次启动会解析失败并静默回落到 API_KEYS 种子（所有自建 Key 变 401）。
      // 0600：这个文件里是明文调用凭据，同机器上的其它用户不该能读。
      const tmp = `${this.keysFile}.tmp.${process.pid}.${Date.now()}`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
      try { fs.chmodSync(tmp, 0o600); } catch (_) { /* Windows 上无意义 */ }
      fs.renameSync(tmp, this.keysFile);
      try { fs.chmodSync(this.keysFile, 0o600); } catch (_) { /* Windows 上无意义 */ }
    } catch (err) {
      // 写盘失败必须让调用方感知：静默吞掉会导致策略变更不落盘、重启后回退
      throw err;
    }
  }

  /**
   * 清零所有凭据的累计用量。
   * 与 STATE 的本机统计重置配套：/api/usage 的个人视图优先读 key.stats，
   * 只清 STATE 的话页面上的数字不会变，按钮等于没生效。
   */
  resetAllStats() {
    let changed = false;
    for (const key of this.keys.values()) {
      if (!key.stats) key.stats = { requests: 0, tokens: 0, cached: 0, spent: 0, input: 0, output: 0, last_used_at: null };
      if (key.stats.requests || key.stats.tokens || key.stats.cached || key.stats.spent) changed = true;
      key.stats.requests = 0;
      key.stats.tokens = 0;
      key.stats.cached = 0;
      key.stats.spent = 0;
      // 重置后「分方向计数」是确定的 0，不再是「未知」，所以写 0 而不是 null。
      key.stats.input = 0;
      key.stats.output = 0;
    }
    if (changed) { try { this.save(); } catch (_) { /* 用量统计落盘失败不影响请求 */ } }
    return changed;
  }

  listKeys(options = {}) {
    const mask = Boolean(options.mask);
    return Array.from(this.keys.values()).map((k) => {
      let tokenOut = k.token;
      if (mask) {
        if (k.token.length > 8) {
          tokenOut = k.token.slice(0, 3) + '...' + k.token.slice(-4);
        } else {
          tokenOut = '***';
        }
      }
      return {
        id: k.id,
        name: k.name,
        token: tokenOut,
        created_at: k.created_at,
        revoked: k.revoked,
        account_policy: {
          mode: k.account_policy.mode,
          accounts: [...k.account_policy.accounts],
        },
        stats: { ...k.stats },
      };
    });
  }

  getKeyById(id) {
    return this.keys.get(String(id)) || null;
  }

  getKeyByToken(token) {
    if (!token) return null;
    const id = this.tokenIndex.get(String(token));
    if (!id) return null;
    return this.keys.get(id) || null;
  }

  createKey(params = {}) {
    let token = typeof params.token === 'string' ? params.token.trim() : '';
    if (!token) {
      token = 'sk-' + crypto.randomBytes(16).toString('hex');
    }
    if (this.tokenIndex.has(token)) {
      throw new Error('调用凭据 Token 已存在');
    }

    const name = typeof params.name === 'string' && params.name.trim()
      ? params.name.trim()
      : 'key-' + token.slice(-4);

    let policy;
    assertAccountPolicyShape(params.account_policy);
    if (params.account_policy) {
      policy = parseAccountPolicy({
        ...params.account_policy,
        mode: derivePolicyMode(
          params.account_policy.mode,
          Array.isArray(params.account_policy.accounts),
        ),
      });
    } else if (params.accounts_access_mode || params.allowed_accounts) {
      policy = parseAccountPolicy({
        mode: derivePolicyMode(params.accounts_access_mode, params.allowed_accounts !== undefined),
        accounts: params.allowed_accounts,
      });
    } else {
      policy = { mode: 'all', accounts: [] };
    }

    // 全放行时不留名单：避免「all + 名单残留」在重启/加载时被误读为缩权
    if (policy.mode === 'all') policy.accounts = [];

    const id = 'key_' + crypto.randomBytes(6).toString('hex');
    const newKey = {
      id,
      name,
      token,
      created_at: new Date().toISOString(),
      revoked: false,
      account_policy: policy,
      stats: {
        requests: 0,
        tokens: 0,
        cached: 0,
        last_used_at: null,
      },
    };

    this._registerKey(newKey);
    this.save();
    return this.getKeyById(id);
  }

  updateKey(id, updates = {}) {
    const key = this.getKeyById(id);
    if (!key) {
      throw new Error(`凭据 ${id} 不存在`);
    }

    if (updates.name !== undefined) {
      const name = String(updates.name).trim();
      if (!name) throw new Error('凭据展示名称不可为空');
      key.name = name;
    }

    if (updates.account_policy !== undefined) {
      assertAccountPolicyShape(updates.account_policy);
      const p = updates.account_policy || {};
      key.account_policy = parseAccountPolicy({
        ...p,
        mode: derivePolicyMode(p.mode, Array.isArray(p.accounts)),
      });
    } else if (updates.accounts_access_mode !== undefined || updates.allowed_accounts !== undefined) {
      const nextMode = updates.accounts_access_mode !== undefined
        ? updates.accounts_access_mode : key.account_policy.mode;
      // 只改名单、未显式给 mode：缩权意图 → explicit；显式 mode 一律尊重
      const mode = (updates.accounts_access_mode === undefined && updates.allowed_accounts !== undefined)
        ? 'explicit'
        : derivePolicyMode(nextMode, Array.isArray(updates.allowed_accounts));
      key.account_policy = parseAccountPolicy({
        mode,
        accounts: updates.allowed_accounts !== undefined ? updates.allowed_accounts : key.account_policy.accounts,
      });
    }

    // 全放行时不留名单（同上）
    if (key.account_policy.mode === 'all') key.account_policy.accounts = [];

    this.save();
    return key;
  }

  revokeKey(id) {
    const key = this.getKeyById(id);
    if (!key) {
      throw new Error(`凭据 ${id} 不存在`);
    }
    key.revoked = true;
    this.save();
    return key;
  }

  recordUsage(id, { tokens = 0, cached = 0 } = {}) {
    const key = this.getKeyById(id);
    if (!key) return;
    key.stats.requests = (key.stats.requests || 0) + 1;
    key.stats.tokens = (key.stats.tokens || 0) + Number(tokens || 0);
    key.stats.cached = (key.stats.cached || 0) + Number(cached || 0);
    key.stats.last_used_at = new Date().toISOString();
    // 异步或节流保存用量，避免高频请求落盘瓶颈
  }

  hasAnyAccountAccess(key) {
    if (!key || key.revoked) return false;
    // 单一真值：与 getAllowedAccountsFromKey / isAccountAllowed 同源，不再维护第二套策略判定
    const scope = getAllowedAccountsFromKey(key);
    return scope.unrestricted === true || scope.ids.length > 0;
  }

  canAccessAccount(key, accountId) {
    if (!key || key.revoked || !accountId) return false;
    return isAccountAllowed(getAllowedAccountsFromKey(key), String(accountId));
  }
}

class CredentialsContext {
  constructor(options = {}) {
    this.adminAuth = new AdminAuthManager(options);
    this.sessionStore = new AdminSessionStore(options);
    this.keyStore = new KeyStore(options);
  }

  authenticateAdmin(req) {
    // ADR-0012：未配置管理口令时，管理权限随调用凭据授予。
    // 这条分支取代 ADR-0002 的「管理凭据必须独立」；显式设置 ADMIN_PASSWORD 即可恢复旧边界。
    if (!this.adminAuth.isConfigured()) {
      // 连调用凭据都没配（本机裸跑，AUTH_ON=false）→ 管理面直接可用
      if (this.keyStore.keys.size === 0) {
        return { ok: true, type: 'open' };
      }
      const inv = this.authenticateInvocation(req);
      if (inv.ok) {
        return { ok: true, type: 'invocation', key: inv.key };
      }
      return {
        ok: false,
        status: inv.status || 401,
        error: inv.error,
        code: inv.code,
      };
    }

    const cookies = parseCookies(req);
    const cookieToken = cookies['aiwork_admin_session'];

    const authHeader = (req && req.headers && req.headers['authorization']) || '';
    let bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

    const headerAdminToken = (req && req.headers && (req.headers['x-admin-token'] || req.headers['x-admin-password'])) || '';

    const candidateToken = bearerToken || cookieToken || headerAdminToken;

    // 1. 如果输入与管理员口令直连匹配（自动化脚本或管理员输入）
    if (candidateToken && this.adminAuth.verifyPassword(candidateToken)) {
      return { ok: true, type: 'admin_password' };
    }

    // 2. 如果输入为有效的管理员会话
    if (candidateToken) {
      const res = this.sessionStore.validateSession(candidateToken, this.adminAuth.getPasswordFingerprint());
      if (res.valid) {
        return { ok: true, type: 'admin_session', session: res.session };
      }
    }

    // 3. 检查是否误传了普通调用凭据试图访问管理端
    if (candidateToken && this.keyStore.getKeyByToken(candidateToken)) {
      return {
        ok: false,
        status: 403,
        error: 'forbidden: invocation keys cannot access management resources',
        code: 'forbidden',
      };
    }

    // 4. 未登录或会话无效
    return {
      ok: false,
      status: 401,
      error: 'unauthorized: admin session required',
      code: 'admin_auth_required',
    };
  }

  authenticateInvocation(req) {
    const authHeader = (req && req.headers && req.headers['authorization']) || '';
    let token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (!token && req && req.headers) {
      token = String(req.headers['x-api-key'] || '').trim();
    }

    if (!token) {
      return {
        ok: false,
        status: 401,
        error: 'missing api key',
        code: 'unauthorized',
      };
    }

    const key = this.keyStore.getKeyByToken(token);
    if (!key) {
      return {
        ok: false,
        status: 401,
        error: 'invalid api key',
        code: 'unauthorized',
      };
    }

    if (key.revoked) {
      return {
        ok: false,
        status: 401,
        error: 'api key has been revoked',
        code: 'revoked_key',
      };
    }

    // 校验账号访问权限策略
    if (!this.keyStore.hasAnyAccountAccess(key)) {
      return {
        ok: false,
        status: 403,
        error: 'no accounts permitted for this api key',
        code: 'no_accounts_permitted',
      };
    }

    return { ok: true, key };
  }
}

/**
 * 账号访问范围统一为冻结结构对象（CODING_STANDARDS 条款 4「一致的集合返回」）。
 * 形状恒为 `{ ids, unrestricted }`，「不限制（全部账号）」不再借用 null / Set /
 * 数组 expando 表达：标记是对象自身属性，spread 与 JSON 序列化都不会丢。
 * `ids` 为空且 `unrestricted === false` 时严格表示「无账号权限」
 * （GLOSSARY「账号访问范围」、模块约定 4：绝不降级为全部账号）。
 */
function accountAccessScope(ids, unrestricted) {
  // ids 恒为同质字符串数组：非字符串条目过滤，字符串做 trim（与 parseAccountPolicy 写边界同口径）
  const list = Array.isArray(ids)
    ? ids.map((x) => (typeof x === 'string' ? x.trim() : null)).filter((x) => x !== null && x !== '')
    : [];
  const isUnrestricted = !!unrestricted;
  return Object.freeze({
    // 内层同样冻结：消费端不得用 scope.ids.push() 就地扩权/缩权。
    // 不限制时 ids 恒为空，避免出现「不限制 + 非空集合」的矛盾态。
    ids: Object.freeze(isUnrestricted ? [] : list),
    unrestricted: isUnrestricted,
  });
}

/** 结构判别：只认 accountAccessScope 造出来的形状。 */
function isAccountScope(scope) {
  return scope !== null
    && typeof scope === 'object'
    && !Array.isArray(scope)
    && Array.isArray(scope.ids)
    && typeof scope.unrestricted === 'boolean';
}

/**
 * 边界归一：把历史调用形态收敛成唯一结构。**幂等**，边界与消费端重复调用安全，
 * 不会改变已归一对象上的标记。
 * - 缺省 null / undefined：既有调用契约是「不限制」，因此在边界上显式建成不限制；
 * - Set / 普通数组：历史「指定集合」形态（Set 按指定集合收窄，比旧实现更严格）；
 * - 已是结构对象：原样重建并重新冻结（内容不变，保证外层与内层都不可变）；
 * - 未知 / 畸形形状：fail-closed 收敛为「无账号权限」，绝不解释为全部账号。
 * 归一之后的下游只认结构对象，null 不再是可解释的第四态。
 */
function normalizeAccountScope(scope) {
  if (scope == null) return accountAccessScope([], true);
  // 结构对象也重建一次：确保外层与内层都冻结（JSON 往返/外部构造的对象可能未冻结）
  if (isAccountScope(scope)) return accountAccessScope(scope.ids, scope.unrestricted);
  if (scope instanceof Set) return accountAccessScope([...scope], false);
  if (Array.isArray(scope)) return accountAccessScope(scope, false);
  // 未知形状 fail-closed：GLOSSARY「账号访问范围」明确 Avoid「空名单默认全部」，
  // 畸形输入宁可给「无账号权限」，也不得放行全部账号。
  return accountAccessScope([], false);
}

/** 读取「不限制」这一显式语义（只认结构对象，null/undefined 一律为否）。 */
function isUnrestrictedAccountScope(scope) {
  return scope != null && scope.unrestricted === true;
}

/** 单账号放行判定：共享谓词，取代各消费端重复的 `!unrestricted && !allowed.includes()`。
 *  null / undefined 不是可解释的 scope，一律 fail-closed（与 isUnrestrictedAccountScope 对称）。 */
function isAccountAllowed(scope, accountId) {
  // 只认结构对象：历史数组 / 畸形对象一律 fail-closed（不抛错、不放行）
  if (!isAccountScope(scope)) return false;
  return scope.unrestricted === true || scope.ids.includes(accountId);
}

/**
 * 策略模式 → 账号范围的单点换算（account_policy 与 legacy 字段共用）。
 * 与 parseAccountPolicy 的写边界口径对齐：缺省 mode 视为 'all'（未设置 ≠ 未知值），
 * 未知值 fail-closed；大小写/空白按写边界同样归一（'ALL' / ' custom ' 均可识别）。
 */
function resolvePolicyToScope(mode, accounts) {
  const m = mode == null ? null : String(mode).trim().toLowerCase();
  if (m === 'explicit' || m === 'custom') return accountAccessScope(accounts, false);
  // 空串与缺省同义（未设置 → 'all'），与 parseAccountPolicy 写边界一致
  if (m == null || m === '' || m === 'all') return accountAccessScope([], true);
  // 未知模式 fail-closed：不认识的 mode 不得解释为「全部账号」
  return accountAccessScope([], false);
}

function getAllowedAccountsFromKey(keyObj) {
  if (!keyObj) return accountAccessScope([], true);
  // 只认对象形态的策略：account_policy 存在但非对象属畸形，直接 fail-closed
  // （不回退 legacy，否则畸形值会被解释为「全部账号」）。
  const policy = keyObj.account_policy;
  if (policy != null) {
    if (typeof policy !== 'object' || Array.isArray(policy)) {
      return accountAccessScope([], false);
    }
    const mode = normalizePolicyMode(policy.mode);
    if (mode === 'invalid') return accountAccessScope([], false);
    // 与写侧 derivePolicyMode 同规则：未设置 mode 但显式给了名单 → explicit（空名单即无权限）
    if (mode === 'unset' && Array.isArray(policy.accounts)) {
      return accountAccessScope(policy.accounts, false);
    }
    return resolvePolicyToScope(policy.mode, policy.accounts);
  }
  const legacyMode = normalizePolicyMode(keyObj.accounts_access_mode);
  if (legacyMode === 'invalid') return accountAccessScope([], false);
  if (legacyMode === 'unset' && Array.isArray(keyObj.allowed_accounts)) {
    return accountAccessScope(keyObj.allowed_accounts, false);
  }
  return resolvePolicyToScope(keyObj.accounts_access_mode, keyObj.allowed_accounts);
}

module.exports = {
  timingSafeEqualStr,
  parseCookies,
  serializeAdminCookie,
  getAllowedAccountsFromKey,
  accountAccessScope,
  normalizeAccountScope,
  isUnrestrictedAccountScope,
  isAccountAllowed,
  parseAccountPolicy,
  AdminAuthManager,
  AdminSessionStore,
  KeyStore,
  CredentialsContext,
};
