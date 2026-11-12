#!/usr/bin/env node
/**
 * AiWork / Agentix -> OpenAI-compatible HTTP bridge + simple web UI.
 *
 * Endpoints:
 *   GET  /                       -> 网页界面（PUBLIC_UI=0 可关闭）
 *   POST /v1/chat/completions    -> OpenAI 兼容对话（SSE 流式 / JSON，含 usage）
 *                                   支持：tools / tool_choice（function calling，网关内协议转换）
 *                                         image_url（data:base64 / http(s) URL / 本地路径）
 *                                         model（按请求指定模型，MODEL_OVERRIDE=0 可关闭）
 *   GET  /v1/models              -> OpenAI 兼容模型列表
 *   POST /v1/responses           -> OpenAI Responses 协议（Codex CLI 用，由 responses-adapter 翻译）
 *   POST /v1/messages            -> Anthropic Messages 协议（Claude Code 用，由 messages-adapter 翻译）
 *   POST /v1/messages/count_tokens -> 上下文 token 估算（Claude Code 靠它决定何时压缩）
 *   GET  /api/models             -> 模型列表 + 真实计费倍率（ratio，来自 Router）
 *   GET  /api/usage              -> 本机 token 统计 + 真实用量/额度（real）
 *   GET  /api/usage/buckets      -> 用量账本的小时窗口总量（管理权限）
 *   GET  /api/keys               -> 各 API Key 的调用次数与 token 消耗
 *   POST /api/balance            -> 设置单价/本地余额/重置统计
 *   POST /api/local-stats/reset  -> 只重置本机统计（控制台用，不碰账单接口）
 *   GET  /api/dashboard          -> 部署级只读仪表盘（账号池/积分/模型，ADR-0009）
 *   GET  /api/logs               -> 最近请求日志（只读，权限同仪表盘）
 *   GET  /healthz                -> 纯文本 ok（给 HEALTHCHECK / 反代探活）
 *   GET  /status                 -> JSON：运行时长、daemon 状态、CLI 登录状态（免鉴权）
 *
 *   以上 /api/* 支持 ?force=1 跳过 60s 缓存，强制刷新真实数据。
 *
 * 真实数据来源（登录后由 CLI 维护，读 $AGENTIX_STATE_DIR/.env 里的 router key）:
 *   GET https://aiwork-api.dtagi.cn/v1/models                      -> data[].ratio / tags
 *   GET https://aiwork-api.dtagi.cn/v1/dashboard/billing/usage     -> total_usage（当月）
 *   GET https://aiwork-api.dtagi.cn/v1/dashboard/billing/subscription -> hard_limit_usd
 *
 * Prerequisites:
 *   1) coder 守护进程常驻:  aiworkcn agent start coder
 *   2) Node.js >= 18
 *
 * Env:
 *   PORT                 listen port (default 8080)
 *   BIND                 bind addr (default 127.0.0.1)；设置页保存后以配置文件为准
 *   API_KEYS             多 Key "sk-abc:名称,sk-def:名称2"（兼容单 Key 的 API_TOKEN）
 *   PUBLIC_UI            1/0 是否提供网页界面（默认 1）
 *   RATE_LIMIT_PER_MIN   每个 Key 每分钟请求上限（0 = 不限）
 *   TRUST_PROXY          1 = 信任 X-Forwarded-For（反代后面要开）
 *   CORS_ORIGIN          允许来源（默认 *）
 *   ALLOW_IPS            IP 白名单，逗号分隔，支持 CIDR（留空=不限制）
 *   LOG_REQUESTS         0 = 关闭访问日志
 *   REQUEST_LOG_ARCHIVE  0 = 关闭请求日志 JSONL 归档（默认按天写 <DATA_DIR>/logs）
 *   REQUEST_LOG_RETENTION_DAYS  归档保留天数初始值（默认 14，页面可改）
 *   REQUEST_LOG_MAX_MB   归档总容量上限初始值（默认 200，页面可改）
 *   DTCODER_BIN          CLI 路径（Linux 默认 aiworkcn）
 *   AGENT                agent id (default coder)
 *   COST_PER_1K          本地估算单价 ¥/1k tokens（默认 0.02，可在前端设置）
 *   INITIAL_BALANCE      本地估算初始余额 ¥（默认 100）
 *   MAX_BODY_MB          请求体上限 MB（默认 12，base64 图片需要）
 *   MAX_IMAGES           单次请求最多几张图（默认 8）
 *   STATE_PATH           usage-state.json 路径（本机累计计数器，可被重置）
 *   USAGE_BUCKETS_PATH   用量账本路径（默认与 STATE_PATH 同目录的 usage-buckets.json，重置不受影响）
 *   USAGE_BUCKETS_DEBOUNCE_MS 账本落盘防抖（默认 30000）
 *   MODEL_OVERRIDE       0 = 忽略请求里的 model，全部用 agent 默认模型
 *   THINKING_LEVEL       off/minimal/low/medium/high/adaptive，透传 CLI --thinking-level
 */
'use strict';

const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const util = require('util');
const crypto = require('crypto');
const dns = require('dns');
const net = require('net');
const { spawn } = require('child_process');
const { createResponsesAdapter } = require('./responses-adapter');
const { createMessagesAdapter } = require('./messages-adapter');
const thinking = require('./thinking');
const { attachResponsesWs } = require('./ws-responses');
const { CredentialsContext, parseCookies, serializeAdminCookie } = require('./credentials');
const { AccountPool } = require('./account-pool');
const { ModelAliasManager } = require('./model-aliases');
const { SessionRouter } = require('./session-router');
const { readBody: readBodyShared, maskSecrets, cleanDebugDumps, getAllowedAccounts } = require('./adapter-common');
const { ResponseHistoryManager } = require('./response-history');
const { UsageRecorder } = require('./usage-ledger');
const { RequestLogArchive } = require('./request-log-archive');

const PORT = Number(process.env.PORT || 8080);
const AGENT = process.env.AGENT || 'coder';
// 请求体与缓冲区上限配置 (Issue #07)
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_MB || 12) * 1024 * 1024;
const MAX_TOOL_ARG_BYTES = Number(process.env.MAX_TOOL_ARG_BYTES || 4 * 1024 * 1024);
const MAX_RESPONSE_BYTES = Number(process.env.MAX_RESPONSE_BYTES || 32 * 1024 * 1024);

// ---------------------------------------------------------------------------
// 鉴权 / 限流 / 日志（生产化配置）
//   API_KEYS        多 Key，格式 "sk-abc:名称,sk-def:名称2"；单独写 "sk-abc" 也行
//                   兼容旧变量 API_TOKEN（单 Key）
//   PUBLIC_UI       是否对外提供网页界面（默认 1；设为 0 只留 API）
//   RATE_LIMIT_PER_MIN  每个 Key 每分钟请求上限（0 = 不限）
//   TRUST_PROXY     置 1 时信任 X-Forwarded-For（Caddy/Nginx 后面要开）
//   CORS_ORIGIN     允许的来源（默认 *；生产建议填具体域名）
//   LOG_REQUESTS    置 0 关闭访问日志
// ---------------------------------------------------------------------------
const RAW_KEYS = process.env.API_KEYS || process.env.API_TOKEN || '';
const PUBLIC_UI = process.env.PUBLIC_UI !== '0';
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN || 0);
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const LOG_REQUESTS = process.env.LOG_REQUESTS !== '0';
const LOG_LEVEL = String(process.env.LOG_LEVEL || (process.env.QUIET === '1' ? 'error' : 'info')).toLowerCase();
const QUIET_MODE = process.env.QUIET === '1' || LOG_LEVEL === 'error' || LOG_LEVEL === 'warn';

// 可选 IP 白名单（没域名、直接开端口时最有用）：
//   ALLOW_IPS=1.2.3.4,5.6.7.0/24,10.0.0.0/8
// 留空 = 不限制。支持精确 IP 和 CIDR。
const ALLOW_IPS = String(process.env.ALLOW_IPS || '')
  .split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);

function ipToInt(ip) {
  const p = String(ip).split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const x of p) {
    const v = Number(x);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}
function ipAllowed(ip) {
  if (!ALLOW_IPS.length) return true;
  const v = String(ip).replace(/^::ffff:/, '');
  const a = ipToInt(v);
  if (a === null) return false;
  return ALLOW_IPS.some((rule) => {
    if (rule.includes('/')) {
      const [net, bitsRaw] = rule.split('/');
      const b = ipToInt(net);
      const bits = Number(bitsRaw);
      if (b === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      return (a & mask) === (b & mask);
    }
    // 支持 "1.2.3." 这种前缀写法
    if (rule.endsWith('.')) return v.startsWith(rule);
    return v === rule;
  });
}

function parseKeys(raw) {
  const map = new Map(); // key -> {name}
  if (!raw) return map;
  for (const part of String(raw).split(/[,\n]/)) {
    const p = part.trim();
    if (!p) continue;
    const i = p.indexOf(':');
    let key = p, name = '';
    if (i > 0) {
      const a = p.slice(0, i).trim(), b = p.slice(i + 1).trim();
      if (/^sk-/.test(a)) { key = a; name = b; }        // sk-xxx:名称
      else if (/^sk-/.test(b)) { key = b; name = a; }   // 名称:sk-xxx
      else { key = a; name = b; }
    }
    if (!name) name = 'key-' + key.replace(/^sk-/, '').slice(-4);
    map.set(key, { name });
  }
  return map;
}
const DATA_DIR = process.env.GATEWAY_DATA_DIR || process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const { RuntimeConfig, parseBindAddress } = require('./runtime-config');
const runtimeConfig = new RuntimeConfig({ dataDir: DATA_DIR });
// 监听地址：配置文件优先，env BIND 只是初始默认值。保存后由 rebindServer 改写这里。
// 地址可以带端口（127.0.0.1:9000），不带端口时沿用 env PORT —— 老配置的语义不变。
const initialBind = parseBindAddress(runtimeConfig.get('bind_address'));
let activeBind = initialBind.ok ? initialBind.value : '127.0.0.1';
let activeHost = initialBind.ok ? initialBind.host : '127.0.0.1';
let activePort = (initialBind.ok ? initialBind.port : null) || PORT;
const credentialsContext = new CredentialsContext({
  dataDir: DATA_DIR,
  adminPassword: process.env.ADMIN_PASSWORD,
  adminSessionTtlSec: Number(process.env.ADMIN_SESSION_TTL_SEC || 86400),
  rawEnvKeys: RAW_KEYS,
});

const KEYS = credentialsContext.keyStore.keys;
const AUTH_ON = credentialsContext.keyStore.keys.size > 0;

// 统一解析调用方身份：查已注册的调用凭据表，撤销凭据立即失效。
// ADR-0002: 彻底移除不验签即可获取调用身份的 JWT 兼容认证路径。
function resolveKey(token) {
  if (!token) return null;
  const hit = credentialsContext.keyStore.getKeyByToken(token);
  if (!hit || hit.revoked) return null;
  return hit;
}

// Windows 的 dtcoder.exe 需要显式 --dist external；Linux 的 aiworkcn 软链已固化 dist，
// 传了反而报 "unexpected argument '--dist'"。允许用 CLI_DIST_ARGS 覆盖。
const DIST_ARGS = (process.env.CLI_DIST_ARGS !== undefined
  ? process.env.CLI_DIST_ARGS
  : (process.platform === 'win32' ? '--dist external' : '')
).split(/\s+/).filter(Boolean);

const DTCODER_BIN =
  process.env.DTCODER_BIN ||
  (process.platform === 'win32'
    ? path.join(os.homedir(), 'AppData', 'Roaming', 'Agentix', 'bin', 'dtcoder.exe')
    : 'aiworkcn');

const STATE_DIR = process.env.AGENTIX_STATE_DIR || path.join(os.homedir(), '.agentix');
const CONFIG_PATH = path.join(STATE_DIR, 'config.json');
const STATE_PATH = process.env.STATE_PATH || path.join(__dirname, 'usage-state.json');
// 用量账本是独立文件（ADR 见 src/usage-ledger.js 头注释）：默认与 STATE_PATH 同目录，
// 这样容器里挂一个卷就能同时保住「可重置的本机统计」和「不可重置的历史账本」。
const USAGE_BUCKETS_PATH = process.env.USAGE_BUCKETS_PATH
  || path.join(path.dirname(STATE_PATH), 'usage-buckets.json');
const INDEX_PATH = path.join(__dirname, 'index.html');

const accountPool = new AccountPool({
  dataDir: DATA_DIR,
  upstreamAccounts: process.env.UPSTREAM_ACCOUNTS,
  defaultStateDir: STATE_DIR,
});

const { DynamicAccountManager, fetchLiveRouterModels } = require('./dynamic-accounts');
const dynamicAccountManager = new DynamicAccountManager({
  dataDir: DATA_DIR,
  accountPool,
});

const modelAliasManager = new ModelAliasManager({
  dataDir: DATA_DIR,
  rawEnvAliases: process.env.MODEL_ALIASES,
});

const sessionRouter = new SessionRouter({
  maxConcurrency: Number(process.env.MAX_CONCURRENCY_PER_ACCOUNT || 10),
  sessionTtlMs: Number(process.env.SESSION_BINDING_TTL_MS || 3600000),
  maxAccountAttempts: process.env.MAX_ACCOUNT_ATTEMPTS,
  // ADR-0013：三项调度参数存在网关配置文件里，按请求读取才能「改完立即生效」
  settings: () => runtimeConfig.getAll(),
});

accountPool.onAccountReloaded = (acc) => {
  sessionRouter.clearCooldown(acc.id);
};

// 上游选择：
//   direct = 直连 aiwork-api（OpenAI 兼容，无 agent 开销，实测 19K -> 34 tokens）
//   agent  = 走 CLI（有技能/代码执行，但每轮固定 16~19K agent 提示）
const UPSTREAM = String(process.env.UPSTREAM || 'direct').toLowerCase() === 'agent' ? 'agent' : 'direct';
// ADR-0001: 直连模式下严禁跨模式自动回落到智能体模式，保持两执行模式严格物理隔离
const UPSTREAM_FALLBACK = false;
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 300000);
// 调试抓包：DEBUG_DUMP=1 时把每个请求的入参与上游原始流写到 DUMP_DIR (Issue #08 / US 51)
// 默认关闭；显式开启时对敏感凭据掩码脱敏，并实施明确的最大文件数、总字节数与过期时间有界清理。
const DEBUG_DUMP = process.env.DEBUG_DUMP === '1' || process.env.DEBUG_DUMP === 'true' || process.env.DEBUG_CAPTURE === '1';
const DUMP_DIR = process.env.DUMP_DIR || path.join(DATA_DIR, 'gw-logs');
const DEBUG_DUMP_MAX_FILES = Number(process.env.DEBUG_DUMP_MAX_FILES || 100);
const DEBUG_DUMP_MAX_BYTES = Number(process.env.DEBUG_DUMP_MAX_BYTES || 10 * 1024 * 1024);
const DEBUG_DUMP_MAX_AGE_SEC = Number(process.env.DEBUG_DUMP_MAX_AGE_SEC || 86400);

// 服务端内存历史续接配置 (Issue #08 / US 48 & US 49 / ADR-0003)
const ENABLE_IN_MEMORY_CONTINUATION = process.env.ENABLE_IN_MEMORY_CONTINUATION === '1'
  || process.env.ENABLE_IN_MEMORY_CONTINUATION === 'true'
  || process.env.SERVER_HISTORY_ENABLED === '1';
const HISTORY_MAX_ENTRIES = Number(process.env.HISTORY_MAX_ENTRIES || 500);
const HISTORY_TTL_SEC = Number(process.env.HISTORY_TTL_SEC || 3600);

const STARTED_AT = Date.now();

function log(...a) {
  if (QUIET_MODE) {
    const raw = util.format(...a).toLowerCase();
    if (!raw.includes('error') && !raw.includes('fatal') && !raw.includes('fail')) {
      return;
    }
  }
  const formatted = util.format(...a);
  const masked = maskSecrets(formatted);
  console.log(`[bridge ${new Date().toISOString()}]`, masked);
}

const responseHistoryManager = new ResponseHistoryManager({
  enabled: ENABLE_IN_MEMORY_CONTINUATION,
  maxEntries: HISTORY_MAX_ENTRIES,
  ttlSec: HISTORY_TTL_SEC,
  log,
});

// DEBUG_DUMP=1 时落盘，敏感凭据脱敏且执行有界容量清理
function dumpWrite(name, data) {
  if (!DEBUG_DUMP) return;
  try {
    fs.mkdirSync(DUMP_DIR, { recursive: true });
    const masked = maskSecrets(data);
    fs.writeFileSync(path.join(DUMP_DIR, name), masked);
    cleanDebugDumps(DUMP_DIR, {
      maxFiles: DEBUG_DUMP_MAX_FILES,
      maxBytes: DEBUG_DUMP_MAX_BYTES,
      maxAgeSec: DEBUG_DUMP_MAX_AGE_SEC,
      log,
    });
  } catch (e) {
    log('dump write failed: %s', e.message);
  }
}



// 结构化访问日志（一行一条 JSON，方便 docker logs / Loki 采集，脱敏输出）
function accessLog(entry) {
  if (!LOG_REQUESTS || QUIET_MODE) return;
  try {
    const masked = maskSecrets(entry);
    console.log('[access] ' + JSON.stringify(masked));
  } catch { /* ignore */ }
}

// --------------------------------------------------------------------------
// 请求日志环形缓冲（页面「日志」TAB 的数据源）
//
// 为什么不复用 accessLog：容器以 QUIET=1 运行，accessLog 会直接 return，
// 页面拿不到任何记录。这里独立缓冲，只收代理调用（/v1/*），
// 页面自身的轮询（/api/dashboard、/healthz、/api/logs）不入内，避免刷屏。
// 只记录元数据，绝不记录 Authorization / 请求体 / 响应体。
// --------------------------------------------------------------------------
const REQ_LOG_CAPACITY = Math.max(1, Number(process.env.REQ_LOG_CAPACITY || 200));
const REQ_LOG = []; // 最新在前

// JSONL 归档：内存缓冲之外再按天落一份，进程重启也能回看。
// 部署级开关 REQUEST_LOG_ARCHIVE=0 时整体关闭；保留天数、容量、来源开关走运行时设置。
const requestLogArchive = new RequestLogArchive({
  dir: path.join(DATA_DIR, 'logs'),
  enabled: process.env.REQUEST_LOG_ARCHIVE !== '0',
  settings: () => ({
    retention_days: runtimeConfig.get('request_log_retention_days'),
    max_mb: runtimeConfig.get('request_log_max_mb'),
    capture_source: runtimeConfig.get('request_log_capture_source'),
  }),
  log,
});

function isLoggedPath(pathname) {
  return pathname === '/v1' || pathname.startsWith('/v1/');
}

function recordRequest(entry) {
  try {
    REQ_LOG.unshift(entry);
    if (REQ_LOG.length > REQ_LOG_CAPACITY) REQ_LOG.length = REQ_LOG_CAPACITY;
  } catch { /* 记录失败不能影响请求本身 */ }
}

// 账号短标识：日志只留 6 位指纹，既能区分同名账号，又不把内部 id 写进日志。
function shortAccountRef(id) {
  if (!id) return null;
  return crypto.createHash('sha1').update(String(id)).digest('hex').slice(0, 6);
}

// 凭据标识（进日志与归档）：命名凭据用名字；未命名凭据的默认名是「key-<密钥末四位>」，
// 那等于把密钥片段写进磁盘，所以改成 id 的短哈希（与账号短标识同一做法）。
function keyRefOf(key) {
  if (!key) return null;
  const name = key.name ? String(key.name) : '';
  const token = key.token ? String(key.token) : '';
  const defaultName = token ? 'key-' + token.slice(-4) : '';
  if (!name || name === defaultName) return shortAccountRef(key.id);
  return name;
}

function requestKeyRef(req) {
  if (req.__keyObj && req.__keyObj.id) return keyRefOf(req.__keyObj);
  if (req.__keyId) return shortAccountRef(req.__keyId);
  return null;
}

function describeAccount(account) {
  if (!account) return null;
  return { name: account.name || account.id, short: shortAccountRef(account.id) };
}

// 请求级日志细节：由处理路径边跑边填，收尾时统一落盘。
// 全部是元数据，绝不写 Authorization / 请求体 / 响应正文。
function logMeta(req) {
  if (!req.__logMeta) {
    req.__logMeta = {
      account: null,
      model: null,
      attempts: 0,
      prompt_tokens: null,
      completion_tokens: null,
      total_tokens: null,
      error: '',
      streamInterrupted: false,
    };
  }
  return req.__logMeta;
}

function setLogUsage(req, usage) {
  if (!usage) return;
  const m = logMeta(req);
  const input = usage.prompt_tokens != null ? usage.prompt_tokens
    : (usage.input_tokens != null ? usage.input_tokens : null);
  const output = usage.completion_tokens != null ? usage.completion_tokens
    : (usage.output_tokens != null ? usage.output_tokens : null);
  m.prompt_tokens = input;
  m.completion_tokens = output;
  m.total_tokens = usage.total_tokens != null ? usage.total_tokens
    : (input != null && output != null ? input + output : null);
}

// 错误摘要只留一层皮：压掉换行、截到 200 字，避免把上游整段响应塞进日志。
function setLogError(req, message) {
  if (message == null) return;
  const text = String(message).replace(/\s+/g, ' ').trim().slice(0, 200);
  if (text) logMeta(req).error = text;
}

// /api/logs 支持的结果分类（与 emitRequestLog 的判定保持一致）。
// client_error = 请求在网关侧就被拒（没有选中任何账号）：未带凭据、凭据无效、
// 限流、参数不合法等。它和 upstream_error 的区别是「谁的错」，排障时不能混。
const LOG_OUTCOMES = ['success', 'upstream_error', 'stream_error', 'client_error', 'client_abort'];

// 时间参数：unix 秒（整数或小数）或 ISO 8601，都按毫秒时间戳比较。
// wholeSecond 用于 from/to 的语义区分：以 unix 秒给出的 to 包含该整秒。
function parseLogTime(raw) {
  const s = String(raw).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return { ms: Math.round(Number(s) * 1000), wholeSecond: !s.includes('.') };
  return { ms: Date.parse(s), wholeSecond: false };
}

