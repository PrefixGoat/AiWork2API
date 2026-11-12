'use strict';
/**
 * 用量聚合（Issue #07）：窗口查询、分组、趋势与折叠。
 *
 * 这里只顾账本对外的查询契约：
 *   1) 总量与 by_account / by_model / by_key 三组明细各自合计一致；
 *   2) 平均延迟/吞吐按「累计值 / 样本数」加权，不是对每桶均值再平均；
 *   3) 同一模型因倍率不同产生的多个桶，在 by_model 里只有一行；
 *   4) 小时窗口只看小时桶；天窗口含日桶与当天小时桶，且不重复计入；
 *   5) 折叠 90 天前的小时桶，连续两次折叠总量不变、结果一致，日桶永久保留；
 *   6) 桶数超上限时先折叠，仍超限就停止接收新桶并只告警一次。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { UsageRecorder } = require('../src/usage-ledger');
const { hourKey, dayKey } = require('../src/time-keys');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwork-usage-aggregation-'));
process.on('exit', () => {
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch (_) {}
});

let seq = 0;
function bucketsFile() {
  seq += 1;
  return path.join(TMP_ROOT, `usage-buckets-${seq}.json`);
}

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
// 本地时区 2026-11-10 22:30
const NOW = new Date(2026, 10, 10, 22, 30, 0).getTime();

function okEntry(overrides = {}) {
  return {
    accountId: 'acc-1',
    model: 'deepseek-flash',
    rate: 0.2,
    key: 'key-1',
    ok: true,
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    latencyMs: 1000,
    tokensPerSecond: 25,
    credits: 0.003,
    cacheHit: 80,
    cacheMiss: 20,
    ...overrides,
  };
}

function sum(rows, field) {
  return rows.reduce((acc, row) => acc + row[field], 0);
}

/** 浮点累计的末位噪声不该让「合计一致」的断言失败 */
function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    throw err;
  }
}

