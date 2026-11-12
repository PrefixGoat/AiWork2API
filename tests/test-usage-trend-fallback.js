'use strict';
/**
 * 静态契约：趋势图的「图表库可用 → Chart.js，不可用 → DOM 柱子」这条双出口。
 *
 * 票 04 把旧函数改名成 renderUsageChartBars，当时守的是「旧名字彻底消失」。
 * 票 05 新建了同名的 renderUsageChart（Chart.js 双轴图），所以这里改成守新的分工：
 *   - renderUsageChartBars 仍在，作为兜底出口；
 *   - renderUsageChart 在，是主渲染路径；
 *   - renderUsageChart 里必须有「拿不到 window.Chart / onerror 置位就退回 bars」的分支
 *     （票 07 补上了 __chartLoadFailed：defer 脚本的 onerror 可能晚于内联脚本执行）。
 * 同时不再断言「页面里没有 renderUsageChart(」——那已经和现实相反。
 *
 * 页面没有 DOM 测试环境，沿用 test-usage-page.js 的静态断言写法。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');

// ---- 1. 两个函数都在：兜底出口与主渲染路径各司其职 ----
assert(HTML.indexOf('function renderUsageChartBars(') > -1,
  '兜底柱子渲染函数 renderUsageChartBars() 必须保留');

const chartStart = HTML.indexOf('function renderUsageChart(');
assert(chartStart > -1, '主渲染路径 renderUsageChart() 必须存在（票 05）');

// ---- 2. 主路径里保留降级分支：库不可用（缺 Chart 或 onerror 已置位）时委托给兜底出口 ----
const chartEnd = HTML.indexOf('function usageMetricColumns(', chartStart);
assert(chartEnd > chartStart, '找不到 renderUsageChart 的函数体边界');
const chartBody = HTML.slice(chartStart, chartEnd);
assert(/if\s*\(\s*!window\.Chart\s*\|\|\s*window\.__chartLoadFailed\s*\)\s*\{\s*renderUsageChartBars\(series\);\s*return;\s*\}/.test(chartBody),
  'renderUsageChart 必须在 window.Chart 缺失或加载失败时退回 renderUsageChartBars(series)');

// ---- 3. 调用点走主路径：两处（加载成功 / 读取失败清图）都调用 renderUsageChart ----
const chartCalls = (HTML.match(/\brenderUsageChart\(/g) || []).length;
assert(chartCalls >= 3, `renderUsageChart 至少应有 1 处声明 + 2 处调用，实际 ${chartCalls} 处`);
assert(/renderUsageChart\(j\.series\);/.test(HTML), '加载成功后应调用 renderUsageChart(j.series)');
assert(/renderUsageChart\(\[\]\);/.test(HTML), '读取失败清图时应调用 renderUsageChart([])');

// 直接调用兜底函数的只有声明与降级分支：别处再调它就是在绕过双轴图。
const barCalls = (HTML.match(/\brenderUsageChartBars\(/g) || []).length;
assert.strictEqual(barCalls, 2, 'renderUsageChartBars 只应被声明与降级分支引用');

console.log('ok - 趋势图：Chart.js 主路径 + 无库时退回 DOM 柱子');
