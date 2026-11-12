'use strict';
/**
 * 用量账本 (src/usage-ledger.js)
 *
 * 一次请求结束后把用量写进「时间片 × 账号 × 模型 × 倍率 × 调用凭据」的分桶账本，
 * 与 usage-state.json 的累计计数器完全独立：清空本机统计不得动账本。
 *
 * 为什么独立：
 *   - usage-state.json 是可以被「重置本机统计」清零的实时视图；
 *   - 账本是历史事实，分桶之后才谈得上按小时/模型/账号做分组与序列（票 07）。
 * 两者混在一个文件里，任何一次重置都会把历史一起抹掉。
 *
 * 两类时间片：
 *   - period='hour'，slot='2026-11-10T22'：最近 90 个自然日（今天 + 前 89 天）的明细；
 *   - period='day'， slot='2026-11-10'：更早的小时桶折叠而来，永久保留。
 *
 * 折叠是幂等的：小时桶先合并进对应日桶、再删除；第二次执行时已经无桶可折。
 * 桶数触到硬上限时先**逐级折叠**：30 天前 → 7 天前 → 1 天前，先牺牲远期的小时粒度
 * 换空间；全都折过仍满则停止接收新桶、把拒收条数记进 dropped（查询接口可见），
 * 并且只告警一次——宁可少记一段，也不能让账本无限膨胀把网关拖死。
 *
 * 落盘策略：30 秒防抖 + 「临时文件 + rename」原子替换。rename 是同目录内的原子操作，
 * 进程被强杀时目标文件要么是上一版完整 JSON，要么是新一版，不会出现半截内容。
 * 防抖到点的那次落盘只把**写盘**交给异步 IO（序列化仍在主线程同步完成，账本很大时
 * 那仍是一笔主线程开销）；进程退出时才用同步落盘，保证退出前一定写完一次。
 *
 * 零依赖：只用 Node 内置 fs / path。
 */

const fs = require('fs');
const path = require('path');

const { hourKey, dayKey, shiftDayKey } = require('./time-keys');

const fsp = fs.promises;

const DEFAULT_DEBOUNCE_MS = 30000;
const FILE_VERSION = 2;
// 分桶 key 的字段分隔符。取 \u0000 而不是 '|'：账号/模型/凭据名里出现 '|' 是可能的。
const KEY_SEP = '\u0000';

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MAX_WINDOW_HOURS = 60 * 24; // 滚动窗口最多 60 天
const FOLD_AFTER_DAYS = 90; // 小时桶保留最近 90 个自然日（今天 + 前 89 天）
const DEFAULT_MAX_BUCKETS = 400000;
// 桶数触顶时的逐级折叠：先折更早的小时桶（30 天前），再 7 天前，最后 1 天前。
// 顺序固定为「从远到近」：腾空间时先牺牲远期细粒度，保住最近一天的小时分辨率。
const PRESSURE_FOLD_DAYS = [30, 7, 1];
const MAX_DENSE_SERIES_SLOTS = 5000; // 超过这个槽位数时趋势只返回有数据的点

const BUCKET_FIELDS = [
  'req', 'err', 'prompt', 'completion', 'total',
  'latency_sum', 'latency_samples', 'tps_sum', 'tps_samples',
  'credits_sum', 'cache_hit', 'cache_miss',
];