// 解析筛选参数。返回 { filters } 或 { error }（error 用于 400 的可读说明）。
// 约定：account / model / q 为包含匹配且大小写不敏感；q 匹配路径、模型与错误摘要；
// outcome / status 为精确匹配；from / to 为闭区间（unix 秒或 ISO 8601）。
function parseLogFilters(query) {
  const val = (key) => {
    const v = query.get(key);
    return v == null ? '' : String(v).trim();
  };
  const filters = { account: '', model: '', outcome: '', status: null, q: '', from: null, to: null };
  filters.account = val('account');
  filters.model = val('model');
  filters.q = val('q');

  const rawOutcome = val('outcome');
  if (rawOutcome) {
    const outcome = rawOutcome.toLowerCase();
    if (!LOG_OUTCOMES.includes(outcome)) {
      return { error: `未知的 outcome: "${rawOutcome}"，可选值：${LOG_OUTCOMES.join(' / ')}` };
    }
    filters.outcome = outcome;
  }

  const rawStatus = val('status');
  if (rawStatus) {
    if (!/^\d{3}$/.test(rawStatus) || Number(rawStatus) < 100 || Number(rawStatus) > 599) {
      return { error: `status 必须是 100-599 之间的整数状态码，收到 "${rawStatus}"` };
    }
    filters.status = Number(rawStatus);
  }

  const rawFrom = val('from');
  if (rawFrom) {
    const parsed = parseLogTime(rawFrom);
    if (!Number.isFinite(parsed.ms)) {
      return { error: `from 不是合法时间，支持 unix 秒或 ISO 8601，收到 "${rawFrom}"` };
    }
    filters.from = parsed.ms;
  }

  const rawTo = val('to');
  if (rawTo) {
    const parsed = parseLogTime(rawTo);
    if (!Number.isFinite(parsed.ms)) {
      return { error: `to 不是合法时间，支持 unix 秒或 ISO 8601，收到 "${rawTo}"` };
    }
    // 以 unix 秒给出的 to 覆盖整秒，避免「结束时间 12:00:00」漏掉同一秒内的记录。
    filters.to = parsed.wholeSecond ? parsed.ms + 999 : parsed.ms;
  }

  if (filters.from != null && filters.to != null && filters.from > filters.to) {
    return { error: 'from 不能晚于 to' };
  }
  return { filters };
}

// 单条记录是否命中筛选条件。命中总数与展示条目共用这一套谓词，避免两处各算一遍。
// 模块内部使用，另有单测直接引用（tests/test-log-filter-predicate.js）守住入参守卫。
function matchLogFilters(entry, f = {}) {
  // 默认参数只兜 undefined：调用方显式传 null 时这里会拿到 null，
  // 后面的 f.account 会直接 TypeError，把一次日志查询打成 500。
  f = f || {};
  if (f.account) {
    const acc = entry.account || {};
    const hay = `${acc.name || ''} ${acc.short || ''}`.toLowerCase();
    if (!hay.includes(f.account.toLowerCase())) return false;
  }
  if (f.model && !String(entry.model || '').toLowerCase().includes(f.model.toLowerCase())) return false;
  if (f.outcome && String(entry.outcome || '') !== f.outcome) return false;
  if (f.status != null && Number(entry.status) !== f.status) return false;
  if (f.q) {
    const needle = f.q.toLowerCase();
    const hay = [entry.path, entry.model, entry.error]
      .map((v) => String(v == null ? '' : v)).join(' ').toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  if (f.from != null || f.to != null) {
    const ms = Date.parse(entry.t);
    if (!Number.isFinite(ms)) return false;
    if (f.from != null && ms < f.from) return false;
    if (f.to != null && ms > f.to) return false;
  }
  return true;
}

// 返回命中筛选的记录（新到旧）。是否按 limit 截断由调用方决定，
// 这样「命中总数」与「展示条目」不会算出两套结果。
function readRequestLog(filters) {
  return REQ_LOG.filter((entry) => matchLogFilters(entry, filters));
}

// 简单滑动窗口限流：每个 Key 每分钟计数
const RL = new Map(); // name -> {windowStart, count}
function rateLimitCheck(keyName) {
  if (!RATE_LIMIT_PER_MIN || !keyName) return true;
  const now = Date.now();
  const w = Math.floor(now / 60000);
  const rec = RL.get(keyName);
  if (!rec || rec.windowStart !== w) { RL.set(keyName, { windowStart: w, count: 1 }); return true; }
  rec.count += 1;
  return rec.count <= RATE_LIMIT_PER_MIN;
}


// --------------------------------------------------------------------------
// 模型配置（名称 / 成本倍率 / 成本标签）—— 从账号池与 config.json 读取
// --------------------------------------------------------------------------
function loadModelInfo() {
  accountPool.reloadIfChanged();
  const out = new Map();
  const poolModels = accountPool.getAllAvailableModels();
  for (const m of poolModels) {
    out.set(m.id, {
      id: m.id,
      name: m.name || m.id,
      context_window: m.context_window || null,
      max_tokens: m.max_tokens || null,
      reasoning: !!m.reasoning,
      input: m.input || ['text'],
      multiplier: m.multiplier != null ? m.multiplier : 1,
      costTag: m.costTag || '',
      ratio: m.ratio || '',
    });
  }
  if (out.size === 0) {
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
        const defs = cfg?.models?.['aiwork-router']?.models || [];
        for (const d of defs) {
          out.set(d.id, {
            id: d.id, name: d.name || d.id,
            context_window: d.context_window || null, max_tokens: d.max_tokens || null,
            reasoning: !!d.reasoning, input: d.input || ['text'],
            multiplier: 1, costTag: '', ratio: '',
          });
        }
      }
    } catch (_) {}
  }
  return out;
}
let MODEL_INFO = loadModelInfo();

// 支持按账号池状态与 config.json 变更进行零停机热重载
let CONFIG_MTIME = 0;
// 有副作用：账号池或 config.json 变更时零停机重载 MODEL_INFO，并返回是否发生过重载。
// 名字带 refresh 是为了让调用点看出这里不只是查询，还会改写模块级 MODEL_INFO。
function refreshModelsIfConfigChanged() {
  const reloaded = accountPool.reloadIfChanged();
  const poolChanged = reloaded.length > 0;
  let stChanged = false;
  try {
    const st = fs.statSync(CONFIG_PATH);
    if (st.mtimeMs !== CONFIG_MTIME) {
      CONFIG_MTIME = st.mtimeMs;
      stChanged = true;
    }
  } catch (_) {}

  if (!poolChanged && !stChanged && MODEL_INFO && MODEL_INFO.size > 0) return false;
  const fresh = loadModelInfo();
  for (const [id, old] of MODEL_INFO) {
    const f = fresh.get(id);
    if (f && old.ratioReal) {
      f.multiplier = old.multiplier;
      f.ratio = old.ratio;
      f.ratioReal = true;
      if (old.costTag) f.costTag = old.costTag;
    }
  }
  const before = MODEL_INFO.size;
  MODEL_INFO = fresh;
  if (poolChanged || stChanged) log('model config reloaded: %d -> %d models', before, MODEL_INFO.size);
  return true;
}

