'use strict';
/**
 * 时间窗口的两个口径问题（评审 #04/#08）：
 *   1) datetime-local 是「本地时间、无时区」，必须转成带时区的 ISO 再发，
 *      否则服务端按自己的时区（容器常为 UTC）解释，用户选的时段整体偏移；
 *   2) 「今天」必须是本地零点到此刻，不能用滚动 24 小时（会把昨天傍晚算进来）。
 *
 * 断言方式：页面函数无法在 Node 里执行，改为断言「换算与口径只在一处发生」，
 * 并检查调用点确实用了转换函数，而不是把原始 value 直接塞进查询。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');

// 转换函数存在且用 Date 转 ISO
assert(/function localInputToIso\(v\)/.test(html), '必须有本地时间转 ISO 的函数');
assert(
  /function localInputToIso\(v\)\{[\s\S]{0,240}toISOString\(\)/.test(html),
  '转换函数必须产出带时区的 ISO'
);

// 日志筛选的 from/to 走转换
assert(
  /from: localInputToIso\(get\('logFilterFrom'\)\)/.test(html) &&
    /to: localInputToIso\(get\('logFilterTo'\)\)/.test(html),
  '日志筛选的起止时间必须经过时区转换'
);

// 用量自定义区间走转换
assert(
  /from: localInputToIso\(from\), to: localInputToIso\(to\)/.test(html),
  '用量自定义区间必须经过时区转换'
);

// 今天 = 本地零点到此刻（返回 from/to，而不是 hours 窗口）
assert(
  /state\.usageRange === 'today'[\s\S]{0,260}getFullYear\(\)[\s\S]{0,120}from: start\.toISOString\(\)/.test(html),
  '「今天」必须从本地零点算起'
);
assert(
  !/RANGE_HOURS\s*=\s*\{\s*today:\s*24/.test(html),
  '「今天」不能再挂在滚动 24 小时上'
);

console.log('✓ [All Passed] 时间窗口：本地时区换算 + 今天按自然日');
