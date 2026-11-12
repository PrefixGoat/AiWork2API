'use strict';
/**
 * 协议适配层共用的小工具。
 *
 * responses-adapter.js（OpenAI Responses，给 Codex 用）和
 * messages-adapter.js（Anthropic Messages，给 Claude Code 用）都走同一套流程：
 *   1) 把各自的请求体翻成 chat.completions
 *   2) 用一个假的 http.ServerResponse 接住 api-bridge 里直连路径的输出
 *   3) 再翻回各自的协议
 * 这里放的是第 2、3 步都用得到的公共件，避免两份实现各自漂移。
 */

const crypto = require('crypto');
const zlib = require('zlib');

function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function str(v) { return v == null ? '' : String(v); }
function newId(prefix) { return `${prefix}_${crypto.randomBytes(12).toString('hex')}`; }

/**
 * 假 ServerResponse：把 runDirectPath / runAgentPath 写出来的东西收回来。
 *
 * 为什么用这种方式而不是重构上游调用：直连路径里已经积累了大量踩坑出来的逻辑
 * （tool_calls 碎片合并、reasoning_effort 探测重试、空回复兜底、会话指纹、用量统计），
 * 重写一遍必然会漂移。假 sink 让适配层"寄生"在既有实现上，chat 路径修一处两边同时受益。
 * 代价只是一次多余的 JSON 序列化，可忽略。
 */
function createSink(onData) {
  const listeners = new Map();
  const sink = {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    finished: false,
    sendDate: false,
    writeHead(code) { this.statusCode = code; this.headersSent = true; return this; },
    setHeader() {},
    getHeader() { return undefined; },
    removeHeader() {},
    hasHeader() { return false; },
    flushHeaders() {},
    write(chunk) {
      if (this.writableEnded) return true;
      if (!this.headersSent) this.headersSent = true;
      try { if (chunk) onData(chunk); } catch { /* 翻译层异常不能影响上游连接 */ }
      return true;
    },
    end(chunk) {
      if (this.writableEnded) return this;
      if (chunk) this.write(chunk);
      this.writableEnded = true;
      this.finished = true;
      this.emit('finish');
      this.emit('close');
      if (typeof this.onEnd === 'function') { try { this.onEnd(); } catch { /* ignore */ } }
      return this;
    },
    on(ev, fn) {
      if (!listeners.has(ev)) listeners.set(ev, []);
      listeners.get(ev).push(fn);
      return this;
    },
    once(ev, fn) {
      const wrapper = (...args) => {
        this.removeListener(ev, wrapper);
        fn(...args);
      };
      return this.on(ev, wrapper);
    },
    removeListener(ev, fn) {
      const arr = listeners.get(ev);
      if (arr) {
        const idx = arr.indexOf(fn);
        if (idx >= 0) arr.splice(idx, 1);
      }
      return this;
    },
    emit(ev, ...args) {
      const arr = listeners.get(ev) || [];
      for (const fn of [...arr]) {
        try { fn(...args); } catch (_) {}
      }
      return arr.length > 0;
    },
    destroy() {
      if (this.writableEnded) return this;
      // 中断语义：只通知关闭，不置 finished、不触发 onEnd——不把「中断」伪装成「正常收尾」。
      this.writableEnded = true;
      this.emit('close');
      return this;
    },
  };
  return sink;
}

/**
 * 请求体解码与有界解压控制 (Issue #07 & ADR-0004)
 * 支持 gzip / deflate / br / zstd / identity，带有严格的输出上限限制，
 * 遇到解压炸弹 (Zip Bomb) 会立即中止并拒绝，避免耗尽事件循环与堆内存。
 * 对不支持的 Content-Encoding 明确返回 unsupportedEncoding 标记。
 */
function isSupportedEncoding(enc) {
  if (!enc || enc === 'identity') return true;
  const parts = String(enc).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return parts.every((p) => ['gzip', 'deflate', 'br', 'zstd', 'identity'].includes(p));
}