// --------------------------------------------------------------------------
// 真实数据：从 AiWork Router 的 OpenAI 兼容账单/模型接口读取真实倍率与用量
//   - 真实倍率: GET https://aiwork-api.dtagi.cn/v1/models        (data[].ratio)
//   - 真实用量: GET .../v1/dashboard/billing/usage               (total_usage)
//   - 额度:     GET .../v1/dashboard/billing/subscription        (hard_limit_usd)
// 鉴权用 ~/.agentix/.env 里的 router API key（由 CLI 登录后维护）。
// --------------------------------------------------------------------------
const ROUTER_BASE = (process.env.ROUTER_BASE_URL || 'https://aiwork-api.dtagi.cn').replace(/\/+$/, '');
function readRouterKey() {
  accountPool.reloadIfChanged();
  const ready = accountPool.getReadyAccounts();
  if (ready.length > 0 && ready[0].routerKey) return ready[0].routerKey;
  // 次选：账号池里任何仍持有凭据的账号。账号可能因一次上游 401 被标记 needs_reauth，
  // 但它的 key 对 /v1/models、账单接口仍可能有效，不应直接报「未找到 router key」。
  for (const acc of accountPool.listAccounts()) {
    if (acc.routerKey) return acc.routerKey;
  }
  const KEY_RE = /^\s*AGENTIX_CONFIG_MODELS_AIWORK_ROUTER_API_KEY\s*=\s*(.*)$/m;
  const readEnvKey = (file) => {
    try {
      const m = fs.readFileSync(file, 'utf-8').match(KEY_RE);
      const v = m && m[1].trim().replace(/^["']|["']$/g, '');
      return v || '';
    } catch (_) { return ''; }
  };
  // 动态账号目录（网页设备登录 / 手动导入的落盘位置）
  try {
    const dynDir = path.join(DATA_DIR, 'accounts');
    for (const name of fs.readdirSync(dynDir)) {
      const v = readEnvKey(path.join(dynDir, name, '.env'));
      if (v) return v;
    }
  } catch (_) { /* ignore */ }
  const legacy = readEnvKey(path.join(STATE_DIR, '.env'));
  if (legacy) return legacy;
  return process.env.AGENTIX_CONFIG_MODELS_AIWORK_ROUTER_API_KEY || '';
}

function routerKeySearchHint() {
  return `${STATE_DIR}/.env 与 ${path.join(DATA_DIR, 'accounts', '*', '.env')}`;
}

let REAL = { ok: false, usage: null, limit: null, unlimited: true, period: null, fetchedAt: 0, error: null };

// Router 返回的成本标签是英文，转成中文便于展示
const TAG_ZH = {
  free: '免费', 'free tier': '免费', 'free-tier': '免费', trial: '免费试用',
  'low cost': '低成本', lowcost: '低成本', 'low-cost': '低成本', cheap: '低成本',
  'medium cost': '中成本', 'medium-cost': '中成本', 'mid cost': '中成本',
  'mid-cost': '中成本', midcost: '中成本', moderate: '中成本', standard: '中成本',
  'high cost': '高成本', highcost: '高成本', 'high-cost': '高成本', premium: '高成本',
  preview: '尝鲜',
  'time-limited discount': '限时折扣', 'limited-time discount': '限时折扣',
  'time limited discount': '限时折扣', discount: '折扣', promo: '促销',
};
function zhTag(t) {
  const raw = String(t || '').trim();
  if (!raw) return '';
  return TAG_ZH[raw.toLowerCase()] || raw;
}
function tagByMult(mult) {
  if (mult <= 0) return '免费';
  if (mult <= 0.3) return '低成本';
  if (mult <= 1) return '中成本';
  return '高成本';
}

// 上游刷新共用骨架：TTL 缓存 + 在途去重。
// 两处各写一份时，「什么时候算新鲜」「在途 Promise 何时清空」很容易改出偏差
// （历史上就出现过 Promise 永久滞留，导致登录后仍只拿到启动时旧错误），所以只保留这一份。
const REFRESH_TTL_MS = 60000;

function createRefresher({ isFresh, load, current }) {
  let inFlight = null;
  // 缓存命中/失败回落时返回 current()，保证同一个刷新器的返回值类型不随「命中还是发起」而变。
  const snapshot = () => (typeof current === 'function' ? current() : undefined);
  return async function refresh(force) {
    refreshModelsIfConfigChanged();
    // 在途请求优先：force 只是绕过缓存，不叠加并发。
    // 但必须经过同一个 catch——直接把裸 Promise 交出去，同一次上游故障会变成
    // 先到的请求拿到兜底值、后到的请求抛出 500。
    if (inFlight) return inFlight.catch(() => snapshot());
    if (!force && isFresh()) return snapshot();
    const task = Promise.resolve().then(load);
    inFlight = task;
    try {
      return await task;
    } catch (e) {
      // load 自己会兜住上游错误；这里兜的是「兜底代码也抛了」的情形，
      // 绝不能让它变成 unhandled rejection（Node 15+ 默认直接结束进程）。
      log('refresh failed: %s', e.message);
      return snapshot();
    } finally {
      if (inFlight === task) inFlight = null;
    }
  };
}

// 模型目录（真实倍率 + 成本标签）与账单是两件事：ADR-0011 之后仪表盘只需要目录，
// 不应该为了列模型而顺手请求账单。这里把「只拉 /v1/models」单独抽出来。
let MODEL_CATALOG_AT = 0;
// 失败也要记一次「短时间内别再试」：否则凭据无效时 isFresh() 恒为 false，
// 页面 15 秒一刷就变成每 15 秒打一次上游（还带 12 秒超时），仪表盘被拖慢。
let MODEL_CATALOG_RETRY_BEFORE = 0;
const MODEL_CATALOG_FAILURE_TTL_MS = 30000;

/** 拉一次 /v1/models 并写回 MODEL_INFO；返回错误描述，成功返回 null。 */
async function fetchModelCatalog(H) {
  const mres = await fetch(`${ROUTER_BASE}/v1/models`, { headers: H, signal: AbortSignal.timeout(12000) });
  if (!mres.ok) {
    // 不能静默当成功：凭据无效时 /v1/models 返回 401，旧实现仍报 real.ok=true，
    // 页面于是把本地 config.json 的占位倍率当成真实倍率展示。
    return `Router /v1/models 返回 HTTP ${mres.status}（router key 可能无效）`;
  }
  const mj = await mres.json();
  for (const d of (mj.data || [])) {
    const id = d.id; if (!id) continue;
    const b = MODEL_INFO.get(id) || { id, name: d.name || id, input: ['text'] };
    if (d.ratio != null && String(d.ratio) !== '') {
      const x = parseFloat(String(d.ratio).replace(/x/i, ''));
      if (isFinite(x)) b.multiplier = x;
      b.ratio = String(d.ratio);
    }
    const rawTags = String(d.tags || '');
    if (/free/i.test(rawTags) && (d.ratio == null || String(d.ratio) === '')) {
      b.multiplier = 0;          // 标了 Free 但没有 ratio 的，按 0 倍率处理
      b.ratio = '0x';
    }
    const t = zhTag(d.tags);
    if (t) b.costTag = t;
    else if (b.ratio) b.costTag = tagByMult(b.multiplier); // 无标签但有倍率时才推导
    b.ratioReal = true;
    MODEL_INFO.set(id, b);
  }
  MODEL_CATALOG_AT = Date.now();
  return null;
}

/** 仪表盘用：只保证模型目录新鲜，绝不发账单请求。 */
const refreshModelCatalog = createRefresher({
  isFresh: () => (!!MODEL_CATALOG_AT && Date.now() - MODEL_CATALOG_AT < REFRESH_TTL_MS)
    || Date.now() < MODEL_CATALOG_RETRY_BEFORE,
  load: async () => {
    const key = readRouterKey();
    if (!key) {
      MODEL_CATALOG_RETRY_BEFORE = Date.now() + MODEL_CATALOG_FAILURE_TTL_MS;
      return;
    }
    try {
      const err = await fetchModelCatalog({ Authorization: 'Bearer ' + key });
      if (err) {
        MODEL_CATALOG_RETRY_BEFORE = Date.now() + MODEL_CATALOG_FAILURE_TTL_MS;
        log('model catalog fetch failed: %s', err);
      }
    } catch (e) {
      MODEL_CATALOG_RETRY_BEFORE = Date.now() + MODEL_CATALOG_FAILURE_TTL_MS;
      log('model catalog fetch failed: %s', e.message);
    }
  },
});

const refreshReal = createRefresher({
  isFresh: () => REAL.ok && Date.now() - REAL.fetchedAt < REFRESH_TTL_MS,
  current: () => REAL,
  load: async () => {
    try {
      const key = readRouterKey();
      if (!key) {
        REAL = { ...REAL, ok: false, error: `未找到 router key（已检查 ${routerKeySearchHint()}）`, fetchedAt: Date.now() };
        return REAL;
      }
      const H = { Authorization: 'Bearer ' + key };
      const today = new Date().toISOString().slice(0, 10);
      const first = today.slice(0, 8) + '01';
      // 1) 真实倍率（ratio 为权威值）+ 成本标签
      const modelsError = await fetchModelCatalog(H);
      if (modelsError) log('real models fetch failed: %s', modelsError);
      // 2) 真实用量（本月）+ 3) 额度
      const [ures, sres] = await Promise.all([
        fetch(`${ROUTER_BASE}/v1/dashboard/billing/usage?start_date=${first}&end_date=${today}`,
          { headers: H, signal: AbortSignal.timeout(12000) }),
        fetch(`${ROUTER_BASE}/v1/dashboard/billing/subscription`,
          { headers: H, signal: AbortSignal.timeout(12000) }),
      ]);
      const uj = ures.ok ? await ures.json() : {};
      const sj = sres.ok ? await sres.json() : {};
      const limit = (typeof sj.hard_limit_usd === 'number') ? sj.hard_limit_usd : null;
      REAL = {
        ok: !modelsError,
        usage: (typeof uj.total_usage === 'number') ? uj.total_usage : null,
        limit,
        unlimited: (limit == null || limit >= 1e6),
        period: today.slice(0, 7),
        range: { from: first, to: today },
        fetchedAt: Date.now(),
        error: modelsError,
      };
      log('real data refreshed: usage=%s limit=%s unlimited=%s models=%d',
        REAL.usage, REAL.limit, REAL.unlimited, MODEL_INFO.size);
    } catch (e) {
      REAL = { ...REAL, ok: false, error: e.message, fetchedAt: Date.now() };
      log('real data refresh failed: %s', e.message);
    }
    return REAL;
  },
});

// --------------------------------------------------------------------------
// 用量 / 余额状态（内存 + 落盘 usage-state.json）
// --------------------------------------------------------------------------
const DEFAULTS = {
  costPer1k: Number(process.env.COST_PER_1K || 0.02), // ¥ per 1k tokens（估算）
  balance: Number(process.env.INITIAL_BALANCE || 100), // ¥
};
let STATE = {
  costPer1k: DEFAULTS.costPer1k,
  balance: DEFAULTS.balance,
  spent: 0,                 // 累计预估消耗 ¥
  tokens: { input: 0, output: 0, total: 0, cached: 0 },
  requests: 0,
  byModel: {},              // model_id -> {tokens, spent}
  byKey: {},                // key_id 或 key 名称 -> {tokens, requests}
  byAccount: {},            // account_id -> {tokens, requests, spent}
  sessions: {},             // scopedId -> {requests, tokens, label, ...}
  fallbackModel: '',        // 前端设置的回落模型（空 = 用 env / 自动挑）
};
try {
  if (fs.existsSync(STATE_PATH)) {
    STATE = Object.assign(STATE, JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8')));
    if (!STATE.byAccount) STATE.byAccount = {};
    if (!STATE.byKey) STATE.byKey = {};
    if (!STATE.byModel) STATE.byModel = {};
    if (!STATE.tokens) STATE.tokens = { input: 0, output: 0, total: 0, cached: 0 };
    if (!STATE.sessions) STATE.sessions = {};
  }
} catch (e) { /* ignore */ }

// --------------------------------------------------------------------------
// 用量账本（Issue #06）
//   与上面的 STATE 完全独立：STATE 是「可被重置的本机计数器」，账本是「分桶历史」。
//   两者写不同文件，resetLocalStats 只清前者（清空本机统计不得清掉账本）。
// --------------------------------------------------------------------------
const USAGE_BUCKETS_DEBOUNCE_MS = (() => {
  const n = Number(process.env.USAGE_BUCKETS_DEBOUNCE_MS);
  return (Number.isFinite(n) && n >= 0) ? n : 30000;
})();
const usageRecorder = new UsageRecorder({
  filePath: USAGE_BUCKETS_PATH,
  debounceMs: USAGE_BUCKETS_DEBOUNCE_MS,
  log: (msg) => log(msg),
});

/** 该模型当前的倍率；查不到一律记 1（与 recordUsage 里对 STATE.spent 的口径一致，0 也按 1 记） */
function modelMultiplier(modelId) {
  const id = String(modelId || '');
  const raw = (MODEL_INFO.get(id.split('/').pop()) || {}).multiplier
    || (MODEL_INFO.get(id) || {}).multiplier;
  const mult = Number(raw);
  return (raw != null && raw !== '' && Number.isFinite(mult)) ? mult : 1;
}

let persistTimer = null;

function doAtomicPersist() {
  try {
    const dir = path.dirname(STATE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${STATE_PATH}.tmp.${process.pid}.${Date.now()}`;
    // 默认持久化边界保护 (Issue #08 / US 50): 仅保存必要用量统计与配置，绝不持久化任何问答正文、首句摘要或敏感片段
    const sanitizedSessions = {};
    if (STATE.sessions) {
      for (const [sid, sess] of Object.entries(STATE.sessions)) {
        if (!sess) continue;
        sanitizedSessions[sid] = {
          scopedId: sess.scopedId,
          explicit: !!sess.explicit,
          model: sess.model || '',
          keyId: sess.keyId || null,
          accountId: sess.accountId || null,
          requests: sess.requests || 0,
          tokens: sess.tokens || 0,
          input: sess.input || 0,
          output: sess.output || 0,
          firstAt: sess.firstAt,
          lastAt: sess.lastAt,
        };
      }
    }
    const stateToSave = {
      costPer1k: STATE.costPer1k,
      balance: STATE.balance,
      spent: STATE.spent,
      tokens: STATE.tokens,
      requests: STATE.requests,
      byModel: STATE.byModel,
      byKey: STATE.byKey,
      byAccount: STATE.byAccount,
      sessions: sanitizedSessions,
      fallbackModel: STATE.fallbackModel,
    };
    fs.writeFileSync(tmp, JSON.stringify(stateToSave, null, 2), 'utf-8');
    fs.renameSync(tmp, STATE_PATH);
  } catch (e) {
    log('persist state failed: %s', e.message);
  }
}

function persistState(immediate = false) {
  if (immediate) {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    doAtomicPersist();
    return;
  }
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    doAtomicPersist();
  }, 100);
  if (persistTimer.unref) persistTimer.unref();
}

// ---------------------------------------------------------------------------
// 回落模型
//   有些客户端会带自己的模型名：Codex 恢复历史会话时发的是会话记录的 gpt-6.1-sol，
//   Claude Code 固定发 claude-*。按 ADR-0003 的显式匹配规则，这类名字不在模型表里就返回
//   404，不静默回落；客户端应改用真实模型 ID，或在 model_aliases 里配别名。
//   这里的回落值只供 /api/fallback 与仪表盘展示，不参与请求解析。
//   优先级：前端设置 > 环境变量 > deepseek-flash > 模型表第一个
// ---------------------------------------------------------------------------
function resolveFallbackModel() {
  const picked = String(STATE.fallbackModel || '').trim();
  if (picked) return picked;
  const env = (process.env.FALLBACK_MODEL || process.env.ANTHROPIC_FALLBACK_MODEL || '').trim();
  if (env) return env;
  refreshModelsIfConfigChanged();
  if (MODEL_INFO.has('deepseek-flash')) return 'deepseek-flash';
  const first = [...MODEL_INFO.keys()][0];
  return first || 'deepseek-flash';
}

// 告诉前端这个值是哪来的，避免"我改了但看起来没生效"的困惑
function fallbackSource() {
  if (String(STATE.fallbackModel || '').trim()) return 'ui';
  if ((process.env.FALLBACK_MODEL || '').trim()) return 'env:FALLBACK_MODEL';
  if ((process.env.ANTHROPIC_FALLBACK_MODEL || '').trim()) return 'env:ANTHROPIC_FALLBACK_MODEL';
  return 'auto';
}

// ---------------------------------------------------------------------------
// 会话识别
// ---------------------------------------------------------------------------
// 多轮对话里每次请求都是独立的，网关本身没有会话概念。要归并同一段对话，
// 按可靠性从高到低找信号：
//   1) 客户端显式给的 x-session-id / x-conversation-id / x-chat-id 头
//   2) 请求体里的 session_id / conversation_id / chat_id 字段
//   3) 指纹：system 内容（前 4096 字）+ 第一条 user 消息 做 sha1
// 第 3 条之所以可行：同一会话的多轮请求，messages 是"前缀增长"的
//   [sys,u1] -> [sys,u1,a1,u2] -> [sys,u1,a1,u2,a2,u3]
// 第一条 user 消息始终不变，所以指纹稳定；换个话题新开会话就会变。
// 已知误判：两个人同时问一模一样的首句会被并成一个会话（概率低，可接受）。
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS || 50);

function sessionFingerprint(req, parsed) {
  const b = parsed || {};
  const msgs = Array.isArray(b.messages) ? b.messages : [];
  const firstUser = msgs.find((m) => m && m.role === 'user');
  const userText = contentToText(firstUser && firstUser.content) || '';
  // 隐私保护 (Issue #08 / US 50): 默认不保存、不记录会话首句摘要或聊天正文
  const label = '';

  const hdr = req.headers['x-session-id'] || req.headers['x-conversation-id'] || req.headers['x-chat-id'];
  if (hdr) return { id: String(hdr).slice(0, 80), explicit: true, label };

  for (const f of ['session_id', 'conversation_id', 'chat_id']) {
    if (typeof b[f] === 'string' && b[f].trim()) {
      return { id: b[f].trim().slice(0, 80), explicit: true, label };
    }
  }

  const sys = msgs.find((m) => m && m.role === 'system');
  const seed = (contentToText(sys && sys.content) || '').slice(0, 4096) + '\u0001' + userText;
  if (!seed.replace('\u0001', '').trim()) return { id: null, explicit: false, label };
  return { id: 'fp-' + crypto.createHash('sha1').update(seed).digest('hex').slice(0, 12), explicit: false, label };
}

function updateSession(sess, modelId, usage, keyName, keyId = null, accountId = null) {
  if (!sess || !sess.id) return;
  const S = STATE.sessions || (STATE.sessions = {});
  const it = usage.prompt_tokens || usage.input_tokens || 0;
  const ot = usage.completion_tokens || usage.output_tokens || 0;
  const tt = usage.total_tokens || (it + ot);
  const scopedId = sessionRouter.makeScopedSessionId(keyId, sess.id) || sess.id;
  const cur = S[scopedId] || (S[scopedId] = {
    id: sess.id,
    scopedId: scopedId,
    explicit: !!sess.explicit,
    label: sess.label || '',
    key: keyName || null,
    keyId: keyId || null,
    accountId: accountId || null,
    model: '',
    requests: 0,
    tokens: 0,
    input: 0,
    output: 0,
    firstAt: Date.now(),
    lastAt: Date.now(),
  });
  cur.requests += 1;
  cur.input += it;
  cur.output += ot;
  cur.tokens += tt;
  cur.model = String(modelId || '').split('/').pop() || cur.model;
  cur.lastAt = Date.now();
  if (accountId) cur.accountId = accountId;
  cur.label = '';

  const ids = Object.keys(S);
  if (ids.length > MAX_SESSIONS) {
    ids.sort((a, b) => (S[a].lastAt || 0) - (S[b].lastAt || 0))
      .slice(0, ids.length - MAX_SESSIONS)
      .forEach((k) => { delete S[k]; });
  }
}

/**
 * 记一次调用的用量。
 *
 * 两条口径（ADR-0017 §8）：
 *   - 账本记**尝试**：有 usage 记真实 token，没有就记 0；ok=false 表示这次尝试失败了。
 *   - 仪表盘的 STATE 计数器记**成功**：只有真的拿到 usage 才 +1，所以没有 usage 时提前返回。
 *
 * ok=false 用于「这次尝试最终失败了、但上游可能报了部分 usage」的路径：
 * 部分用量照实记进账本，但必须标成失败，否则一次被掐断的调用会在账本里算作成功。
 *
 * @param {string} sessionId 会话标识
 * @param {string} modelId 本次实际调用的模型
 * @param {object|null} usage 上游返回的 usage；没有时只记一次尝试
 * @param {object} [options] { keyName, sess, keyId, accountId, latencyMs, ok }
 */
function recordUsage(sessionId, modelId, usage, options = {}) {
  const {
    keyName = null,
    sess = null,
    keyId = null,
    accountId = null,
    latencyMs = null,
    ok = true,
  } = options;
  // 账本记的是「每次尝试」：即便上游没给 usage 也要算一次请求，token 记 0，不凭空造数。
  if (!usage) {
    usageRecorder.add(Date.now(), {
      accountId,
      model: modelId,
      rate: modelMultiplier(modelId),
      key: keyId || keyName,
      ok,
    });
    return;
  }
  const it = usage.prompt_tokens || usage.input_tokens || 0;
  const ot = usage.completion_tokens || usage.output_tokens || 0;
  const tt = usage.total_tokens || (it + ot);
  // 前缀缓存命中量：不同后端字段名不一样，两个都认
  const cached = (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens)
    || usage.prompt_cache_hit_tokens || 0;
  STATE.tokens.input += it; STATE.tokens.output += ot; STATE.tokens.total += tt;
  STATE.tokens.cached = (STATE.tokens.cached || 0) + cached;
  STATE.requests += 1;

  const mult = modelMultiplier(modelId);
  const cost = (tt / 1000) * STATE.costPer1k * mult;
  STATE.spent += cost;

  // 账本：同一份倍率与估算消耗，按小时 × 账号 × 模型 × 倍率 × 凭据分桶。
  // 缓存命中/未命中分开记：命中量已知时「未命中 = 输入 - 命中」，负值按 0 处理。
  usageRecorder.add(Date.now(), {
    accountId,
    model: modelId,
    rate: mult,
    key: keyId || keyName,
    ok,
    promptTokens: it,
    completionTokens: ot,
    totalTokens: tt,
    latencyMs,
    tokensPerSecond: (typeof latencyMs === 'number' && latencyMs > 0 && ot > 0)
      ? (ot / (latencyMs / 1000))
      : null,
    credits: cost,
    cacheHit: cached,
    cacheMiss: Math.max(0, it - cached),
  });

  if (keyId) {
    const keyObj = credentialsContext.keyStore.getKeyById(keyId);
    if (keyObj && keyObj.stats) {
      keyObj.stats.requests = (keyObj.stats.requests || 0) + 1;
      keyObj.stats.tokens = (keyObj.stats.tokens || 0) + tt;
      keyObj.stats.cached = (keyObj.stats.cached || 0) + cached;
      keyObj.stats.spent = (keyObj.stats.spent || 0) + cost;
      // 输入/输出分开记：个人视图的「合计」取自这里，如果两侧来源不同（合计来自计数器、
      // 输入输出来自会话聚合），清账后就会出现「合计 0、输入 600」。
      keyObj.stats.input = (keyObj.stats.input || 0) + it;
      keyObj.stats.output = (keyObj.stats.output || 0) + ot;
      keyObj.stats.last_used_at = new Date().toISOString();
    }
  }

  const kLabel = keyId || keyName;
  if (kLabel) {
    const k = (STATE.byKey[kLabel] = STATE.byKey[kLabel] || { tokens: 0, requests: 0, cached: 0, spent: 0, keyId, keyName });
    k.tokens += tt; k.requests += 1; k.cached = (k.cached || 0) + cached; k.spent = (k.spent || 0) + cost;
  }
  if (keyName && keyName !== kLabel) {
    const k = (STATE.byKey[keyName] = STATE.byKey[keyName] || { tokens: 0, requests: 0, cached: 0, spent: 0, keyId, keyName });
    k.tokens += tt; k.requests += 1; k.cached = (k.cached || 0) + cached; k.spent = (k.spent || 0) + cost;
  }

  if (accountId) {
    STATE.byAccount = STATE.byAccount || {};
    const acc = (STATE.byAccount[accountId] = STATE.byAccount[accountId] || {
      tokens: 0, requests: 0, cached: 0, spent: 0, success: 0, errors: 0,
      lastSuccessAt: null, lastLatencyMs: null, lastTokPerSec: null,
    });
    acc.tokens += tt; acc.requests += 1; acc.cached = (acc.cached || 0) + cached; acc.spent += cost;
    // 成功按「尝试」累计（ADR-0016）：换号前的失败记在旧账号，成功记在新账号。
    acc.success = (acc.success || 0) + 1;
    acc.lastSuccessAt = Date.now();
    // 延迟与吞吐取「最近一次」而不是平均：一个昨天很快、今天慢下来的号，
    // 平均值会一直好看，运维看不出它现在有问题（对齐 workbuddy2api 的 Last* 口径）。
    if (typeof latencyMs === 'number' && latencyMs >= 0) {
      acc.lastLatencyMs = Math.round(latencyMs);
      const seconds = latencyMs / 1000;
      acc.lastTokPerSec = (ot > 0 && seconds > 0) ? Math.round(ot / seconds * 10) / 10 : null;
    } else {
      acc.lastLatencyMs = null;
      acc.lastTokPerSec = null;
    }
  }

  const key = String(modelId).split('/').pop() || modelId;
  const bm = (STATE.byModel[key] = STATE.byModel[key] || { tokens: 0, spent: 0, cached: 0 });
  bm.tokens += tt; bm.spent += cost; bm.cached = (bm.cached || 0) + cached;
  updateSession(sess, modelId, usage, keyName, keyId, accountId);
  persistState();
}

/**
 * 记一次账号级失败尝试（ADR-0016）。
 * 只在请求确实落到某个账号、并以上游错误/网络错误结束时调用；400 属于客户端参数问题，
 * 不计入账号健康度（与 session-router 的既有口径一致）。
 *
 * 账本口径：失败的尝试同样是一次请求（req+1）并额外记一次失败（err+1）；
 * 没有 usage 就没有 token、延迟与吞吐样本——不拿请求的耗时冒充一次成功服务的延迟。
 */
function noteAccountAttemptError(accountId, info = {}) {
  if (!accountId) return;
  usageRecorder.add(Date.now(), {
    accountId,
    model: info.model || '',
    rate: modelMultiplier(info.model),
    key: info.key || '',
    ok: false,
  });
  STATE.byAccount = STATE.byAccount || {};
  const acc = (STATE.byAccount[accountId] = STATE.byAccount[accountId] || {
    tokens: 0, requests: 0, cached: 0, spent: 0, success: 0, errors: 0,
    lastSuccessAt: null, lastLatencyMs: null, lastTokPerSec: null,
  });
  acc.errors = (acc.errors || 0) + 1;
  // 失败的尝试没有可信的吞吐：清掉上一次的速度，避免界面拿旧数字冒充当前状态
  // （workbuddy2api 的 LastTokensPerSecond 同样在失败时置空）。
  acc.lastTokPerSec = null;
  persistState();
}

function usageSnapshot(real) {  const r = real || REAL;
  const allSessions = Object.values(STATE.sessions || {});
  return {
    tokens: STATE.tokens,
    requests: STATE.requests,
    spent: STATE.spent,
    sessions: allSessions.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0)).slice(0, 20),
    session_count: allSessions.length,
    balance: STATE.balance,
    remaining: Math.max(0, STATE.balance - STATE.spent),
    costPer1k: STATE.costPer1k,
    byModel: STATE.byModel || {},
    byKey: STATE.byKey || {},
    byAccount: STATE.byAccount || {},
    real: {
      ok: !!r.ok,
      usage: r.usage,
      limit: r.limit,
      unlimited: !!r.unlimited,
      period: r.period || null,
      range: r.range || null,
      fetchedAt: r.fetchedAt || 0,
      error: r.error || null,
    },
  };
}

// --------------------------------------------------------------------------
// chat 子进程 -> NDJSON 事件流（实验智能体模式隔离调用）
// 遵循 ADR-0001 与 Issue #09：
// - 具备有界 stderr 消费（上限 64KB），防止管道缓冲区占满导致进程挂起
// - 支持调用超时（timeoutMs）与下发终止信号
// - 支持客户端断连（signal/req.on('close')）终止与资源清理
// --------------------------------------------------------------------------
const MAX_STDERR_BYTES = 64 * 1024; // 64KB

function runChat(sessionId, message, handlers, opts = {}) {
  const cliBin = opts.cliBin || DTCODER_BIN;
  const args = [
    ...(opts.distArgs || DIST_ARGS), 'chat',
    '--session', sessionId,
    '--message', message,
    '--json',
    '--dangerously-skip-permissions',
    '--agent', opts.agent || AGENT,
  ];
  // 图片：CLI 原生支持 --image（可重复），本地路径或 http(s) URL 都行
  for (const src of (opts.images || [])) args.push('--image', src);
  // 按请求指定模型（仅当该 id 在本地模型表里，避免 CLI 因未知模型报错）
  if (opts.model) args.push('--model', opts.model);
  if (opts.thinking) args.push('--thinking-level', opts.thinking);
  const env = { ...process.env, ...(opts.env || {}) };
  delete env.https_proxy; delete env.http_proxy; delete env.all_proxy;

  let child;
  try {
    // stdin MUST be 'ignore': dtcoder chat otherwise blocks on the stdin pipe.
    child = spawn(cliBin, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    handlers.onError(`spawn failed: ${e.message}`);
    return null;
  }

  let buf = '';
  let stderrBuf = '';
  let stderrTruncated = false;
  let usage = null;
  let model = null;
  let completed = false;
  // 终止状态只允许出现一次：超时/子进程错误都会先 onError，随后 ChildProcess 一定还会 close。
  // 把「已经报过错」告诉调用方，它才不会在错误帧之后再补一个 finish_reason:'stop' + [DONE]。
  let failed = false;

  // 1) 空闲超时：智能体模式是持续输出 NDJSON 事件的长任务，卡死的表现是「一段时间没有任何新输出」。
  //    所以按「多久没新数据」计时，并且每收到一次 stdout 输出就重置，而不是一次性总时长上限——
  //    否则正常的长任务会被固定值误杀，`stream_idle_timeout_sec` 这个名字也就名不副实。
  //    只认 stdout：stderr 是诊断输出，卡在等上游的进程可以无限往里打重试日志，
  //    若它也算「活动」，空闲超时就永远不触发（等于没有超时）。
  const idleMs = opts.timeoutMs != null ? Number(opts.timeoutMs) : UPSTREAM_TIMEOUT_MS;
  let timer = null;
  const clearIdleTimer = () => {
    if (timer) { clearTimeout(timer); timer = null; }
  };
  const fail = (message) => {
    if (failed) return;
    failed = true;
    clearIdleTimer();
    if (child && !child.killed) {
      try { child.kill('SIGTERM'); } catch (_) {}
    }
    handlers.onError(message);
  };
  const armIdleTimer = () => {
    if (!(idleMs > 0) || failed) return;
    clearIdleTimer();
    timer = setTimeout(() => fail(`subprocess idle for ${idleMs}ms`), idleMs);
    if (timer.unref) timer.unref();
  };
  armIdleTimer();

  // 2) 有界消费 stderr，防止子进程因 stderr 管道满（通常 64KB）卡死
  if (child.stderr) {
    child.stderr.on('data', (d) => {
      if (stderrBuf.length < MAX_STDERR_BYTES) {
        stderrBuf += d.toString('utf-8');
        if (stderrBuf.length > MAX_STDERR_BYTES) {
          stderrBuf = stderrBuf.slice(0, MAX_STDERR_BYTES);
          stderrTruncated = true;
        }
      } else {
        stderrTruncated = true;
      }
    });
  }

  // 3) 外部取消信号：取消也是一次失败尝试，必须置 failed，
  //    否则子进程被 kill 后 onClose 还会往下游补 finish/[DONE]。
  const onCancel = () => {
    if (failed) return;
    failed = true;
    clearIdleTimer();
    if (child && !child.killed) { try { child.kill('SIGTERM'); } catch (_) {} }
  };
  if (opts.signal) {
    if (opts.signal.aborted) onCancel();
    else opts.signal.addEventListener('abort', onCancel, { once: true });
  }

  const flush = () => {
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      const name = ev?.event?.name || ev?.name;
      const data = ev?.data || ev?.event?.data;
      if (name === 'stream.text_delta' && data?.text) {
        handlers.onText(data.text);
      } else if (name === 'stream.usage' && data) {
        usage = { prompt_tokens: data.input_tokens || 0, completion_tokens: data.output_tokens || 0, total_tokens: (data.input_tokens || 0) + (data.output_tokens || 0) };
      } else if (name === 'stream.completed') {
        completed = true;
        if (data?.final_text != null) handlers.onFinalText(data.final_text);
        if (data?.model) { model = data.model; handlers.onModel(data.model); }
      }
    }
  };

  child.stdout.on('data', (d) => { armIdleTimer(); buf += d.toString(); flush(); });
  child.on('error', (e) => {
    fail(`child error: ${e.message}`);
  });
  child.on('close', (code) => {
    clearIdleTimer();
    buf = buf.trim();
    if (buf) {
      try {
        const ev = JSON.parse(buf);
        const name = ev?.event?.name || ev?.name;
        const data = ev?.data || ev?.event?.data;
        if (name === 'stream.completed' && data?.final_text != null) handlers.onFinalText(data.final_text);
      } catch {}
    }
    const finalStderr = stderrBuf + (stderrTruncated ? ' [stderr truncated]' : '');
    // 第 6 个参数是终止状态：true 表示这次尝试已经以 onError 结束，调用方不得再发成功帧。
    handlers.onClose(code, usage, completed, model, finalStderr, failed);
  });

  return child;
}

// --------------------------------------------------------------------------
// 多模态 / 工具调用（在 OpenAI 协议与 CLI 之间做转换）
//   - 图片：从 messages 里抽出 image_url，落成本地文件或直接透传 URL，交给 `chat --image`
//   - 工具：CLI 没有原生 function calling，这里用「哨兵块 + JSON」协议模拟，
//           模型按约定输出 TOOL_BEGIN…TOOL_END，网关解析成标准 tool_calls 返回
// --------------------------------------------------------------------------
const TOOL_BEGIN = '[[TOOL_CALLS]]';
const TOOL_END = '[[/TOOL_CALLS]]';
const MAX_IMAGES = Number(process.env.MAX_IMAGES || 8);

const EXT_BY_MIME = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg',
  'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp',
};

// 把 OpenAI 的 content（字符串或分块数组）压成纯文本；图片块留下占位标记
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let img = 0;
  return content.map((p) => {
    if (!p) return '';
    if (p.type === 'text') return p.text || '';
    if (p.type === 'image_url' || p.type === 'input_image') { img += 1; return `[图片 ${img}]`; }
    return '';
  }).join('');
}

function buildPrompt(messages) {
  const lines = [];
  for (const m of messages) {
    if (!m) continue;
    switch (m.role) {
      case 'system':
        lines.push(`System: ${contentToText(m.content)}`);
        break;
      case 'user':
        lines.push(`User: ${contentToText(m.content)}`);
        break;
      case 'assistant': {
        // 上一轮模型发起的工具调用要回到提示词里，否则多轮工具链会断
        const called = Array.isArray(m.tool_calls) && m.tool_calls.length
          ? m.tool_calls.map((c) => {
              const f = (c && c.function) || {};
              return `${f.name || '?'}(${f.arguments || '{}'})`;
            }).join(', ')
          : '';
        const text = contentToText(m.content);
        lines.push(called
          ? `Assistant: ${text ? text + '\n' : ''}[你调用了工具] ${called}`
          : `Assistant: ${text}`);
        break;
      }
      case 'tool':
        // 工具执行结果
        lines.push(`ToolResult(${m.name || 'tool'}${m.tool_call_id ? ' ' + m.tool_call_id : ''}): ${contentToText(m.content)}`);
        break;
      default:
        break;
    }
  }
  return lines.join('\n');
}

// 抽出所有图片引用（http(s) URL 或 data: base64）
function extractImageRefs(messages) {
  const out = [];
  for (const m of messages) {
    if (!m || !Array.isArray(m.content)) continue;
    for (const p of m.content) {
      if (!p) continue;
      if (p.type !== 'image_url' && p.type !== 'input_image') continue;
      const u = typeof p.image_url === 'string'
        ? p.image_url
        : (p.image_url && p.image_url.url) || p.url || '';
      if (u) out.push(String(u));
      if (out.length >= MAX_IMAGES) return out;
    }
  }
  return out;
}

function isPrivateIp(ip) {
  if (!ip) return true;
  const clean = String(ip).replace(/^::ffff:/i, '').trim();
  if (clean === '127.0.0.1' || clean === '::1' || clean === '0.0.0.0' || clean === '::') return true;
  if (net.isIPv4(clean)) {
    const parts = clean.split('.').map(Number);
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true; // 0.0.0.0/8, 10.0.0.0/8, 127.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link local, cloud metadata)
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
    if (a >= 224) return true; // 224.0.0.0/4 multicast & reserved
    return false;
  }
  if (net.isIPv6(clean)) {
    const lower = clean.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true; // fe80::/10
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7
    return false;
  }
  return true;
}

// data: URL 落盘 + http(s) 先下载再落盘（CLI 明确拒绝 remote-only 图片：
// IMAGE_INPUT_REMOTE_UNSUPPORTED），最后统一交 --image 本地路径
function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase().trim();
  if (!h) return true;
  if (h === 'localhost' || /\.(localhost|local|internal|svc|onion)$/.test(h)) return true;
  if (h.includes(':')) return true; // IPv6 文字地址一律交由 IP 解析严格校验
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    return isPrivateIp(h);
  }
  return false;
}

async function resolveAndCheckHost(hostname) {
  if (isPrivateHost(hostname)) return { ok: false, reason: 'private host blocked' };
  try {
    const addresses = await dns.promises.lookup(hostname, { all: true });
    if (!addresses || addresses.length === 0) return { ok: false, reason: 'dns lookup empty' };
    for (const addr of addresses) {
      if (isPrivateIp(addr.address)) {
        return { ok: false, reason: `private host blocked (${addr.address})` };
      }
    }
    return { ok: true, ip: addresses[0].address };
  } catch (e) {
    return { ok: false, reason: `dns lookup failed: ${e.message}` };
  }
}

async function downloadImage(url, maxBytes = 10 * 1024 * 1024, timeoutMs = 20000, depth = 0) {
  if (depth > 3) throw new Error('too many redirects');
  let u;
  try { u = new URL(url); } catch { throw new Error('bad url'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('unsupported protocol');

  // 防 SSRF：核实主机名并异步解析 DNS 核对目标真实 IP
  const check = await resolveAndCheckHost(u.hostname);
  if (!check.ok) throw new Error(check.reason);

  return new Promise((resolve, reject) => {
    const mod = u.protocol === 'https:' ? require('https') : require('http');
    const req = mod.get(u, { timeout: timeoutMs, headers: { 'User-Agent': runtimeConfig.get('outbound_user_agent') } }, async (res) => {
      const code = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
        res.resume();
        let next;
        try { next = new URL(res.headers.location, u).toString(); } catch { return reject(new Error('bad redirect url')); }
        try {
          const file = await downloadImage(next, maxBytes, timeoutMs, depth + 1);
          return resolve(file);
        } catch (err) {
          return reject(err);
        }
      }
      if (code !== 200) { res.resume(); return reject(new Error('http ' + code)); }

      const mime = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      const ext = EXT_BY_MIME[mime] || 'png';
      const file = path.join(os.tmpdir(), `aiwork-img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
      const chunks = [];
      let size = 0;
      let done = false;
      res.on('data', (c) => {
        if (done) return;
        size += c.length;
        if (size > maxBytes) { done = true; req.destroy(); return reject(new Error('image too large')); }
        chunks.push(c);
      });
      res.on('end', () => {
        if (done) return;
        done = true;
        try { fs.writeFileSync(file, Buffer.concat(chunks)); resolve(file); } catch (e) { reject(e); }
      });
      res.on('error', (e) => { if (!done) { done = true; reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function materializeImages(refs) {
  const paths = [];
  const tmp = [];
  const failed = [];
  for (const u of refs) {
    if (/^data:/i.test(u)) {
      const m = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(u);
      if (!m) { failed.push('unsupported data url'); continue; }
      const ext = EXT_BY_MIME[m[1].toLowerCase()] || 'png';
      const file = path.join(os.tmpdir(), `aiwork-img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
      try {
        fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
        paths.push(file);
        tmp.push(file);
      } catch (e) {
        failed.push('write failed: ' + e.message);
      }
      continue;
    }
    if (/^https?:\/\//i.test(u)) {
      try {
        const file = await downloadImage(u);
        paths.push(file);
        tmp.push(file);
      } catch (e) {
        log('image download failed: %s (%s)', String(u).slice(0, 100), e.message);
        failed.push(`${String(u).slice(0, 60)}: ${e.message}`);
      }
      continue;
    }
    // 明确拒绝本地绝对路径和相对路径：防止服务器本地文件读取
    failed.push(`local_path_forbidden: 本地路径已被禁止 (${String(u).slice(0, 60)})`);
  }
  return { paths, tmp, failed };
}

// 把 OpenAI tools 定义 + 工具选择策略编成提示词块
function buildToolsBlock(tools, toolChoice) {
  if (!Array.isArray(tools) || !tools.length) return '';
  const defs = tools.map((t) => {
    if (t && t.type === 'function' && t.function) {
      return {
        name: t.function.name,
        description: t.function.description || '',
        parameters: t.function.parameters || { type: 'object', properties: {} },
      };
    }
    return null;
  }).filter(Boolean);
  if (!defs.length) return '';

  let forced = '';
  if (toolChoice === 'required') {
    forced = '\n本轮你必须调用至少一个工具。';
  } else if (toolChoice && typeof toolChoice === 'object' && toolChoice.function && toolChoice.function.name) {
    forced = `\n本轮你必须调用工具 "${toolChoice.function.name}"。`;
  }

  return [
    '【外部工具协议｜系统级配置，优先级最高】',
    '本会话由一个外部程序代理。调用方声明了一批"外部工具"，它们由那个外部程序负责执行，',
    '**不在你的本机工具列表里**——查不到不代表它们不存在，也不要用你自己的搜索/命令去代替。',
    '当你需要只有这些工具才能提供的信息时：不要声明无法查询、不要编造结果、不要改用其他手段，',
    '直接输出下面的调用请求块，外部程序会执行它，并把结果以 ToolResult 的形式回传给你，你再据此作答。',
    '',
    '调用请求格式（整条回复**只包含这个块**，前后不要有任何文字，不要用 ``` 包裹）：',
    TOOL_BEGIN,
    '[{"name":"工具名","arguments":{"参数名":"值"}}]',
    TOOL_END,
    '',
    '规则：',
    '1. arguments 必须是符合该工具 parameters 的合法 JSON 对象；',
    '2. 一次可调用多个工具，放进同一个 JSON 数组；',
    '3. 不需要工具时，直接用自然语言回答，完全不要出现这个块。' + forced,
    '',
    '外部工具定义（JSON）：',
    JSON.stringify(defs),
  ].join('\n');
}

// 解析模型输出里的哨兵块 -> OpenAI tool_calls
function parseToolCalls(text) {
  const src = String(text || '');
  const i = src.indexOf(TOOL_BEGIN);
  if (i < 0) return { calls: [], text: src };

  const j = src.indexOf(TOOL_END, i + TOOL_BEGIN.length);
  let raw = j >= 0 ? src.slice(i + TOOL_BEGIN.length, j) : src.slice(i + TOOL_BEGIN.length);
  raw = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();

  let arr;
  try { arr = JSON.parse(raw); } catch (e) {
    log('tool block json parse failed: %s', e.message);
    return { calls: [], text: src };
  }
  if (!Array.isArray(arr)) arr = [arr];

  const calls = [];
  for (const c of arr) {
    if (!c || !c.name) continue;
    const args = typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments || {});
    calls.push({
      id: `call_${Math.random().toString(36).slice(2, 10)}`,
      type: 'function',
      function: { name: String(c.name), arguments: args },
    });
  }
  const rest = (src.slice(0, i) + src.slice(j >= 0 ? j + TOOL_END.length : src.length)).trim();
  return { calls, text: rest };
}

// 拿来当流式分片（有工具时不能边生成边下发，只能结束后补发）
function chunkText(text, size = 120) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function sendSSE(res, obj) { res.write(`data: ${JSON.stringify(obj)}\n\n`); }

// --------------------------------------------------------------------------
// HTTP handlers
// --------------------------------------------------------------------------
async function handleChatCompletions(req, res, keyName) {
  const { body, tooLarge, decodeError, unsupportedEncoding } = await readBodyShared(req, MAX_BODY_BYTES);
  if (tooLarge) {
    res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      error: {
        message: `请求体超过 ${Math.round(MAX_BODY_BYTES / 1024 / 1024)}MB 上限；图片请优先用 http(s) URL，少用 base64`,
        type: 'invalid_request_error', code: 'body_too_large',
      },
    }));
    return;
  }
  if (unsupportedEncoding) {
    res.writeHead(415, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      error: {
        message: `无法解压请求体（Content-Encoding）: ${decodeError}`,
        type: 'invalid_request_error', code: 'unsupported_content_encoding',
      },
    }));
    return;
  }
  if (decodeError) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      error: {
        message: `请求体解压失败: ${decodeError}`,
        type: 'invalid_request_error', code: 'decompression_failed',
      },
    }));
    return;
  }
  let parsed;
  try { parsed = JSON.parse(body); } catch {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { message: '请求体不是合法 JSON', type: 'invalid_request_error', code: 'bad_json' } }));
    return;
  }

  // 检查图片引用：明确禁止本地文件路径（如 /etc/passwd 或 C:\...），仅允许 data:base64 或 http(s) URL
  const imageRefs = extractImageRefs(parsed.messages || []);
  for (const ref of imageRefs) {
    if (!/^data:image\/[a-z0-9.+-]+;base64,/i.test(ref) && !/^https?:\/\//i.test(ref)) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        error: {
          message: `本地文件路径已被禁止，仅支持 data:base64 或 http(s) URL 图片: ${String(ref).slice(0, 80)}`,
          type: 'invalid_request_error',
          code: 'image_local_path_forbidden',
        },
      }));
      return;
    }
  }

  // Issue #07 & US-46: 检查未实现的厂商功能或工具类型，严禁静默丢弃
  if (Array.isArray(parsed.tools)) {
    for (const t of parsed.tools) {
      if (t && t.type && t.type !== 'function') {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          error: {
            message: `不支持的工具类型: ${t.type}。网关仅支持 function 类型的工具调用。`,
            type: 'invalid_request_error',
            code: 'unsupported_tool_type',
          },
        }));
        return;
      }
    }
  }

    // 模型解析与校验（ADR-0003: 废除未知模型静默兜底，支持显式别名，未知模型返回 404）
    const allowedAccounts = getAllowedAccounts(req);
    const modelRes = modelAliasManager.resolveModel(parsed.model, accountPool, allowedAccounts);
    if (!modelRes.ok) {
      res.writeHead(modelRes.status || 404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        error: {
          message: modelRes.message,
          type: 'invalid_request_error',
          code: modelRes.code || 'model_not_found',
          available: modelRes.availableModels || [],
        },
      }));
      return;
    }

    parsed.model = modelRes.actualModel;
    req.__resolvedModel = modelRes;

    const p = UPSTREAM === 'agent' ? runAgentPath(req, res, parsed, keyName) : runDirectPath(req, res, parsed, keyName);
    return Promise.resolve(p).catch((e) => {
      log('chat/completions run error: %s', e.stack || e.message);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { message: 'bridge: ' + e.message, type: 'server_error' } }));
      } else { try { res.end(); } catch (_) {} }
    });
}

