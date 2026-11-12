'use strict';
/**
 * 动态账号池与设备授权流核心模块 (src/dynamic-accounts.js)
 *
 * 遵循 ADR-0006 架构决策：
 * 1. 双源账号共存：挂载账号 (source: 'mount') 与动态账号 (source: 'dynamic') 统一纳入账号池。
 * 2. 动态账号 CRUD：存储于 dataDir/accounts/<id> 目录，支持导入、重命名、启停与删除。
 * 3. 只读保护：挂载账号 (source: 'mount') 禁止在管理界面被删除。
 * 4. 设备授权流 (Device Code Flow) 状态机：支持发起授权链接、轮询与换票落盘。
 * 5. 额度查询缓存：提供各账号上游已用量与总额度聚合查询，内建 60s 内存缓存。
 */

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const http = require('http');
const path = require('path');
const { URL } = require('url');
const { AccountInstance } = require('./account-pool');

const DEFAULT_AUTH_URL = 'https://aiwork.dtagi.cn/account/auth/device';
const DEFAULT_BILLING_TIMEOUT_MS = 6000;
const BILLING_CACHE_TTL_MS = 60000;
// 官方 CLI 端点清单中的 Router 凭据换票接口（external/prod profile）。
// 设备授权返回的 accessToken 只是账号服务 JWT，必须用它换取真正的 Router API Key (data.sk)。
const ROUTER_APIKEY_EXCHANGE_PATH = '/api/v1/router/apikey/exchange';
const DEFAULT_ROUTER_BASE_URL = 'https://aiwork-api.dtagi.cn';
// 额度聚合取数（管理台额度看板）。可用 AIWORK_BILLING_BASE_URL 指向本地，默认仍为官方地址。
const DEFAULT_BILLING_BASE_URL = 'https://aiwork-api.dtagi.cn';
// 账号服务的积分汇总接口。只认账号 JWT，Router Key 访问会 401。
const ACCOUNT_USAGE_SUMMARY_PATH = '/api/v1/user/usage-summary';
const TOKEN_REFRESH_PATH = '/api/v1/token/refresh';
const CREDITS_CACHE_TTL_MS = 60000;
const CREDITS_ERROR_TTL_MS = 15000;
const TOKEN_EXPIRY_SKEW_MS = 60000;

function doJsonGet(targetUrl, token, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(targetUrl);
    const client = urlObj.protocol === 'https:' ? https : http;
    const req = client.request(urlObj, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'AiWorkCLI/1.0',
      },
      timeout: timeoutMs,
    }, (res) => {
      let buf = '';
      res.on('data', (d) => (buf += d));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(buf) });
        } catch (_) {
          resolve({ status: res.statusCode, data: null, raw: buf });
        }
      });
    });
    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('请求官方账号服务超时'));
    });
    req.end();
  });
}

/** 仅用于保存账号登录态：0600，避免把半截文件或宽松权限留在磁盘上。 */
function writePrivateFile(file, body) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch (_) {}
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch (_) {}
}

/** 老版本写下的文件是 0644，启动时顺手收紧；只读挂载上 chmod 失败不影响启动。 */
function hardenPrivateFiles(dir) {
  for (const name of ['.env', 'session.json', 'auth.json']) {
    try { fs.chmodSync(path.join(dir, name), 0o600); } catch (_) {}
  }
}

/** 仅用于保存账号登录态：0600 + 原子替换，避免把半截文件或宽松权限留在磁盘上。 */
function writePrivateJson(file, value) {
  writePrivateFile(file, JSON.stringify(value, null, 2));
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 按优先级取第一个可解析的数字。上游字段命名有好几代（totalCredits / monthlyCredits / plan.total），
 * 之前这段三元嵌套被复制了 6 次，改一处口径要同步改 6 处。
 *
 * 口径：**可解析**优先，而不是「非 null 优先」。上游偶尔把占位值发成字符串
 * （`totalCredits: "abc"`），旧实现会把整块额度显示成空，这里改为继续回退到下一候选字段。
 * 这是 ADR-0015 §8 记录的有意变更，不是重构副作用。
 */
function pickNum(...candidates) {
  for (const v of candidates) {
    const n = numOrNull(v);
    if (n !== null) return n;
  }
  return null;
}

function sumKnown(...values) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  return nums.length ? nums.reduce((a, b) => a + b, 0) : null;
}

function normalizeQuota(o) {
  if (!o || typeof o !== 'object') return null;
  return {
    total: pickNum(o.totalCredits, o.monthlyCredits),
    used: pickNum(o.usedCredits, o.monthlyUsed),
    remaining: pickNum(o.remainingCredits, o.monthlyRemaining),
    expire_at: o.expireAt || null,
  };
}