function createDecompressor(enc) {
  const e = enc.toLowerCase();
  if (e.includes('zstd')) {
    if (typeof zlib.createZstdDecompress === 'function') return zlib.createZstdDecompress();
    throw new Error('zstd streaming decompression not available in this runtime');
  }
  if (e.includes('gzip')) return zlib.createGunzip();
  if (e.includes('deflate')) return zlib.createInflate();
  if (e.includes('br')) return zlib.createBrotliDecompress();
  throw new Error(`Unsupported compression: ${enc}`);
}

function decompressBounded(buf, encoding, maxBytes) {
  return new Promise((resolve) => {
    const enc = String(encoding || '').trim().toLowerCase();
    if (!isSupportedEncoding(enc)) {
      return resolve({ unsupportedEncoding: true, error: `Unsupported Content-Encoding: "${encoding}"` });
    }
    if (!enc || enc === 'identity') {
      if (buf.length > maxBytes) return resolve({ tooLarge: true });
      return resolve({ buffer: buf });
    }

    let decompressor;
    try {
      decompressor = createDecompressor(enc);
    } catch (e) {
      // 运行时未暴露流接口时使用带上限的同步保护
      try {
        let decomp;
        if (enc.includes('zstd')) decomp = zlib.zstdDecompressSync(buf);
        else if (enc.includes('gzip')) decomp = zlib.gunzipSync(buf);
        else if (enc.includes('deflate')) decomp = zlib.inflateSync(buf);
        else if (enc.includes('br')) decomp = zlib.brotliDecompressSync(buf);
        if (!decomp) return resolve({ error: 'decompression produced null' });
        if (decomp.length > maxBytes) return resolve({ tooLarge: true });
        return resolve({ buffer: decomp });
      } catch (syncErr) {
        return resolve({ error: syncErr.message });
      }
    }

    let decompressedLen = 0;
    const outChunks = [];
    let done = false;

    decompressor.on('data', (c) => {
      if (done) return;
      decompressedLen += c.length;
      if (decompressedLen > maxBytes) {
        done = true;
        decompressor.destroy();
        return resolve({ tooLarge: true });
      }
      outChunks.push(c);
    });

    decompressor.on('end', () => {
      if (done) return;
      done = true;
      resolve({ buffer: Buffer.concat(outChunks) });
    });

    decompressor.on('error', (err) => {
      if (done) return;
      done = true;
      resolve({ error: err.message });
    });

    decompressor.end(buf);
  });
}

function readBody(req, maxBytes) {
  return new Promise((resolve) => {
    const chunks = [];
    let rawLen = 0;
    let tooLarge = false;
    req.on('data', (c) => {
      if (tooLarge) return;
      chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      rawLen += c.length;
      if (rawLen > maxBytes) { tooLarge = true; chunks.length = 0; }
    });
    req.on('end', async () => {
      if (tooLarge) return resolve({ body: '', tooLarge: true });
      const buf = Buffer.concat(chunks);
      const enc = req.headers && req.headers['content-encoding'];
      const res = await decompressBounded(buf, enc, maxBytes);
      if (res.tooLarge) return resolve({ body: '', tooLarge: true });
      if (res.unsupportedEncoding) {
        return resolve({ body: '', tooLarge: false, unsupportedEncoding: true, decodeError: res.error });
      }
      if (res.error) {
        return resolve({ body: '', tooLarge: false, decodeError: res.error });
      }
      resolve({ body: res.buffer.toString('utf8'), tooLarge: false });
    });
    req.on('error', (err) => resolve({ body: '', tooLarge: false, error: err.message }));
  });
}

function sendJson(res, status, obj) {
  if (res.headersSent) { if (!res.writableEnded) res.end(); return; }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function sendError(res, status, message, code, type) {
  sendJson(res, status, {
    error: { message, type: type || 'invalid_request_error', code: code || null, param: null },
  });
}

/**
 * 粗略估算 token 数。用于 Anthropic 的 /v1/messages/count_tokens ——
 * 上游没有这个端点，而 Claude Code 靠它做上下文管理、决定何时自动压缩。
 * ASCII 按 3.5 字符/token、非 ASCII 按 1 字符/token：两者都故意偏保守（高估 token 数），
 * 因为低估会让客户端以为还有余量，直到真超限才报错，体验更差。
 */
function estimateTokens(text) {
  const s = str(text);
  if (!s) return 0;
  let ascii = 0;
  let wide = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) < 128) ascii++;
    else wide++;
  }
  return Math.ceil(ascii / 3.5 + wide);
}