function run() {
  console.log('[用量聚合] 窗口、分组、趋势与折叠');

  test('总量与三组明细合计一致，均值按样本加权', () => {
    const rec = new UsageRecorder({ filePath: bucketsFile(), debounceMs: 0 });
    // 同一个桶两次样本（100ms / 300ms），另一个桶一次样本（900ms）。
    // 若对每桶均值再平均会得到 (200+900)/2 = 550，加权正确值为 1300/3 ≈ 433.3。
    rec.add(NOW, okEntry({ latencyMs: 100, tokensPerSecond: 10 }));
    rec.add(NOW + 60 * 1000, okEntry({ latencyMs: 300, tokensPerSecond: 30 }));
    rec.add(NOW - HOUR, okEntry({
      latencyMs: 900, tokensPerSecond: 90, accountId: 'acc-2', key: 'key-2',
    }));

    const q = rec.query({ hours: 2 }, NOW + 60 * 1000);
    assert.strictEqual(q.totals.requests, 3);
    assert.strictEqual(q.totals.avg_latency_ms, 433.3, '平均延迟必须是累计值/样本数');
    assert.strictEqual(q.totals.avg_tokens_per_second, 43.3, '平均 TPS 必须是累计值/样本数');

    for (const rows of [q.by_account, q.by_model, q.by_key]) {
      assert.strictEqual(sum(rows, 'requests'), q.totals.requests, '分组请求数之和必须等于总量');
      assert.strictEqual(sum(rows, 'total_tokens'), q.totals.total_tokens, '分组 token 之和必须等于总量');
      assert.strictEqual(sum(rows, 'errors'), q.totals.errors);
      assert.strictEqual(sum(rows, 'prompt_tokens'), q.totals.prompt_tokens);
      assert.strictEqual(round6(sum(rows, 'credits')), q.totals.credits);
    }
    assert.strictEqual(q.totals.cache_hit, 240);
    assert.strictEqual(q.totals.cache_miss, 60);
    rec.close();
  });

  test('同一模型多倍率在 by_model 里合并成一行，倍率只影响估算消耗', () => {
    const rec = new UsageRecorder({ filePath: bucketsFile(), debounceMs: 0 });
    rec.add(NOW, okEntry({ model: 'same-model', rate: 0.2, totalTokens: 1000, credits: 0.01 }));
    rec.add(NOW, okEntry({
      model: 'same-model', rate: 1, accountId: 'acc-2', totalTokens: 1000, credits: 0.05,
    }));

    const q = rec.query({ hours: 1 }, NOW);
    assert.strictEqual(q.by_model.length, 1, '同一模型即使倍率不同也只能出现一行');
    assert.strictEqual(q.by_model[0].model, 'same-model');
    assert.strictEqual(q.by_model[0].requests, 2);
    assert.strictEqual(q.by_model[0].total_tokens, 2000);
    assert.deepStrictEqual(q.by_model[0].rates, [0.2, 1], '倍率以区间形式附在该行');
    // 0.06 / 2000 * 1e6 = 30（每百万 token 的加权估算消耗）
    assert.strictEqual(q.by_model[0].credits_per_million_tokens, 30);
    assert.strictEqual(q.by_account.length, 2, '账号维度仍应分开');
    rec.close();
  });

  test('小时窗口只含小时桶，已折叠的日桶不出现在小时窗口里', () => {
    const old = NOW - 100 * DAY;
    const rec = new UsageRecorder({ filePath: bucketsFile(), debounceMs: 0 });
    rec.add(old, okEntry());
    rec.fold(NOW);

    const hourly = rec.query({ hours: 1 }, old + 10 * 60 * 1000);
    assert.strictEqual(hourly.totals.requests, 0, '小时窗口不能借日桶把折叠过的历史算进来');

    const daily = rec.query({ from: dayKey(old), to: dayKey(old) });
    assert.strictEqual(daily.totals.requests, 1, '天窗口应读到折叠后的日桶');
    rec.close();
  });

  test('天窗口同时含日桶与当天小时桶时不重复计入，序列合计等于总量', () => {
    const rec = new UsageRecorder({ filePath: bucketsFile(), debounceMs: 0 });
    rec.add(NOW - 100 * DAY, okEntry({ totalTokens: 150 }));
    rec.add(NOW - 50 * DAY, okEntry({ accountId: 'acc-2', totalTokens: 30 }));
    rec.add(NOW, okEntry({ accountId: 'acc-3', totalTokens: 20 }));
    rec.fold(NOW);

    const q = rec.query({
      from: dayKey(NOW - 101 * DAY), to: dayKey(NOW), granularity: 'day',
    });
    assert.strictEqual(q.granularity, 'day');
    assert.strictEqual(q.totals.requests, 3);
    assert.strictEqual(q.totals.total_tokens, 200);
    assert.strictEqual(sum(q.series, 'requests'), 3, '趋势序列合计必须等于总量');
    assert.strictEqual(sum(q.series, 'total_tokens'), 200, '折叠前后总量不变');
    assert.strictEqual(sum(q.by_account, 'requests'), 3);
    rec.close();
  });

  test('小时粒度序列保留已折叠的日桶，用 scope 与真正的小时点区分', () => {
    const rec = new UsageRecorder({ filePath: bucketsFile(), debounceMs: 0, now: () => NOW });
    const old = NOW - 100 * DAY;
    rec.add(old, okEntry({ totalTokens: 150 }));
    rec.fold(NOW); // 超出保留期（90 天）的小时桶折成日桶
    rec.add(NOW, okEntry({ accountId: 'acc-2', totalTokens: 20 }));

    const q = rec.query({ from: dayKey(NOW - 110 * DAY), to: dayKey(NOW), granularity: 'hour' });
    assert.strictEqual(q.granularity, 'hour');
    assert.strictEqual(q.totals.requests, 2, '总量必须仍包含已折叠的日桶');
    assert.strictEqual(sum(q.series, 'requests'), 2, '序列合计必须等于总量（日桶不能丢）');

    const dayPoints = q.series.filter((p) => p.scope === 'day');
    assert.strictEqual(dayPoints.length, 1, '日桶应作为整日汇总点出现在小时序列里');
    assert.strictEqual(dayPoints[0].slot, `${dayKey(old)}T00`, '日桶落在当天 00:00 的槽位');
    assert.strictEqual(dayPoints[0].granularity, 'hour', '粒度仍按调用方要求的 hour');
    assert.strictEqual(dayPoints[0].requests, 1);
    assert.strictEqual(dayPoints[0].total_tokens, 150);

    const busyHours = q.series.filter((p) => p.scope === 'hour' && p.requests > 0);
    assert.strictEqual(busyHours.length, 1, '今天的小时桶应是 scope=hour 的点');
    assert.strictEqual(busyHours[0].slot, hourKey(NOW));
    assert.strictEqual(busyHours[0].requests, 1);
    assert.strictEqual(busyHours[0].total_tokens, 20);
    rec.close();
  });

  test('连续两次折叠：结果一致、总量不变，日桶永久保留且重启后仍在', () => {
    const filePath = bucketsFile();
    const rec = new UsageRecorder({ filePath, debounceMs: 0 });
    rec.add(NOW - 100 * DAY, okEntry());
    rec.add(NOW - 50 * DAY, okEntry({ accountId: 'acc-2' }));
    rec.add(NOW, okEntry({ accountId: 'acc-3' }));

    const window = { from: dayKey(NOW - 101 * DAY), to: dayKey(NOW), granularity: 'day' };
    const before = rec.query(window);
    const first = rec.fold(NOW);
    const after = rec.query(window);
    assert.ok(first.hours_folded >= 1, '必须真的折掉了小时桶');
    assert.strictEqual(after.totals.requests, before.totals.requests);
    assert.strictEqual(after.totals.total_tokens, before.totals.total_tokens);

    const second = rec.fold(NOW);
    assert.strictEqual(second.hours_folded, 0, '第二次折叠不应再有可折的小时桶');
    assert.deepStrictEqual(rec.query(window), after, '连续两次折叠结果必须完全一致');

    rec.flush();
    const restarted = new UsageRecorder({ filePath });
    assert.deepStrictEqual(restarted.query(window), after, '重启后折叠结果与日桶必须保持');
    assert.strictEqual(restarted.fold(NOW).hours_folded, 0, '重启后再折叠不应重复计入');
    rec.close();
    restarted.close();
  });

  test('90 天边界：保留今天 + 前 89 天，第 90 天前的小时桶折叠', () => {
    const rec = new UsageRecorder({ filePath: bucketsFile(), debounceMs: 0 });
    // NOW = 2026-11-10，保留最近 90 个自然日 = 2026-08-13 ~ 2026-11-10；
    // 2026-08-12 是第 91 天（即「90 天前」），按整天折必须折掉。
    rec.add(new Date(2026, 7, 13, 10, 0, 0).getTime(), okEntry({ accountId: 'kept-89d' }));
    rec.add(new Date(2026, 7, 13, 23, 0, 0).getTime(), okEntry({ accountId: 'kept-89d-evening' }));
    rec.add(new Date(2026, 7, 12, 23, 0, 0).getTime(), okEntry({ accountId: 'folded-90d' }));
    rec.add(new Date(2026, 7, 11, 23, 0, 0).getTime(), okEntry({ accountId: 'folded-91d' }));

    const stats = rec.fold(NOW);
    assert.strictEqual(stats.hours_folded, 2, '第 90 天（08-12）与更早的小时桶必须折叠，08-13 起保留');

    const kept = rec.query({ from: '2026-08-13', to: '2026-08-13', granularity: 'hour' });
    assert.strictEqual(kept.totals.requests, 2, '边界日（第 90 天之前一天）的小时桶必须保留');
    const foldedBoundary = rec.query({ from: '2026-08-12', to: '2026-08-12', granularity: 'hour' });
    assert.strictEqual(foldedBoundary.totals.requests, 1, '被折叠的那天仍能通过日桶读到');
    const foldedOlder = rec.query({ from: '2026-08-11', to: '2026-08-11', granularity: 'hour' });
    assert.strictEqual(foldedOlder.totals.requests, 1);
    assert.strictEqual(rec.fold(NOW).hours_folded, 0, '折叠后不应再有可折的小时桶');
    rec.close();
  });

  test('hours 窗口上限钳制到 60 天', () => {
    const rec = new UsageRecorder({ filePath: bucketsFile(), debounceMs: 0 });
    rec.add(NOW, okEntry());
    const q = rec.query({ hours: 99999 }, NOW);
    const currentHour = new Date(NOW);
    currentHour.setMinutes(0, 0, 0);
    assert.strictEqual(q.hours, 1440, '超过上限的小时窗口必须被钳制而不是报错');
    assert.strictEqual(q.clamped, true);
    assert.strictEqual(q.from, hourKey(currentHour.getTime() - 1439 * HOUR), '窗口起点应是 1440 小时前');
    rec.close();
  });

  test('桶数超上限：先折叠腾位置，仍超限则停止接收新桶并只告警一次', () => {
    const logs = [];
    const rec = new UsageRecorder({
      filePath: bucketsFile(), debounceMs: 0, maxBuckets: 2, log: (m) => logs.push(m),
    });
    // 两个同日不同小时的老桶：折叠后合并成一个日桶，腾出位置。
    rec.add(NOW - 101 * DAY, okEntry({ accountId: 'old' }));
    rec.add(NOW - 101 * DAY + HOUR, okEntry({ accountId: 'old' }));
    assert.strictEqual(rec.query({ hours: 1 }, NOW).totals.requests, 0);

    assert.strictEqual(rec.add(NOW, okEntry({ accountId: 'fresh-0' })), true, '折叠腾出位置后应继续接收');
    assert.strictEqual(rec.query({ hours: 1 }, NOW).totals.requests, 1);
    assert.strictEqual(logs.length, 0, '折叠腾出位置时不应该告警');

    assert.strictEqual(rec.add(NOW, okEntry({ accountId: 'fresh-1' })), false, '折叠后仍超限必须拒收');
    assert.strictEqual(rec.query({ hours: 1 }, NOW).totals.requests, 1, '被拒收的桶不能出现');
    assert.strictEqual(logs.filter((m) => /桶数|cap|上限/.test(m)).length, 1, '告警只打一条');

    assert.strictEqual(rec.add(NOW, okEntry({ accountId: 'fresh-2' })), false);
    assert.strictEqual(logs.filter((m) => /桶数|cap|上限/.test(m)).length, 1, '重复拒收不能反复告警');
    rec.close();
  });

  test('显式 from/to 是闭区间，非法窗口被拒绝', () => {
    const rec = new UsageRecorder({ filePath: bucketsFile(), debounceMs: 0 });
    rec.add(new Date(2026, 10, 1, 0, 0, 0).getTime(), okEntry());
    rec.add(new Date(2026, 10, 10, 23, 59, 0).getTime(), okEntry());

    const q = rec.query({ from: '2026-11-01', to: '2026-11-10' });
    assert.strictEqual(q.totals.requests, 2, '闭区间应包含起止当天');
    assert.strictEqual(q.mode, 'range');

    assert.throws(() => rec.query({ from: '2026-11-10', to: '2026-11-01' }), /from|to|窗口/);
    assert.throws(() => rec.query({ from: '2026-11-01' }), /from|to|窗口/);
    rec.close();
  });

  console.log('✓ [All Passed] 用量聚合：加权均值、多倍率合并、窗口口径、折叠幂等、上限保护');
}

run();
