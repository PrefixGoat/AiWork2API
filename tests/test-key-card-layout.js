'use strict';
/**
 * 回归测试：凭据卡片改成行式布局（票 03-key-card-row-layout）。
 *
 * 这张票的价值是把结构先定下来，后面五张票各自往自己那一行的操作位加按钮。
 * 所以要守住的不只是「六行在」，还有三件会决定并行是否冲突的事：
 *   1) 单张卡片的渲染必须是独立函数（renderKeyCard），列表渲染只负责循环；
 *   2) 行由 keyRow(标签, 值) 造，右侧操作位是独立空容器，只能用 addKeyRowAction 追加；
 *   3) 行顺序固定为 名称 / 接口地址 / API Key / 模型 / ID / 账号范围。
 * 本票据不留任何复制按钮——操作位必须是空的。
 *
 * 页面没有 DOM 测试环境，沿用 test-key-reveal.js 的静态断言写法。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');

// 取某个顶层（缩进两格）函数的函数体：从声明处到同缩进的收尾大括号。
function fnBody(name){
  const start = HTML.indexOf(`function ${name}(`);
  assert(start > -1, `页面里找不到函数 ${name}()`);
  const end = HTML.indexOf('\n  }\n', start);
  return HTML.slice(start, end === -1 ? undefined : end);
}

const CARD = fnBody('renderKeyCard');
const LIST = fnBody('renderAdminKeys');
const ROW = fnBody('keyRow');
const OPS = fnBody('addKeyRowAction');

// 注释里会提到后续票据要加什么，判断「有没有真的加」只看代码行。
const CARD_CODE = CARD.replace(/^\s*\/\/.*$/gm, '');

// ---- 1. 单卡渲染与列表渲染分开 ----
assert(/renderKeyCard\(k\)/.test(LIST), '列表渲染必须调用单卡渲染 renderKeyCard(k)');
assert(!/keyRow\(/.test(LIST), '列表渲染不应自己拼行，行结构只在 renderKeyCard 里');
assert(!/createElement\('div'\)[\s\S]*key-card/.test(LIST), '列表渲染不应再直接造卡片');
assert(/document\.createElement\('div'\)/.test(CARD) && /return card;/.test(CARD), 'renderKeyCard 应返回一张卡片');

// ---- 2. 六行齐全，顺序固定（后续票据按顺序接线） ----
const ROWS = ['名称', '接口地址', 'API Key', '模型', 'ID', '账号范围'];
const positions = ROWS.map((label) => {
  const idx = CARD.indexOf(`keyRow('${label}'`);
  assert(idx > -1, `卡片缺少「${label}」行`);
  return idx;
});
assert(
  positions.every((v, i) => i === 0 || v > positions[i - 1]),
  '六行的先后顺序被改动，后续票据的行会错位'
);

// ---- 3. 行辅助：标签 + 值 + 空操作位 ----
assert(/key-row-label/.test(ROW), '行必须带左侧标签节点');
assert(/key-row-value/.test(ROW), '行必须带中间的值节点');
assert(/key-row-ops/.test(ROW), '行必须带右侧操作位容器');
assert(/document\.createElement\('span'\)/.test(ROW), '操作位应是独立节点，而不是复用值节点');
assert(/function addKeyRowAction\(row, node\)/.test(HTML), '缺少往操作位加按钮的辅助 addKeyRowAction(row, node)');
assert(/querySelector\('\.key-row-ops'\)/.test(OPS), 'addKeyRowAction 应定位到该行的操作位');

// ---- 4. 本票据不放复制按钮，操作位保持为空 ----
assert(!/addKeyRowAction\(/.test(CARD_CODE), '本票据不应往操作位加任何按钮');
assert(!/copyText\(/.test(CARD_CODE), '本票据不放复制实现，复制由后续票据各自接');

// ---- 5. 接口地址是当前访问地址 + /v1，不拼出双斜杠 ----
assert(/keyRow\('接口地址',\s*location\.origin \+ '\/v1'\)/.test(CARD),
  '接口地址应显示为 location.origin + /v1');
assert(!/'\/\/v1'/.test(CARD), '接口地址不要手写双斜杠');

// ---- 6. 模型行只占位，渲染时不发请求 ----
assert(/keyRow\('模型', '点复制时读取'\)/.test(CARD), '模型行本票据只显示「点复制时读取」占位');
assert(!/\/v1\/models/.test(CARD_CODE), '渲染列表时不得请求模型，模型要按需读');

// ---- 7. 既有能力不能丢 ----
assert(/key-card' \+ \(k\.revoked \? ' revoked' : ''\)/.test(CARD), '撤销卡片的置灰样式要保留');
assert(/badge ' \+ \(k\.revoked \? 'revoked' : 'active'\)/.test(CARD), '状态徽标要保留');
assert(/aria-label', '显示完整 Key'/.test(CARD), '「显示完整 Key」入口要保留');
assert(/tokenEl\.dataset\.masked/.test(CARD), 'token 需要独立节点记录脱敏值');
assert(/tokenEl\.textContent = tokenEl\.dataset\.masked/.test(CARD), '收起时必须把明文从 DOM 里抹掉');
assert(/k\.stats\.requests/.test(CARD), '请求次数不能丢');
assert(/btnEdit/.test(CARD) && /btnRevoke/.test(CARD), '修改与撤销按钮要保留');
assert(/暂无调用凭据/.test(LIST), '空列表提示要保持一致');
assert(/加载调用凭据列表失败/.test(HTML), '加载失败提示要保持一致');

// ---- 8. 只用 createElement / textContent，不用 innerHTML 拼结构 ----
assert(!/\.innerHTML\s*=/.test(HTML), '不得用 innerHTML 赋值构建 DOM');

// ---- 9. 窄屏：标签定宽不换行，值可断行，不产生横向滚动 ----
const rowCss = HTML.match(/\.key-row\{[^}]*\}/);
assert(rowCss, '缺少 .key-row 样式');
assert(/display:grid/.test(rowCss[0]), '.key-row 应用 grid 排版');
assert(/minmax\(0,1fr\)/.test(rowCss[0]), '值列必须可收缩，否则窄屏会横向滚动');
assert(/\.key-row-label\{[^}]*white-space:nowrap/.test(HTML), '标签不应被挤压换行');
assert(/\.key-row-value\{[^}]*min-width:0/.test(HTML), '值列需要 min-width:0 才能收缩');
assert(/\.key-row-value\{[^}]*word-break:break-all/.test(HTML), '长地址与长 Key 应换行而不是撑破卡片');
assert(/\.key-row-ops\{/.test(HTML), '缺少操作位样式');

console.log('✓ [All Passed] 凭据卡片：单卡渲染拆出 + 六行布局 + 空操作位');