/**
 * 把上游的错误体翻成用户能看懂的话。
 * 上游有些错误码只有看了报文才知道该怎么处理，直接透传等于让用户猜。
 */
function friendlyUpstreamError(status, raw, modelHint) {
  const text = str(raw);
  if (status === 409 || /provider_state_unavailable/.test(text)) {
    return `上游拒绝了这次请求：它需要"工具调用会话状态"，但自动路由把请求分到了不同后端。`
      + `请把模型从 automodel 换成具体模型（如 ${modelHint || 'deepseek-flash'}）；`
      + `多轮工具调用必须落在同一个后端上。`;
  }
  if (status === 401 || status === 403) {
    return `上游鉴权失败（${status}）：router key 可能失效，执行 docker compose exec aiwork aiworkcn login 重新登录。`;
  }
  if (status === 429) {
    return '上游限流（429），稍后重试或降低并发。';
  }
  if (status === 404) {
    return `上游找不到该模型（404）：${text.slice(0, 200)}`;
  }
  if (status >= 500) {
    return `上游异常（${status}）：${text.slice(0, 300)}`;
  }
  return text.slice(0, 400) || `上游返回 ${status}`;
}

/**
 * 敏感信息脱敏：将 API key、Bearer 令牌、密码等掩码处理 (Issue #08 / US 50)
 */
