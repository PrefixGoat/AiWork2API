'use strict';
/**
 * 时间键工具 (src/time-keys.js)
 *
 * 用量账本的分桶与请求日志归档都要把时间戳折成本地时区的定长字符串键：
 *   - hourKey: 2026-11-10T22
 *   - dayKey:  2026-11-10
 * 定长而且「字典序即时间序」，可以直接用字符串比较先后。
 *
 * 抽到一处：两边各自实现时，只要对「自然日」的处理分叉，账本折叠边界与归档文件
 * 命名就会对不上，排障时看到的是两套日期。
 *
 * 零依赖：只用 Date 内置能力。
 */

// 定长补零只服务于本模块的两个键构造，外部没有使用者，不导出。
function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 本地时区的小时键，如 2026-11-10T22（定长，可直接按字符串比较先后） */
function hourKey(at) {
  const d = at instanceof Date ? at : new Date(at);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}`;
}

/** 本地时区的日键，如 2026-11-10 */
function dayKey(at) {
  const d = at instanceof Date ? at : new Date(at);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * base 往前/后挪 deltaDays 个**自然日**的日键。
 *
 * 不用 `ms - n*DAY_MS`：夏令时切换那天差值不是整 24 小时，按毫秒减会差一天。
 * base 无法解析时回落到今天——调用方拿到一个可用日期键，总好过 "NaN-NaN-NaN"
 * 参与字符串比较后把整段历史折掉。
 */
function shiftDayKey(base, deltaDays) {
  const d = new Date(base instanceof Date ? base.getTime() : Number(base));
  if (!Number.isFinite(d.getTime())) return dayKey(new Date());
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + deltaDays);
  return dayKey(d);
}

module.exports = {
  hourKey,
  dayKey,
  shiftDayKey,
};