function doJsonPost(targetUrl, payload, timeoutMs = 6000, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(targetUrl);
    const client = urlObj.protocol === 'https:' ? https : http;
    const bodyStr = JSON.stringify(payload);
    const req = client.request(urlObj, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        'Accept': 'application/json',
        'User-Agent': 'AiWorkCLI/1.0',
        ...extraHeaders,
      },
      timeout: timeoutMs,
    }, (res) => {
      let buf = '';
      res.on('data', (d) => (buf += d));
      res.on('end', () => {
        try {
          const json = JSON.parse(buf);
          resolve({ status: res.statusCode, data: json });
        } catch (_) {
          resolve({ status: res.statusCode, data: null, raw: buf });
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('请求官方上游接口超时'));
    });
    req.write(bodyStr);
    req.end();
  });
}

/**
 * 用设备授权得到的账号访问令牌 (JWT) 换取真正的 Router API Key。
 * 官方端点：POST {authBaseUrl}/api/v1/router/apikey/exchange
 *   headers: Authorization: Bearer <accessToken>
 *   response.data.sk -> Router API Key（形如 48 位字符串，不是 JWT）
 */
async function exchangeRouterKey(authBaseUrl, accessToken) {
  const base = String(authBaseUrl || `https://aiwork.dtagi.cn`).replace(/\/+$/, '');
  const url = process.env.DTCODER_ROUTER_APIKEY_EXCHANGE_URL || `${base}${ROUTER_APIKEY_EXCHANGE_PATH}`;
  const resp = await doJsonPost(url, {}, 8000, { Authorization: `Bearer ${accessToken}` });
  if (resp.status !== 200 || !resp.data || resp.data.success !== true || !resp.data.data) {
    const msg = (resp.data && (resp.data.errorMessage || resp.data.error)) || `HTTP ${resp.status}`;
    throw new Error(`官方换票接口返回 ${msg}`);
  }
  const d = resp.data.data;
  const sk = d.sk || d.apiKey || d.routerKey;
  if (!sk || typeof sk !== 'string') {
    throw new Error('官方换票响应缺少 Router API Key (data.sk)');
  }
  return { ...d, sk };
}

/** Router 标签 -> 中文成本标签（与 src/api-bridge.js 的展示口径一致） */
function costTagOf(m) {
  const raw = String(m.tags || '').toLowerCase();
  if (raw.includes('free')) return '免费';
  if (raw.includes('discount') || raw.includes('promo')) return '折扣';
  if (raw.includes('preview')) return '尝鲜';
  const x = parseFloat(String(m.ratio || '').replace(/x/i, ''));
  if (!isFinite(x)) return '';
  if (x <= 0) return '免费';
  if (x <= 0.3) return '低成本';
  if (x <= 1) return '中成本';
  return '高成本';
}