// 返回"写错的模型名"（需要报错时），认识就返回 null。
// 允许：不传 / 别名 / 带 vendor 前缀（qwen/qwen3.8-max）/ 表里存在的 id。
function checkModelExists(model) {
  const m = String(model == null ? '' : model).trim();
  if (process.env.MODEL_OVERRIDE === '0') return null;
  accountPool.reloadIfChanged();
  const availableModelIds = accountPool.getAllAvailableModelIds();
  if (availableModelIds.includes(m)) return null;
  if (m.includes('/') && availableModelIds.includes(m.split('/').pop())) return null;
  if (modelAliasManager.aliases.has(m.toLowerCase())) return null;
  return m;
}

// 走 CLI agent：具备技能/代码执行/联网能力，代价是每轮固定 16~19K 的 agent 提示
async function runAgentPath(req, res, parsed, keyName) {
    const messages = parsed.messages || [];
    const reqModel = parsed.model || [...MODEL_INFO.keys()][0];
    logMeta(req).model = reqModel;
    const stream = !!parsed.stream;
    const sess = sessionFingerprint(req, parsed);
    const sessionId = sess.id || `bridge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // 工具调用：CLI 无原生 function calling，用哨兵块协议模拟
    const tools = Array.isArray(parsed.tools) ? parsed.tools : [];
    const wantTools = tools.length > 0 && parsed.tool_choice !== 'none';

    // 图片：data URL 直接落盘；http(s) 先下载再落盘（CLI 不接受 remote-only 图片）
    const imageRefs = extractImageRefs(messages);
    const { paths: imagePaths, tmp: tmpImages, failed: imageErrors } = await materializeImages(imageRefs);
    const cleanup = () => { for (const f of tmpImages) fs.unlink(f, () => {}); };

    // 请求里带了图但一张都没能拿到 -> 明确报错，避免模型对着空气回答
    if (imageRefs.length && !imagePaths.length) {
      cleanup();
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        error: {
          message: `图片获取失败：${imageErrors.join('; ')}`,
          type: 'invalid_request_error', code: 'image_fetch_failed', details: imageErrors,
        },
      }));
      return;
    }

    let prompt = buildPrompt(messages);
    // 关键：协议块必须以 System 身份出现。buildPrompt 把整个对话压成一条 user 消息，
    // 若只是追加在 User 后面，模型会当成"用户粘贴的一段文字"而忽略其指令性。
    if (wantTools) prompt = `System: ${buildToolsBlock(tools, parsed.tool_choice)}\n\n${prompt}`;
    if (!prompt.trim()) {
      cleanup();
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { message: 'empty prompt', type: 'invalid_request_error', code: 'empty_prompt' } }));
      return;
    }

    // 模型覆盖：仅当请求的 id 在本地模型表里才下发，避免 CLI 因未知模型报错
    const overrideModel = (process.env.MODEL_OVERRIDE !== '0' && MODEL_INFO.has(reqModel) && reqModel !== 'automodel')
      ? reqModel : null;
    // ADR-0022：思考档位——客户端显式表达（三种协议归一后都在 reasoning_effort 上）
    // 优先于环境 THINKING_LEVEL；xhigh 映射成 CLI 认识的 adaptive。
    const clientThinking = thinking.inboundLevel(parsed);
    const chatOpts = {
      images: imagePaths,
      model: overrideModel,
      thinking: clientThinking.kind === 'level'
        ? (thinking.cliThinking(clientThinking.value) || '')
        : (process.env.THINKING_LEVEL || ''),
      // 智能体模式是持续输出 NDJSON 事件的流式调用，用「流空闲超时」而不是短请求总时长，
      // 否则一次正常的长任务会被 120 秒的短请求上限误杀。
      timeoutMs: runtimeConfig.getMs('stream_idle_timeout_sec'),
      // 下游断连时 dispatch 会 abort 这个 controller；此前传的是 req.signal，
      // 而 IncomingMessage 没有这个属性，取消传播实际上从未生效（只有 res close 兜底）。
      signal: (req.__abortController && req.__abortController.signal) || null,
    };
    if (overrideModel) log('model override: %s', overrideModel);
    if (imagePaths.length) log('images attached: %d', imagePaths.length);

    // 未登录时 CLI 会"静默成功但产出为空"，调用方只会拿到空字符串，很难排查。
    // 这里提前拦一道，返回明确的 503（authState 有 60s 缓存，不增加开销）。
    const auth = authState();
    if (auth.status !== 'active') {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        error: {
          message: 'AiWork CLI 未登录，服务端无法完成对话。请在服务器执行：docker compose exec aiwork aiworkcn login',
          type: 'service_unavailable',
          code: 'cli_not_logged_in',
          cli_auth: auth.status,
        },
      }));
      return;
    }

    let full = '';
    let finalModel = reqModel;
    const onText = (t) => { full += t; };
    const onFinalText = (t) => { if (!full) full = t; };
    const onModel = (m) => { finalModel = m; logMeta(req).model = m; };

    // 带 tools 时不能边生成边下发：万一模型最后给的是工具调用，
    // 前面已经吐出去的文本就成了"多余内容"，客户端会解析错乱。
    const bufferFirst = wantTools;

    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      let finished = false;
      const base = () => ({ id: `chatcmpl-${sessionId}`, object: 'chat.completion.chunk', model: finalModel });
      const child = runChat(sessionId, prompt, {
        onText: (t) => {
          if (!bufferFirst) {
            sendSSE(res, { ...base(), choices: [{ index: 0, delta: { content: t }, finish_reason: null }] });
          }
        },
        onFinalText, onModel,
        onError: (e) => { sendSSE(res, { error: e }); },
        onClose: (code, usage, completed, modelId, stderr, failed) => {
          finished = true;
          cleanup();
          // 只记上游真的报出来的用量：失败尝试通常没有 usage，不能凭空记成一次成功调用。
          // 账本仍然要记这一次尝试（失败且无 usage 时 token 记 0），所以只要失败就记一次；
          // ok 跟着 failed 走（部分用量照实记，但算失败）。仪表盘的 requests 只在有 usage 时 +1，
          // 两条口径不同是刻意的：账本按尝试计，仪表盘按成功计（ADR-0017）。
          if (usage || failed) {
            recordUsage(sessionId, finalModel, usage, {
              keyName,
              sess,
              keyId: req.__keyId || (req.__keyObj && req.__keyObj.id),
              ok: !failed,
            });
          }
          // 已经发过错误帧：只收尾，绝不能再补 finish_reason:'stop' 与 [DONE]，
          // 否则客户端会把一次失败读成成功（规范 2：不得下发伪造的 [DONE]）。
          if (failed) {
            if (!res.writableEnded) { try { res.end(); } catch (_) {} }
            log('stream aborted session=%s model=%s reason=subprocess_failed', sessionId, finalModel);
            return;
          }
          const { calls, text } = wantTools ? parseToolCalls(full) : { calls: [], text: full };
          if (bufferFirst) {
            if (calls.length) {
              sendSSE(res, {
                ...base(),
                choices: [{ index: 0, delta: { role: 'assistant', tool_calls: calls.map((c, i) => ({ index: i, ...c })) }, finish_reason: null }],
              });
              sendSSE(res, { ...base(), choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: usage || undefined });
            } else {
              for (const piece of chunkText(text)) {
                sendSSE(res, { ...base(), choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
              }
              sendSSE(res, { ...base(), choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: usage || undefined });
            }
          } else {
            // 末尾发送带 usage 的 finish chunk（OpenAI include_usage 形态）
            sendSSE(res, { ...base(), choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: usage || undefined });
          }
          res.write('data: [DONE]\n\n');
          res.end();
          log('stream done session=%s model=%s chars=%d tool_calls=%d usage=%j', sessionId, finalModel, full.length, calls.length, usage);
        },
      }, chatOpts);
      if (!child) {
        cleanup();
        // runChat 在 spawn 失败时已经调过 onError，上面那个 handler 已经发过错误帧。
        // 这里只收尾：不能再补一帧错误，更不能补 [DONE]（失败被读成正常结束）。
        try { if (!res.writableEnded) res.end(); } catch (_) {}
        return;
      }
      const abortChild = () => { if (!finished && child && !child.killed) { try { child.kill('SIGTERM'); } catch (_) {} } };
      res.on('close', abortChild);
      req.on('close', abortChild);
    } else {
      let finished = false;
      const child = runChat(sessionId, prompt, {
        onText, onFinalText, onModel,
        onError: (e) => { finished = true; cleanup(); if (!res.headersSent) { res.writeHead(502); res.end('bridge: ' + e); } },
        onClose: (code, usage, completed, modelId, stderr, failed) => {
          finished = true;
          cleanup();
          // 已经回过 502：不能再写 200 JSON（after-end 写入），也不该把这次尝试记成一次成功调用。
          if (failed) {
            // 上游可能已经报过 usage（部分生成被掐断），那部分用量照实记；没有 usage 也要在
            // 账本里留一次失败尝试（token 0），否则「失败的调用」在历史里凭空消失。
            recordUsage(sessionId, finalModel, usage, {
              keyName,
              sess,
              keyId: req.__keyId || (req.__keyObj && req.__keyObj.id),
              ok: false,
            });
            log('completion aborted session=%s model=%s reason=subprocess_failed', sessionId, finalModel);
            return;
          }
          recordUsage(sessionId, finalModel, usage, {
            keyName,
            sess,
            keyId: req.__keyId || (req.__keyObj && req.__keyObj.id),
          });
          const { calls, text } = wantTools ? parseToolCalls(full) : { calls: [], text: full };
          const message = { role: 'assistant', content: calls.length ? null : text };
          if (calls.length) message.tool_calls = calls;
          const out = {
            id: `chatcmpl-${sessionId}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: finalModel,
            choices: [{ index: 0, message, finish_reason: calls.length ? 'tool_calls' : 'stop' }],
            usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          };
          if (!res.headersSent) { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); }
          res.end(JSON.stringify(out));
          log('completion session=%s model=%s chars=%d tool_calls=%d', sessionId, finalModel, text.length, calls.length);
        },
      }, chatOpts);
      if (!child) {
        cleanup();
        if (!res.headersSent) { res.writeHead(502); res.end('bridge: failed to start agent'); }
        return;
      }
      const abortChild = () => { if (!finished && child && !child.killed) { try { child.kill('SIGTERM'); } catch (_) {} } };
      res.on('close', abortChild);
      req.on('close', abortChild);
    }
}

// --------------------------------------------------------------------------
// 直连上游：把请求原样转发给 aiwork-api（OpenAI 兼容），无 agent 开销
//   - 工具调用、图片、思考、前缀缓存全部是上游原生能力，不需要任何转换
//   - 失败（key 失效 / 模型不存在 / 上游异常）时可以自动降级到 agent 路径
// --------------------------------------------------------------------------
// ADR-0022：上游 400 拒绝过思考参数的模型（进程生命周期内记住，重启清零）。
const thinkingUnsupportedModels = new Set();