function hourStart(at) {
  const d = new Date(at);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

function slotStartMs(slot, period) {
  const parts = String(slot).split('T');
  const [y, m, d] = parts[0].split('-').map(Number);
  if (period === 'day') return new Date(y, m - 1, d).getTime();
  return new Date(y, m - 1, d, Number(parts[1] || 0)).getTime();
}

function nonNegative(value) {
  return (typeof value === 'number' && Number.isFinite(value) && value >= 0) ? value : 0;
}

/**
 * 可选的计数（延迟、吞吐、消耗）：缺失或非法时返回 null，而不是 0。
 * 与 nonNegative 的区别是语义，不是风格：token 是「没有就是 0」，这些是「没测到
 * 就不能计入样本」，用 0 顶替会把「没有数据」和「测得 0」混成一个数（见 ADR-0017 §2）。
 */
function optionalNonNegative(value) {
  return (typeof value === 'number' && Number.isFinite(value) && value >= 0) ? value : null;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * 桶的五个维度：时间片 period/slot、账号、模型、倍率、调用凭据。
 * 始终整体传递，不拆成六个位置参数——顺序一旦抄错，桶就静默错配而不是报错。
 */
function emptyBucket(dims) {
  const bucket = {
    period: dims.period,
    slot: dims.slot,
    account: dims.account,
    model: dims.model,
    rate: dims.rate,
    key: dims.key,
  };
  for (const field of BUCKET_FIELDS) bucket[field] = 0;
  return bucket;
}

function bucketId(dims) {
  return [dims.period, dims.slot, dims.account, dims.model, dims.rate, dims.key].join(KEY_SEP);
}

/** 聚合中间态：累计值 + 样本数，最终由 finalizeAgg 换算成对外的均值 */
function emptyAgg(trackRates = false) {
  return {
    requests: 0,
    errors: 0,
    prompt: 0,
    completion: 0,
    total: 0,
    credits_sum: 0,
    latency_sum: 0,
    latency_samples: 0,
    tps_sum: 0,
    tps_samples: 0,
    cache_hit: 0,
    cache_miss: 0,
    buckets: 0,
    // 只有「按模型」一行需要收集出现过的倍率；其余分组不需要，也不该为每个桶建一个 Set。
    rates: trackRates ? new Set() : null,
  };
}

function accumulate(agg, bucket) {
  agg.requests += bucket.req;
  agg.errors += bucket.err;
  agg.prompt += bucket.prompt;
  agg.completion += bucket.completion;
  agg.total += bucket.total;
  agg.credits_sum += bucket.credits_sum;
  agg.latency_sum += bucket.latency_sum;
  agg.latency_samples += bucket.latency_samples;
  agg.tps_sum += bucket.tps_sum;
  agg.tps_samples += bucket.tps_samples;
  agg.cache_hit += bucket.cache_hit;
  agg.cache_miss += bucket.cache_miss;
  agg.buckets += 1;
  if (agg.rates) agg.rates.add(bucket.rate);
}

function finalizeAgg(agg) {
  const cacheTotal = agg.cache_hit + agg.cache_miss;
  return {
    requests: agg.requests,
    errors: agg.errors,
    prompt_tokens: agg.prompt,
    completion_tokens: agg.completion,
    total_tokens: agg.total,
    credits: round6(agg.credits_sum),
    cache_hit: agg.cache_hit,
    cache_miss: agg.cache_miss,
    cache_hit_rate: cacheTotal ? round6(agg.cache_hit / cacheTotal) : null,
    buckets: agg.buckets,
    // 均值一律「累计值 ÷ 样本数」：对每桶均值再平均会让样本多的桶被稀释。
    avg_latency_ms: agg.latency_samples ? round1(agg.latency_sum / agg.latency_samples) : null,
    avg_tokens_per_second: agg.tps_samples ? round1(agg.tps_sum / agg.tps_samples) : null,
  };
}

function sortGroups(rows, field) {
  return rows.sort((a, b) => (b.requests - a.requests) || String(a[field]).localeCompare(String(b[field])));
}

/**
 * 往分组聚合里加一条桶：没有该分组就先建一个再累加。
 * 「按账号 / 按模型 / 按凭据 / 序列」四段的分组方式完全同形，共用这一处，
 * 免得某一段漏掉 initialize 或漏掉 accumulate 而静默少算。
 */
function bumpGroup(map, key, bucket, trackRates = false) {
  let agg = map.get(key);
  if (!agg) {
    agg = emptyAgg(trackRates);
    map.set(key, agg);
  }
  accumulate(agg, bucket);
  return agg;
}

/** 解析 from/to：'YYYY-MM-DD' 按整天闭区间，其他交给 Date.parse（要求带时间） */
function parseBoundary(value, isEnd) {
  if (value === undefined || value === null || value === '') {
    throw windowError('from 与 to 必须同时提供，且是日期或时间');
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const [y, m, d] = text.split('-').map(Number);
    const at = isEnd
      ? new Date(y, m - 1, d, 23, 59, 59, 999)
      : new Date(y, m - 1, d, 0, 0, 0, 0);
    return at.getTime();
  }
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) throw windowError(`无法解析时间: ${text}`);
  return ms;
}

function windowError(message) {
  const err = new Error(message);
  err.code = 'invalid_window';
  return err;
}

class UsageRecorder {
  /**
   * @param {object} options
   * @param {string} options.filePath 账本文件路径（默认调用方给 usage-buckets.json）
   * @param {number} [options.debounceMs] 防抖窗口；<=0 表示每次记录立即落盘（测试用）
   * @param {() => number} [options.now] 时钟，便于测试
   * @param {(msg: string) => void} [options.log] 落盘/加载/折叠告警的日志出口
   * @param {number} [options.maxBuckets] 桶数硬上限，超过先折叠，仍超限则拒收新桶
   * @param {number} [options.foldAfterDays] 小时桶保留天数，超过折叠成日桶
   */
  constructor(options = {}) {
    this.filePath = options.filePath;
    if (!this.filePath) throw new Error('UsageRecorder 需要 filePath');
    this.debounceMs = options.debounceMs === undefined ? DEFAULT_DEBOUNCE_MS : Number(options.debounceMs);
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.log = typeof options.log === 'function' ? options.log : () => {};
    this.maxBuckets = Number.isFinite(Number(options.maxBuckets)) && Number(options.maxBuckets) > 0
      ? Math.floor(Number(options.maxBuckets))
      : DEFAULT_MAX_BUCKETS;
    this.foldAfterDays = Number.isFinite(Number(options.foldAfterDays)) && Number(options.foldAfterDays) >= 0
      ? Math.floor(Number(options.foldAfterDays))
      : FOLD_AFTER_DAYS;
    this.buckets = new Map();
    this.dirty = false;
    this.timer = null;
    this.dropped = 0; // 因桶数上限被拒收的记录数（进程生命周期内累计）
    this._capBlocked = false;
    this._lastCapAttemptMs = 0;
    this._lastFoldMs = 0;
    this._persistSeq = 0;
    this._persistChain = Promise.resolve();
    this._load();
    // 启动即折一次：进程长期不重启时，接下来由 add 里的每小时节流兜底。
    this._maybeFold();
  }

  /**
   * 记一次尝试（成功或失败都算一次请求）。
   * @returns {boolean} 桶数已达上限且折叠腾不出空间时返回 false（该桶被拒收）。
   */
  add(at, entry = {}) {
    const when = (at === undefined || at === null) ? this.now() : at;
    const ms = when instanceof Date ? when.getTime() : Number(when);
    if (!Number.isFinite(ms)) return false;
    this._maybeFold();

    const period = 'hour';
    const slot = hourKey(ms);
    const account = entry.accountId ? String(entry.accountId) : '';
    const model = entry.model ? String(entry.model) : '';
    const rate = (typeof entry.rate === 'number' && Number.isFinite(entry.rate)) ? entry.rate : 1;
    const key = entry.key ? String(entry.key) : '';
    const dims = { period, slot, account, model, rate, key };
    const id = bucketId(dims);

    let bucket = this.buckets.get(id);
    if (!bucket) {
      if (this.buckets.size >= this.maxBuckets && !this._ensureCapacity(ms)) {
        // 折叠腾不出空间：这条尝试只能不要，但要留痕，否则「账本为什么少了一段」无从查起。
        this.dropped += 1;
        return false;
      }
      bucket = emptyBucket(dims);
      this.buckets.set(id, bucket);
    }

    bucket.req += 1;
    if (!entry.ok) bucket.err += 1;
    bucket.prompt += nonNegative(entry.promptTokens);
    bucket.completion += nonNegative(entry.completionTokens);
    bucket.total += nonNegative(entry.totalTokens);
    bucket.cache_hit += nonNegative(entry.cacheHit);
    bucket.cache_miss += nonNegative(entry.cacheMiss);

    // 延迟/吞吐/消耗都是「累计值 + 样本数」：没有样本时平均值必须给 null，
    // 用 0 顶替会让「没有数据」和「测得 0」变成同一个数字。
    const latencyMs = optionalNonNegative(entry.latencyMs);
    if (latencyMs !== null) {
      bucket.latency_sum += latencyMs;
      bucket.latency_samples += 1;
    }
    const tokensPerSecond = optionalNonNegative(entry.tokensPerSecond);
    if (tokensPerSecond !== null) {
      bucket.tps_sum += tokensPerSecond;
      bucket.tps_samples += 1;
    }
    const credits = optionalNonNegative(entry.credits);
    if (credits !== null) bucket.credits_sum += credits;

    this.dirty = true;
    this._schedule();
    return true;
  }

  /**
   * 最近 hours 个小时片内的总量（小时桶口径；日桶是更久远的历史，不进小时窗口）。
   */
  totals(hours = 24, at) {
    const q = this.query({ hours, granularity: 'hour' }, at);
    return { ...q.totals, from: q.from, to: q.to };
  }

  /**
   * 一次查询拿到全貌。
   *
   * 窗口二选一：
   *   - { hours }       滚动窗口，1..1440（超过 60 天自动钳制）
   *   - { from, to }    显式闭区间：'YYYY-MM-DD' 按整天，或可被 Date.parse 的时间
   * 可选 { granularity: 'hour' | 'day' }；默认小时窗口给 hour，区间跨度 > 72h 给 day。
   * 可选 { account }：只统计该账号（桶里的 account 是账号 id），用于面板互跳的「只看这个账号」。
   * 不传或传空串时不筛账号，行为与改造前完全一致。
   *
   * 返回：totals / by_account / by_model / by_key / series。
   * 小时窗口只统计小时桶；天窗口同时统计日桶与当天的小时桶，同一日期以日桶为准（折叠后
   * 小时桶已删除，这里再兜一层，保证不会重复计入）。
   */
  query(params = {}, at) {
    const nowMs = (at === undefined || at === null) ? this.now() : (at instanceof Date ? at.getTime() : Number(at));
    if (!Number.isFinite(nowMs)) throw windowError('当前时间不可用');

    const hasRange = params.from !== undefined && params.from !== null
      || params.to !== undefined && params.to !== null;
    let mode;
    let fromMs;
    let toMs;
    let hours = null;
    let clamped = false;

    if (hasRange) {
      if (params.from === undefined || params.from === null || params.to === undefined || params.to === null) {
        throw windowError('from 与 to 必须同时提供，且是日期或时间');
      }
      mode = 'range';
      fromMs = parseBoundary(params.from, false);
      toMs = parseBoundary(params.to, true);
      if (fromMs > toMs) throw windowError('from 不能晚于 to');
    } else {
      mode = 'hours';
      const requested = params.hours === undefined || params.hours === null ? 24 : Number(params.hours);
      if (!Number.isFinite(requested) || requested < 1) {
        throw windowError('hours 必须是大于等于 1 的数字');
      }
      hours = Math.floor(requested);
      if (hours > MAX_WINDOW_HOURS) {
        hours = MAX_WINDOW_HOURS;
        clamped = true;
      }
      fromMs = hourStart(nowMs) - (hours - 1) * HOUR_MS;
      toMs = nowMs;
    }

    const spanHours = Math.max(1, Math.ceil((toMs - fromMs) / HOUR_MS));
    const granularity = params.granularity === 'hour' || params.granularity === 'day'
      ? params.granularity
      : (mode === 'hours' ? 'hour' : (spanHours > 72 ? 'day' : 'hour'));

    // 账号过滤：精确匹配桶里的账号 id（不是名字），空串/未传视为不筛。
    // 账号被删除后旧入口仍会传 id，此时命中 0 个桶，正常返回全 0 的空结果，不抛错。
    const accountFilter = (params.account === undefined || params.account === null)
      ? '' : String(params.account).trim();

    const fromHour = hourKey(fromMs);
    const toHour = hourKey(toMs);
    const fromDay = dayKey(fromMs);
    const toDay = dayKey(toMs);

    // 同一天既有日桶又残留小时桶时，以日桶为准。正常折叠后不会出现，属于防御性兜底。
    const foldedDays = new Set();
    if (mode === 'range') {
      for (const b of this.buckets.values()) {
        if (b.period === 'day' && b.slot >= fromDay && b.slot <= toDay) foldedDays.add(b.slot);
      }
    }

    const totalsAgg = emptyAgg();
    const byAccount = new Map();
    const byModel = new Map();
    const byKey = new Map();
    const series = new Map();
    // 哪些序列槽位是「整日汇总」（来自日桶）而不是单个小时。小时粒度下两者共用
    // 一条序列，日桶被放到当天 00:00 的槽位上，只能靠这个集合区分（见 ADR-0017）。
    const dayScopedSlots = new Set();

    for (const b of this.buckets.values()) {
      if (accountFilter && b.account !== accountFilter) continue;
      let seriesSlot;
      if (b.period === 'hour') {
        if (b.slot < fromHour || b.slot > toHour) continue;
        if (foldedDays.has(b.slot.slice(0, 10))) continue; // 该日已折叠为日桶，避免重复计入
        seriesSlot = b.slot;
      } else {
        if (mode === 'hours') continue; // 小时窗口只含小时桶
        if (b.slot < fromDay || b.slot > toDay) continue;
        seriesSlot = b.slot;
      }

      accumulate(totalsAgg, b);
      bumpGroup(byAccount, b.account, b);
      bumpGroup(byModel, b.model, b, true);
      bumpGroup(byKey, b.key, b);

      const slot = granularity === 'day'
        ? (b.period === 'day' ? b.slot : b.slot.slice(0, 10))
        : (b.period === 'day' ? `${b.slot}T00` : b.slot);
      if (b.period === 'day') dayScopedSlots.add(slot);
      bumpGroup(series, slot, b);
    }

    const totals = finalizeAgg(totalsAgg);

    const accountRows = sortGroups([...byAccount].map(([account, agg]) => ({
      account, ...finalizeAgg(agg),
    })), 'account');

    const modelRows = sortGroups([...byModel].map(([model, agg]) => ({
      model,
      ...finalizeAgg(agg),
      rates: [...agg.rates].sort((a, b) => a - b),
      // 倍率只体现在估算消耗里：同一模型多倍率合并后给一个每百万 token 的加权成本。
      credits_per_million_tokens: agg.total > 0 ? round6(agg.credits_sum / agg.total * 1e6) : null,
    })), 'model');

    const keyRows = sortGroups([...byKey].map(([key, agg]) => ({
      key, ...finalizeAgg(agg),
    })), 'key');

    const seriesRows = this._buildSeries(series, fromMs, toMs, granularity, dayScopedSlots);

    return {
      mode,
      hours,
      clamped,
      from: granularity === 'day' ? fromDay : fromHour,
      to: granularity === 'day' ? toDay : toHour,
      from_time: new Date(fromMs).toISOString(),
      to_time: new Date(toMs).toISOString(),
      granularity,
      totals,
      by_account: accountRows,
      by_model: modelRows,
      by_key: keyRows,
      series: seriesRows,
    };
  }

  /**
   * 把早于保留期的小时桶合并进日桶后删除。幂等：重复执行只剩 0 个可折的桶。
   *
   * 保留期按**整天**算：保留最近 afterDays 个自然日（今天 + 前 afterDays-1 天），
   * 日键早于「今天 - (afterDays-1)」的小时桶折叠。用自然日而不是毫秒差，
   * 夏令时切换那天不会少折或多折一天。
   *
   * @param {number|Date} [at] 基准时间
   * @param {{afterDays?: number}} [options] 临时改用更短的保留期（桶数触顶时逐级折叠用）
   * @returns {{hours_folded: number, days_created: number}}
   */
  fold(at, options = {}) {
    const nowMs = (at === undefined || at === null) ? this.now() : (at instanceof Date ? at.getTime() : Number(at));
    const afterDays = (options && Number.isFinite(options.afterDays) && options.afterDays >= 0)
      ? Math.floor(options.afterDays)
      : this.foldAfterDays;
    const cutoffDay = shiftDayKey(nowMs, -(afterDays - 1));
    let hoursFolded = 0;
    let daysCreated = 0;

    for (const [id, bucket] of [...this.buckets]) {
      if (bucket.period !== 'hour') continue;
      const day = bucket.slot.slice(0, 10);
      if (day >= cutoffDay) continue;
      if (this._mergeIntoDay(day, bucket)) daysCreated += 1;
      this.buckets.delete(id);
      hoursFolded += 1;
    }

    if (hoursFolded > 0) {
      this._capBlocked = false;
      this.dirty = true;
      this._schedule();
    }
    return { hours_folded: hoursFolded, days_created: daysCreated };
  }

  /** 把一条小时桶的累计值并入对应日桶；返回是否新建了日桶 */
  _mergeIntoDay(day, bucket) {
    const dims = {
      period: 'day',
      slot: day,
      account: bucket.account,
      model: bucket.model,
      rate: bucket.rate,
      key: bucket.key,
    };
    const id = bucketId(dims);
    let target = this.buckets.get(id);
    let created = false;
    if (!target) {
      target = emptyBucket(dims);
      this.buckets.set(id, target);
      created = true;
    }
    for (const field of BUCKET_FIELDS) target[field] += bucket[field];
    return created;
  }

  /** 每小时最多折一次：超出保留期的小时桶到期就该变成日桶，不必等桶数触顶 */
  _maybeFold() {
    const nowMs = this.now();
    if (nowMs - this._lastFoldMs < HOUR_MS) return;
    this._lastFoldMs = nowMs;
    this.fold(nowMs);
  }

  /**
   * 桶数触顶：先按「更早的小时」逐级折叠腾空间（30 天前 → 7 天前 → 1 天前），
   * 再退回正常保留期折一次；仍然满才拒收。
   *
   * 只在真的触顶时逐级折叠：平时保留 90 天小时明细，压力下才牺牲远期分辨率。
   * 已进入拒收状态后每小时最多再试一次（全表扫描很贵，不能每来一条新桶就扫一遍）。
   */
  _ensureCapacity(nowMs) {
    if (this._capBlocked && nowMs - this._lastCapAttemptMs < HOUR_MS) return false;
    this._lastCapAttemptMs = nowMs;

    for (const days of PRESSURE_FOLD_DAYS) {
      this.fold(nowMs, { afterDays: days });
      if (this.buckets.size < this.maxBuckets) return true;
    }
    this.fold(nowMs);
    if (this.buckets.size < this.maxBuckets) return true;

    this._capBlocked = true;
    this.log(`usage ledger 桶数达到上限 ${this.maxBuckets}：折叠后仍满，已停止接收新桶`);
    return false;
  }

  /** 账本现状：桶数、硬上限、因上限被拒收的记录数 */
  stats() {
    return { buckets: this.buckets.size, max_buckets: this.maxBuckets, dropped: this.dropped };
  }

  /**
   * 展开趋势序列：槽位不多时补零（连续时间轴），过多时只给有数据的点。
   *
   * 每个点带 `scope`：'hour' 表示这一格是单个小时，'day' 表示它是整日汇总。
   * 小时粒度下已折叠的日桶不会丢——为了「趋势合计 = KPI」它们仍进序列，
   * 只是落在当天 00:00 这一格，必须靠 scope 与真正的小时桶区分，否则读的人
   * 会把一整天的量当成凌晨一小时。
   */
  _buildSeries(series, fromMs, toMs, granularity, dayScopedSlots = new Set()) {
    const step = granularity === 'day' ? DAY_MS : HOUR_MS;
    const start = granularity === 'day' ? slotStartMs(dayKey(fromMs), 'day') : slotStartMs(hourKey(fromMs), 'hour');
    const end = granularity === 'day' ? slotStartMs(dayKey(toMs), 'day') : slotStartMs(hourKey(toMs), 'hour');
    const count = Math.floor((end - start) / step) + 1;
    const slots = count > MAX_DENSE_SERIES_SLOTS
      ? [...series.keys()].sort()
      : Array.from({ length: count }, (_, i) => {
        const ms = start + i * step;
        return granularity === 'day' ? dayKey(ms) : hourKey(ms);
      });
    return slots.map((slot) => {
      const agg = series.get(slot);
      return {
        slot,
        granularity,
        scope: granularity === 'day' || dayScopedSlots.has(slot) ? 'day' : 'hour',
        ...(agg ? finalizeAgg(agg) : finalizeAgg(emptyAgg())),
      };
    });
  }

  /**
   * 立即**同步**落盘：退出路径、测试与「必须确认已写盘」的场合用。
   * 同步写会卡住事件循环，所以运行期不用它——那条路走 _persistAsync。
   */
  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return;
    this._persistSync();
  }

  /** 停止定时器并落盘 */
  close() {
    this.flush();
  }

  _schedule() {
    if (this.debounceMs <= 0) {
      this._persistAsync();
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.dirty) this._persistAsync();
    }, this.debounceMs);
    if (this.timer.unref) this.timer.unref();
  }

  _payload() {
    return JSON.stringify({
      version: FILE_VERSION,
      updated_at: new Date(this.now()).toISOString(),
      buckets: [...this.buckets.values()],
    });
  }

  /**
   * 异步落盘：临时文件 + rename，串行执行，绝不把事件循环卡在整文件写上。
   * 每次只取一个序号；序号被更新的落盘（含同步 flush）顶掉时直接放弃本次结果，
   * 避免旧快照后写、覆盖掉新快照。序列化放在真正轮到它写的时候做，
   * 被顶掉的那些快照连字符串都不会生成。
   */
  _persistAsync() {
    const seq = ++this._persistSeq;
    this._persistChain = this._persistChain.then(() => this._writeAsync(seq)).catch(() => {});
  }

  async _writeAsync(seq) {
    if (seq !== this._persistSeq) return; // 已经有更新的一版在排队，本次不用写了
    let payload;
    try {
      payload = this._payload();
    } catch (err) {
      this.log(`usage ledger persist failed: ${err.message}`);
      return;
    }
    const tmp = `${this.filePath}.tmp.${process.pid}.${seq}`;
    try {
      await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
      await fsp.writeFile(tmp, payload, 'utf8');
      if (seq !== this._persistSeq) {
        // 写完发现被顶掉了（例如退出时的同步落盘）：不能覆盖更新的内容。
        await fsp.unlink(tmp).catch(() => {});
        return;
      }
      await fsp.rename(tmp, this.filePath);
      if (seq === this._persistSeq) this.dirty = false;
    } catch (err) {
      // 账本写不进去不能把网关带崩：保留 dirty，下次记录/退出时再试。
      await fsp.unlink(tmp).catch(() => {});
      this.log(`usage ledger persist failed: ${err.message}`);
    }
  }

  _persistSync() {
    const seq = ++this._persistSeq;
    let tmp = null;
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      tmp = `${this.filePath}.tmp.${process.pid}.${seq}`;
      fs.writeFileSync(tmp, this._payload(), 'utf8');
      fs.renameSync(tmp, this.filePath);
      this.dirty = false;
    } catch (err) {
      // 账本写不进去不能把网关带崩：保留 dirty，下次记录/退出时再试。
      if (tmp) { try { fs.unlinkSync(tmp); } catch (_) {} }
      this.log(`usage ledger persist failed: ${err.message}`);
    }
  }

  _load() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      const rows = Array.isArray(parsed && parsed.buckets) ? parsed.buckets : [];
      for (const row of rows) {
        if (!row) continue;
        // v1 只有 hour 字段；v2 起统一为 period + slot。
        const period = row.period === 'day' ? 'day' : 'hour';
        const slot = typeof row.slot === 'string'
          ? row.slot
          : (period === 'hour' && typeof row.hour === 'string' ? row.hour : null);
        if (!slot) continue;
        const account = typeof row.account === 'string' ? row.account : '';
        const model = typeof row.model === 'string' ? row.model : '';
        const rate = (typeof row.rate === 'number' && Number.isFinite(row.rate)) ? row.rate : 1;
        const key = typeof row.key === 'string' ? row.key : '';
        const dims = { period, slot, account, model, rate, key };
        const bucket = emptyBucket(dims);
        // 旧文件里的 credits_samples 只写不读，已从桶字段里删除；缺字段按 0 处理，不视为损坏。
        for (const field of BUCKET_FIELDS) bucket[field] = nonNegative(row[field]);
        this.buckets.set(bucketId(dims), bucket);
      }
    } catch (err) {
      // 账本损坏时按空账本启动：宁可少一段历史，也不能让网关起不来。
      this.log(`usage ledger load failed: ${err.message}`);
      this.buckets.clear();
    }
  }
}

module.exports = {
  UsageRecorder,
  DEFAULT_DEBOUNCE_MS,
  FILE_VERSION,
  MAX_WINDOW_HOURS,
  FOLD_AFTER_DAYS,
};
