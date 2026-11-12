'use strict';
/**
 * 全量集成测试执行引导脚本
 * 串行执行 tests/ 目录下的所有 test-*.js 测试套件，默认开启 Quiet Mode，
 * 输出整洁的测试概览与结果摘要，防止终端日志膨胀。
 */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const TESTS_DIR = path.join(ROOT_DIR, 'tests');

// 默认开启静默模式 (除非显式传入 QUIET=0 或 DEBUG=1)
const QUIET_DEFAULT = (process.env.QUIET === '0' || process.env.DEBUG === '1') ? '0' : '1';
const TEST_ENV = {
  ...process.env,
  QUIET: process.env.QUIET || QUIET_DEFAULT,
  LOG_LEVEL: process.env.LOG_LEVEL || (QUIET_DEFAULT === '1' ? 'error' : 'info'),
};

const testFiles = fs.readdirSync(TESTS_DIR)
  .filter((f) => f.startsWith('test-') && f.endsWith('.js'))
  .sort();

console.log('============================================================');
console.log(`AiWork Gateway - 运行全量测试套件 (${testFiles.length} 个套件)`);
console.log(`模式: ${TEST_ENV.QUIET === '1' ? 'Quiet (仅通过标记，失败输出上下文)' : 'Verbose (完整调试日志)'}`);
console.log('============================================================\n');

const suiteResults = [];
const overallStartTime = Date.now();

for (const file of testFiles) {
  const filePath = path.join(TESTS_DIR, file);
  const suiteName = path.basename(file, '.js');
  process.stdout.write(`▶ 运行 ${file} ...\n`);

  const suiteStart = Date.now();
  const res = cp.spawnSync(process.execPath, [filePath], {
    cwd: ROOT_DIR,
    env: TEST_ENV,
    stdio: 'inherit',
  });
  const elapsed = ((Date.now() - suiteStart) / 1000).toFixed(1);

  if (res.status === 0) {
    suiteResults.push({ file, passed: true, elapsed });
    console.log(`✓ [Passed] ${file} (${elapsed}s)\n`);
  } else {
    suiteResults.push({ file, passed: false, elapsed, code: res.status });
    console.error(`\n❌ [Failed] ${file} 退出码: ${res.status} (${elapsed}s)\n`);
    // 一旦失败立即中止并报告
    console.error('============================================================');
    console.error(`测试套件执行中断: ${file} 验证失败`);
    console.error('============================================================');
    process.exit(res.status || 1);
  }
}

const totalElapsed = ((Date.now() - overallStartTime) / 1000).toFixed(1);

console.log('============================================================');
console.log('AiWork Gateway - 全量测试执行汇总');
console.log('============================================================');
for (const r of suiteResults) {
  console.log(`  ✓ ${r.file.padEnd(40)} ${r.elapsed}s [OK]`);
}
console.log('------------------------------------------------------------');
console.log(`结果: ${suiteResults.length}/${suiteResults.length} 套件全部通过 (100% Green), 总耗时: ${totalElapsed}s`);
console.log('============================================================');
