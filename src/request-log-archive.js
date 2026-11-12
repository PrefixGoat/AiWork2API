'use strict';
/**
 * 请求日志 JSONL 归档 (src/request-log-archive.js)
 *
 * 内存环形缓冲只留最近 200 条，进程一重启就没了；这里把每条请求记录按天追加到
 * `<DATA_DIR>/logs/requests-YYYY-MM-DD.jsonl`，一行一条 JSON，方便用 jq / grep 回看。
 *
 * 设计约束（工单 05）：
 *   - 写盘不得进入请求路径：append 只入内存队列，由定时器异步落盘；
 *   - 队列满或写盘失败只告警一次，绝不抛错、绝不阻塞请求；
 *   - 某批写失败时把没写成功的行放回队首重试（有界，超出队列上限才丢弃并计入 dropped），
 *     不再整批静默丢弃；
 *   - 只在归档层做来源裁剪：关闭来源开关后新行不含 ip / user_agent，旧行原样保留；
 *   - 保留天数、容量上限每次落盘/清理时实时读设置，所以「保存即生效」；
 *   - 单文件超过上限时轮转成 `.part2.jsonl`，同一天可多片。
 *
 * 零依赖：只用 Node 内置 fs / path。
 */

const fs = require('fs');
const path = require('path');

const { dayKey, shiftDayKey } = require('./time-keys');

const DEFAULT_RETENTION_DAYS = 14;
const DEFAULT_MAX_MB = 200;
const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_QUEUE = 10000;
const DEFAULT_AUTO_FLUSH_MS = 200;
const MB = 1024 * 1024;

// requests-2026-11-10.jsonl / requests-2026-11-10.part2.jsonl
const FILE_RE = /^requests-(\d{4}-\d{2}-\d{2})(?:\.part(\d+))?\.jsonl$/;

function fileNameFor(day, part) {
  return part > 1 ? `requests-${day}.part${part}.jsonl` : `requests-${day}.jsonl`;
}

class RequestLogArchive {
  /**
   * @param {object} options
   * @param {string} options.dir 归档目录（<DATA_DIR>/logs）
   * @param {() => {retention_days?:number, max_mb?:number, capture_source?:boolean}} [options.settings]
   *   实时读取的设置快照；缺省字段回落到工单默认值
   * @param {boolean} [options.enabled] 部署级开关（REQUEST_LOG_ARCHIVE=0 时整体关闭）
   * @param {() => number} [options.now] 时钟，便于测试
   * @param {(msg:string)=>void} [options.log] 告警出口
   * @param {number} [options.autoFlushMs] 定时落盘间隔；<=0 表示不装定时器，只由 flush 驱动
   * @param {number} [options.maxQueue] 内存队列上限
   * @param {number} [options.maxFileBytes] 单文件轮转阈值（默认 50MB）
   */
  constructor(options = {}) {
    if (!options.dir) throw new Error('RequestLogArchive 需要 dir');
    this.dir = options.dir;
    this.enabled = options.enabled !== false;
    this.settings = typeof options.settings === 'function' ? options.settings : () => ({});
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.log = typeof options.log === 'function' ? options.log : () => {};
    this.autoFlushMs = options.autoFlushMs === undefined
      ? DEFAULT_AUTO_FLUSH_MS : Number(options.autoFlushMs);
    this.maxQueue = Math.max(1, Number(options.maxQueue) || DEFAULT_MAX_QUEUE);
    this.maxFileBytes = Math.max(1, Number(options.maxFileBytes) || DEFAULT_MAX_FILE_BYTES);

    this.queue = [];
    this.timer = null;
    this._chain = Promise.resolve();
    this._active = null; // { day, part, size }
    this.writeError = '';
    this.dropped = 0; // 入队被拒或写失败重试放不下而丢掉的条数（进程生命周期内累计）
    // 已告警过的种类：queue（队满）/ write（写盘、目录、清理）。同一类只告警一次。
    this._warned = new Set();
  }

  /** 读实时设置；缺省或类型不对的字段回落到默认值，绝不因为设置异常停写 */
  _config() {
    const s = this.settings() || {};
    const retention = Number.isInteger(s.retention_days) && s.retention_days > 0
      ? s.retention_days : DEFAULT_RETENTION_DAYS;
    const maxMb = Number.isFinite(s.max_mb) && s.max_mb > 0 ? s.max_mb : DEFAULT_MAX_MB;
    return {
      retentionDays: retention,
      maxBytes: Math.round(maxMb * MB),
      captureSource: s.capture_source !== false,
    };
  }

