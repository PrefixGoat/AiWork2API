'use strict';
/**
 * 运行时配置 (src/runtime-config.js)
 *
 * ADR-0013：控制台设置页的数据源。
 *   - 配置存 `<DATA_DIR>/gateway-config.json`，env 只作为初始默认值；
 *   - 按请求读取，写完立即生效，不需要重启容器；
 *   - 白名单键 + 类型/范围校验，越界整体拒绝，未知键忽略。
 *
 * 这里故意不引入 schema 库：字段用显式表更易审查，也避免新依赖。
 */

const fs = require('fs');
const net = require('net');
const path = require('path');

const CONFIG_FILENAME = 'gateway-config.json';

const SCHEMA = {
  max_concurrency_per_account: {
    type: 'int', def: 10, min: 1, max: 1000,
    env: 'MAX_CONCURRENCY_PER_ACCOUNT',
    label: '单账号最大在途',
  },
  session_binding_ttl_sec: {
    type: 'int', def: 3600, min: 60, max: 86400,
    env: 'SESSION_BINDING_TTL_MS', envScale: 0.001, // 旧变量是毫秒
    label: '会话粘性 TTL',
  },
  session_binding_enabled: {
    type: 'bool', def: true,
    label: '会话粘性路由',
  },
  short_request_timeout_sec: {
    type: 'int', def: 120, min: 5, max: 900,
    env: 'SHORT_REQUEST_TIMEOUT_SEC',
    label: '短请求超时',
  },
  first_byte_timeout_sec: {
    type: 'int', def: 120, min: 5, max: 900,
    env: 'FIRST_BYTE_TIMEOUT_SEC',
    label: '聊天首字节超时',
  },
  stream_idle_timeout_sec: {
    type: 'int', def: 300, min: 5, max: 1800,
    env: 'STREAM_IDLE_TIMEOUT_SEC',
    label: '流空闲超时',
  },
  outbound_user_agent: {
    type: 'string', def: 'aiwork-gateway/1.0', maxLen: 200,
    env: 'OUTBOUND_USER_AGENT',
    label: '出站 User-Agent',
  },
  bind_address: {
    type: 'string', def: '127.0.0.1', maxLen: 259, // 253 主机名 + ':' + 5 位端口
    env: 'BIND',
    format: 'bind_address',
    label: '监听地址',
  },
  request_log_retention_days: {
    type: 'int', def: 14, min: 1, max: 365,
    env: 'REQUEST_LOG_RETENTION_DAYS',
    label: '请求日志保留天数',
  },
  request_log_max_mb: {
    type: 'int', def: 200, min: 10, max: 5000,
    env: 'REQUEST_LOG_MAX_MB',
    label: '请求日志容量上限',
  },
  request_log_capture_source: {
    type: 'bool', def: true,
    label: '记录来源 IP 与浏览器标识',
  },
};

const KNOWN_KEYS = Object.keys(SCHEMA);

/**
 * 监听地址 = 主机（合法 IPv4 含 0.0.0.0，或主机名）+ 可选端口。
 * 故意不接受 IPv6 字面量：设置页的输入框与部署文档目前都按 IPv4 写，
 * 放开写法的同时会带来「配了 ::1 却以为对端能连」这类误判。
 */