function runDirectPath(req, res, parsed, keyName, failoverState = null) {
  const fState = failoverState || {
    attemptCount: 1,
    attemptedAccountIds: [],
    contentDelivered: false,
  };
  req.__failoverState = fState;

  // ADR-0004 & Issue #06: 检查不透明账号状态与会话上下文可重建性
  const hasOpaqueState = Boolean(
    parsed.opaque_account_state === true ||
    (req.headers && (req.headers['x-opaque-account-state'] === 'true' || req.headers['x-opaque-account-state'] === '1'))
  );
  const isContextReconstructible = !(
    parsed.reconstructible === false ||
    (req.headers && (req.headers['x-reconstructible'] === 'false' || req.headers['x-reconstructible'] === '0'))
  );
  const canFailover = !hasOpaqueState && isContextReconstructible;

  const allowedAccounts = getAllowedAccounts(req);
  const keyId = req.__keyId || (req.__keyObj && req.__keyObj.id) || (keyName ? `legacy-${keyName}` : 'anon');
  const sess = sessionFingerprint(req, parsed);
  const rawSessionId = sess.id || `direct-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // 账号调度与会话绑定校验（ADR-0003 & ADR-0004: 排除已尝试账号、候选筛选、轮询调度与粘性）
  const routeRes = sessionRouter.routeSession({
    keyId,
    rawSessionId,
    targetModel: parsed.model,
    accountPool,
    allowedAccounts,
    excludeAccountIds: fState.attemptedAccountIds,
  });

  if (!routeRes.ok) {
    const meta = logMeta(req);
    meta.attempts = Math.max(0, (Number(fState.attemptCount) || 1) - 1);
    setLogError(req, routeRes.message);
    if (!res.headersSent) {
      res.writeHead(routeRes.status || 503, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        error: {
          message: routeRes.message,
          type: routeRes.status === 404 ? 'invalid_request_error' : 'service_unavailable',
          code: routeRes.code || 'service_unavailable',
        },
      }));
    } else {
      res.write(`data: ${JSON.stringify({
        error: { message: routeRes.message, type: 'service_unavailable', code: routeRes.code || 'service_unavailable' }
      })}\n\n`);
      if (!res.writableEnded) res.end();
    }
    return;
  }

  const account = routeRes.account;
  req.__account = account;
  // 日志归属跟着「这一次尝试」走：换号后重进本函数会覆盖成最终服务这次请求的账号。
  const meta = logMeta(req);
  meta.account = describeAccount(account);
  meta.model = parsed.model || meta.model;
  meta.attempts = Math.max(0, (Number(fState.attemptCount) || 1) - 1);
  req.__scopedSessionId = routeRes.scopedSessionId;
  const key = account.routerKey;
  const sessionId = rawSessionId;

  if (!fState.attemptedAccountIds.includes(account.id)) {
    fState.attemptedAccountIds.push(account.id);
  }

  // 并发追踪与生命周期取消传播 (Issue #07)
  sessionRouter.acquireAccount(account.id);
  let released = false;
  let upReq = null;
  let firstByteTimer = null;
  let shortDeadlineTimer = null;
  const clearAttemptTimers = () => {
    if (firstByteTimer) { clearTimeout(firstByteTimer); firstByteTimer = null; }
    if (shortDeadlineTimer) { clearTimeout(shortDeadlineTimer); shortDeadlineTimer = null; }
  };
  const releaseSlot = () => {
    if (!released) {
      released = true;
      sessionRouter.releaseAccount(account.id);
    }
  };

  const ac = req.__abortController || new AbortController();
  req.__abortController = ac;
  const signal = ac.signal;

  const onAbort = () => {
    if (upReq && !upReq.destroyed) {
      try { upReq.destroy(new Error('downstream cancelled')); } catch (_) {}
    }
    releaseSlot();
  };
  if (signal.aborted) {
    onAbort();
    return;
  }
  signal.addEventListener('abort', onAbort, { once: true });

  const releaseAll = () => {
    signal.removeEventListener('abort', onAbort);
    clearAttemptTimers();
    releaseSlot();
  };

  if (typeof res.on === 'function') {
    res.on('finish', releaseAll);
    res.on('close', releaseAll);
  }

  const stream = !!parsed.stream;
  let logModel = parsed.model || 'automodel';

  const REASONING = String(process.env.REASONING || 'off').toLowerCase();
  const payloadObj = { ...parsed };
  // ADR-0022：思考档位统一收口。三条协议（chat 直传 / messages / responses）都汇到
  // 这里，客户端表达过的档位在此归一并翻成上游方言；REASONING 只管响应侧剥离，
  // 与这里的映射无关。上游 400 拒过思考参数的模型，进程内记住，后续不再带。
  let thinkingRequested = false;
  if (!fState.thinkingStripped && !thinkingUnsupportedModels.has(String(parsed.model || ''))) {
    const applied = thinking.applyUpstream(payloadObj);
    thinkingRequested = applied.applied;
    if (applied.level) log('thinking level %s -> upstream (%s)', applied.level, parsed.model);
  } else {
    // 重试或已记住的模型：把客户端原始参数彻底摘掉，一个不剩。
    delete payloadObj.reasoning_effort;
    delete payloadObj.thinking;
  }

  // ADR-0021 决定 2：defer_loading 显式消费。原生 chat 路径整包 spread 会把
  // tools[] 条目（wrapper 层与 function 层）的非协议字段透传给上游，被参数
  // 白名单以 400 unknown_parameter 拒掉（客户端以为按需加载生效的假开关）。
  // 这里对函数工具整体白名单重建：wrapper 只留 type，function 只拷协议内字段
  // （name/description/parameters/strict，存在才拷），其余剥掉并打日志留痕；
  // 非 function 类型已在入口拦截 400，不会到这里。不原地改 parsed（thinking
  // 重试与 failover 会复用 parsed），净化幂等——重试再进来时字段已在白名单内，
  // 不会二次剥、不会丢字段。
  if (Array.isArray(payloadObj.tools)) {
    payloadObj.tools = payloadObj.tools.map((t) => {
      if (!t || t.type !== 'function' || !t.function || typeof t.function !== 'object') return t;
      const fn = {};
      for (const k of ['name', 'description', 'parameters', 'strict']) {
        if (k in t.function) fn[k] = t.function[k];
      }
      const stripped = [
        ...Object.keys(t).filter((k) => k !== 'type' && k !== 'function'),
        ...Object.keys(t.function).filter((k) => !(k in fn)),
      ];
      if (stripped.length > 0) {
        log('[chat] stripped non-protocol tool fields: %s', stripped.join(', '));
      }
      return { type: 'function', function: fn };
    });
  }

  const payload = JSON.stringify(payloadObj);
  const bodyBuf = Buffer.from(payload, 'utf8');

  // 抓包：只记录结构摘要 + 消息体，便于看清客户端到底传了什么
  const dumpId = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  if (DEBUG_DUMP) {
    dumpWrite(`${dumpId}-req.json`, JSON.stringify({
      model: parsed.model, stream: !!parsed.stream,
      reasoning_effort: payloadObj.reasoning_effort,
      tool_choice: parsed.tool_choice,
      tools: (parsed.tools || []).map((t) => t && t.function && t.function.name).filter(Boolean),
      tool_count: (parsed.tools || []).length,
      max_tokens: parsed.max_tokens, temperature: parsed.temperature,
      message_count: (parsed.messages || []).length,
      messages: parsed.messages,
    }, null, 2));
  }
  let u;
  try { u = new URL('/v1/chat/completions', ROUTER_BASE); } catch {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { message: 'ROUTER_BASE_URL 配置有误: ' + ROUTER_BASE, type: 'server_error' } }));
    return;
  }

  const mod = u.protocol === 'https:' ? require('https') : require('http');
  let settled = false;
  let abandoned = false;
  let activeUpRes = null;

  // 客户端断开 -> 主动断开上游（具名，便于 abandon 时解绑，避免每次重试按次累积）
  const onClientClose = () => { if (!settled && upReq) upReq.destroy(); };

  const abandonCurrentAttempt = () => {
    if (abandoned) return;
    abandoned = true;
    settled = true;
    clearAttemptTimers();
    signal.removeEventListener('abort', onAbort);
    if (typeof res.removeListener === 'function') {
      res.removeListener('finish', releaseAll);
      res.removeListener('close', releaseAll);
      res.removeListener('close', onClientClose);
    }
    if (activeUpRes) {
      try {
        activeUpRes.removeAllListeners('data');
        activeUpRes.removeAllListeners('end');
        activeUpRes.removeAllListeners('error');
        // 先挂 noop 再 destroy：destroy 与上游 ECONNRESET 竞态时避免 error 无监听
        activeUpRes.on('error', () => {});
        activeUpRes.destroy();
      } catch (_) {}
      activeUpRes = null;
    }
    if (upReq) {
      try {
        upReq.removeAllListeners('timeout');
        upReq.removeAllListeners('error');
        // 先挂 noop 再 destroy：destroy 后可能迟发 error，避免无监听成为 uncaught
        upReq.on('error', () => {});
        upReq.destroy();
      } catch (_) {}
      upReq = null;
    }
    releaseSlot();
  };

  // ADR-0004: 有限换号核心决策器
  const tryFailover = (errorInfo = {}) => {
    if (signal.aborted || (errorInfo.message && String(errorInfo.message).includes('downstream cancelled'))) {
      return false;
    }

    sessionRouter.recordAccountError(accountPool, account.id, {
      statusCode: errorInfo.statusCode,
      headers: errorInfo.headers,
      body: errorInfo.body,
      modelId: parsed.model,
      networkError: errorInfo.networkError,
      timeout: errorInfo.timeout,
    });

    const status = Number(errorInfo.statusCode || 0);
    const is400 = (status === 400);
    // 账本里这次失败记在「刚失败的那个账号」上：换号前的失败属于旧账号，不挪给接手的新账号。
    if (!is400) noteAccountAttemptError(account.id, { model: logModel, key: keyId });
    const isRetryable = !is400 && (
      errorInfo.networkError ||
      errorInfo.timeout ||
      status === 401 ||
      status === 403 ||
      status === 404 ||
      status === 408 ||
      status === 429 ||
      status >= 500
    );

    if (!fState.contentDelivered && canFailover && isRetryable && fState.attemptCount < sessionRouter.maxAccountAttempts) {
      const candidates = sessionRouter.getCandidates({
        accountPool,
        targetModel: parsed.model,
        allowedAccounts,
        excludeAccountIds: fState.attemptedAccountIds,
        checkConcurrency: true,
      });

      if (candidates.length > 0) {
        log('Failover triggered: account %s failed (%s), switching to candidate %s (attempt %d/%d)',
          account.id, errorInfo.statusCode || errorInfo.message || 'error', candidates[0].id, fState.attemptCount + 1, sessionRouter.maxAccountAttempts);
        abandonCurrentAttempt();
        fState.attemptCount += 1;
        runDirectPath(req, res, parsed, keyName, fState);
        return true;
      }
    }
    return false;
  };

  // 单次尝试的起点：成功收尾时用它算「最近一次延迟」与吞吐（ADR-0016）。
  const attemptStartedAt = Date.now();
  upReq = mod.request(u, {
    method: 'POST',
    signal,
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Content-Length': bodyBuf.length,
      'Accept': stream ? 'text/event-stream' : 'application/json',
      // ADR-0013：出站 UA 可配置，默认保持原值以免改变上游对客户端的识别
      'User-Agent': runtimeConfig.get('outbound_user_agent'),
    },
    // socket timeout 只做流式空闲上限；非流式的「总时长上限」由下面的 shortDeadlineTimer 负责，
    // 因为 socket timeout 是空闲超时，上游持续滴流时它永远不会触发。
    timeout: stream ? runtimeConfig.getMs('stream_idle_timeout_sec') : 0,
  }, (upRes) => {
    // 已经收到响应头，首字节超时不再适用
    if (firstByteTimer) { clearTimeout(firstByteTimer); firstByteTimer = null; }
    activeUpRes = upRes;
    if (abandoned) {
      try { upRes.on('error', () => {}); upRes.destroy(); } catch (_) {}
      activeUpRes = null;
      return;
    }
    const status = upRes.statusCode || 0;

    // 非 200：先收完错误体，再决定是否重试或故障换号
    if (status !== 200) {
      const chunks = [];
      // 收错误体途中断连：必须终止请求（不能只吞错，否则永不 settle）
      upRes.on('error', (e) => {
        if (abandoned || settled || res.destroyed) return;
        settled = true;
        const msg = (e && e.message) || 'unknown';
        setLogError(req, 'upstream error: ' + msg);
        const payload = { error: { message: 'upstream error: ' + msg, type: 'upstream_error', code: 'upstream_unreachable' } };
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(payload));
        } else {
          // 已发 200（流式首试换号后二次尝试）：用 SSE 错误帧收尾，不能让客户端挂死
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
          if (!res.writableEnded) res.end();
        }
      });
      upRes.on('data', (c) => {
        if (abandoned || settled) return;
        chunks.push(c);
      });
      upRes.on('end', () => {
        if (abandoned || settled) return;
        settled = true;
        const text = Buffer.concat(chunks).toString('utf8');
        if (status !== 200) dumpWrite(`${dumpId}-err-${status}.json`, text);
        log('upstream %d: %s', status, text.slice(0, 300));

        let parsedErrBody = null;
        try { parsedErrBody = JSON.parse(text); } catch (_) {}

        // ADR-0022：上游不认识思考参数时摘掉重试一次，并按模型记住，
        // 后续请求首试就不带。只在我们确实带过参数时才判。
        if (status === 400 && thinkingRequested && !fState.thinkingStripped
            && thinking.looksLikeThinkingReject(text)) {
          fState.thinkingStripped = true;
          // 摘参数重试不是换号：清掉排除名单，让路由可以再次选中原账号
          // （单账号场景下不清会把唯一的候选排除掉，直接 404）。
          fState.attemptedAccountIds = [];
          thinkingUnsupportedModels.add(String(parsed.model || ''));
          log('upstream 400 rejected thinking params for %s; retrying without them', parsed.model);
          abandonCurrentAttempt();
          runDirectPath(req, res, parsed, keyName, fState);
          return;
        }

        if (tryFailover({ statusCode: status, headers: upRes.headers, body: parsedErrBody, message: text })) {
          return;
        }

        // 换号也救不回来：把上游给的原因压成摘要留给日志（正文本身不进日志）。
        setLogError(req, (parsedErrBody && parsedErrBody.error && parsedErrBody.error.message) || text);

        if (!res.headersSent) {
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(text || JSON.stringify({ error: { message: 'upstream error', type: 'upstream_error' } }));
        } else {
          res.write(`data: ${JSON.stringify({
            error: { message: text || 'upstream error', type: 'upstream_error', code: `upstream_${status}` }
          })}\n\n`);
          if (!res.writableEnded) res.end();
        }
      });
      return;
    }

    if (!stream) {
      const chunks = [];
      let totalRespBytes = 0;
      upRes.on('data', (c) => {
        if (abandoned) return;
        totalRespBytes += c.length;
        if (totalRespBytes > MAX_RESPONSE_BYTES) {
          upRes.destroy();
          if (!settled && !abandoned) {
            settled = true;
            log('upstream non-stream response exceeded MAX_RESPONSE_BYTES: %d', totalRespBytes);
            if (!res.headersSent) {
              res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({
                error: {
                  message: `上游响应体超过 ${Math.round(MAX_RESPONSE_BYTES / 1024 / 1024)}MB 上限`,
                  type: 'upstream_error',
                  code: 'response_too_large',
                },
              }));
            } else {
              if (!res.writableEnded) res.end();
            }
          }
          return;
        }
        chunks.push(c);
      });
      upRes.on('end', () => {
        if (abandoned || settled) return;
        settled = true;
        const text = Buffer.concat(chunks).toString('utf8');
        dumpWrite(`${dumpId}-up.json`, text);
        let usage = null;
        let out = text;
        try {
          const j = JSON.parse(text);
          usage = j.usage || null;
          if (j.model) logModel = j.model;
          // 规范化：tool_calls 里不该有 index（那是流式用的），reasoning 按配置剥掉
          for (const ch of j.choices || []) {
            const m = ch && ch.message;
            if (!m) continue;
            // 老式 function_call -> tool_calls（平台只认后者）
            if (!Array.isArray(m.tool_calls) && m.function_call && typeof m.function_call === 'object') {
              const fc = m.function_call;
              m.tool_calls = [{
                id: `call_${Math.random().toString(36).slice(2, 10)}`,
                type: 'function',
                function: {
                  name: fc.name || '',
                  arguments: typeof fc.arguments === 'string'
                    ? fc.arguments : JSON.stringify(fc.arguments || {}),
                },
              }];
              delete m.function_call;
              if (ch.finish_reason === 'function_call') ch.finish_reason = 'tool_calls';
            }
            if (Array.isArray(m.tool_calls)) {
              for (const tc of m.tool_calls) {
                if (tc) delete tc.index;
                if (tc && tc.function && typeof tc.function.arguments !== 'string') {
                  tc.function.arguments = JSON.stringify(tc.function.arguments || {});
                }
              }
              if (m.content === undefined) m.content = null;
            }
            if (REASONING === 'off') delete m.reasoning_content;
          }
          out = JSON.stringify(j);
        } catch { /* 上游返回非 JSON 时原样透传 */ }
        recordUsage(sessionId, logModel, usage, {
          keyName,
          sess,
          keyId,
          accountId: account.id,
          latencyMs: Date.now() - attemptStartedAt,
        });
        logMeta(req).model = logModel;
        setLogUsage(req, usage);
        if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(out);
        log('direct completion session=%s model=%s usage=%j', sessionId, logModel, usage);
      });
      upRes.on('error', (e) => {
        if (abandoned) return;
        if (!settled) {
          settled = true;
          log('upstream stream error: %s', e.message);
          if (tryFailover({ networkError: true, statusCode: 502, message: e.message })) {
            return;
          }
          setLogError(req, 'upstream stream error: ' + e.message);
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: { message: 'upstream stream error: ' + e.message, type: 'upstream_error' } }));
          } else {
            if (!res.writableEnded) res.end();
          }
        }
      });
      return;
    }

    // 流式：不能纯 pipe。上游把 tool_calls 拆成几十个碎片帧（arguments 是分段给的），
    // 很多平台只认第一帧，拿到 "arguments":"{" 这种半截 JSON 就会执行失败 / 直接结束会话。
    // 这里把 tool_calls 碎片合并成一帧再下发，其余帧规范化后转发。
    if (!res.headersSent) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
    }
    let usage = null;
    let buf = '';
    let chunkId = '';
    const toolAcc = new Map(); // index -> {id,type,name,args}
    const rawDump = DEBUG_DUMP ? [] : null;
    let sawContent = false;      // 上游是否真的吐过正文
    let emittedToolCount = 0;    // 已经补发过几帧完整 tool_calls
    let reasoningText = '';      // 上游只给思考内容时留一份，用于兜底
    let sentDone = false;        // 是否已经下发过 [DONE]
    let sawUpstreamDone = false; // 上游是否真传过 [DONE]
    let lastFinish = null;       // 上游给的 finish_reason，排查空回复时用

    // 背压控制：当客户端消费较慢导致操作系统或响应缓冲满载时暂停上游拉取 (Issue #07)
    let pausedByBackpressure = false;
    const write = (s) => {
      if (abandoned || res.writableEnded) return;
      const ok = res.write(s);
      if (!ok && !pausedByBackpressure && upRes && typeof upRes.pause === 'function') {
        pausedByBackpressure = true;
        upRes.pause();
        if (typeof res.once === 'function') {
          res.once('drain', () => {
            pausedByBackpressure = false;
            if (abandoned) return;
            if (upRes && typeof upRes.resume === 'function') {
              upRes.resume();
            }
          });
        }
      }
    };
    const frame = (delta, finishReason) => `data: ${JSON.stringify({
      id: chunkId || `chatcmpl-${sessionId}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: logModel,
      choices: [{ index: 0, delta, finish_reason: finishReason || null }],
    })}\n\n`;

    const emitToolCalls = () => {
      if (!toolAcc.size) return;
      const calls = [...toolAcc.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, c], k) => ({
          index: k,
          id: c.id || `call_${Math.random().toString(36).slice(2, 10)}`,
          type: 'function',
          function: { name: c.name, arguments: c.args || '{}' },
        }));
      toolAcc.clear();
      emittedToolCount += calls.length;
      fState.contentDelivered = true;
      write(frame({ tool_calls: calls }));
      log('tool_calls merged: %d call(s)', calls.length);
    };

    const handleBlock = (block) => {
      if (abandoned) return;
      const dataLines = block.split('\n')
        .map((l) => l.trim())
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim());
      if (!dataLines.length) { if (block.trim()) write(block + '\n\n'); return; }

      const payload = dataLines.join('\n');
      if (payload === '[DONE]') {
        sawUpstreamDone = true;
        emitToolCalls();
        write('data: [DONE]\n\n');
        sentDone = true;
        return;
      }

      let j;
      try { j = JSON.parse(payload); } catch { write(block + '\n\n'); return; }

      // 流中错误帧拦截：若尚未交付正文，允许故障换号
      if (j && j.error) {
        if (!fState.contentDelivered && tryFailover({ statusCode: 502, body: j, message: j.error.message })) {
          return;
        }
        setLogError(req, j.error.message || 'upstream stream error');
        logMeta(req).streamInterrupted = true;
        write(block + '\n\n');
        return;
      }

      if (j.id) chunkId = j.id;
      if (j.model) logModel = j.model;
      if (j.usage) usage = j.usage;

      const ch = Array.isArray(j.choices) ? j.choices[0] : null;
      if (!ch) { write(block + '\n\n'); return; }

      const delta = ch.delta || {};
      const hasContentDelta = (typeof delta.content === 'string' && delta.content.length > 0);
      const hasReasoningDelta = (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0);
      const hasToolDelta = (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) ||
                           Boolean(delta.function_call && Object.keys(delta.function_call).length > 0);

      // REASONING=off 时思考片段会在发送前被剥除，不构成向客户端实际交付内容 (Spec line 57 / US 33)
      const reasoningDelivered = (REASONING !== 'off') && hasReasoningDelta;

      // ADR-0004 & Issue #06: 一旦有实际交付给客户端的正文、思考或工具调用片段，越过内容交付边界，严禁换号
      if (hasContentDelta || reasoningDelivered || hasToolDelta) {
        fState.contentDelivered = true;
      }

      if (hasContentDelta) sawContent = true;
      if (typeof delta.reasoning_content === 'string') reasoningText += delta.reasoning_content;

      // 1) 工具调用碎片：累积，不转发
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) {
        for (const tc of delta.tool_calls) {
          if (!tc) continue;
          const i = tc.index == null ? 0 : tc.index;
          const cur = toolAcc.get(i) || { id: '', type: 'function', name: '', args: '' };
          if (tc.id) cur.id = tc.id;
          if (tc.type) cur.type = tc.type;
          if (tc.function && tc.function.name) cur.name += tc.function.name;
          if (tc.function && tc.function.arguments) cur.args += tc.function.arguments;
          toolAcc.set(i, cur);
        }
        let currentToolArgsTotal = 0;
        for (const [, c] of toolAcc.entries()) {
          currentToolArgsTotal += (c.args ? c.args.length : 0);
        }
        if (currentToolArgsTotal > MAX_TOOL_ARG_BYTES) {
          log('tool arguments aggregation exceeded MAX_TOOL_ARG_BYTES: %d', currentToolArgsTotal);
          settled = true;
          upReq.destroy(new Error('tool_arguments_too_large'));
          write(`data: ${JSON.stringify({
            error: {
              message: `工具调用参数累计超过 ${Math.round(MAX_TOOL_ARG_BYTES / 1024 / 1024)}MB 上限`,
              type: 'invalid_request_error',
              code: 'tool_arguments_too_large',
            },
          })}\n\n`);
          if (!res.writableEnded) res.end();
          return;
        }
        return;
      }

      // 1b) 老式 function_call：部分后端（含某些中转）还在用这个字段，
      //     平台只认 tool_calls，原样透传会得到一条空消息。这里转成 tool_calls。
      if (delta.function_call && typeof delta.function_call === 'object') {
        const fc = delta.function_call;
        const cur = toolAcc.get(0) || { id: '', type: 'function', name: '', args: '' };
        if (fc.name) cur.name += fc.name;
        if (fc.arguments) {
          cur.args += typeof fc.arguments === 'string' ? fc.arguments : JSON.stringify(fc.arguments);
        }
        toolAcc.set(0, cur);
        if (cur.args && cur.args.length > MAX_TOOL_ARG_BYTES) {
          log('tool arguments aggregation exceeded MAX_TOOL_ARG_BYTES: %d', cur.args.length);
          settled = true;
          upReq.destroy(new Error('tool_arguments_too_large'));
          write(`data: ${JSON.stringify({
            error: {
              message: `工具调用参数累计超过 ${Math.round(MAX_TOOL_ARG_BYTES / 1024 / 1024)}MB 上限`,
              type: 'invalid_request_error',
              code: 'tool_arguments_too_large',
            },
          })}\n\n`);
          if (!res.writableEnded) res.end();
          return;
        }
        return;
      }

      // 2) finish_reason 帧：如果前面攒了工具调用，先补发完整的一帧；
      //    如果整轮一个字的正文都没有、只有思考，也在这里兜底补发，保证在 finish 之前
      if (ch.finish_reason) {
        lastFinish = ch.finish_reason;
        if (toolAcc.size) emitToolCalls();
      }

      // 3) 规范化 delta：content 用空串代替 null，剥掉 reasoning_content
      const outDelta = { ...delta };
      if (outDelta.content === null) outDelta.content = '';
      if (REASONING === 'off') delete outDelta.reasoning_content;
      // 4) 只有 role 的帧，补一个空 content，避免严格客户端渲染 null
      if (outDelta.content === undefined && !outDelta.tool_calls && Object.keys(outDelta).length) {
        // 保留 reasoning/role 等字段，但确保 content 存在
        outDelta.content = '';
      }
      // 5) finish_reason 归一：老式 function_call 统一说成 tool_calls，平台才认
      const finishReason = ch.finish_reason === 'function_call' ? 'tool_calls' : ch.finish_reason;
      write(`data: ${JSON.stringify({ ...j, choices: [{ ...ch, delta: outDelta, finish_reason: finishReason }] })}\n\n`);
    };

    upRes.on('data', (chunk) => {
      if (abandoned) return;
      if (rawDump) rawDump.push(chunk);
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        if (abandoned) return;
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        handleBlock(block);
      }
    });
    upRes.on('end', () => {
      if (abandoned || settled) return;
      settled = true;
      if (res.writableEnded) return;
      if (buf.trim()) handleBlock(buf);
      if (abandoned) return;

      // ADR-0004 & Issue #06: 上游流意外提前断开且未下发过 [DONE]
      if (!sentDone && !sawUpstreamDone) {
        // 未交付内容：安全换号
        if (!fState.contentDelivered) {
          if (tryFailover({ networkError: true, statusCode: 502, message: 'upstream connection closed prematurely before DONE' })) {
            return;
          }
        }
        // 已交付内容或不可重试：严禁伪造 [DONE] 或 finish_reason: 'stop'！下发明确中断失败帧
        log('Stream interrupted prematurely after %s tokens delivered', fState.contentDelivered ? 'content' : 'metadata');
        write(`data: ${JSON.stringify({
          error: {
            message: 'stream interrupted: upstream connection closed prematurely',
            type: 'upstream_error',
            code: 'stream_interrupted',
          },
        })}\n\n`);
        setLogError(req, 'stream interrupted: upstream connection closed prematurely');
        logMeta(req).streamInterrupted = true;
        if (!res.writableEnded) res.end();
        return;
      }

      emitToolCalls();
      if (!sentDone) { write('data: [DONE]\n\n'); sentDone = true; }
      if (!sawContent && !emittedToolCount) {
        log('⚠ 空回复：上游既没给正文也没给工具调用（finish_reason=%s，思考 %d 字）',
          lastFinish, reasoningText.length);
      }
      if (rawDump) {
        dumpWrite(`${dumpId}-up.sse`, Buffer.concat(rawDump));
        log('dump written: %s-{req.json,up.sse}', dumpId);
      }
      recordUsage(sessionId, logModel, usage, {
        keyName,
        sess,
        keyId,
        accountId: account.id,
        latencyMs: Date.now() - attemptStartedAt,
      });
      logMeta(req).model = logModel;
      setLogUsage(req, usage);
      if (!res.writableEnded) res.end();
      log('direct stream done session=%s model=%s content=%s tools=%d reasoning=%d usage=%j',
        sessionId, logModel, sawContent, emittedToolCount, reasoningText.length, usage);
    });
    upRes.on('error', (e) => {
      if (abandoned || settled) return;
      settled = true;
      log('upstream stream error: %s', e.message);
      if (!fState.contentDelivered && tryFailover({ networkError: true, statusCode: 502, message: e.message })) {
        return;
      }
      if (fState.contentDelivered) {
        write(`data: ${JSON.stringify({
          error: {
            message: 'stream interrupted: ' + e.message,
            type: 'upstream_error',
            code: 'stream_interrupted',
          },
        })}\n\n`);
        setLogError(req, 'stream interrupted: ' + e.message);
        logMeta(req).streamInterrupted = true;
      }
      try { if (!res.writableEnded) res.end(); } catch { /* ignore */ }
    });
  });

  // ADR-0013：首字节超时与"空闲超时"是两回事。空闲超时由 socket timeout 负责，
  // 首字节超时管的是"请求已发出、上游迟迟不回第一个字节"的情形。
  const firstByteMs = runtimeConfig.getMs('first_byte_timeout_sec');
  if (firstByteMs > 0) {
    firstByteTimer = setTimeout(() => {
      if (settled || abandoned) return;
      log('upstream first byte timeout after %dms', firstByteMs);
      try { upReq.destroy(new Error('first byte timeout')); } catch (_) {}
    }, firstByteMs);
    if (firstByteTimer.unref) firstByteTimer.unref();
  }

  // ADR-0013：短请求超时是「从发起到拿到完整响应」的总时长上限。
  // 用一次性定时器而不是 socket timeout，否则上游慢速滴流可以无限延长。
  if (!stream) {
    const shortMs = runtimeConfig.getMs('short_request_timeout_sec');
    if (shortMs > 0) {
      shortDeadlineTimer = setTimeout(() => {
        if (settled || abandoned || !upReq) return;
        log('upstream short request deadline exceeded after %dms', shortMs);
        try { upReq.destroy(new Error('short request deadline exceeded')); } catch (_) {}
      }, shortMs);
      if (shortDeadlineTimer.unref) shortDeadlineTimer.unref();
    }
  }

  upReq.on('timeout', () => {
    if (abandoned) return;
    upReq.destroy(new Error('upstream timeout'));
  });
  upReq.on('error', (e) => {
    clearAttemptTimers();
    if (abandoned || settled) return;
    settled = true;
    log('upstream connect failed: %s', e.message);
    if (!signal.aborted && !fState.contentDelivered && tryFailover({ networkError: true, timeout: e.message.includes('timeout'), statusCode: 504, message: e.message })) {
      return;
    }
    if (!res.headersSent) {
      if (signal.aborted) {
        try { if (!res.writableEnded) res.end(); } catch (_) {}
        return;
      }
      setLogError(req, '连不上上游 ' + ROUTER_BASE + ': ' + e.message);
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        error: { message: '连不上上游 ' + ROUTER_BASE + ': ' + e.message, type: 'upstream_error', code: 'upstream_unreachable' },
      }));
    } else {
      if (!res.writableEnded) {
        if (!signal.aborted) {
          try {
            res.write(`data: ${JSON.stringify({
              error: { message: 'stream interrupted: ' + e.message, type: 'upstream_error', code: 'upstream_unreachable' }
            })}\n\n`);
          } catch (_) {}
        }
        try { res.end(); } catch (_) {}
      }
    }
  });

  // 客户端断开 -> 主动断开上游，避免白烧 token（旧监听在 abandonCurrentAttempt 中已解绑）
  res.on('close', onClientClose);
  upReq.end(bodyBuf);
}

