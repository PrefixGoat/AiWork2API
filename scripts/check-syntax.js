'use strict';
/**
 * 极简快速语法预检脚本 (node --check)
 * 遍历 src/、tests/ 与 scripts/ 下的所有 .js 文件执行语法校验，毫秒级拦截语法错误
 */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const TARGET_DIRS = ['src', 'tests', 'scripts'];

function collectJsFiles(dir) {
  const fullPath = path.join(ROOT_DIR, dir);
  if (!fs.existsSync(fullPath)) return [];
  const files = [];

  function walk(current) {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const ent of entries) {
      const p = path.join(current, ent.name);
      if (ent.isDirectory()) {
        walk(p);
      } else if (ent.isFile() && ent.name.endsWith('.js')) {
        files.push(p);
      }
    }
  }

  walk(fullPath);
  return files;
}

const startTime = Date.now();
const allFiles = TARGET_DIRS.flatMap(collectJsFiles);
let failureCount = 0;

for (const file of allFiles) {
  const relPath = path.relative(ROOT_DIR, file);
  try {
    cp.execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    failureCount++;
    console.error(`\n❌ [语法错误] ${relPath}:`);
    if (err.stderr) {
      console.error(err.stderr.toString().trim());
    } else {
      console.error(err.message);
    }
  }
}

const elapsedMs = Date.now() - startTime;
if (failureCount > 0) {
  console.error(`\n预检失败: 发现 ${failureCount} 个文件存在语法错误 (耗时 ${elapsedMs}ms)`);
  process.exit(1);
} else {
  console.log(`✓ 语法预检通过: ${allFiles.length} 个 JS 源码文件语法校验全部通过 (耗时 ${elapsedMs}ms)`);
}
