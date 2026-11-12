'use strict';
/**
 * 用量账本（Issue #06）：分桶记账 + 独立落盘。
 *
 * 断言的是「账本对外承诺的行为」，不碰内部结构：
 *   1) 一次成功请求写进当前小时窗口后，窗口读到 1 次请求，token 与记录一致；
 *   2) 时间片 × 账号 × 模型 × 倍率 × 调用凭据 任一不同就是不同的桶；
 *   3) 失败尝试也占一次请求、只额外记一次失败，没有 usage 时 token 记 0；
 *   4) 窗口按本地小时切，窗口外的不计入；
 *   5) 落盘后重建实例（模拟重启）数据仍在；
 *   6) 落盘走「临时文件 + rename 原子替换」，写失败时旧文件仍是完整 JSON；
 *   7) 防抖到点自动落盘，不需要调用方手动 flush。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { UsageRecorder } = require('../src/usage-ledger');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwork-usage-ledger-'));
process.on('exit', () => {
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch (_) {}
});

let seq = 0;
function bucketsFile() {
  seq += 1;
  return path.join(TMP_ROOT, `usage-buckets-${seq}.json`);
}

// 本地时区的 22:30，小时键应是 2026-11-10T22
const T_2230 = new Date(2026, 10, 10, 22, 30, 0).getTime();
const HOUR = 3600 * 1000;

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
    latencyMs: 2000,
    tokensPerSecond: 25,
    credits: 0.003,
    cacheHit: 80,
    cacheMiss: 20,
    ...overrides,
  };
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

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    throw err;
  }
}

async function run() {
  console.log('[用量账本] 分桶记账与落盘');

  test('一次成功请求：窗口内 1 次请求，token 与记录一致', () => {
    const rec = new UsageRecorder({ filePath: bucketsFile() });
    rec.add(T_2230, okEntry());
    const totals = rec.totals(1, T_2230 + 5 * 60 * 1000);

    assert.strictEqual(totals.requests, 1, '必须记 1 次请求');
    assert.strictEqual(totals.errors, 0, '成功请求不能计入失败');
    assert.strictEqual(totals.prompt_tokens, 100);
    assert.strictEqual(totals.completion_tokens, 50);
    assert.strictEqual(totals.total_tokens, 150);
    assert.strictEqual(totals.credits, 0.003);
    assert.strictEqual(totals.avg_latency_ms, 2000);
    assert.strictEqual(totals.avg_tokens_per_second, 25);
    assert.strictEqual(totals.buckets, 1);
    rec.close();
  });

  test('同一小时内同账号/模型/倍率/凭据落进同一个桶', () => {
    const rec = new UsageRecorder({ filePath: bucketsFile() });
    rec.add(T_2230, okEntry());
    rec.add(T_2230 + 10 * 60 * 1000, okEntry({ promptTokens: 20, completionTokens: 10, totalTokens: 30, credits: 0.001 }));
    const totals = rec.totals(1, T_2230);
    assert.strictEqual(totals.buckets, 1, '五个维度都相同必须合并成一个桶');
    assert.strictEqual(totals.requests, 2);
    assert.strictEqual(totals.total_tokens, 180, '150 + 30');
    rec.close();
  });

  test('五个维度任一不同即分桶', () => {
    const rec = new UsageRecorder({ filePath: bucketsFile() });
    rec.add(T_2230, okEntry());
    rec.add(T_2230, okEntry({ key: 'key-2' }));
    rec.add(T_2230, okEntry({ accountId: 'acc-2' }));
    rec.add(T_2230, okEntry({ model: 'deepseek-pro' }));
    rec.add(T_2230, okEntry({ rate: 1 }));
    rec.add(T_2230 + HOUR, okEntry());
    const totals = rec.totals(2, T_2230 + HOUR);
    assert.strictEqual(totals.buckets, 6, `应与记录维度一一对应，实际 ${totals.buckets}`);
    assert.strictEqual(totals.requests, 6);
    rec.close();
  });

  test('失败尝试：请求 +1、失败 +1，token 记 0，不伪造延迟/吞吐', () => {
    const rec = new UsageRecorder({ filePath: bucketsFile() });
    rec.add(T_2230, { accountId: 'acc-9', model: 'deepseek-flash', rate: 1, key: 'key-9', ok: false });
    const totals = rec.totals(1, T_2230);
    assert.strictEqual(totals.requests, 1, '失败的尝试也是一次请求');
    assert.strictEqual(totals.errors, 1);
    assert.strictEqual(totals.prompt_tokens, 0);
    assert.strictEqual(totals.completion_tokens, 0);
    assert.strictEqual(totals.total_tokens, 0, '没有 usage 时不能凭空造 token');
    assert.strictEqual(totals.credits, 0);
    assert.strictEqual(totals.avg_latency_ms, null, '没有样本时平均延迟是 null 而不是 0');
    assert.strictEqual(totals.avg_tokens_per_second, null);
    rec.close();
  });

  test('没有 usage 的成功尝试 token 记 0', () => {
    const rec = new UsageRecorder({ filePath: bucketsFile() });
    rec.add(T_2230, { accountId: 'acc-1', model: 'deepseek-flash', rate: 1, key: 'key-1', ok: true });
    const totals = rec.totals(1, T_2230);
    assert.strictEqual(totals.requests, 1);
    assert.strictEqual(totals.total_tokens, 0);
    rec.close();
  });

  test('桶数触顶：先把 30 天前的小时桶逐级折叠，腾出空间而不是直接拒收', () => {
    const logs = [];
    const rec = new UsageRecorder({
      filePath: bucketsFile(), debounceMs: 0, maxBuckets: 5, log: (m) => logs.push(m),
    });
    const at = (offsetDays, hour) => new Date(2026, 10, 10 + offsetDays, hour, 0, 0).getTime();

    // 40 天前同一天的 3 个小时桶（同账号/模型/凭据）：折一次就能并成 1 个日桶。
    rec.add(at(-40, 10), okEntry({ accountId: 'old' }));
    rec.add(at(-40, 11), okEntry({ accountId: 'old' }));
    rec.add(at(-40, 12), okEntry({ accountId: 'old' }));
    rec.add(at(-20, 10), okEntry({ accountId: 'mid' }));
    rec.add(at(-3, 10), okEntry({ accountId: 'recent' }));
    assert.strictEqual(rec.stats().buckets, 5, '先占满上限');

    // 第 6 个桶触顶：先折 30 天前（3 → 1），空间腾出来就继续接收。
    assert.strictEqual(rec.add(at(0, 10), okEntry({ accountId: 'fresh' })), true,
      '折叠腾出空间后必须继续接收，不能直接拒收');
    assert.strictEqual(rec.stats().dropped, 0, '腾出空间时不应记拒收');
    assert.strictEqual(rec.stats().buckets, 4, '3 个老小时桶应并成 1 个日桶');
    assert.strictEqual(rec.stats().max_buckets, 5);
    assert.strictEqual(logs.length, 0, '折叠成功时不应该告警');

    // 折叠不丢数：全部 6 次尝试都能读回来。
    const q = rec.query({
      from: '2026-09-30', to: '2026-11-10', granularity: 'day',
    });
    assert.strictEqual(q.totals.requests, 6, '折叠前后请求数不变');
    assert.strictEqual(q.totals.buckets, 4);
    rec.close();
  });

  test('折叠后仍满：拒收新桶并累计 dropped，查询接口能读到', () => {
    const rec = new UsageRecorder({ filePath: bucketsFile(), debounceMs: 0, maxBuckets: 2 });
    const at = (hour) => new Date(2026, 10, 10, hour, 0, 0).getTime();

    rec.add(at(10), okEntry({ accountId: 'a' }));
    rec.add(at(11), okEntry({ accountId: 'b' }));
    assert.strictEqual(rec.stats().buckets, 2);

    assert.strictEqual(rec.add(at(12), okEntry({ accountId: 'c' })), false, '当天的小时桶折不动，必须拒收');
    assert.strictEqual(rec.stats().dropped, 1, '拒收条数要记下来');
    assert.strictEqual(rec.add(at(13), okEntry({ accountId: 'd' })), false);
    assert.strictEqual(rec.stats().dropped, 2);
    assert.strictEqual(rec.totals(24, T_2230).requests, 2, '被拒收的记录不能凭空出现');
    rec.close();
  });

  test('窗口按本地小时切，窗口外不计入', () => {
    const rec = new UsageRecorder({ filePath: bucketsFile() });
    rec.add(T_2230, okEntry({ totalTokens: 150 }));
    rec.add(T_2230 - 2 * HOUR, okEntry({ totalTokens: 30 }));
    assert.strictEqual(rec.totals(1, T_2230).total_tokens, 150, '1 小时窗口只能看到当前小时');
    assert.strictEqual(rec.totals(3, T_2230).total_tokens, 180, '3 小时窗口覆盖当前与之前两小时');
    rec.close();
  });

  test('重建实例（模拟重启）后数据仍在', () => {
    const filePath = bucketsFile();
    const first = new UsageRecorder({ filePath, debounceMs: 0 });
    first.add(T_2230, okEntry());
    first.flush();

    const second = new UsageRecorder({ filePath });
    const totals = second.totals(1, T_2230);
    assert.strictEqual(totals.requests, 1, '重启后请求数不能丢');
    assert.strictEqual(totals.total_tokens, 150, '重启后 token 不能丢');
    second.close();
  });

  test('落盘是临时文件 + rename 原子替换，且替换前旧文件始终完整', () => {
    const filePath = bucketsFile();
    const rec = new UsageRecorder({ filePath, debounceMs: 0 });
    rec.add(T_2230, okEntry());
    rec.flush();

    // 第二次写入：在 rename 发生的那一刻，目标文件必须还是上一次的完整 JSON。
    const before = fs.readFileSync(filePath, 'utf8');
    const renames = [];
    const realRename = fs.renameSync;
    fs.renameSync = (from, to) => {
      renames.push({ from, to });
      if (to === filePath) {
        assert.strictEqual(fs.readFileSync(filePath, 'utf8'), before, 'rename 前目标文件必须保持完整旧内容');
      }
      return realRename(from, to);
    };
    try {
      rec.add(T_2230 + 60 * 1000, okEntry());
      rec.flush();
    } finally {
      fs.renameSync = realRename;
    }

    assert.strictEqual(renames.length, 1, '一次落盘只应有一次 rename');
    assert.ok(renames[0].from.startsWith(`${filePath}.tmp`), `必须先写临时文件，实际 ${renames[0].from}`);
    assert.strictEqual(renames[0].to, filePath);
    const leftovers = fs.readdirSync(TMP_ROOT).filter((f) => f.startsWith(path.basename(filePath) + '.tmp'));
    assert.deepStrictEqual(leftovers, [], '落盘完成后不应留下临时文件');
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(filePath, 'utf8')), '落盘结果必须是完整 JSON');
    rec.close();
  });

  test('写入失败时不破坏已有账本', () => {
    const filePath = bucketsFile();
    const rec = new UsageRecorder({ filePath, debounceMs: 0 });
    rec.add(T_2230, okEntry());
    rec.flush();
    const before = fs.readFileSync(filePath, 'utf8');

    const realRename = fs.renameSync;
    fs.renameSync = () => { throw new Error('boom: disk full'); };
    try {
      rec.add(T_2230, okEntry());
      assert.doesNotThrow(() => rec.flush(), '落盘失败不能把进程带崩');
    } finally {
      fs.renameSync = realRename;
    }
    assert.strictEqual(fs.readFileSync(filePath, 'utf8'), before, '写失败后账本文件必须保持上一次的完整内容');
    rec.close();
  });

  await testAsync('防抖：不手动 flush，到点后自动落盘', async () => {
    const filePath = bucketsFile();
    const rec = new UsageRecorder({ filePath, debounceMs: 20 });
    rec.add(T_2230, okEntry());
    assert.strictEqual(fs.existsSync(filePath), false, '刚写完不应该立刻落盘');
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(fs.existsSync(filePath), '防抖到点后应自动落盘');
    assert.strictEqual(new UsageRecorder({ filePath }).totals(1, T_2230).requests, 1);
    rec.close();
  });

  console.log('✓ [All Passed] 用量账本：分桶、窗口、失败计数、原子落盘、重启恢复');
}

run().catch((err) => {
  console.error('测试失败:', err && err.stack || err);
  process.exit(1);
});