async function handleApiModels(req, res, force) {
  accountPool.reloadIfChanged();
  refreshModelsIfConfigChanged();
  await refreshReal(force);
  const poolModels = accountPool.getAllAvailableModels(getAllowedAccounts(req));
  const data = poolModels.map((m) => {
    const mi = MODEL_INFO.get(m.id);
    return {
      id: m.id, name: m.name || m.id, reasoning: m.reasoning, input: m.input || ['text'],
      context_window: m.context_window, max_tokens: m.max_tokens,
      multiplier: (mi && mi.multiplier != null) ? mi.multiplier : (m.multiplier ?? 1),
      costTag: (mi && mi.costTag) ? mi.costTag : (m.costTag || ''),
      ratio: (mi && mi.ratio) ? mi.ratio : (m.ratio || ''),
      ratioReal: !!(mi && mi.ratioReal),
      supportedAccounts: m.supportedAccounts,
    };
  });
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ object: 'list', data, real: { ok: !!REAL.ok, error: REAL.error || null } }));
}

function readJsonBody(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > limit) {
        req.destroy();
        reject(new Error('body_too_large'));
      }
    });
    req.on('end', () => {
      try {
        const parsed = body.trim() ? JSON.parse(body) : {};
        resolve(parsed);
      } catch {
        reject(new Error('invalid_json'));
      }
    });
    req.on('error', reject);
  });
}

async function handleAdminLogin(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'Method Not Allowed', code: 'method_not_allowed' } }));
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'invalid request body', code: 'bad_request' } }));
  }
  if (!credentialsContext.adminAuth.isConfigured()) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: '管理口令未配置，请先通过环境变量或安装向导设置', code: 'admin_not_configured' } }));
  }
  const password = typeof body.password === 'string' ? body.password : '';
  if (!credentialsContext.adminAuth.verifyPassword(password)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: '管理口令错误', code: 'invalid_credentials' } }));
  }
  const session = credentialsContext.sessionStore.createSession(credentialsContext.adminAuth.getPasswordFingerprint());
  const cookie = serializeAdminCookie(session.token, credentialsContext.sessionStore.ttlSec);
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Set-Cookie': cookie,
  });
  res.end(JSON.stringify({
    ok: true,
    token: session.token,
    expires_at: new Date(session.expiresAt).toISOString(),
  }));
}

function handleAdminLogout(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'Method Not Allowed', code: 'method_not_allowed' } }));
  }
  const cookies = parseCookies(req);
  const cookieToken = cookies['aiwork_admin_session'];
  const authHeader = req.headers['authorization'] || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const token = bearerToken || cookieToken;
  if (token) {
    credentialsContext.sessionStore.destroySession(token);
  }
  const cookie = serializeAdminCookie('', 0);
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Set-Cookie': cookie,
  });
  res.end(JSON.stringify({ ok: true }));
}

function handleAdminSession(req, res) {
  const authRes = credentialsContext.authenticateAdmin(req);
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({
    ok: true,
    authenticated: Boolean(authRes.ok),
    configured: credentialsContext.adminAuth.isConfigured(),
    session: authRes.session ? {
      expires_at: new Date(authRes.session.expiresAt).toISOString(),
    } : null,
  }));
}

async function handleAdminPassword(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'Method Not Allowed', code: 'method_not_allowed' } }));
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'invalid request body', code: 'bad_request' } }));
  }
  if (typeof body.password !== 'string' || body.password.length < 4) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: '管理口令长度至少为 4 个字符', code: 'invalid_password' } }));
  }
  credentialsContext.adminAuth.setPassword(body.password);
  credentialsContext.sessionStore.destroyAllSessions();
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: true, message: '管理口令已更新，既有会话已失效' }));
}

async function handleAdminKeysRoute(req, res, url) {
  const parts = url.split('?')[0].split('/').filter(Boolean);
  if (parts.length === 3) {
    if (req.method === 'GET') {
      // 默认只给脱敏值：明文凭据不该随列表一次性落到浏览器里。
      // 需要看完整 Key 时由 GET /api/admin/keys/:id/token 单独按需取。
      const keys = credentialsContext.keyStore.listKeys({ mask: true });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ ok: true, keys }));
    }
    if (req.method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'invalid request body', code: 'bad_request' } }));
      }
      try {
        const key = credentialsContext.keyStore.createKey(body);
        res.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: true, key }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: err.message, code: 'bad_request' } }));
      }
    }
  } else if (parts.length === 4) {
    const id = parts[3];
    if (req.method === 'GET') {
      const key = credentialsContext.keyStore.getKeyById(id);
      if (!key) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'key not found', code: 'not_found' } }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, key }));
    }
    if (req.method === 'PATCH') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'invalid request body', code: 'bad_request' } }));
      }
      try {
        const key = credentialsContext.keyStore.updateKey(id, body);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: true, key }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: err.message, code: 'bad_request' } }));
      }
    }
    if (req.method === 'DELETE') {
      try {
        const key = credentialsContext.keyStore.revokeKey(id);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: true, key }));
      } catch (err) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: err.message, code: 'not_found' } }));
      }
    }
  } else if (parts.length === 5 && parts[4] === 'revoke') {
    const id = parts[3];
    if (req.method === 'POST') {
      try {
        const key = credentialsContext.keyStore.revokeKey(id);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: true, key }));
      } catch (err) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: err.message, code: 'not_found' } }));
      }
    }
  } else if (parts.length === 5 && parts[4] === 'token') {
    // 列表默认脱敏，这是唯一的明文出口：一次请求、一把 Key、不可缓存。
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'GET' });
      return res.end(JSON.stringify({ error: { message: 'Method Not Allowed', code: 'method_not_allowed' } }));
    }
    const id = parts[3];
    const key = credentialsContext.keyStore.getKeyById(id);
    if (!key) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'key not found', code: 'not_found' } }));
    }
    log('key token revealed id=%s name=%s', id, key.name);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
    });
    return res.end(JSON.stringify({ ok: true, token: key.token }));
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
}

async function handleAdminAccountsRoute(req, res, url) {
  const fullReqUrl = req.url || url;
  const urlObj = new URL(fullReqUrl, 'http://127.0.0.1');
  const pathname = urlObj.pathname;
  const parts = pathname.split('/').filter(Boolean);

  // 1. 设备授权流端点
  if (pathname === '/api/admin/accounts/device-login/start' && req.method === 'POST') {
    let body = {};
    try { body = await readJsonBody(req); } catch (_) {}
    try {
      const sess = await dynamicAccountManager.deviceLoginManager.startSession(body);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, ...sess }));
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: { message: err.message, code: 'upstream_auth_error' } }));
    }
  }

  if (pathname === '/api/admin/accounts/device-login/poll' && req.method === 'GET') {
    const sessionId = urlObj.searchParams.get('session_id') || urlObj.searchParams.get('sessionId');
    if (!sessionId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'session_id 必填', code: 'bad_request' } }));
    }
    const polled = await dynamicAccountManager.deviceLoginManager.pollSession(sessionId);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(polled));
  }

  // 2. 快捷导入端点
  if (pathname === '/api/admin/accounts/import' && req.method === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'invalid request body', code: 'bad_request' } }));
    }
    try {
      // 手动粘贴 Router Key 时，若未附带模型目录，就用该 key 拉取实时目录，
      // 避免落盘成 automodel / auto-high 两个占位模型。
      const payload = { ...body };
      if ((!Array.isArray(payload.models) || payload.models.length === 0) && payload.routerKey) {
        try {
          payload.models = await fetchLiveRouterModels(payload.routerKey, process.env.ROUTER_BASE_URL);
        } catch (e) {
          log('live model catalog fetch on import failed: %s', e.message);
        }
      }
      const imported = dynamicAccountManager.importAccount(payload);
      res.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, account: imported }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: err.message, code: 'bad_request' } }));
    }
  }

  // 3. 额度聚合看板端点
  if (pathname === '/api/admin/accounts/billing' && req.method === 'GET') {
    try {
      const billing = await dynamicAccountManager.getBillingOverview();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, billing }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: err.message, code: 'server_error' } }));
    }
  }

  // 4. 账号列表与新增
  if (parts.length === 3) {
    if (req.method === 'GET') {
      accountPool.reloadIfChanged();
      const accounts = accountPool.listAccounts({ mask: true }).map((acc) => {
        const st = (STATE.byAccount && STATE.byAccount[acc.id]) || {};
        return {
          ...acc,
          in_cooldown: sessionRouter.isCooledDown(acc.id),
          cooldown_remaining_sec: Math.round(sessionRouter.getCooldownRemaining(acc.id) / 1000),
          active_requests: sessionRouter.getActiveRequests(acc.id),
          // 账号池表格的指标（ADR-0016）：次数/token 累计，延迟与 tok/s 是最近一次，
          // 成功/失败按尝试计；没打过流量的账号这些是 0 / null，界面显示「—」。
          usage: {
            requests: st.requests || 0,
            tokens: st.tokens || 0,
            success: st.success || 0,
            errors: st.errors || 0,
            last_success_at: st.lastSuccessAt || null,
            last_latency_ms: st.lastLatencyMs ?? null,
            last_tok_per_sec: st.lastTokPerSec ?? null,
          },
        };
      });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, accounts }));
    }
    if (req.method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'invalid request body', code: 'bad_request' } }));
      }
      try {
        const inst = accountPool.addAccount(body);
        res.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: true, account: inst.toJSON({ mask: true }) }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: err.message, code: 'bad_request' } }));
      }
    }
  } else if (parts.length === 4) {
    const id = parts[3];
    if (req.method === 'GET') {
      const acc = accountPool.getAccount(id);
      if (!acc) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'account not found', code: 'not_found' } }));
      }
      const data = {
        ...acc.toJSON({ mask: true }),
        in_cooldown: sessionRouter.isCooledDown(id),
        cooldown_remaining_sec: Math.round(sessionRouter.getCooldownRemaining(id) / 1000),
        active_requests: sessionRouter.getActiveRequests(id),
      };
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, account: data }));
    }
    if (req.method === 'PATCH' || req.method === 'PUT') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'invalid request body', code: 'bad_request' } }));
      }
      try {
        const acc = dynamicAccountManager.patchAccount(id, body);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: true, account: acc }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: err.message, code: 'bad_request' } }));
      }
    }
    if (req.method === 'DELETE') {
      try {
        dynamicAccountManager.deleteAccount(id);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: true, deleted_id: id }));
      } catch (err) {
        const status = err.message && err.message.includes('受到保护') ? 403 : 404;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: err.message, code: status === 403 ? 'forbidden' : 'not_found' } }));
      }
    }
  } else if (parts.length === 5 && parts[4] === 'cooldown') {
    const id = parts[3];
    const acc = accountPool.getAccount(id);
    if (!acc) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'account not found', code: 'not_found' } }));
    }
    if (req.method === 'POST') {
      let body = {};
      try { body = await readJsonBody(req); } catch (_) {}
      if (body.clear) {
        sessionRouter.clearCooldown(id);
        if (acc.status === 'needs_reauth') {
          acc.checkStatus();
        }
      } else {
        const sec = Number(body.duration_sec || body.duration_s || 60);
        sessionRouter.setCooldown(id, sec * 1000);
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({
        ok: true,
        account_id: id,
        in_cooldown: sessionRouter.isCooledDown(id),
        cooldown_remaining_sec: Math.round(sessionRouter.getCooldownRemaining(id) / 1000),
      }));
    }
  } else if (parts.length === 5 && parts[4] === 'credits') {
    // 单账号积分刷新（行内「刷新积分」）：只打这个账号的上游，不动其他账号的缓存。
    const id = parts[3];
    const acc = accountPool.getAccount(id);
    if (!acc) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'account not found', code: 'not_found' } }));
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST' });
      return res.end(JSON.stringify({ error: { message: 'Method Not Allowed', code: 'method_not_allowed' } }));
    }
    try {
      const credits = await dynamicAccountManager.getAccountCredits(id, { force: true });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ ok: true, credits }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: err.message, code: 'credits_refresh_failed' } }));
    }
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
}

async function handleAdminDebugTime(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'Method Not Allowed', code: 'method_not_allowed' } }));
  }
  let body = {};
  try { body = await readJsonBody(req); } catch (_) {}

  if (body.reset) {
    sessionRouter.clearAllBindings();
    for (const acc of accountPool.listAccounts()) {
      const inst = accountPool.getAccount(acc.id);
      if (inst && inst.status === 'needs_reauth') {
        inst.checkStatus();
      }
    }
  }

  if (body.advance_ms) {
    sessionRouter.fastForward(Number(body.advance_ms) || 0);
  } else if (body.advance_sec) {
    sessionRouter.fastForward((Number(body.advance_sec) || 0) * 1000);
  }

  if (body.max_account_attempts !== undefined) {
    sessionRouter.maxAccountAttempts = SessionRouter.parseMaxAccountAttempts(body.max_account_attempts);
  }

  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  return res.end(JSON.stringify({
    ok: true,
    now: sessionRouter.now(),
    offset_ms: sessionRouter.timeOffsetMs,
    max_account_attempts: sessionRouter.maxAccountAttempts,
  }));
}

async function handleAdminAliasesRoute(req, res, url) {
  const parts = url.split('?')[0].split('/').filter(Boolean);
  if (parts.length === 3) {
    if (req.method === 'GET') {
      const aliases = modelAliasManager.listAliases();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, aliases }));
    }
    if (req.method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'invalid request body', code: 'bad_request' } }));
      }
      try {
        const target = body.target || body.targetModel;
        const entry = modelAliasManager.setAlias(body.alias, target);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: true, alias: entry.alias, target: entry.target }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: err.message, code: 'bad_request' } }));
      }
    }
  } else if (parts.length === 4) {
    const alias = decodeURIComponent(parts[3]);
    if (req.method === 'DELETE') {
      const deleted = modelAliasManager.removeAlias(alias);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, deleted }));
    }
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
}

// ADR-0009：仪表盘与请求日志对调用凭据只读开放。
// 未启用管理口令时 authenticateAdmin 已回落到调用凭据，这里的第二次尝试不会发生；
// 启用口令后它会拒绝调用凭据，因此必须再试一次 invocation，否则零回归的只读视图会被口令挡住。
function authenticateDashboardReader(req) {
  const adminAuth = credentialsContext.authenticateAdmin(req);
  if (adminAuth.ok) return adminAuth;
  return credentialsContext.authenticateInvocation(req);
}

async function handleApiDashboard(req, res, force) {
  // ADR-0009：调用凭据可读部署级只读仪表盘；写操作仍然只能走管理会话。
  const auth = authenticateDashboardReader(req);
  if (!auth.ok) {
    res.writeHead(auth.status || 401, {
      'Content-Type': 'application/json',
      'WWW-Authenticate': 'Bearer',
    });
    return res.end(JSON.stringify({ error: { message: auth.error, code: auth.code } }));
  }

  await refreshModelCatalog(force);
  accountPool.reloadIfChanged();
  const accounts = accountPool.listAccounts();

  let credits;
  try {
    credits = await dynamicAccountManager.getCreditsOverview({ force });
  } catch (err) {
    credits = { ok: false, accounts: {}, total_total: null, total_used: null, total_remaining: null, error: err.message || 'credits_unavailable' };
  }

  const models = [...MODEL_INFO.values()].map((m) => ({
    id: m.id,
    name: m.name || m.id,
    ratio: m.ratio || '',
    multiplier: m.multiplier != null ? m.multiplier : null,
    context_window: m.context_window || null,
    cost_tag: m.costTag || '',
    reasoning: !!m.reasoning,
    ratio_real: !!m.ratioReal,
  }));

  const poolAccounts = accounts.map((a) => ({
    id: a.id,
    name: a.name,
    source: a.source,
    status: a.status,
    ready: !!a.ready,
    enabled: a.enabled !== false,
    // 暂停选号：账号仍 ready，但不再接新会话；仪表盘摘要要能看出来（ADR-0016）
    paused: a.paused === true,
    models_count: a.modelsCount || 0,
  }));

  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({
    ok: true,
    generated_at: Date.now(),
    status: {
      ready: poolAccounts.some((a) => a.ready),
      auth_required: AUTH_ON,
      models: models.length,
      accounts_available: poolAccounts.filter((a) => a.ready).length,
      accounts_total: poolAccounts.length,
    },
    pool: {
      total: poolAccounts.length,
      ready: poolAccounts.filter((a) => a.ready).length,
      disabled: poolAccounts.filter((a) => a.enabled === false).length,
      attention: poolAccounts.filter((a) => !a.ready),
      accounts: poolAccounts,
    },
    // ADR-0011：积分是唯一额度口径。Router 账单（total_usage 为累计美分、
    // hard_limit_usd 是无限制哨兵）不再参与展示，也不再为此发起上游请求。
    local: {
      tokens: STATE.tokens,
      requests: STATE.requests,
      by_model: STATE.byModel || {},
    },
    credits,
    models,
  }));
}

// ADR-0009 边界：与仪表盘同权限的只读视图，只回放内存中已有的请求元数据。
// 查询参数：account / model / q（包含匹配，大小写不敏感）、outcome / status（精确）、
// from / to（闭区间，unix 秒或 ISO 8601）、limit（过滤后截断，受缓冲容量上限约束）。
function handleApiLogs(req, res, query) {
  const auth = authenticateDashboardReader(req);
  if (!auth.ok) {
    res.writeHead(auth.status || 401, {
      'Content-Type': 'application/json',
      'WWW-Authenticate': 'Bearer',
    });
    return res.end(JSON.stringify({ error: { message: auth.error, code: auth.code } }));
  }

  const parsed = parseLogFilters(query);
  if (parsed.error) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({
      error: { message: parsed.error, type: 'invalid_request_error', code: 'invalid_log_filter' },
    }));
  }

  const matchedRows = readRequestLog(parsed.filters);
  const limit = Math.max(1, Math.min(REQ_LOG_CAPACITY, Number(query.get('limit')) || 50));
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  return res.end(JSON.stringify({
    ok: true,
    entries: matchedRows.slice(0, limit),
    matched: matchedRows.length,
    total: REQ_LOG.length,
    capacity: REQ_LOG_CAPACITY,
    // 归档占用：页面在筛选栏旁展示。归档关闭时 enabled=false，内存记录照常返回。
    archive: requestLogArchive.stats(),
  }));
}