function isBindHost(value) {
  if (net.isIPv4(value)) return true;
  // 只由数字和点组成却没通过 IPv4 校验的，是写坏的 IP，不要再当主机名接受
  if (/^[0-9.]+$/.test(value)) return false;
  return value.split('.').every((label) =>
    /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
}

/**
 * 解析 `主机[:端口]`。端口省略时返回 port = null，由调用方用部署默认端口
 * （env PORT，默认 8080）补齐 —— 这样「只写地址」的老配置语义完全不变。
 *
 * 返回 { ok:true, host, port, value } 或 { ok:false, error }；
 * value 是规范化后的字符串（host 或 host:port），保存与回显都用它。
 */
function parseBindAddress(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return { ok: false, error: '监听地址不能为空' };
  const colon = raw.lastIndexOf(':');
  const host = colon < 0 ? raw : raw.slice(0, colon);
  const portText = colon < 0 ? '' : raw.slice(colon + 1);
  if (!host) return { ok: false, error: '监听地址缺少主机部分（端口前面要写地址，例如 127.0.0.1:8080）' };
  if (!isBindHost(host)) return { ok: false, error: '的主机部分必须是合法 IPv4 或主机名（例如 127.0.0.1、0.0.0.0、localhost）' };
  if (colon < 0) return { ok: true, host, port: null, value: host };
  if (!/^\d{1,5}$/.test(portText)) {
    return { ok: false, error: '的端口必须是数字（例如 127.0.0.1:8080）' };
  }
  const port = Number(portText);
  if (port < 1 || port > 65535) return { ok: false, error: '的端口必须在 1-65535 之间' };
  return { ok: true, host, port, value: `${host}:${port}` };
}

function envDefaults() {
  const out = {};
  for (const [key, spec] of Object.entries(SCHEMA)) {
    out[key] = spec.def;
    if (!spec.env) continue;
    const raw = process.env[spec.env];
    if (raw == null || String(raw).trim() === '') continue;
    if (spec.type === 'int') {
      const n = Number(raw) * (spec.envScale || 1);
      if (Number.isFinite(n)) out[key] = Math.round(n);
    } else if (spec.type === 'bool') {
      out[key] = String(raw) === '1' || String(raw).toLowerCase() === 'true';
    } else if (spec.type === 'string') {
      out[key] = String(raw);
    }
  }
  return out;
}

/** 校验单个值；返回 { ok, value } 或 { ok:false, error } */
function validateOne(key, value) {
  const spec = SCHEMA[key];
  if (!spec) return { ok: true, skip: true };
  if (spec.type === 'int') {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      return { ok: false, error: `${key} 必须是整数` };
    }
    if (value < spec.min || value > spec.max) {
      return { ok: false, error: `${key} 必须在 ${spec.min}-${spec.max} 之间` };
    }
    return { ok: true, value };
  }
  if (spec.type === 'bool') {
    if (typeof value !== 'boolean') return { ok: false, error: `${key} 必须是布尔值` };
    return { ok: true, value };
  }
  if (spec.type === 'string') {
    if (typeof value !== 'string') return { ok: false, error: `${key} 必须是字符串` };
    const trimmed = value.trim();
    if (!trimmed) return { ok: false, error: `${key} 不能为空` };
    if (trimmed.length > spec.maxLen) return { ok: false, error: `${key} 长度不能超过 ${spec.maxLen}` };
    // 出站头不能含换行，否则可被用来注入额外响应头
    if (/[\r\n]/.test(trimmed)) return { ok: false, error: `${key} 不能包含换行` };
    if (spec.format === 'bind_address') {
      const parsed = parseBindAddress(trimmed);
      if (!parsed.ok) return { ok: false, error: `${key} ${parsed.error}` };
      // 存规范化后的写法：127.0.0.1:08080 → 127.0.0.1:8080
      return { ok: true, value: parsed.value };
    }
    return { ok: true, value: trimmed };
  }
  return { ok: false, error: `${key} 类型不支持` };
}

class RuntimeConfig {
  constructor(options = {}) {
    this.dataDir = options.dataDir;
    this.filePath = path.join(this.dataDir, CONFIG_FILENAME);
    this.values = envDefaults();
    this.warnings = [];
    this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      for (const [key, value] of Object.entries(parsed || {})) {
        if (!KNOWN_KEYS.includes(key)) continue;
        const res = validateOne(key, value);
        if (res.ok && !res.skip) this.values[key] = res.value;
        else this.warnings.push(`忽略无效配置 ${key}: ${res.error}`);
      }
    } catch (err) {
      // 配置文件损坏不能让网关起不来：回落到 env 默认值，并把原因留给 /api/settings 展示
      this.warnings.push(`读取 ${CONFIG_FILENAME} 失败: ${err.message}`);
    }
  }

  get(key) {
    return this.values[key];
  }

  /** 按毫秒取，便于直接喂给 timer */
  getMs(key) {
    return Number(this.values[key]) * 1000;
  }

  getAll() {
    return { ...this.values };
  }

  getWarnings() {
    return this.warnings.slice();
  }

  /**
   * 只校验、不改内存、不落盘。给「先做副作用、成功后才落盘」的调用方用
   * （监听地址要先重绑成功才允许写文件，否则下次重启会绑到一个坏地址上）。
   * 语义与 update 一致：任意一个键非法则整体拒绝，未知键忽略。
   */
  validatePatch(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return { ok: false, errors: ['请求体必须是对象'], ignored: [] };
    }
    const next = {};
    const errors = [];
    const ignored = [];
    for (const [key, value] of Object.entries(patch)) {
      if (!KNOWN_KEYS.includes(key)) { ignored.push(key); continue; }
      const res = validateOne(key, value);
      if (!res.ok) errors.push(res.error);
      else next[key] = res.value;
    }
    if (errors.length) return { ok: false, errors, ignored };
    if (Object.keys(next).length === 0) {
      return { ok: false, errors: [`没有可识别的设置项${ignored.length ? '：' + ignored.join(', ') : ''}`], ignored };
    }
    return { ok: true, next, ignored };
  }

  /**
   * 批量更新。任意一个键非法则整体拒绝，避免"改了一半"的中间态。
   * 未知键忽略（页面版本比后端新时不应报错），但要回报忽略了哪些；
   * 若一个已知键都没有，调用方必须报错——否则 { sessions: {...} } 这种旧包裹层
   * 会得到 200 却一个字段都没写，用户以为保存成功（ADR-0014 §5 否掉的就是这种静默）。
   */
  update(patch) {
    const checked = this.validatePatch(patch);
    if (!checked.ok) return checked;
    Object.assign(this.values, checked.next);
    this._persist();
    return { ok: true, settings: this.getAll(), ignored: checked.ignored };
  }

  _persist() {
    const payload = JSON.stringify(this.values, null, 2);
    const tmp = `${this.filePath}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, payload, 'utf8');
    fs.renameSync(tmp, this.filePath);
  }
}

module.exports = { RuntimeConfig, SCHEMA, KNOWN_KEYS, CONFIG_FILENAME, parseBindAddress };