function maskSecrets(val) {
  if (val === null || val === undefined) return val;
  if (typeof val === 'string') {
    return val
      .replace(/Bearer\s+([a-zA-Z0-9_\-\.]{4,})/gi, 'Bearer sk-***')
      .replace(/sk-[a-zA-Z0-9_\-\.]{6,}/g, 'sk-***')
      .replace(/(["']?(?:password|token|api[_-]?key|secret|authorization)["']?\s*[:=]\s*["'])([^"'\r\n]+)(["'])/gi, '$1***$3');
  }
  if (Buffer.isBuffer(val)) {
    return Buffer.from(maskSecrets(val.toString('utf8')), 'utf8');
  }
  if (Array.isArray(val)) {
    return val.map((item) => maskSecrets(item));
  }
  if (typeof val === 'object') {
    const res = {};
    for (const [k, v] of Object.entries(val)) {
      const lower = k.toLowerCase();
      if (lower.includes('password') || lower.includes('authorization') || lower.includes('token') || lower.includes('secret')) {
        res[k] = '***';
      } else {
        res[k] = maskSecrets(v);
      }
    }
    return res;
  }
  return val;
}

/**
 * 调试抓包目录有界清理 (Issue #08 / US 51)
 * 限制最大文件数 (maxFiles)、总字节数 (maxBytes) 与过期时间 (maxAgeSec)
 */
function cleanDebugDumps(dumpDir, options = {}) {
  const fs = require('fs');
  const path = require('path');
  if (!dumpDir || !fs.existsSync(dumpDir)) return;

  const maxFiles = Math.max(1, Number(options.maxFiles || 100));
  const maxBytes = Math.max(1024, Number(options.maxBytes || 10 * 1024 * 1024));
  const maxAgeMs = Math.max(1000, Number(options.maxAgeSec || 86400) * 1000);
  const now = Date.now();

  try {
    const files = fs.readdirSync(dumpDir);
    const list = [];
    for (const file of files) {
      const filePath = path.join(dumpDir, file);
      try {
        const stat = fs.statSync(filePath);
        if (stat.isFile()) {
          list.push({ file, path: filePath, size: stat.size, mtimeMs: stat.mtimeMs });
        }
      } catch { /* ignore */ }
    }

    // 1. 先清理超过 maxAgeSec 的过期文件
    const remaining = [];
    for (const item of list) {
      if (now - item.mtimeMs > maxAgeMs) {
        try { fs.unlinkSync(item.path); } catch { /* ignore */ }
      } else {
        remaining.push(item);
      }
    }

    // 2. 按修改时间正序排序（旧文件在前）
    remaining.sort((a, b) => a.mtimeMs - b.mtimeMs);

    let totalBytes = remaining.reduce((acc, cur) => acc + cur.size, 0);

    // 3. 超出 maxFiles 或 maxBytes 时逐个清理旧文件
    while (remaining.length > 0 && (remaining.length > maxFiles || totalBytes > maxBytes)) {
      const oldest = remaining.shift();
      try {
        fs.unlinkSync(oldest.path);
        totalBytes -= oldest.size;
      } catch { /* ignore */ }
    }
  } catch (err) {
    if (typeof options.log === 'function') {
      options.log('cleanDebugDumps error: %s', err.message);
    }
  }
}

/**
 * 提取请求关联的账号访问范围，恒返回冻结结构对象（CODING_STANDARDS 条款 4）。
 * 「不限制」由结构上的显式 unrestricted 标记表达（见 credentials.accountAccessScope），
 * 不再返回 null / Set。历史 `__allowedAccounts` 数组 / Set 在这里一次性归一，
 * 下游只认结构对象，无需做多态类型防御。
 */
function getAllowedAccounts(req) {
  const { accountAccessScope, normalizeAccountScope, getAllowedAccountsFromKey } = require('./credentials');
  if (!req) return accountAccessScope([], true);
  if (req.__allowedAccounts != null) return normalizeAccountScope(req.__allowedAccounts);
  if (req.__keyObj) return getAllowedAccountsFromKey(req.__keyObj);
  return accountAccessScope([], true);
}

/**
 * 提取请求体中的会话迁移保护策略标记（不透明账号状态与上下文可重建性）
 */
function extractMigrationFlags(body) {
  const flags = {};
  if (!body || typeof body !== 'object') return flags;
  if (body.opaque_account_state !== undefined) {
    flags.opaque_account_state = Boolean(body.opaque_account_state);
  }
  if (body.reconstructible !== undefined) {
    flags.reconstructible = !(body.reconstructible === false || body.reconstructible === 'false' || body.reconstructible === '0');
  }
  return flags;
}

/**
 * tool_search 的接入协议域描述符。
 * 两域的 tool_search 类型划分依据 ADR-0021 决定 1（Messages 只认 tool_search_tool_ 前缀、
 * Responses 额外认裸 tool_search）；bareToolSearch / traceGroups 是本模块为实现判定与
 * 消费留痕引入的结构化配置，并非 ADR 定义的结构。
 * 用结构化配置取代裸字符串分支：bareToolSearch 决定是否认裸类型，
 * traceGroups 给出消费留痕的组顺序与键名。查表失败即未知域——
 * 不再让 else 分支隐式兼管「messages 与一切其他值」。
 */
const TOOL_SEARCH_DOMAINS = Object.freeze({
  messages: Object.freeze({
    name: 'messages',
    bareToolSearch: false,
    traceGroups: Object.freeze(['tools', 'blocks', 'fields']),
  }),
  responses: Object.freeze({
    name: 'responses',
    bareToolSearch: true,
    traceGroups: Object.freeze(['tools', 'input', 'fields']),
  }),
});

function toolSearchDomain(domain) {
  return typeof domain === 'string'
    && Object.prototype.hasOwnProperty.call(TOOL_SEARCH_DOMAINS, domain)
    ? TOOL_SEARCH_DOMAINS[domain] : null;
}

/** 数组去重（非数组按空列表）；消费留痕与 notes 日志共用。 */
function dedupe(list) {
  return [...new Set(Array.isArray(list) ? list : [])];
}

/**
 * tool_search 一族的类型判定（ADR-0021 决定 1）。
 * 协议域划分见 ADR-0021:23：裸 `tool_search` 只属 Responses 域；
 * Messages 域只认 `tool_search_tool_` 前缀（regex / bm25 / 日期后缀变体）。
 * 抽到公共模块是 CODING_STANDARDS.md 条款 3（单一事实来源）的要求，
 * 两个适配器不得各写一份判定再手工同步。
 * @param {*} type - 工具条目的 type 字段
 * @param {'messages'|'responses'} domain - 接入协议域
 * @returns {boolean}
 */
function isToolSearchType(type, domain) {
  const d = toolSearchDomain(domain);
  const t = str(type);
  if (!d || !t) return false;
  if (d.bareToolSearch && t === 'tool_search') return true;
  return t.startsWith('tool_search_tool_');
}

/**
 * 把 notes 里的消费留痕去重，返回固定键集 + 组顺序（ADR-0021 决定 1：消费留痕）。
 * 返回形状不随域变化：tools/blocks/input/fields 恒为数组，groups 给出
 * 本域使用的组顺序；调用方遍历 groups 而不是靠字符串 domain 隐式选键。
 * @param {object} notes
 * @param {'messages'|'responses'} domain
 * @returns {{tools: string[], blocks: string[], input: string[], fields: string[], groups: string[], hasConsumed: boolean}}
 */
function consumedTrace(notes, domain) {
  const d = toolSearchDomain(domain);
  const n = isObj(notes) ? notes : {};
  const out = {
    tools: dedupe(n.consumedTools),
    blocks: dedupe(n.consumedBlocks),
    input: dedupe(n.consumedInput),
    fields: dedupe(n.consumedFields),
    groups: d ? d.traceGroups : [],
    hasConsumed: false,
  };
  for (const key of out.groups) {
    if (out[key].length) out.hasConsumed = true;
  }
  return out;
}

/**
 * 打一条消费留痕日志（ADR-0021 决定 1：消费留痕）。
 * 守卫、去重、格式化、按域键名与前缀全部收敛在公共模块：升格后的
 * CODING_STANDARDS.md 条款 3 要求两个适配器不得各写一份日志构造骨架。
 * log 由适配器注入（deps 里的日志函数），公共模块不依赖全局状态。
 * @param {function} log
 * @param {object} notes
 * @param {'messages'|'responses'} domain
 */
function emitConsumedTrace(log, notes, domain) {
  const d = toolSearchDomain(domain);
  if (!d || typeof log !== 'function') return;
  const c = consumedTrace(notes, domain);
  if (!c.hasConsumed) return;
  const message = `[${d.name}] tool-search consumed `
    + c.groups.map((key) => `${key}=[%s]`).join(' ');
  log(message, ...c.groups.map((key) => c[key].join(', ')));
}

/**
 * notes 列表字段去重后拼接成日志 / 错误文案串（CODING_STANDARDS.md 条款 3）。
 * 两个适配器的丢弃 / 不支持 / 自定义工具日志不得各写一份
 * `[...new Set(...)].join(', ')`；limit 用于 responses 侧 unknownInput 的
 * 前 8 项截断（既有行为）。非数组输入按空列表处理。
 * @param {*} list
 * @param {number} [limit]
 * @returns {string}
 */
function dedupeJoin(list, limit) {
  const arr = dedupe(list);
  return (typeof limit === 'number' ? arr.slice(0, limit) : arr).join(', ');
}

/**
 * 未实现工具类型的本地拒绝：守卫、错误文案与错误码（CODING_STANDARDS.md 条款 3）。
 * 两个适配器的 unsupportedTools 400 判定逐字同形，收敛到公共模块；调用方只保留
 * 各自发送载体的差异（Anthropic 错误对象 vs OpenAI 风格 sendError）。
 * 文案与 code 按 Issue #07 / US-46、spec「错误文案不动」保持原样。
 * @param {object} notes
 * @returns {{ message: string, code: string } | null} 无 unsupportedTools 时返回 null
 */
function unsupportedToolsError(notes) {
  const list = isObj(notes) ? notes.unsupportedTools : null;
  if (!Array.isArray(list) || list.length === 0) return null;
  return {
    message: `不支持的工具类型: ${dedupeJoin(list)}。网关不提供未实现工具的静默兜底。`,
    code: 'unsupported_tool_type',
  };
}

/**
 * defer_loading 消费留痕的写入侧（CODING_STANDARDS.md 条款 3）。
 * 两个适配器都要把工具条目上的 defer_loading 记入 notes.consumedFields，但工具形状不同：
 * Messages 域是扁平条目（字段直接在条目上），Responses 域的函数工具允许 {function:{...}}
 * 嵌套（字段在条目或 function 子对象上）。域差异通过 domain 参数显式表达
 * （ADR-0021 决定 2：defer_loading 显式消费）。false / 无字段 / notes 缺失均不虚报、不抛错。
 * @param {object} t - 工具条目
 * @param {object} notes
 * @param {'messages'|'responses'} domain
 */
function consumeDeferLoading(t, notes, domain) {
  if (!isObj(t) || !isObj(notes) || !Array.isArray(notes.consumedFields)) return;
  const nested = domain === 'responses' && isObj(t.function) ? t.function : null;
  if (t.defer_loading === true || (nested && nested.defer_loading === true)) {
    notes.consumedFields.push('defer_loading');
  }
}

/**
 * 「notes 列表 → 本地 400」的统一判定（CODING_STANDARDS.md 条款 3）。
 * 两个适配器对 droppedBlocks / unknownInput 的「非空守卫 + dedupeJoin + 错误文案」
 * 逐字同形；收敛后调用方只保留发送载体与文案模板（协议方言差异）。
 * @param {string[]} list
 * @param {{ code: string, message: (joined: string) => string }} spec
 * @returns {{ message: string, code: string, list: string } | null} 无条目时返回 null
 */
function unsupportedListError(list, spec) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const joined = dedupeJoin(list);
  return { message: spec.message(joined), code: spec.code, list: joined };
}

/** chat tools 中是否存在该 function 名（跨协议共用，避免两适配器各写一份谓词）。 */
function hasFunctionTool(tools, name) {
  return Array.isArray(tools) && tools.some((t) => t && t.function && t.function.name === name);
}

/** 原始声明的工具名（含 tool_search 类型名）：区分「被消费」与「笔误」。 */
function collectDeclaredToolNames(tools, domain) {
  const names = [];
  for (const t of Array.isArray(tools) ? tools : []) {
    if (!t || typeof t !== 'object') continue;
    const n = t.name || (t.function && t.function.name);
    if (n) names.push(String(n));
    if (typeof t.type === 'string' && isToolSearchType(t.type, domain)) names.push(t.type);
  }
  return names;
}

/**
 * tool_choice 目标判定（跨协议共用，条款 3）：
 * - 目标已在下发 tools 中 → 返回要下发的 choice；
 * - 目标在原始声明里存在但已被消费 → 写 notes.degradedToolChoice，返回 null（不下发并留痕）；
 * - 目标既未声明也未被消费（客户端笔误）→ 返回原样 choice，交上游按未知 function 拒绝（透传）。
 */
function resolveToolChoice(tools, name, notes, declaredToolNames) {
  const choice = { type: 'function', function: { name } };
  if (hasFunctionTool(tools, name)) return choice;
  const declared = Array.isArray(declaredToolNames) ? declaredToolNames : [];
  if (declared.includes(name)) {
    notes.degradedToolChoice = name;
    return null;
  }
  return choice;
}

/**
 * tools 全空时的 tool_choice 降级留痕：只有在确实发生过消费时才记为「降级」；
 * 无消费（客户端未声明 tool_search）时不写，避免伪降级。
 */
function degradeChoiceForEmptyTools(notes, label) {
  if (!notes || !Array.isArray(notes.consumedTools) || notes.consumedTools.length === 0) return;
  if (label) notes.degradedToolChoice = label;
}

/** tool_choice 降级（目标不可用：被消费或 tools 全空）的统一留痕：文案与 domain 前缀由本函数产出。 */
function emitDegradedChoiceTrace(log, name, domain) {
  if (!name || typeof log !== 'function') return;
  const d = toolSearchDomain(domain);
  if (!d) return;
  log('[%s] tool_choice 降级不下发（目标不可用）: %s', d.name, name);
}

module.exports = {
  isObj, str, newId, createSink, readBody, decompressBounded, isSupportedEncoding, sendJson, sendError, estimateTokens, friendlyUpstreamError, maskSecrets, cleanDebugDumps, getAllowedAccounts, extractMigrationFlags, isToolSearchType, consumedTrace, emitConsumedTrace, dedupeJoin, unsupportedToolsError, unsupportedListError, collectDeclaredToolNames, resolveToolChoice, degradeChoiceForEmptyTools, emitDegradedChoiceTrace, consumeDeferLoading,
};
