'use strict';
/**
 * 静态契约：趋势区块的容器与样式（票 03-container-and-styles）。
 *
 * 后续票据要把这块换成「左轴 token 堆叠柱 + 右轴请求/失败折线」的双轴图，
 * 图例画在画布顶部。这里先把容器结构定死，好让渲染票据照着填：
 *   - 绘图区从 132px 抬到 180px，外层包裹层定高，canvas 撑满；
 *   - 底部「起止时间 + 合计」那一行独立于绘图区，不会被顶部图例压住；
 *   - 窄屏（400px）下不横向滚动、图例不折行；
 *   - 空态有自己的类，居中且不撑高容器。
 *
 * 页面没有 DOM 测试环境，沿用 test-key-card-layout.js 的静态断言写法：
 * 断言的是结构契约（id / 类名 / 定高 / 媒体查询），不碰渲染函数。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');

// 取一条 CSS 规则的声明体。选择器按整段匹配，避免 `.usage-chart` 命中 `.usage-chart-legend`。
function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = HTML.match(new RegExp(escaped + '\\s*\\{([^}]*)\\}'));
  assert(m, `找不到 CSS 规则 ${selector}`);
  return m[1];
}

// 取 @media 查询的整段内容（含嵌套规则），靠大括号配平。
function mediaBody(query) {
  const start = HTML.indexOf(query);
  assert(start > -1, `找不到媒体查询 ${query}`);
  const open = HTML.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < HTML.length; i++) {
    if (HTML[i] === '{') depth++;
    else if (HTML[i] === '}') {
      depth--;
      if (depth === 0) return HTML.slice(open + 1, i);
    }
  }
  assert.fail(`媒体查询 ${query} 的大括号没有配平`);
}

// ---- 1. 绘图区高度：包裹层定高 180px，图表本体撑满 ----
const WRAP = ruleBody('.usage-chart-wrap');
assert(/height:\s*180px/.test(WRAP), '趋势图包裹层必须定高 180px（给顶部图例与绘图区一起留位置）');
assert(/position:\s*relative/.test(WRAP), '包裹层要定位上下文，空态才能绝对定位铺在绘图区上');

const CHART = ruleBody('.usage-chart');
assert(!/height:\s*132px/.test(CHART), '趋势图不再固定 132px，高度交给包裹层');
assert(/height:\s*100%/.test(CHART), '趋势图本体撑满包裹层，canvas 才能铺到 180px');

// ---- 2. 容器标识仍在（test-usage-page.js 与渲染票据都钉着） ----
const wrapStart = HTML.indexOf('class="usage-chart-wrap"');
const legendStart = HTML.indexOf('class="usage-chart-legend"');
const chartStart = HTML.indexOf('id="usageChart"');
assert(wrapStart > -1, '静态结构里要有 .usage-chart-wrap 包裹层');
assert(chartStart > wrapStart, '#usageChart 必须被包裹层包住');
assert(chartStart < legendStart, '#usageChart 要在底部图例行之前');
assert(/class="usage-chart"[^>]*id="usageChart"/.test(HTML), '#usageChart 的 class="usage-chart" 不能摘');
assert(/id="usageChart"[^>]*role="list"/.test(HTML), '#usageChart 的 role="list" 不能摘');
for (const id of ['usageChartFrom', 'usageChartNote', 'usageChartTo']) {
  assert(HTML.includes(`id="${id}"`), `底部图例行缺 ${id}`);
}
// 顶部图例由 Chart.js 画在画布内，容器里不预先塞节点——渲染票据自己创建。
const wrapSeg = HTML.slice(wrapStart, legendStart);
assert(!/<canvas/.test(wrapSeg), '此处只留位置与样式，canvas 由渲染票据创建');

// ---- 3. 底部图例行：不换行、不被挤压 ----
const LEGEND_CELL = ruleBody('.usage-chart-legend>span');
assert(/white-space:\s*nowrap/.test(LEGEND_CELL), '底部图例的每一项不换行，窄屏才不会压到绘图区');
assert(/text-overflow:\s*ellipsis/.test(LEGEND_CELL), '空间不够时省略，而不是撑破布局');

// ---- 4. 空态：居中、绝对定位，不撑高容器 ----
const EMPTY = ruleBody('.usage-chart-empty');
assert(/position:\s*absolute/.test(EMPTY), '空态要绝对定位，不能把容器撑高');
assert(/align-items:\s*center/.test(EMPTY) && /justify-content:\s*center/.test(EMPTY),
  '空态在绘图区里水平垂直居中');
assert(/text-align:\s*center/.test(EMPTY), '空态文案居中');

// ---- 5. 窄屏（400px）：不横向滚动、图例不折行、高度降级但仍可读 ----
const NARROW = mediaBody('@media (max-width:400px)');
assert(/\.usage-chart-wrap\s*\{[^}]*height:\s*1[0-9][0-9]px/.test(NARROW),
  '窄屏要把绘图区高度降下来，但不能塌成一条缝');
assert(/\.usage-chart\s*\{[^}]*overflow-x:\s*hidden/.test(NARROW), '窄屏不再横向滚动，多出的柱子压缩/裁掉');
assert(/\.usage-chart-legend[^{]*\{[^}]*nowrap/.test(NARROW), '窄屏图例不折行');

// ---- 6. 文案债：柱子不参与 Tab 序列，不能承诺「聚焦」 ----
const trendIdx = HTML.indexOf('<h3>趋势</h3>');
assert(trendIdx > -1, '找不到趋势区块标题');
const descMatch = HTML.slice(trendIdx, trendIdx + 500).match(/<p class="pane-desc">([^<]*)<\/p>/);
assert(descMatch, '趋势区块缺少描述文案');
const DESC = descMatch[1];
assert(!/聚焦/.test(DESC), '柱子不可键盘聚焦，描述里不能再出现「聚焦」');
assert(/悬停/.test(DESC), '描述应只讲悬停（hover）这一种真实可用的交互');