  /**
   * 入队一条记录；永不抛错、永不阻塞调用方。
   * @param {object} entry 请求元数据（与内存缓冲同一份）
   * @param {string} [userAgent] 浏览器标识；只额外喂给归档，内存记录保持原样
   */
  append(entry, userAgent) {
    if (!this.enabled || !entry || typeof entry !== 'object') return;
    try {
      if (this.queue.length >= this.maxQueue) {
        this.dropped += 1;
        this._warnOnce('queue', 'request log archive failed to enqueue: queue is full, dropping records');
        return;
      }
      this.queue.push(this._shape(entry, userAgent));
      this._schedule();
    } catch (err) {
      this._warnOnce('write', `request log archive failed to enqueue: ${err.message}`);
    }
  }

  /** 按当前来源开关裁剪字段；旧行已落盘，不受影响 */
  _shape(entry, userAgent) {
    const row = Object.assign({}, entry);
    if (userAgent) row.user_agent = String(userAgent).slice(0, 200);
    if (!this._config().captureSource) {
      delete row.ip;
      delete row.user_agent;
    }
    return row;
  }

  _schedule() {
    if (this.autoFlushMs <= 0 || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.autoFlushMs);
    if (this.timer.unref) this.timer.unref();
  }

  /** 把队列里的记录写盘。多次调用串行执行，返回的 Promise 在写完（或失败）后 resolve */
  flush() {
    if (!this.enabled) return Promise.resolve();
    this._chain = this._chain.then(() => this._flushOnce()).catch(() => {});
    return this._chain;
  }

