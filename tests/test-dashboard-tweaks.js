'use strict';
/**
 * 首页两处改动（可用在前且绿色、仪表盘只在对话视图）。
 *
 * 页面没有 DOM 环境，做结构断言；但只断言能被「改错」打破的事实：
 * 顺序、颜色来源、类名是否真的挂在元素上、显隐映射是否精确。
 * 上一版用 indexOf('</div>') 切片和 {0,200} 松匹配，注释都能骗过，已收紧。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');

// ---- 1. 积分卡：可用在已用前面，且数字与标签都是成功色 ----
const iAvail = html.indexOf('id="dashCreditsAvail"');
const iUsed = html.indexOf('id="dashCreditsUsed"');
assert(iAvail > 0, '积分卡必须有 dashCreditsAvail 元素');
assert(iUsed > 0, '积分卡必须保留 dashCreditsUsed 元素');
assert(iAvail < iUsed, '「可用」必须排在「已用」前面');

// 类名必须真的挂在元素上：只有 CSS 规则、类不在，绿色会静默失效
assert(
  /<div class="dash-kpi avail" id="dashCreditsAvail">/.test(html),
  '可用数字元素必须带 avail 类'
);
assert(
  /\.dash-kpi\.avail\{[^}]*color:var\(--ok\)/.test(html),
  '可用数字必须用成功色（var(--ok)）'
);
assert(
  /\.dash-kpi\.avail small\{[^}]*color:var\(--ok\)/.test(html),
  '「可用」标签也要跟随成功色，不能只染大数字'
);
assert(/id="dashCreditsAvail">[^<]*<small>\s*可用\s*<\/small>/.test(html), '可用 KPI 要带「可用」标签');

// 绘制函数必须用 remain 画可用
assert(
  /setKpi\(\$?\('?dashCreditsAvail'?\),\s*remain/.test(html),
  'paintCredits 必须用 remain 绘制可用数字'
);

// ---- 2. 仪表盘只在对话视图出现 ----
// 精确断言三元映射，而不是只匹配 'chat' 字面：
// 写反成 ? 'none' : ''，或写成 (name==='chat'||name==='usage')，都必须失败。
assert(
  /const dash = \$\('dashboard'\);\s*\n\s*if \(dash\) dash\.style\.display = name === 'chat' \? '' : 'none';/.test(html),
  "仪表盘显隐必须精确写成 name === 'chat' ? '' : 'none'（chat 显示、其余全隐藏）"
);

console.log('✓ [All Passed] 首页：可用在前且绿色 + 仪表盘只在对话视图');