async function handleApiUsage(req, res, force) {
  const adminAuth = credentialsContext.authenticateAdmin(req);
  // ADR-0011 零回归：/api/usage 的全局视图（byKey / byAccount / real）只给真正的管理会话。
  // 未设管理口令时 authenticateAdmin 会以调用凭据通过，那种情形必须继续走下面的个人视图，
  // 否则任何一把调用凭据都能读到全部署用量。
  if (adminAuth.ok && adminAuth.type !== 'invocation') {
    const real = await refreshReal(force);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(usageSnapshot(real)));
  }

  const invAuth = credentialsContext.authenticateInvocation(req);
  if (invAuth.ok) {
    const key = invAuth.key;
    const allSessions = Object.values(STATE.sessions || {});
    // 归属只认 keyId；老会话可能没有 keyId，才用名字兜底。
    // 名字兜底不能无条件启用：createKey 不校验重名，两把同名 Key 会互相读到对方的用量。
    const mySessions = allSessions
      .filter((s) => (s.keyId ? s.keyId === key.id : (s.key && s.key === key.name)))
      .map((s) => ({
        id: s.id || s.rawId || s.scopedId,
        explicit: !!s.explicit,
        label: s.label || '',
        model: s.model || '',
        requests: s.requests || 0,
        tokens: s.tokens || 0,
        input: s.input || 0,
        output: s.output || 0,
        firstAt: s.firstAt,
        lastAt: s.lastAt,
      }));

    const keyStat = (STATE.byKey && (STATE.byKey[key.id] || STATE.byKey[key.name])) || {};
    const sessionInput = mySessions.reduce((acc, s) => acc + (s.input || 0), 0);
    const sessionOutput = mySessions.reduce((acc, s) => acc + (s.output || 0), 0);
    // 有 key.stats 就以它为准；0 是合法值（刚重置过），不能因为它是假值就回落到 byKey——
    // 那会让「重置」在真实流量下看起来完全没生效。
    const hasKeyStats = Boolean(key.stats);
    const totalTokens = hasKeyStats ? (key.stats.tokens || 0) : (keyStat.tokens || (sessionInput + sessionOutput));
    const reqCount = hasKeyStats ? (key.stats.requests || 0) : (keyStat.requests || 0);
    const cachedTokens = hasKeyStats ? (key.stats.cached || 0) : (keyStat.cached || 0);
    const spent = hasKeyStats ? (key.stats.spent || 0) : (keyStat.spent || 0);
    // 分方向计数优先用凭据自己的计数器；老数据没有这两列（null）时才回落到会话聚合，
    // 避免「合计来自计数器、输入输出来自会话」两个口径混用。
    const inputTokens = (hasKeyStats && key.stats.input != null) ? key.stats.input : sessionInput;
    const outputTokens = (hasKeyStats && key.stats.output != null) ? key.stats.output : sessionOutput;
    // 按模型聚合：STATE.byModel 是部署级的，个人视图不能直接给出去；
    // 用本凭据的会话聚合出来，否则默认部署（管理权限随调用凭据）下这张卡片永远是空的。
    const byModel = {};
    for (const s of mySessions) {
      if (!s.model) continue;
      const cur = (byModel[s.model] = byModel[s.model] || { tokens: 0, requests: 0 });
      cur.tokens += s.tokens || 0;
      cur.requests += s.requests || 0;
    }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      tokens: {
        input: inputTokens,
        output: outputTokens,
        total: totalTokens,
        cached: cachedTokens,
      },
      requests: reqCount,
      spent: spent,
      sessions: mySessions.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0)).slice(0, 20),
      session_count: mySessions.length,
      balance: 0,
      remaining: 0,
      costPer1k: STATE.costPer1k,
      byModel,
      real: { ok: false, error: 'admin_only' },
    }));
  }

  res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' });
  res.end(JSON.stringify({ error: { message: 'authentication required', code: 'unauthorized' } }));
}

// 用量账本的读取口径（票 07）：窗口、三组明细与趋势序列。
// 窗口二选一：hours 滚动窗口（最多 60 天，超出钳制）或 from/to 显式闭区间。
function handleApiUsageBuckets(req, res, query) {
  // 与 /api/dashboard、/api/logs 同一口径（ADR-0009 的部署级只读视图）：
  // 管理会话或有效调用凭据均可读。原先只放行管理会话，结果是默认部署（不设口令）
  // 下页面用调用凭据请求会 403，用量页根本打不开；而账本里的维度（账号、模型、按凭据的
  // 用量汇总）与请求日志相比并没有多出敏感类别，日志本来就对调用凭据开放。
  const auth = authenticateDashboardReader(req);
  if (!auth.ok) {
    const status = auth.status || 401;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'WWW-Authenticate': 'Bearer' });
    return res.end(JSON.stringify({
      error: { message: auth.error, type: 'authentication_error', code: auth.code },
    }));
  }

  // 窗口参数的合法性由 usageRecorder.query 判定（hours / from / to 的校验只此一处，
  // 免得 handler 与账本对同一个参数给出两种错误码）。这里只做参数搬运：
  // 空串视为未提供，非空原样传下去；错误的 400 统一按 err.code 返回。
  const rawGranularity = query.get('granularity');
  const params = {};

  if (rawGranularity !== null && rawGranularity !== '') {
    if (rawGranularity !== 'hour' && rawGranularity !== 'day') {
      return sendInvalidWindow(res, 'granularity 只能是 hour 或 day', 'invalid_granularity');
    }
    params.granularity = rawGranularity;
  }

  const rawFrom = query.get('from');
  const rawTo = query.get('to');
  if (rawFrom !== null && rawFrom !== '') params.from = rawFrom;
  if (rawTo !== null && rawTo !== '') params.to = rawTo;

  const rawHours = query.get('hours');
  if (rawHours !== null && rawHours !== '') params.hours = rawHours;

  // 可选账号过滤（页面从账号池/按账号表跳过来时带）：只统计这一个账号。
  // 不传时空串，查询逻辑完全不筛，默认行为与改造前一致；
  // 账号已被删除时只是命中 0 个桶，返回空结果而不是错误。
  const rawAccount = query.get('account');
  if (rawAccount !== null && rawAccount !== '') params.account = String(rawAccount).trim();

  let result;
  try {
    result = usageRecorder.query(params);
  } catch (err) {
    return sendInvalidWindow(res, err.message, err.code || 'invalid_window', 400);
  }

  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  // 顶层同时展开 totals：老调用方（此前的 hours 版本）读 requests/total_tokens 不受影响。
  // ledger 是账本自身状态：当前桶数、硬上限，以及因上限被拒收的记录条数（>0 说明账本在丢数）。
  return res.end(JSON.stringify({ ok: true, ...result.totals, ...result, ledger: usageRecorder.stats() }));
}

function sendInvalidWindow(res, message, code, status = 400) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  return res.end(JSON.stringify({
    error: { message, type: 'invalid_request_error', code },
  }));
}

// 管理用：谁在调用、各自耗了多少（需管理鉴权）
function handleApiKeys(req, res) {
  const adminAuth = credentialsContext.authenticateAdmin(req);
  if (!adminAuth.ok) {
    res.writeHead(adminAuth.status || 401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: adminAuth.error, code: adminAuth.code } }));
  }
  const rows = credentialsContext.keyStore.listKeys({ mask: true }).map((k) => ({
    id: k.id,
    name: k.name,
    token: k.token,
    revoked: k.revoked,
    account_policy: k.account_policy,
    requests: k.stats.requests || (STATE.byKey[k.name] || {}).requests || 0,
    tokens: k.stats.tokens || (STATE.byKey[k.name] || {}).tokens || 0,
  }));
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ object: 'list', data: rows }));
}

async function handleApiBalance(req, res, force) {
  const adminAuth = credentialsContext.authenticateAdmin(req);
  if (!adminAuth.ok) {
    res.writeHead(adminAuth.status || 401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: adminAuth.error, code: adminAuth.code } }));
  }
  if (req.method === 'GET') {
    const real = await refreshReal(force);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      balance: STATE.balance, costPer1k: STATE.costPer1k,
      real: usageSnapshot(real).real,
    }));
    return;
  }
  // POST: 设置余额 / 单价 / 重置统计
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
  req.on('end', async () => {
    try {
      const p = JSON.parse(body || '{}');
      if (typeof p.balance === 'number' && isFinite(p.balance)) STATE.balance = p.balance;
      if (typeof p.costPer1k === 'number' && isFinite(p.costPer1k) && p.costPer1k > 0) STATE.costPer1k = p.costPer1k;
      if (p.reset === true) resetLocalStats();
      else persistState();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(usageSnapshot()));
    } catch {
      res.writeHead(400); res.end('bad json');
    }
  });
}

/**
 * 重置「本机统计」的唯一实现。
 * /api/balance 与 /api/local-stats/reset 都从这里走，避免两处各写一遍清零语句后口径分叉。
 * 范围：网关自己累计的全部计数器——token/请求/花费/按模型，以及按凭据、按账号、按会话的维度。
 * 不范围：上游积分（账号口径，见 ADR-0011）与凭据本身（Key 不删、权限不变）。
 *
 * 为什么连 byKey / byAccount / sessions 一起清：页面上的「本机统计」由它们拼出来，
 * 只清 STATE.tokens 会出现「合计 0、输入 600、按模型还有数」的自相矛盾。
 * 这三者都是计数器（不含任何消息正文），不是需要保留的历史。
 */
function resetLocalStats() {
  STATE.spent = 0;
  STATE.tokens = { input: 0, output: 0, total: 0 };
  STATE.requests = 0;
  STATE.byModel = {};
  STATE.byKey = {};
  STATE.byAccount = {};
  STATE.sessions = {};
  // 个人视图优先读 key.stats；不同步清零的话，页面上的「重置」看起来没反应。
  credentialsContext.keyStore.resetAllStats();
  // 重置是低频、且语义上要求立刻生效的动作：同步落盘，避免刚点完就被崩溃/重启「复活」计数。
  persistState(true);
  return usageSnapshot();
}

// POST /api/local-stats/reset -> 只重置本机统计（ADR-0013 要求页面不再碰 /api/balance）
function handleLocalStatsReset(req, res) {
  // 鉴权由 dispatch 的 isAdminOnlyRoute 前置（与其它管理端点一致），这里只校验方法与语义。
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST' });
    return res.end(JSON.stringify({ ok: false, error: { message: 'Method Not Allowed', code: 'method_not_allowed' } }));
  }
  let snapshot;
  try {
    snapshot = resetLocalStats();
  } catch (err) {
    log('local stats reset failed: %s', err.message);
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: false, error: { message: '重置本地统计失败', code: 'reset_failed' } }));
  }
  // 只回本机计数，不回整份部署快照：这个端点的语义是「重置」，
  // 附带 byKey / byAccount / sessions 等于给调用方开了一个绕过 /api/usage 权限口径的读口子。
  const usage = {
    tokens: snapshot.tokens,
    requests: snapshot.requests,
    spent: snapshot.spent,
    byModel: snapshot.byModel,
  };
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: true, usage }));
}

// GET  /api/fallback -> 当前回落模型、它的来源、可选模型列表
// POST /api/fallback { model } -> 设置回落模型；model 传空 = 清掉前端覆盖，回到 env / 自动挑
// ADR-0013：运行时配置读写。鉴权由 isAdminOnlyRoute 统一前置。
//
// 容器里跑的时候，宿主机端口归 compose 的端口映射管，进程既看不到也改不了，
// 页面据此决定「容器外端口」是给输入框还是给一条宿主机命令。
function isContainerRuntime() {
  try {
    return fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv');
  } catch (_) {
    return false;
  }
}

function settingsPayload(extra) {
  return Object.assign({
    ok: true,
    settings: runtimeConfig.getAll(),
    warnings: runtimeConfig.getWarnings(),
    // 保存值和生效值可能短暂不同（例如绑定时失败回滚），页面靠这个判断
    effective: { bind_address: activeBind, bind_port: activePort },
    container: isContainerRuntime(),
  }, extra || {});
}

/** 把 bind 的 errno 翻成人能读的一句话，前端直接展示。 */
function describeBindError(addr, err) {
  if (err.code === 'EADDRINUSE') return `监听地址 ${addr} 已被占用，请换一个地址或先停掉占用它的进程`;
  if (err.code === 'EACCES') return `没有权限监听 ${addr}，请换一个地址或用更高权限运行`;
  if (err.code === 'EADDRNOTAVAIL') return `本机没有 ${addr} 这个地址，请填写本机网卡上的 IPv4`;
  if (err.code === 'ENOTFOUND') return `找不到主机 ${addr}，请填写 IP 或本机可解析的主机名`;
  return `监听 ${addr} 失败：${err.message}`;
}

async function handleApiSettings(req, res) {
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(settingsPayload()));
  }
  if (req.method !== 'PUT') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: { message: 'Method Not Allowed', code: 'method_not_allowed' } }));
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: { message: '请求体不是合法 JSON', code: 'invalid_body' } }));
  }

  // 契约只有一种形状：扁平对象 { key: value }。之前额外接受 { sessions: {...} } 包裹层，
  // 那个名字既不是会话也不是设置分组，且只有一个调用方，属于没有需求支撑的兼容分支。
  //
  // 先只校验不落盘：监听地址要先真的绑上，才允许写进配置文件——
  // 否则绑定失败却把地址存了下来，下次重启网关会直接起不来。
  const checked = runtimeConfig.validatePatch(body);
  if (!checked.ok) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      ok: false,
      error: {
        message: checked.errors.join('；'),
        code: 'invalid_settings',
        details: checked.errors,
        ignored: checked.ignored || [],
      },
    }));
  }

  const nextBind = checked.next.bind_address;
  if (nextBind && nextBind !== activeBind) {
    const nextHost = (parseBindAddress(nextBind).host) || nextBind;
    if (unsafeOpenBind(nextHost)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({
        ok: false,
        error: {
          message: `监听 ${nextBind} 会让接口暴露在回环之外，但当前没有配置任何 API Key。`
            + '请先设置 API_KEYS；确认要在内网无鉴权运行，可在部署时加 ALLOW_OPEN_BIND=1。',
          code: 'unsafe_open_bind',
        },
      }));
    }
    try {
      await rebindServer(nextBind);
    } catch (err) {
      log('重绑监听地址 %s 失败: %s', nextBind, err.message);
      res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({
        ok: false,
        error: {
          message: describeBindError(nextBind, err),
          code: 'bind_failed',
          errno: err.code || null,
          effective: { bind_address: activeBind, bind_port: activePort },
        },
      }));
    }
    log('监听地址已切换到 %s:%s', activeHost, activePort);
  }

  const result = runtimeConfig.update(body);
  if (!result.ok) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      ok: false,
      error: {
        message: result.errors.join('；'),
        code: 'invalid_settings',
        details: result.errors,
        ignored: result.ignored || [],
      },
    }));
  }

  // 归档参数保存即生效：立刻按新设置清一次，别等下一次定时清理。
  requestLogArchive.cleanup();

  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  return res.end(JSON.stringify(settingsPayload({ ignored: result.ignored || [] })));
}

function handleApiFallback(req, res) {
  const adminAuth = credentialsContext.authenticateAdmin(req);
  if (!adminAuth.ok) {
    res.writeHead(adminAuth.status || 401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: adminAuth.error, code: adminAuth.code } }));
  }
  const reply = () => {
    refreshModelsIfConfigChanged();
    return {
      current: resolveFallbackModel(),
      source: fallbackSource(),
      options: [...MODEL_INFO.keys()],
    };
  };
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(reply()));
    return;
  }
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
  req.on('end', () => {
    let p;
    try { p = JSON.parse(body || '{}'); } catch { res.writeHead(400); res.end('bad json'); return; }
    const m = String(p.model == null ? '' : p.model).trim();
    const avail = reply().options;
    if (m && !avail.includes(m)) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: `未知模型 "${m}"`, options: avail }));
      return;
    }
    STATE.fallbackModel = m;
    persistState();
    log('回落模型已设为 %j（来源: %s）', m || '(清空)', fallbackSource());
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(reply()));
  });
}

function handleV1Models(req, res) {
  accountPool.reloadIfChanged();
  const allowed = getAllowedAccounts(req);
  const models = accountPool.getAllAvailableModels(allowed);
  const data = models.map((m) => ({
    id: m.id, object: 'model', created: 0, owned_by: 'aiwork-router',
    permission: [], root: m.id, parent: null,
  }));
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ object: 'list', data }));
}

function handleIndex(req, res) {
  try {
    const html = fs.readFileSync(INDEX_PATH, 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('index.html not found');
  }
}

function handleHealth(req, res) {
  // 轻量：给 docker HEALTHCHECK / 反代探活用
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('ok');
}

function handleStatus(req, res) {
  accountPool.reloadIfChanged();
  refreshModelsIfConfigChanged();
  const auth = authState();
  const readyAccounts = accountPool.getReadyAccounts();
  const hasKey = readyAccounts.length > 0;
  const ready = UPSTREAM === 'direct' ? hasKey : (auth.status === 'active');
  const availableModels = accountPool.getAllAvailableModels();
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({
    ok: true,
    ready,
    status: ready ? 'ready' : 'unready',
    unready_reason: ready ? null : (UPSTREAM === 'direct' ? 'router_key_missing' : 'cli_not_logged_in'),
    accounts_available: readyAccounts.length,
    accounts_total: accountPool.accounts.size,
    uptime_sec: Math.round((Date.now() - STARTED_AT) / 1000),
    agent: AGENT,
    auth_required: AUTH_ON,
    keys: credentialsContext.keyStore.keys.size,
    daemon: daemonState(),
    cli_auth: auth,
    models: availableModels.length,
    aliases_count: modelAliasManager.aliases.size,
    capabilities: {
      upstream: UPSTREAM,
      upstream_base: UPSTREAM === 'direct' ? ROUTER_BASE : 'cli-agent',
      upstream_fallback: false,
      router_key: hasKey,
      tools: true,            // 通过哨兵块协议模拟 OpenAI function calling
      images: true,           // data URL / http(s) URL / 本地路径已被安全限制
      max_images: MAX_IMAGES,
      max_body_mb: Math.round(MAX_BODY_BYTES / 1024 / 1024),
      model_override: process.env.MODEL_OVERRIDE !== '0',
      debug_dump: DEBUG_DUMP,
      // 支持哪几套协议：chat/completions 是原生，另两套是适配层翻译过来的
      protocols: {
        'chat.completions': '/v1/chat/completions',
        'openai.responses': '/v1/responses',
        'anthropic.messages': '/v1/messages',
      },
      // 客户端自带的模型名网关认不出时，回落到哪个模型（可在网页界面里改）
      // 注意：这个值只用于展示与 /api/fallback，不参与请求解析——未知模型仍然 404
      fallback_model: resolveFallbackModel(),
      fallback_source: fallbackSource(),
    },
    real_data: { ok: !!REAL.ok, error: REAL.error || null, fetchedAt: REAL.fetchedAt || 0 },
    requests: STATE.requests,
  }));
}

// --------------------------------------------------------------------------
// daemon / CLI 登录状态探测（带缓存，避免每次健康检查都 spawn 子进程）
// --------------------------------------------------------------------------
let DAEMON_CACHE = { at: 0, value: 'unknown' };
function daemonState() {
  if (UPSTREAM === 'direct') return 'disabled_in_direct_mode';
  if (Date.now() - DAEMON_CACHE.at < 15000) return DAEMON_CACHE.value;
  if (!fs.existsSync(DTCODER_BIN)) {
    DAEMON_CACHE = { at: Date.now(), value: 'cli_not_installed' };
    return DAEMON_CACHE.value;
  }
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync(DTCODER_BIN, [...DIST_ARGS, 'agent', 'list'], {
      encoding: 'utf-8', timeout: 8000, windowsHide: true,
      env: { ...process.env, http_proxy: '', https_proxy: '', HTTP_PROXY: '', HTTPS_PROXY: '' },
    });
    const line = out.split('\n').find((l) => l.trim().startsWith(AGENT + ' '));
    const st = line ? (line.trim().split(/\s+/).pop() || 'unknown') : 'missing';
    DAEMON_CACHE = { at: Date.now(), value: st };
    return st;
  } catch (e) {
    DAEMON_CACHE = { at: Date.now(), value: 'unreachable' };
    return 'unreachable';
  }
}

function checkLocalAuthState(stateDir) {
  const authPath = path.join(stateDir, 'auth.json');
  try {
    if (fs.existsSync(authPath)) {
      const j = JSON.parse(fs.readFileSync(authPath, 'utf8'));
      const entries = Array.isArray(j?.entries) ? j.entries : [];
      if (entries.length > 0) {
        const latest = entries[0];
        if (latest && typeof latest.expires_at === 'number' && latest.expires_at > 0) {
          if (latest.expires_at * 1000 < Date.now()) {
            return { status: 'expired', expiredAt: latest.expires_at };
          }
        }
        return { status: 'active', provider: latest.provider || 'aiwork' };
      }
    }
  } catch (_) {}

  const configPath = path.join(stateDir, 'config.json');
  try {
    if (fs.existsSync(configPath)) {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const ext = cfg?.aiwork?.external_auth;
      if (ext && ext.access_token) {
        let expMs = null;
        if (typeof ext.expires_at === 'number') {
          expMs = ext.expires_at > 1e11 ? ext.expires_at : ext.expires_at * 1000;
        } else if (typeof ext.expires_at === 'string') {
          expMs = Date.parse(ext.expires_at);
        }
        if (expMs && !Number.isNaN(expMs) && expMs < Date.now()) {
          return { status: 'expired', expiredAt: ext.expires_at };
        }
        return { status: 'active', provider: 'aiwork' };
      }
    }
  } catch (_) {}

  const envPath = path.join(stateDir, '.env');
  try {
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      if (/^\s*AGENTIX_CONFIG_MODELS_AIWORK_ROUTER_API_KEY\s*=\s*\S+/m.test(content)) {
        return { status: 'active', provider: 'router-env' };
      }
    }
  } catch (_) {}

  return { status: 'not_logged_in' };
}

let AUTH_CACHE = { at: 0, value: { status: 'unknown' } };
function authState() {
  if (Date.now() - AUTH_CACHE.at < 60000) return AUTH_CACHE.value;
  // 直连模式或未找到 CLI 时直接通过本地状态文件判定，无需依赖官方 CLI 运行
  if (UPSTREAM === 'direct' || !fs.existsSync(DTCODER_BIN)) {
    const local = checkLocalAuthState(STATE_DIR);
    AUTH_CACHE = { at: Date.now(), value: local };
    return AUTH_CACHE.value;
  }
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync(DTCODER_BIN, [...DIST_ARGS, 'auth', 'status', '--json'], {
      encoding: 'utf-8', timeout: 8000, windowsHide: true,
      env: { ...process.env, http_proxy: '', https_proxy: '', HTTP_PROXY: '', HTTPS_PROXY: '' },
    });
    const j = JSON.parse(out.trim().split('\n').pop());
    AUTH_CACHE = { at: Date.now(), value: { status: j.status || 'unknown' } };
  } catch (e) {
    AUTH_CACHE = { at: Date.now(), value: { status: 'unknown', error: e.message } };
  }
  return AUTH_CACHE.value;
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const xf = req.headers['x-forwarded-for'];
    if (xf) return String(xf).split(',')[0].trim();
  }
  return (req.socket && req.socket.remoteAddress) || '-';
}