  async _flushOnce() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.queue.length) return;
    const rows = this.queue.splice(0, this.queue.length);

    const groups = new Map(); // day -> rows，保持写入顺序
    for (const row of rows) {
      const ms = Date.parse(row.t);
      const day = Number.isFinite(ms) ? dayKey(ms) : dayKey(this.now());
      if (!groups.has(day)) groups.set(day, []);
      groups.get(day).push(row);
    }

    for (const [day, dayRows] of groups) {
      for (const chunk of this._plan(day, dayRows)) {
        const text = chunk.lines.join('');
        try {
          await appendFile(chunk.filePath, text);
          this.writeError = '';
        } catch (err) {
          // 尺寸按「已写」记过账，失败后作废当前文件缓存，下次按磁盘实际大小重新判断
          this._active = null;
          this.writeError = `写归档失败：${err.message}`;
          this._warnOnce('write', `request log archive write failed: ${err.message}`);
          // 这一批一行都没落盘：整块放回队首等下一轮重试，不能静默丢。
          this._requeue(chunk.rows);
        }
      }
    }
  }

  /**
   * 把写失败的行放回队首（下一轮先写它们，顺序不乱）。
   * 队列上限是硬约束：放不下的部分只能丢，但要计入 dropped 让日志页看得见。
   */
  _requeue(rows) {
    if (!rows.length) return;
    const free = Math.max(0, this.maxQueue - this.queue.length);
    const overflow = rows.length - free;
    if (overflow > 0) {
      this.dropped += overflow;
      this._warnOnce('write', `request log archive dropped ${overflow} records: retry queue is full`);
    }
    const keep = overflow > 0 ? rows.slice(overflow) : rows;
    this.queue = keep.concat(this.queue);
  }

  /**
   * 把一天的记录切成「目标文件 + 若干行」的块，跨过单文件上限就换下一片。
   * 这里不碰磁盘，只在内存里累加字节数，避免为每行都 stat 一次。
   * 每块同时带着原始行：写失败时要把它们原样放回队列，不能只剩已经序列化好的文本。
   */
  _plan(day, rows) {
    const chunks = [];
    let target = this._targetFor(day);
    let lines = [];
    let chunkRows = [];
    for (const row of rows) {
      const line = JSON.stringify(row) + '\n';
      const bytes = Buffer.byteLength(line);
      if (target.size > 0 && target.size + bytes > this.maxFileBytes) {
        if (lines.length) chunks.push({ filePath: path.join(this.dir, fileNameFor(day, target.part)), lines, rows: chunkRows });
        lines = [];
        chunkRows = [];
        target = this._advance(day);
      }
      lines.push(line);
      chunkRows.push(row);
      target.size += bytes;
    }
    if (lines.length) chunks.push({ filePath: path.join(this.dir, fileNameFor(day, target.part)), lines, rows: chunkRows });
    return chunks;
  }

  /** 当天的写入目标：沿用缓存，否则从磁盘上已有的片段里挑最大编号 */
  _targetFor(day) {
    if (this._active && this._active.day === day) {
      return this._active.size < this.maxFileBytes ? this._active : this._advance(day);
    }
    const parts = this._scan().filter((f) => f.day === day);
    let part = 1;
    let size = 0;
    if (parts.length) {
      const last = parts[parts.length - 1];
      part = last.part;
      size = last.bytes;
      if (size >= this.maxFileBytes) {
        part += 1;
        size = 0;
      }
    }
    this._active = { day, part, size };
    return this._active;
  }

  _advance(day) {
    const next = { day, part: (this._active && this._active.day === day ? this._active.part : 1) + 1, size: 0 };
    this._active = next;
    return next;
  }

  /**
   * 按当前设置清理一次：先按保留天数删过期文件，再从最旧的文件开始删到总量不超上限。
   * 永远至少留下最新的一个文件，避免把正在写入的当天日志删掉。
   */
  cleanup() {
    if (!this.enabled) return this.stats();
    const { retentionDays, maxBytes } = this._config();
    const cutoff = shiftDayKey(this.now(), -(retentionDays - 1));

    for (const file of this._scan()) {
      if (file.day >= cutoff) continue;
      try { fs.unlinkSync(file.path); } catch (err) { this._warnOnce('write', `request log archive cleanup failed: ${err.message}`); }
    }

    let files = this._scan();
    let total = files.reduce((n, f) => n + f.bytes, 0);
    let alive = files.length;
    for (const file of files) {
      if (total <= maxBytes || alive <= 1) break;
      try {
        fs.unlinkSync(file.path);
        total -= file.bytes;
        alive -= 1;
      } catch (err) {
        this._warnOnce('write', `request log archive cleanup failed: ${err.message}`);
        break;
      }
    }

    // 目录内容变了，写入目标要重新发现（不能继续往一个已被删掉的片段里追加）
    this._active = null;
    return this.stats();
  }

  /** 归档占用；日志页用它显示「归档 3 个文件 · 1.2 MB · 最早 11-07」 */
  stats() {
    if (!this.enabled) {
      return { enabled: false, files: 0, bytes: 0, oldest_day: null, writable: true, error: '', queued: 0, dropped: this.dropped };
    }
    const files = this._scan();
    return {
      enabled: true,
      files: files.length,
      bytes: files.reduce((n, f) => n + f.bytes, 0),
      oldest_day: files.length ? files[0].day : null,
      writable: !this.writeError,
      error: this.writeError,
      queued: this.queue.length,
      // 入队被拒或写失败重试放不下而丢掉的条数；>0 说明归档在少记。
      dropped: this.dropped,
    };
  }

  /** 启动时调用：确认目录可用、立即清理一次，之后每天清理一次 */
  start() {
    if (!this.enabled) return this.stats();
    this._probe();
    const stats = this.cleanup();
    const timer = setInterval(() => { this.cleanup(); }, 24 * 60 * 60 * 1000);
    if (timer.unref) timer.unref();
    this._dailyTimer = timer;
    return stats;
  }

  close() {
    if (this._dailyTimer) {
      clearInterval(this._dailyTimer);
      this._dailyTimer = null;
    }
    return this.flush();
  }

  _probe() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      this.writeError = '';
    } catch (err) {
      this.writeError = `日志目录不可用：${err.message}`;
      this._warnOnce('write', `request log archive failed: log dir unusable: ${err.message}`);
    }
  }

  /** 按日期、片段号升序列出归档文件 */
  _scan() {
    let names;
    try {
      names = fs.readdirSync(this.dir);
    } catch (err) {
      if (err.code !== 'ENOENT') this._noteReadError(err);
      return [];
    }
    const out = [];
    for (const name of names) {
      const m = FILE_RE.exec(name);
      if (!m) continue;
      const filePath = path.join(this.dir, name);
      let bytes;
      try { bytes = fs.statSync(filePath).size; } catch (_) { continue; }
      out.push({ path: filePath, name, day: m[1], part: m[2] ? Number(m[2]) : 1, bytes });
    }
    out.sort((a, b) => (a.day === b.day ? a.part - b.part : (a.day < b.day ? -1 : 1)));
    return out;
  }

  _noteReadError(err) {
    this.writeError = `日志目录不可用：${err.message}`;
    this._warnOnce('write', `request log archive failed to read log dir: ${err.message}`);
  }

  /** 同一类告警全生命周期只打一条：日志页会一直显示状态，不需要刷屏 */
  _warnOnce(kind, message) {
    if (this._warned.has(kind)) return;
    this._warned.add(kind);
    try { this.log(message); } catch (_) {}
  }
}

function appendFile(filePath, text) {
  return new Promise((resolve, reject) => {
    fs.appendFile(filePath, text, 'utf8', (err) => (err ? reject(err) : resolve()));
  });
}

module.exports = {
  RequestLogArchive,
  fileNameFor,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_MAX_MB,
  DEFAULT_MAX_FILE_BYTES,
};
