'use strict';
/**
 * 单测：matchLogFilters 的入参守卫（不启动网关）。
 *
 * 过滤条件来自页面查询串与内部调用，两者都可能把「没有条件」传成 null。
 * 默认参数只兜 undefined，显式 null 必须在函数体内收口，否则一次
 * `f.account` 的 TypeError 就会把 /api/logs 打成 500。
 *
 * 状态目录全部指向临时目录：加载模块时账本会读盘，绝不污染仓库。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwork-log-filter-predicate-'));
process.on('exit', () => {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
});

// 先改环境再 require：账本路径与状态目录都在模块加载时求值。
process.env.QUIET = '1';
process.env.GATEWAY_DATA_DIR = TMP_DIR;
process.env.STATE_PATH = path.join(TMP_DIR, 'usage-state.json');
process.env.USAGE_BUCKETS_PATH = path.join(TMP_DIR, 'usage-buckets.json');
process.env.AGENTIX_STATE_DIR = path.join(TMP_DIR, 'nonexistent-agentix');

const { matchLogFilters } = require('../src/api-bridge');

const ENTRY = {
  t: '2026-01-01T00:00:00.000Z',
  account: { name: '账号甲', short: 'ab12cd34' },
  model: 'deepseek-flash',
  outcome: 'success',
  status: 200,
  path: '/v1/chat/completions',
  error: '',
};

// 显式 null：这是本次要守的回归点（默认参数对它不生效）。
assert.doesNotThrow(() => matchLogFilters(ENTRY, null), '显式 null 不能抛错');
assert.strictEqual(matchLogFilters(ENTRY, null), true, '没有筛选条件时任何记录都命中');
assert.strictEqual(matchLogFilters(ENTRY, undefined), true, 'undefined 仍按无筛选处理');
assert.strictEqual(matchLogFilters(ENTRY), true, '省略第二个参数仍按无筛选处理');
assert.strictEqual(matchLogFilters(ENTRY, { model: 'pro' }), false, '空条件收口后仍要按条件过滤');
assert.strictEqual(matchLogFilters(ENTRY, { model: 'FLASH' }), true, '条件匹配语义不变（大小写不敏感）');

console.log('✓ [All Passed] matchLogFilters 入参守卫：null/undefined 视为无筛选，条件照常生效');
process.exit(0);