// --------------------------------------------------------------------------
// Responses API 适配层（Codex CLI 这类只认 /v1/responses 的客户端）
//   它把 Responses 请求翻成 chat.completions，再交给上面同一个 runDirectPath /
//   runAgentPath 处理，所以工具调用合并、reasoning 重试、会话指纹、用量统计全部复用，
//   不会出现"两套逻辑各修各的"。
// --------------------------------------------------------------------------
const responsesAdapter = createResponsesAdapter({
  log,
  maxBodyBytes: MAX_BODY_BYTES,
  checkModel: (m) => checkModelExists(m),
  resolveModel: (requestedModel, allowedAccounts) => modelAliasManager.resolveModel(requestedModel, accountPool, allowedAccounts),
  debugDump: DEBUG_DUMP,
  dump: dumpWrite,
  // REASONING=auto 时才把客户端自己带的 reasoning.effort 透传上去；
  // 其余情况统一由网关的注入逻辑决定，避免各家取值不统一导致 400。
  reasoningAuto: String(process.env.REASONING || 'off').toLowerCase() === 'auto',
  responseHistoryManager,
  run: (rq, rs, chatBody, kn) => {
    const p = UPSTREAM === 'agent' ? runAgentPath(rq, rs, chatBody, kn) : runDirectPath(rq, rs, chatBody, kn);
    return Promise.resolve(p).catch((e) => {
      log('run path error: %s', e.stack || e.message);
      if (!rs.headersSent) {
        rs.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        rs.end(JSON.stringify({ error: { message: 'bridge: ' + e.message, type: 'server_error' } }));
      } else { try { rs.end(); } catch (_) {} }
    });
  },
});

const messagesAdapter = createMessagesAdapter({
  log,
  maxBodyBytes: MAX_BODY_BYTES,
  checkModel: (m) => checkModelExists(m),
  resolveModel: (requestedModel, allowedAccounts) => modelAliasManager.resolveModel(requestedModel, accountPool, allowedAccounts),
  debugDump: DEBUG_DUMP,
  dump: dumpWrite,
  run: (rq, rs, chatBody, kn) => {
    const p = UPSTREAM === 'agent' ? runAgentPath(rq, rs, chatBody, kn) : runDirectPath(rq, rs, chatBody, kn);
    return Promise.resolve(p).catch((e) => {
      log('run path error: %s', e.stack || e.message);
      if (!rs.headersSent) {
        rs.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        rs.end(JSON.stringify({ error: { message: 'bridge: ' + e.message, type: 'server_error' } }));
      } else { try { rs.end(); } catch (_) {} }
    });
  },
});

async function handleRequest(req, res) {
  const t0 = Date.now();
  let fullUrl = req.url || '';
  // 有些客户端会把"绝对 URL"塞进请求行（Claude Code 在工具调用后的后续请求就这么干），
  // 此时 req.url 是 "http://127.0.0.1:18080/v1/messages"，按路径匹配会全部落空变 404。
  // Node 的 http 客户端接受这种写法，所以网关这边得自己归一化。
  if (/^https?:\/\//i.test(fullUrl)) {
    try {
      const abs = new URL(fullUrl);
      fullUrl = abs.pathname + (abs.search || '');
    } catch { /* 解析不了就原样用，交给下面的 404 */ }
  }
  const url = fullUrl.split('?')[0];
  const query = new URLSearchParams(fullUrl.split('?')[1] || '');
  const force = query.get('force') === '1' || query.get('refresh') === '1';

  // CORS：默认 *，可用 CORS_ORIGIN 收紧
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Session-Id, x-api-key, anthropic-version, anthropic-beta');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (CORS_ORIGIN !== '*') res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // IP 白名单（可选）。/healthz 必须放行，否则容器健康检查会把自己拦成 unhealthy。
  if (url !== '/healthz' && !ipAllowed(clientIp(req))) {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      error: {
        message: 'source ip not allowed',
        type: 'permission_error',
        code: 'ip_not_allowed',
        client_ip: clientIp(req),
      },
    }));
    return;
  }

  // 收尾时打一条访问日志（含状态码与耗时）。
  // finish 和 close 都要接：客户端中途断开时只有 close，那种情况记 client_abort，
  // 否则这类请求在日志里会凭空消失。两条路径只落一次。
  let logEmitted = false;
  const emitRequestLog = (clientAborted) => {
    if (logEmitted) return;
    logEmitted = true;
    const meta = req.__logMeta || {};
    let outcome = 'success';
    if (clientAborted) outcome = 'client_abort';
    else if (meta.streamInterrupted) outcome = 'stream_error';
    // 4xx/5xx 不能一概算上游故障：网关自己拒掉的请求（未带凭据、凭据无效、限流、
    // 参数不合法）从头到尾没选中任何账号，错在调用方，记 client_error（页面「请求被拒」）。
    // 选中过账号之后才失败，才是 upstream_error。
    else if (Number(res.statusCode) >= 400) outcome = meta.account ? 'upstream_error' : 'client_error';

    const entry = {
      t: new Date().toISOString(), ip: clientIp(req), method: req.method,
      path: url, status: res.statusCode, ms: Date.now() - t0,
      key: requestKeyRef(req),
      account: meta.account || null,
      model: meta.model || null,
      outcome,
      attempts: Number.isFinite(meta.attempts) ? meta.attempts : 0,
      prompt_tokens: meta.prompt_tokens != null ? meta.prompt_tokens : null,
      completion_tokens: meta.completion_tokens != null ? meta.completion_tokens : null,
      total_tokens: meta.total_tokens != null ? meta.total_tokens : null,
      error: outcome === 'success' ? '' : (meta.error || ''),
    };
    accessLog(entry);
    if (isLoggedPath(url)) {
      recordRequest(entry);
      // 只入内存队列，由归档模块异步落盘；这里绝不 await，避免拖慢请求收尾。
      // 浏览器标识只喂给归档：内存记录保持票 03 的字段集合，来源开关也只影响归档行。
      const ua = req.headers['user-agent'] ? String(req.headers['user-agent']).slice(0, 200) : '';
      requestLogArchive.append(entry, ua);
    }
  };
  res.on('finish', () => emitRequestLog(false));
  res.on('close', () => emitRequestLog(!res.writableFinished));

  const isHealth = (url === '/healthz' || url === '/status' || url === '/health');
  const isUi = PUBLIC_UI && (url === '/' || url === '/index.html');
  // /api/usage/buckets 不在这里：它是部署级只读视图，与 /api/dashboard、/api/logs 同口径，
  // 鉴权在 handleApiUsageBuckets 内部用 authenticateDashboardReader 处理。
  const isAdminOnlyRoute = url.startsWith('/api/admin/') || url === '/api/keys' || url === '/api/balance'
    || url === '/api/fallback' || url === '/api/settings' || url === '/api/local-stats/reset';

  try {
    // 1. 公开端点（无需鉴权）
    if (isUi) return handleIndex(req, res);
    if (url === '/healthz') return handleHealth(req, res);
    if (req.method === 'GET' && (url === '/status' || url === '/health')) return handleStatus(req, res);
    if (url === '/api/admin/session') return handleAdminSession(req, res);
    if (url === '/api/admin/login') return handleAdminLogin(req, res);
    if (url === '/api/admin/logout') return handleAdminLogout(req, res);

    // 2. 管理专属端点（需管理权限，普通调用凭据会被 403 拒绝）
    if (isAdminOnlyRoute) {
      const adminAuth = credentialsContext.authenticateAdmin(req);
      if (!adminAuth.ok) {
        res.writeHead(adminAuth.status || 401, {
          'Content-Type': 'application/json',
          'WWW-Authenticate': 'Bearer',
        });
        return res.end(JSON.stringify({
          error: {
            message: adminAuth.error,
            type: adminAuth.status === 403 ? 'access_denied_error' : 'authentication_error',
            code: adminAuth.code,
          },
        }));
      }
      if (url === '/api/admin/password') return handleAdminPassword(req, res);
      if (url.startsWith('/api/admin/keys')) return handleAdminKeysRoute(req, res, url);
      if (url.startsWith('/api/admin/accounts')) return handleAdminAccountsRoute(req, res, url);
      if (url.startsWith('/api/admin/aliases')) return handleAdminAliasesRoute(req, res, url);
      if (url.startsWith('/api/admin/debug/time')) return handleAdminDebugTime(req, res);
      if (req.method === 'GET' && url === '/api/keys') return handleApiKeys(req, res);
      if (url === '/api/balance') return handleApiBalance(req, res, force);
      if (url === '/api/fallback') return handleApiFallback(req, res);
      if (url === '/api/local-stats/reset') return handleLocalStatsReset(req, res);
      if (url === '/api/settings') return handleApiSettings(req, res);
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'not found', path: url }));
    }

    // 3. 仪表盘只读聚合（调用凭据或管理会话均可，见 ADR-0009）
    if (req.method === 'GET' && url === '/api/dashboard') {
      return handleApiDashboard(req, res, force);
    }

    // 3a. 用量账本（部署级只读，权限同仪表盘与日志，见 ADR-0009）
    if (req.method === 'GET' && url === '/api/usage/buckets') {
      return handleApiUsageBuckets(req, res, query);
    }

    // 3b. 请求日志（只读，权限同仪表盘）
    if (req.method === 'GET' && url === '/api/logs') {
      return handleApiLogs(req, res, query);
    }

    // 4. 用量端点（管理看全局，调用方看自身）
    if (req.method === 'GET' && url === '/api/usage') {
      return handleApiUsage(req, res, force);
    }

    // 4. 模型列表接口（管理后台与客户端模型发现，支持管理员与调用凭据）
    if (req.method === 'GET' && (url === '/api/models' || url === '/v1/models')) {
      if (AUTH_ON) {
        const adminAuth = credentialsContext.authenticateAdmin(req);
        if (!adminAuth.ok) {
          const invAuth = credentialsContext.authenticateInvocation(req);
          if (!invAuth.ok) {
            res.writeHead(invAuth.status || 401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' });
            return res.end(JSON.stringify({ error: { message: invAuth.error, code: invAuth.code } }));
          }
          req.__keyObj = invAuth.key;
          req.__keyName = invAuth.key.name;
        }
      }
      if (url === '/v1/models') return handleV1Models(req, res);
      await handleApiModels(req, res, force);
      return;
    }

    // 5. 模型调用及客户端接口：必须持有合法、未撤销且拥有账号权限的调用凭据
    if (AUTH_ON) {
      const invAuth = credentialsContext.authenticateInvocation(req);
      if (!invAuth.ok) {
        res.writeHead(invAuth.status || 401, {
          'Content-Type': 'application/json',
          'WWW-Authenticate': 'Bearer',
        });
        return res.end(JSON.stringify({
          error: {
            message: invAuth.error,
            type: invAuth.status === 403 ? 'access_denied_error' : 'invalid_request_error',
            code: invAuth.code,
          },
        }));
      }
      req.__key = invAuth.key;
      req.__keyName = invAuth.key.name;
      req.__keyId = invAuth.key.id;
      req.__keyObj = invAuth.key;

      if (!rateLimitCheck(invAuth.key.id)) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' });
        return res.end(JSON.stringify({
          error: {
            message: `rate limit exceeded (${RATE_LIMIT_PER_MIN}/min)`,
            type: 'rate_limit_error',
          },
        }));
      }

      // Issue #07: 统一调用凭据级并发上限与全局排队上限检查
      const acqKey = sessionRouter.acquireKey(invAuth.key.id);
      if (!acqKey.ok) {
        res.writeHead(acqKey.status || 429, { 'Content-Type': 'application/json', 'Retry-After': '5' });
        return res.end(JSON.stringify({
          error: {
            message: acqKey.message,
            type: acqKey.status === 503 ? 'service_unavailable' : 'rate_limit_error',
            code: acqKey.code,
          },
        }));
      }

      let keyReleased = false;
      const releaseKey = () => {
        if (!keyReleased) {
          keyReleased = true;
          sessionRouter.releaseKey(invAuth.key.id);
        }
      };
      res.on('finish', releaseKey);
      res.on('close', releaseKey);

      // 统一生命周期取消追踪：客户端提前断连时立即中止在途上游请求
      const ac = new AbortController();
      req.__abortController = ac;
      req.on('aborted', () => {
        try { ac.abort(); } catch { /* ignore */ }
      });
      res.on('close', () => {
        if (!res.writableEnded) {
          try { ac.abort(); } catch { /* ignore */ }
        }
      });
    } else {
      // 未启用 AUTH_ON 时的全局排队与生命周期控制
      const acqKey = sessionRouter.acquireKey('anon');
      if (!acqKey.ok) {
        res.writeHead(acqKey.status || 503, { 'Content-Type': 'application/json', 'Retry-After': '5' });
        return res.end(JSON.stringify({
          error: {
            message: acqKey.message,
            type: 'service_unavailable',
            code: acqKey.code,
          },
        }));
      }
      let keyReleased = false;
      const releaseKey = () => {
        if (!keyReleased) {
          keyReleased = true;
          sessionRouter.releaseKey('anon');
        }
      };
      res.on('finish', releaseKey);
      res.on('close', releaseKey);

      const ac = new AbortController();
      req.__abortController = ac;
      req.on('aborted', () => {
        try { ac.abort(); } catch { /* ignore */ }
      });
      res.on('close', () => {
        if (!res.writableEnded) {
          try { ac.abort(); } catch { /* ignore */ }
        }
      });
    }

    if (req.method === 'POST' && url === '/v1/chat/completions') return handleChatCompletions(req, res, req.__keyName);
    // Codex CLI 走这套（它已经彻底不支持 chat completions 了）
    if (req.method === 'POST' && url === '/v1/responses') return responsesAdapter.handle(req, res, req.__keyName);
    if (req.method === 'POST' && url === '/v1/responses/compact') return responsesAdapter.handleCompact(req, res);
    if (req.method === 'GET' && url.startsWith('/v1/responses/')) return responsesAdapter.handleGet(req, res, url);
    // Claude Code / Anthropic SDK 走这套
    if (req.method === 'POST' && url === '/v1/messages/count_tokens') return messagesAdapter.handleCountTokens(req, res);
    if (req.method === 'POST' && url === '/v1/messages') return messagesAdapter.handle(req, res, req.__keyName);
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found', path: url }));
  } catch (e) {
    log('handler error: %s', e.stack || e.message);
    if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json' }); }
    res.end(JSON.stringify({ error: { message: 'internal error', detail: e.message } }));
  }
}

/**
 * 造一个可用的监听实例。凡是"要换地址"就必须换 server 对象——同一个 server
 * close() 之后的状态不可控，而旧对象上的存量连接照样能跑完。
 */
function createGatewayServer() {
  const srv = http.createServer(handleRequest);
  // ---- Responses WebSocket（Codex Desktop / 新版 codex 的流式通道）----
  // provider=OpenAI 的流式请求不走 POST+SSE，而是 WS 升级到同一个 /v1/responses，
  // 发 {"type":"response.create", ...} 收 Responses 事件帧。不接这个 upgrade 的话，
  // 客户端会一直 "request timed out"（实测每 15s 重试一次）。
  // 重绑时新 server 也要挂一次，否则换地址之后 WS 端点会静默 404。
  attachResponsesWs({
    server: srv,
    adapter: responsesAdapter,
    log,
    credentialsContext,
    sessionRouter,
    rateLimitCheck,
    authOn: AUTH_ON,
    findKey: resolveKey,
    ipAllowed,
    clientIpOf: clientIp,
  });
  // 监听失败由 listenOn 的 once('error') 处理；这里兜住运行期错误，
  // 否则任何一次 EADDRINUSE 都会把进程带崩。
  srv.on('error', (err) => log('server error: %s', err.message));
  return srv;
}

// 重绑会换 server 对象，被换下来的那个可能还挂着存量连接（stopListening 只停 accept）。
// 退出时要把它们全部关掉，否则旧 server 上的长连接会拖住进程，只能靠强退掐断。
// 集合只在新监听成功时增长，重绑是低频人工操作，不做回收也不会无限膨胀。
const servers = new Set();
let server = createGatewayServer();
servers.add(server);

/** 在 host:port 上监听一个新 server。失败时把原始 errno 抛给调用方做回滚判断。 */
function listenOn(host, port) {
  const candidate = createGatewayServer();
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      candidate.removeListener('listening', onListening);
      try { candidate.close(); } catch (_) { /* 还没进入监听态，关不掉也无所谓 */ }
      reject(err);
    };
    const onListening = () => {
      candidate.removeListener('error', onError);
      servers.add(candidate);
      resolve(candidate);
    };
    candidate.once('error', onError);
    candidate.once('listening', onListening);
    candidate.listen(port, host);
  });
}

/** 只停 accept，不 kill 存量连接：正在进行的请求按原样跑完。 */
function stopListening(srv) {
  try { srv.close(); } catch (_) { /* 已经关过 */ }
}

/**
 * 运行时重绑监听地址。
 *
 * 同一个端口上换地址时新旧监听会互相冲突（0.0.0.0 与具体网卡地址重叠），
 * 所以顺序是：先试着不动旧监听（不同地址族/端口仍能并存）→ 撞 EADDRINUSE 时
 * 先停旧 accept 再绑新地址 → 还失败就在旧地址上重新起一个 server 保证网关没断。
 * 抛出的错误最终都落到调用方（HTTP 4xx），配置由调用方决定是否落盘。
 */
async function rebindServer(nextBind) {
  const target = parseBindAddress(nextBind);
  if (!target.ok) {
    const err = new Error(target.error);
    err.code = 'EINVAL';
    throw err;
  }
  // 地址不带端口时回到部署默认端口（env PORT），与「没填端口」的字面意思一致。
  const next = { bind: target.value, host: target.host, port: target.port || PORT };
  const previous = { bind: activeBind, host: activeHost, port: activePort };
  if (next.bind === previous.bind && next.port === previous.port) return;
  // 端点一样、只是写法不同（127.0.0.1 与 127.0.0.1:8080）：不必重绑，但生效写法要跟上保存值。
  if (next.host === previous.host && next.port === previous.port) { activeBind = next.bind; return; }
  const previousServer = server;
  const commit = () => {
    activeBind = next.bind;
    activeHost = next.host;
    activePort = next.port;
  };

  try {
    // 换端口时新旧监听互不冲突：先绑上新的再停旧的，中间没有空窗。
    server = await listenOn(next.host, next.port);
    commit();
    stopListening(previousServer);
    return;
  } catch (err) {
    if (err.code !== 'EADDRINUSE') throw err;
  }

  // 只有同端口换地址（0.0.0.0 与具体网卡地址重叠）才会撞 EADDRINUSE：
  // 停掉旧 accept（端口立刻释放，存量连接继续），再绑新地址。
  stopListening(previousServer);
  try {
    server = await listenOn(next.host, next.port);
    commit();
    return;
  } catch (err) {
    server = previousServer;
    try {
      server = await listenOn(previous.host, previous.port);
      log('重绑到 %s 失败，已恢复监听 %s（%s）', next.bind, previous.bind, err.message);
    } catch (restoreErr) {
      log('FATAL: 重绑失败且无法恢复监听 %s:%s — %s', previous.host, previous.port, restoreErr.message);
    }
    throw err;
  }
}

/** 非回环监听 + 无鉴权 = 把模型接口裸奔出去；启动与重绑都要拦。 */
function isLoopbackBind(addr) {
  return addr === 'localhost' || addr === '::1' || /^127\./.test(String(addr));
}

function unsafeOpenBind(addr) {
  return !AUTH_ON && !isLoopbackBind(addr) && process.env.ALLOW_OPEN_BIND !== '1';
}

// ---- 启动前安全校验：公网监听却没有任何 Key，直接拒绝启动 ----
function assertSafeBinding() {
  if (unsafeOpenBind(activeHost)) {
    log('FATAL: BIND=%s:%s 监听非回环地址但没有配置任何 API Key。', activeHost, activePort);
    log('       请设置 API_KEYS=sk-xxxx（或 API_TOKEN），否则等于把模型接口裸奔在公网。');
    log('       确认要在内网无鉴权运行，可加 ALLOW_OPEN_BIND=1。');
    process.exit(2);
  }
}

// 退出时等归档队列落盘的上限：磁盘再慢也不能把退出拖到被 orchestrator 强杀。
const SHUTDOWN_WAIT_MS = 2000;

/** 给 Promise 加个上限：超时就当已完成，继续走退出流程 */
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      if (t.unref) t.unref();
    }),
  ]);
}

/** 停掉所有监听（含重绑前的老 server）；存量连接按原样跑完，不等它们 */
function closeAllServers() {
  const pending = [];
  for (const srv of servers) {
    if (!srv.listening) continue;
    pending.push(new Promise((resolve) => {
      try { srv.close(() => resolve()); } catch (_) { resolve(); }
    }));
  }
  return Promise.all(pending);
}

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('shutting down (%s)...', signal);
  persistState(true);
  // 账本最多攒了 30 秒的改动：退出路径用同步落盘，保证退出前一定写了一次。
  try { usageRecorder.flush(); } catch (e) { log('flush usage ledger failed: %s', e.message); }
  // 先停掉所有监听：不再接新请求，重绑换下来的老 server 上的长连接也不会拖住退出。
  // 给在途请求留 2 秒收尾（它们的收尾会往归档队列里追加记录），超时就继续往下走。
  await withTimeout(closeAllServers(), SHUTDOWN_WAIT_MS);
  // 归档队列里可能还压着最后几条记录：等它写完再退出，最多再等 2 秒。
  try {
    await withTimeout(
      Promise.resolve(requestLogArchive.close()).catch((e) => log('flush request log archive failed: %s', e.message)),
      SHUTDOWN_WAIT_MS,
    );
  } catch (e) {
    log('flush request log archive failed: %s', e.message);
  }
  // 收尾期内完成的请求会排进账本的 30 秒防抖计时器，退出前再同步落一次，
  // 否则「重启后数字不丢」在关停路径上不成立。
  try { usageRecorder.flush(); } catch (e) { log('final usage ledger flush failed: %s', e.message); }
  process.exit(0);
}

if (require.main === module) {
  assertSafeBinding();
  // 启动时确认归档目录可用，并按当前保留天数/容量清理一次；之后每天清理一次。
  requestLogArchive.start();

  // 启动绑不上就没什么好服务的：把原因说清楚再退出，别留一个半死的进程。
  // 监听成功后必须摘掉：监听期的 error 只是启动失败，运行期的 error 不该直接退出。
  const onListenError = (err) => {
    log('FATAL: 无法监听 %s:%s — %s', activeHost, activePort, err.message);
    process.exit(2);
  };
  server.once('error', onListenError);
  server.listen(activePort, activeHost, () => {
    server.removeListener('error', onListenError);
    log('AiWork gateway listening on http://%s:%s  agent=%s  auth=%s  keys=%d',
      activeHost, server.address().port, AGENT, AUTH_ON ? 'on' : 'OPEN', credentialsContext.keyStore.keys.size);
    log('cli bin: %s   state dir: %s', DTCODER_BIN, STATE_DIR);
    log('models loaded: %d  ui=%s  rate_limit=%s/min', MODEL_INFO.size,
      PUBLIC_UI ? 'on' : 'off', RATE_LIMIT_PER_MIN || 'unlimited');
    refreshReal(true).catch(() => {});
    const timer = setInterval(() => { refreshReal(true).catch(() => {}); }, 5 * 60 * 1000);
    if (timer.unref) timer.unref();
  });

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = {
  // 重绑会换 server 对象，导出成 getter 才能始终拿到正在用的那个
  get server() { return server; },
  get activeBind() { return activeBind; },
  credentialsContext,
  accountPool,
  modelAliasManager,
  sessionRouter,
  STATE,
  persistState,
  usageRecorder,
  refreshReal,
  isPrivateIp,
  isPrivateHost,
  resolveAndCheckHost,
  matchLogFilters,
  downloadImage,
  materializeImages,
  checkLocalAuthState,
  readRouterKey,
  runChat,
};