/** 用真正的 Router API Key 拉取实时模型目录（含真实计费倍率） */
async function fetchLiveRouterModels(routerKey, routerBaseUrl) {
  const base = String(routerBaseUrl || process.env.ROUTER_BASE_URL || DEFAULT_ROUTER_BASE_URL).replace(/\/+$/, '');
  const res = await fetch(`${base}/v1/models`, {
    headers: { Authorization: `Bearer ${routerKey}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Router /v1/models 返回 HTTP ${res.status}`);
  const body = await res.json();
  const list = Array.isArray(body.data) ? body.data : [];
  return list.filter((m) => m && m.id).map((m) => ({
    id: String(m.id),
    name: String(m.name || m.id),
    context_window: m.context_window || null,
    max_tokens: m.max_token || m.max_tokens || null,
    reasoning: !!m.reasoning,
    ratio: m.ratio != null ? String(m.ratio) : '',
    multiplier: (() => {
      const x = parseFloat(String(m.ratio || '').replace(/x/i, ''));
      return isFinite(x) ? x : null;
    })(),
    costTag: costTagOf(m),
  }));
}

class DeviceLoginManager {
  constructor(options = {}) {
    this.dynamicAccountManager = options.dynamicAccountManager || null;
    this.sessions = new Map();
  }

  async startSession(options = {}) {
    const rawName = String(options.name || '').trim();
    const timeoutSec = Math.max(60, Number(options.timeoutSec) || 180);
    const authBaseUrl = options.authBaseUrl || process.env.DTCODER_EXTERNAL_AUTH_BASE_URL || 'https://aiwork.dtagi.cn';
    const authEndpoint = `${authBaseUrl.replace(/\/+$/, '')}/api/v1/auth/device/authorize`;

    let deviceCode = null;
    let userCode = null;
    let verificationUri = null;
    let expiresIn = timeoutSec;
    let interval = 5;

    // 向官方设备授权接口发起真实请求，获取官方服务端签发并注册的合法授权码
    try {
      const resp = await doJsonPost(authEndpoint, { client_id: 'AiWorkCLI', type: 'AiWorkCLI' }, 5000);
      if (resp.status === 200 && resp.data && resp.data.success && resp.data.data) {
        const d = resp.data.data;
        deviceCode = d.deviceCode;
        userCode = d.userCode;
        verificationUri = d.verificationUriComplete || d.verificationUri;
        if (d.expiresIn) expiresIn = Number(d.expiresIn);
        if (d.interval) interval = Number(d.interval);
      } else {
        throw new Error((resp.data && (resp.data.errorMessage || resp.data.error)) || `官方授权接口返回 HTTP ${resp.status}`);
      }
    } catch (err) {
      throw new Error(`连接官方授权接口失败 (${err.message})，请检查网络或使用手动粘贴 Router Key 导入。`);
    }

    const sessionId = crypto.randomBytes(16).toString('hex');
    const session = {
      sessionId,
      userCode,
      deviceCode,
      verificationUri,
      authBaseUrl,
      interval,
      name: rawName,
      status: 'pending', // 'pending' | 'confirmed' | 'expired'
      createdAt: Date.now(),
      expiresAt: Date.now() + expiresIn * 1000,
      accountId: null,
      accountInfo: null,
    };

    this.sessions.set(sessionId, session);
    this._cleanExpiredSessions();

    return {
      sessionId: session.sessionId,
      userCode: session.userCode,
      verificationUri: session.verificationUri,
      expiresIn,
      interval,
      status: session.status,
    };
  }

  async pollSession(sessionId) {
    this._cleanExpiredSessions();
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { ok: false, status: 'expired', message: '会话已过期或不存在' };
    }
    if (Date.now() > session.expiresAt) {
      session.status = 'expired';
      return { ok: false, status: 'expired', message: '登录会话已超时' };
    }
    if (session.status === 'confirmed') {
      return {
        ok: true,
        status: 'confirmed',
        accountId: session.accountId,
        account: session.accountInfo,
      };
    }

    // 向上游官方 Token 接口轮询
    let tokenData = null;
    try {
      const tokenEndpoint = `${session.authBaseUrl.replace(/\/+$/, '')}/api/v1/auth/device/token`;
      const resp = await doJsonPost(tokenEndpoint, {
        deviceCode: session.deviceCode,
        client_id: 'AiWorkCLI',
      }, 4000);
      if (resp.status === 200 && resp.data && resp.data.success && resp.data.data) {
        tokenData = resp.data.data;
      }
    } catch (_) {
      // 轮询中网络瞬时抖动忽略，等待下一次轮询
    }
    if (!tokenData || !tokenData.accessToken) {
      return {
        ok: true,
        status: 'pending',
        userCode: session.userCode,
        verificationUri: session.verificationUri,
      };
    }

    // 官方设备授权只返回账号服务的 accessToken (JWT)，它不能用于 Router 鉴权。
    // 必须调用官方换票接口拿到真正的 Router API Key，否则上游一律 401。
    let exchange;
    try {
      exchange = await exchangeRouterKey(session.authBaseUrl, tokenData.accessToken);
    } catch (err) {
      session.lastError = err.message;
      return {
        ok: false,
        status: 'error',
        message: `Router Key 换票失败：${err.message}。请改用「手动粘贴 Router Key」导入。`,
      };
    }

    // 实时模型目录以 Router /v1/models 为准；换票响应里的 availableModels 是旧快照，仅作降级。
    let models = [];
    try {
      models = await fetchLiveRouterModels(exchange.sk, exchange.routerBaseUrl);
    } catch (_) {
      models = (exchange.availableModels || []).map((id) => ({ id: String(id), name: String(id) }));
    }

    const imported = this.dynamicAccountManager.importAccount({
      name: session.name || tokenData.nickname || '官方授权账号',
      routerKey: exchange.sk,
      userId: tokenData.userId || exchange.memberId || (exchange.newApiUserId ? String(exchange.newApiUserId) : null),
      models,
      // 只把 refresh token 落盘；access token 留在内存，供积分接口首次使用。
      refreshToken: tokenData.refreshToken || null,
      accessToken: tokenData.accessToken,
      expiresIn: tokenData.expiresIn,
      authBaseUrl: session.authBaseUrl,
    });

    session.status = 'confirmed';
    session.accountId = imported.id;
    session.accountInfo = imported;

    return {
      ok: true,
      status: 'confirmed',
      accountId: imported.id,
      account: imported,
    };
  }

  completeSession(sessionId, payload = {}) {
    const session = this.sessions.get(sessionId);
    if (!session || session.status === 'expired') {
      throw new Error('无法完成已过期或不存在的登录会话');
    }

    if (!this.dynamicAccountManager) {
      throw new Error('未配置 DynamicAccountManager，无法落盘账号');
    }

    const imported = this.dynamicAccountManager.importAccount({
      name: session.name || payload.name || payload.nickname || '新登录账号',
      routerKey: payload.routerKey,
      userId: payload.userId,
      models: payload.models || [],
      nickname: payload.nickname || '',
      refreshToken: payload.refreshToken || null,
      accessToken: payload.accessToken || null,
      expiresIn: payload.expiresIn,
      authBaseUrl: payload.authBaseUrl,
    });

    session.status = 'confirmed';
    session.accountId = imported.id;
    session.accountInfo = imported;

    return imported;
  }

  _cleanExpiredSessions() {
    const now = Date.now();
    for (const [id, s] of this.sessions.entries()) {
      if (now > s.expiresAt + 60000) {
        this.sessions.delete(id);
      }
    }
  }
}

class DynamicAccountManager {
  constructor(options = {}) {
    this.dataDir = options.dataDir || path.join(__dirname, '..', 'data');
    this.accountsDir = path.join(this.dataDir, 'accounts');
    this.accountPool = options.accountPool || null;
    this.mountAccounts = Array.isArray(options.mountAccounts)
      ? options.mountAccounts.map((a) => (a instanceof AccountInstance ? a : new AccountInstance({ ...a, source: 'mount' })))
      : [];

    this.dynamicAccounts = new Map(); // id -> AccountInstance
    this.billingFetcher = options.billingFetcher || null;
    // 仅影响额度聚合取数；模型目录、授权与 Router Key 交换各有各的地址，不受此设置影响。
    this.billingBaseUrl = String(
      options.billingBaseUrl || process.env.AIWORK_BILLING_BASE_URL || DEFAULT_BILLING_BASE_URL
    ).replace(/\/+$/, '');
    this.billingCache = {
      timestamp: 0,
      data: {},
    };

    // 积分/登录态缓存：refresh token 落盘，access token 只在内存。
    this.creditsCache = new Map();   // accountId -> { at, ttl, data }
    this.accessTokens = new Map();   // accountId -> { token, expiresAt }
    this.refreshInFlight = new Map();// accountId -> Promise<string>

    this.deviceLoginManager = new DeviceLoginManager({ dynamicAccountManager: this });
    this.load();
  }

  load() {
    this.dynamicAccounts.clear();
    if (!fs.existsSync(this.accountsDir)) {
      try {
        fs.mkdirSync(this.accountsDir, { recursive: true });
      } catch (_) {}
      return;
    }

    let entries = [];
    try {
      entries = fs.readdirSync(this.accountsDir, { withFileTypes: true });
    } catch (_) {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const accId = entry.name;
      const stateDir = path.join(this.accountsDir, accId);
      const authPath = path.join(stateDir, 'auth.json');
      // 升级上来的目录可能还是 0644；这里一次收紧，不必等下次写入。
      hardenPrivateFiles(stateDir);

      let name = accId;
      let userId = null;
      let enabled = true;

      if (fs.existsSync(authPath)) {
        try {
          const authData = JSON.parse(fs.readFileSync(authPath, 'utf8'));
          if (authData.name) name = authData.name;
          if (authData.user_id) userId = authData.user_id;
          if (authData.enabled !== undefined) enabled = Boolean(authData.enabled);
        } catch (_) {}
      }

      const inst = new AccountInstance({
        id: accId,
        name,
        stateDir,
        enabled,
        source: 'dynamic',
        userId,
      });

      this.dynamicAccounts.set(accId, inst);
    }
  }

  listAccounts(options = {}) {
    if (this.accountPool) {
      return this.accountPool.listAccounts(options);
    }
    const list = [];
    // 挂载账号
    for (const inst of this.mountAccounts) {
      list.push(inst.toJSON(options));
    }
    // 动态账号
    for (const inst of this.dynamicAccounts.values()) {
      list.push(inst.toJSON(options));
    }
    return list;
  }

  getAccount(id) {
    if (!id) return null;
    if (this.accountPool) {
      return this.accountPool.getAccount(id);
    }
    const target = String(id).trim();
    if (this.dynamicAccounts.has(target)) {
      return this.dynamicAccounts.get(target);
    }
    for (const inst of this.mountAccounts) {
      if (inst.id === target) return inst;
    }
    return null;
  }

  importAccount(options = {}) {
    const rawKey = String(options.routerKey || '').trim();
    if (!rawKey) {
      throw new Error('上游凭据 (routerKey) 不能为空');
    }

    const rawName = String(options.name || options.nickname || '未命名账号').trim();
    const rawUserId = options.userId ? String(options.userId).trim() : null;

    // 检查是否已有相同 userId 的动态账号，有则原地覆盖；
    // 手工只导入 Router Key 的账号没有 userId，设备授权后按相同 Router Key 复用，
    // 避免同一上游账号在面板里出现两条记录。
    let targetId = null;
    const existingAccounts = this.accountPool
      ? [...this.accountPool.accounts.values()]
      : [...this.dynamicAccounts.values()];
    if (rawUserId) {
      for (const inst of existingAccounts) {
        if (inst.source === 'dynamic' && inst.userId === rawUserId) {
          targetId = inst.id;
          break;
        }
      }
    }
    if (!targetId && rawKey) {
      for (const inst of existingAccounts) {
        if (inst.source === 'dynamic' && inst.routerKey === rawKey) {
          targetId = inst.id;
          break;
        }
      }
    }

    if (!targetId) {
      const sanitized = rawUserId ? rawUserId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 16) : '';
      targetId = sanitized ? `acc_${sanitized}` : `acc_${crypto.randomBytes(4).toString('hex')}`;
      if (this.dynamicAccounts.has(targetId) || (this.accountPool && this.accountPool.accounts.has(targetId))) {
        targetId = `${targetId}_${crypto.randomBytes(2).toString('hex')}`;
      }
    }

    const accDir = path.join(this.accountsDir, targetId);
    fs.mkdirSync(accDir, { recursive: true });

    // 1. 写入 .env（里面是明文 Router Key，必须 0600）
    const envContent = `AGENTIX_CONFIG_MODELS_AIWORK_ROUTER_API_KEY=${rawKey}\n`;
    writePrivateFile(path.join(accDir, '.env'), envContent);

    // 2. 写入 auth.json
    const authData = {
      entries: [
        {
          version: 'v1.26433.0',
          provider: 'aiwork-router',
          user_id: rawUserId,
          base_url: 'https://aiwork-api.dtagi.cn',
          updated_at: new Date().toISOString(),
        }
      ],
      user_id: rawUserId,
      name: rawName,
      enabled: true,
      updated_at: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(accDir, 'auth.json'), JSON.stringify(authData, null, 2), 'utf8');

    // 3. 写入 config.json
    // 保留 Router /v1/models 的真实倍率与能力字段；只有调用方完全没提供目录时
    // 才退回两个 auto 占位模型（正常设备登录 / 手动导入都会带上实时目录）。
    const normalizeModel = (m) => {
      const o = (m && typeof m === 'object') ? m : { id: String(m) };
      const out = {
        id: String(o.id || o.name || o),
        name: String(o.name || o.id || o),
      };
      for (const k of ['context_window', 'max_tokens', 'reasoning', 'multiplier', 'ratio', 'costTag']) {
        if (o[k] !== undefined && o[k] !== null && o[k] !== '') out[k] = o[k];
      }
      return out;
    };
    const supplied = Array.isArray(options.models) && options.models.length > 0
      ? options.models
      : (Array.isArray(options.availableModels) ? options.availableModels : []);
    const modelsList = supplied.length > 0
      ? supplied.map(normalizeModel)
      : [
          { id: 'automodel', name: 'auto-经济' },
          { id: 'auto-high', name: 'auto-高级' }
        ];

    const configData = {
      base_url: 'https://aiwork-api.dtagi.cn',
      api: 'openai-completions',
      models: {
        'aiwork-router': {
          models: modelsList,
        }
      }
    };
    fs.writeFileSync(path.join(accDir, 'config.json'), JSON.stringify(configData, null, 2), 'utf8');

    // 4. 账号登录态：只落盘 refresh token；access token 只在内存中缓存。
    //    手动只导入 Router Key 时不覆盖已有登录态，也不创建空 session。
    if (options.refreshToken) {
      this.saveAccountSession(targetId, {
        refreshToken: options.refreshToken,
        accessToken: options.accessToken || null,
        expiresIn: options.expiresIn,
        authBaseUrl: options.authBaseUrl,
        userId: rawUserId,
      });
    } else if (options.accessToken && Number(options.expiresIn) > 0) {
      this.accessTokens.set(targetId, {
        token: String(options.accessToken),
        expiresAt: Date.now() + Number(options.expiresIn) * 1000,
      });
    }

    // 5. 实例化或刷新 AccountInstance
    let inst = this.getAccount(targetId);
    if (inst) {
      inst.name = rawName;
      inst.userId = rawUserId;
      inst.enabled = true;
      inst.reload();
    } else {
      inst = new AccountInstance({
        id: targetId,
        name: rawName,
        stateDir: accDir,
        enabled: true,
        source: 'dynamic',
        userId: rawUserId,
      });
      this.dynamicAccounts.set(targetId, inst);
      if (this.accountPool) {
        this.accountPool.accounts.set(targetId, inst);
      }
    }

    if (this.accountPool) {
      this.accountPool.reloadIfChanged();
    }

    this.billingCache.timestamp = 0;
    return inst.toJSON();
  }

  _sessionPath(id) {
    return path.join(this.accountsDir, id, 'session.json');
  }

  /**
   * 保存账号登录态：只写 refresh token（0600、原子替换）。
   * access token 只进内存，进程重启后由 refresh token 重新换取。
   */
  saveAccountSession(id, opts = {}) {
    const refreshToken = opts.refreshToken ? String(opts.refreshToken) : '';
    if (!refreshToken) return;
    fs.mkdirSync(path.join(this.accountsDir, id), { recursive: true });
    const file = this._sessionPath(id);
    let prev = {};
    try { prev = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (_) {}
    const now = Date.now();
    const data = {
      version: 1,
      auth_base_url: String(opts.authBaseUrl || prev.auth_base_url || 'https://aiwork.dtagi.cn').replace(/\/+$/, ''),
      refresh_token: refreshToken,
      refresh_updated_at: new Date(now).toISOString(),
      user_id: opts.userId || prev.user_id || null,
    };
    writePrivateJson(file, data);
    const expiresIn = Number(opts.expiresIn) || 0;
    if (opts.accessToken && expiresIn > 0) {
      this.accessTokens.set(id, { token: String(opts.accessToken), expiresAt: now + expiresIn * 1000 });
    }
    this.creditsCache.delete(id);
  }

  readAccountSession(id) {
    try {
      const data = JSON.parse(fs.readFileSync(this._sessionPath(id), 'utf8'));
      return data && data.refresh_token ? data : null;
    } catch (_) {
      return null;
    }
  }

  _reauthError(message) {
    const err = new Error(message || '账号登录态已失效，请重新授权以读取积分');
    err.code = 'reauth_required';
    return err;
  }

  /** 用 refresh token 换短期 access token；同账号并发只刷新一次，避免轮换互相作废。 */
  async ensureAccountAccessToken(account, options = {}) {
    const id = account.id;
    const cached = this.accessTokens.get(id);
    if (!options.forceRefresh && cached && cached.token && cached.expiresAt - TOKEN_EXPIRY_SKEW_MS > Date.now()) {
      return cached.token;
    }
    if (this.refreshInFlight.has(id)) return this.refreshInFlight.get(id);

    const task = (async () => {
      const session = this.readAccountSession(id);
      if (!session) throw this._reauthError('账号缺少登录态（没有 refresh token），请重新授权');
      const base = String(session.auth_base_url || 'https://aiwork.dtagi.cn').replace(/\/+$/, '');
      const resp = await doJsonPost(`${base}${TOKEN_REFRESH_PATH}`, { refreshToken: session.refresh_token }, 10000);
      const d = resp.data && resp.data.data;
      // 官方账号服务通常返回 {success:true,data}；也兼容只返回 {data:{accessToken}} 的实现。
      const envelopeOk = !!resp.data && resp.data.success !== false && !!d && !!d.accessToken;
      if (resp.status !== 200 || !envelopeOk) {
        const code = (resp.data && (resp.data.errorCode || resp.data.code)) || `HTTP ${resp.status}`;
        throw this._reauthError(`账号登录态刷新失败（${code}），请重新授权`);
      }
      const expiresIn = Number(d.expiresIn) || 7200;
      this.saveAccountSession(id, {
        refreshToken: d.refreshToken || session.refresh_token,
        accessToken: d.accessToken,
        expiresIn,
        authBaseUrl: base,
        userId: session.user_id,
      });
      return d.accessToken;
    })();

    this.refreshInFlight.set(id, task);
    try {
      return await task;
    } finally {
      if (this.refreshInFlight.get(id) === task) this.refreshInFlight.delete(id);
    }
  }

  async _fetchAccountCredits(account, options = {}) {
    const session = this.readAccountSession(account.id);
    if (!session) throw this._reauthError('账号缺少登录态（没有 refresh token），请重新授权');

    let token = await this.ensureAccountAccessToken(account, options);
    const base = String(session.auth_base_url || 'https://aiwork.dtagi.cn').replace(/\/+$/, '');
    let resp = await doJsonGet(`${base}${ACCOUNT_USAGE_SUMMARY_PATH}`, token, 10000);

    // access token 被上游拒绝：清掉内存缓存，强制刷新一次，且只重试一次。
    if (resp.status === 401) {
      this.accessTokens.delete(account.id);
      token = await this.ensureAccountAccessToken(account, { forceRefresh: true });
      resp = await doJsonGet(`${base}${ACCOUNT_USAGE_SUMMARY_PATH}`, token, 10000);
    }

    const d = resp.data && resp.data.data;
    if (resp.status !== 200 || !resp.data || resp.data.success === false || !d) {
      const code = (resp.data && (resp.data.errorCode || resp.data.code)) || `HTTP ${resp.status}`;
      if (resp.status === 401) throw this._reauthError(`积分接口拒绝登录态（${code}），请重新授权`);
      const err = new Error(`积分接口返回 ${code}`);
      err.code = 'credits_unavailable';
      throw err;
    }

    const plan = normalizeQuota(d.plan);
    const benefit = normalizeQuota(d.benefit);
    const addons = normalizeQuota(d.addons);
    const total = pickNum(d.totalCredits, d.monthlyCredits, plan && plan.total);
    const used = pickNum(d.usedCredits, d.monthlyUsed, plan && plan.used);
    const remaining = pickNum(d.remainingCredits, d.monthlyRemaining, plan && plan.remaining);
    const allRemaining = pickNum(d.allRemainingCredits)
      ?? sumKnown(plan && plan.remaining, benefit && benefit.remaining, addons && addons.remaining);

    return {
      ok: true,
      account_id: account.id,
      account_name: account.name,
      plan_name: d.planName || null,
      total,
      used,
      remaining,
      all_remaining: allRemaining,
      used_percent: pickNum(d.usedPercent)
        ?? (total && total > 0 && used != null ? Math.min(100, Math.max(0, (used / total) * 100)) : null),
      today_credits: numOrNull(d.todayCredits),
      today_requests: numOrNull(d.todayRequests),
      addon_total: pickNum(d.addonCredits, d.addonTotal, addons && addons.total),
      addon_used: pickNum(d.addonUsed, addons && addons.used),
      addon_expiry: d.addonExpiry || (addons && addons.expire_at) || null,
      expire_at: d.expireAt || (plan && plan.expire_at) || null,
      plan,
      benefit,
      addons,
      fetched_at: Date.now(),
    };
  }

  async getAccountCredits(accountId, options = {}) {
    const id = String(accountId || '').trim();
    const cached = this.creditsCache.get(id);
    if (!options.force && cached && Date.now() - cached.at < cached.ttl) {
      return { ...cached.data, cached: true };
    }

    let data;
    try {
      const account = this.getAccount(id);
      if (!account) throw new Error(`账号 "${id}" 不存在`);
      if (account.source !== 'dynamic') {
        throw Object.assign(new Error('挂载账号不读取积分，请使用设备授权账号'), { code: 'not_applicable' });
      }
      data = await this._fetchAccountCredits(account, options);
    } catch (err) {
      data = {
        ok: false,
        account_id: id,
        error: err.code || 'credits_unavailable',
        message: err.message || '积分读取失败',
        fetched_at: Date.now(),
      };
    }
    const ttl = data.ok ? CREDITS_CACHE_TTL_MS : CREDITS_ERROR_TTL_MS;
    this.creditsCache.set(id, { at: Date.now(), ttl, data });
    return data;
  }

  async getCreditsOverview(options = {}) {
    const accounts = this.accountPool
      ? this.accountPool.listAccounts({ includeSecrets: false })
      : [...this.dynamicAccounts.values()].map((a) => a.toJSON());
    const results = await Promise.all((accounts || []).map((a) => this.getAccountCredits(a.id, options)));
    const byId = {};
    let totalRemaining = 0;
    let totalTotal = 0;
    let totalUsed = 0;
    let anyOk = false;
    let firstError = null;
    for (const r of results) {
      byId[r.account_id] = r;
      if (r.ok) {
        anyOk = true;
        // 聚合只累加读取成功的账号；任一账号失败时其余账号仍照常计入，
        // 由调用方通过 accounts[id].ok 区分「总和里缺了谁」。
        if (typeof r.total === 'number') totalTotal += r.total;
        if (typeof r.used === 'number') totalUsed += r.used;
        if (typeof r.all_remaining === 'number') totalRemaining += r.all_remaining;
        else if (typeof r.remaining === 'number') totalRemaining += r.remaining;
      } else if (!firstError) {
        firstError = r.error;
      }
    }
    return {
      ok: anyOk,
      accounts: byId,
      total_total: anyOk ? totalTotal : null,
      total_used: anyOk ? totalUsed : null,
      total_remaining: anyOk ? totalRemaining : null,
      error: anyOk ? null : (firstError || 'credits_unavailable'),
      fetched_at: Date.now(),
    };
  }

  patchAccount(id, updates = {}) {
    const acc = this.getAccount(id);
    if (!acc) throw new Error(`账号 "${id}" 不存在`);

    if (updates.name !== undefined) {
      acc.name = String(updates.name).trim() || acc.name;
    }
    if (updates.enabled !== undefined) {
      acc.enabled = Boolean(updates.enabled);
      acc.reload();
    }
    // 暂停选号：独立于 enabled 的运维状态（不接新会话，已绑定会话继续，见 ADR-0016）
    if (updates.paused !== undefined) {
      acc.paused = Boolean(updates.paused);
    }

    if (acc.source === 'dynamic') {
      const authPath = path.join(acc.stateDir, 'auth.json');
      try {
        let authData = {};
        if (fs.existsSync(authPath)) {
          authData = JSON.parse(fs.readFileSync(authPath, 'utf8'));
        }
        authData.name = acc.name;
        authData.enabled = acc.enabled;
        authData.paused = acc.paused;
        authData.updated_at = new Date().toISOString();
        fs.writeFileSync(authPath, JSON.stringify(authData, null, 2), 'utf8');
      } catch (_) {}
    }

    if (this.accountPool) {
      // 落盘到 accounts.json：重启后暂停状态仍然生效，不会因为「忘了」重新接流量。
      this.accountPool.save();
      this.accountPool.reloadIfChanged();
    }

    return acc.toJSON();
  }

  deleteAccount(id) {
    const target = String(id || '').trim();
    const acc = this.getAccount(target);
    if (!acc) throw new Error(`动态账号 "${target}" 不存在`);

    if (acc.source === 'mount') {
      throw new Error(`只读挂载账号受到保护，不可在网页端删除: ${target}`);
    }

    this.dynamicAccounts.delete(target);
    if (this.accountPool) {
      this.accountPool.accounts.delete(target);
    }
    this.creditsCache.delete(target);
    this.accessTokens.delete(target);
    this.refreshInFlight.delete(target);

    try {
      if (fs.existsSync(acc.stateDir)) {
        fs.rmSync(acc.stateDir, { recursive: true, force: true });
      }
    } catch (_) {}

    this.billingCache.timestamp = 0;
    return true;
  }

  setBillingFetcher(fn) {
    this.billingFetcher = typeof fn === 'function' ? fn : null;
  }

  async getBillingOverview() {
    const now = Date.now();
    if (now - this.billingCache.timestamp < BILLING_CACHE_TTL_MS && Object.keys(this.billingCache.data).length > 0) {
      const cloned = {};
      for (const [k, v] of Object.entries(this.billingCache.data)) {
        cloned[k] = { ...v, cached: true };
      }
      return cloned;
    }

    const allAccounts = [];
    for (const a of this.mountAccounts) if (a.ready) allAccounts.push(a);
    for (const a of this.dynamicAccounts.values()) if (a.ready) allAccounts.push(a);

    const result = {};
    for (const acc of allAccounts) {
      try {
        let billInfo = null;
        if (this.billingFetcher) {
          billInfo = await this.billingFetcher(acc);
        } else {
          billInfo = await this._fetchUpstreamBilling(acc.routerKey);
        }
        result[acc.id] = {
          account_id: acc.id,
          name: acc.name,
          ...billInfo,
          cached: false,
        };
      } catch (err) {
        result[acc.id] = {
          account_id: acc.id,
          name: acc.name,
          error: err.message || '查询上游额度失败',
          cached: false,
        };
      }
    }

    this.billingCache = {
      timestamp: now,
      data: result,
    };

    return result;
  }

  _fetchUpstreamBilling(apiKey) {
    if (!apiKey) return Promise.resolve({ total_usage_usd: 0, hard_limit_usd: 0 });

    return new Promise((resolve) => {
      const usageUrl = new URL(`${this.billingBaseUrl}/v1/dashboard/billing/subscription`);
      // 默认是 https；指向本地 mock 时允许 http。
      const client = usageUrl.protocol === 'https:' ? https : http;
      const req = client.request(
        usageUrl,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: 'application/json',
          },
          timeout: DEFAULT_BILLING_TIMEOUT_MS,
        },
        (res) => {
          let buf = '';
          res.on('data', (d) => (buf += d));
          res.on('end', () => {
            try {
              const data = JSON.parse(buf);
              resolve({
                hard_limit_usd: Number(data.hard_limit_usd || data.total_available || 0),
                total_usage_usd: Number(data.total_usage || 0),
                currency: data.currency || 'USD',
              });
            } catch (_) {
              resolve({ hard_limit_usd: 0, total_usage_usd: 0 });
            }
          });
        }
      );

      req.on('error', () => resolve({ hard_limit_usd: 0, total_usage_usd: 0 }));
      req.on('timeout', () => {
        req.destroy();
        resolve({ hard_limit_usd: 0, total_usage_usd: 0 });
      });
      req.end();
    });
  }
}

module.exports = {
  DeviceLoginManager,
  DynamicAccountManager,
  exchangeRouterKey,
  fetchLiveRouterModels,
};
