'use strict';
/**
 * 回归测试：设置页说人话（票 01-settings-plain-copy）。
 *
 * 设置页是用户唯一能改运行时配置的地方，文案本身就是功能：
 *   - 11 项按「账号调度 / 超时 / 网络与日志」三组排列，组内顺序固定；
 *   - 标题是一句人话，单位不再塞进标题，改由输入框右侧的英文后缀显示；
 *   - 每项带一句说明，读得出「改了会怎样」，且不靠括号与引号补信息。
 *
 * 断言只落在页面的公开结构上（静态 HTML），后端读写契约由
 * test-runtime-settings.js 覆盖。这里另外守住两件事：脚本引用的控件 id 必须仍存在，
 * 数字输入的 min/max 提示不能在重排布局时被丢掉——否则「改值保存后重新打开能读回」
 * 会在页面侧悄悄断掉。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');

// 顺序即展示顺序。说明文字照抄产品确认过的文案——这里刻意硬编码成独立事实来源，
// 而不是从页面反推，否则断言会跟着实现一起漂移。
const ITEMS = [
  {
    id: 'setMaxConcurrency',
    title: '单账号最大在途并发',
    unit: null,
    desc: '一个账号同时最多处理几个请求，满了新的请求会换到别的账号。',
  },
  {
    id: 'setSessionBinding',
    title: '会话粘性路由',
    unit: null,
    desc: '开启后同一段对话尽量固定在一个账号上，避免多轮问答跳号。',
  },
  {
    id: 'setSessionTtl',
    title: '会话粘性 TTL',
    unit: 's',
    desc: '这个固定关系保留多久，超时后下一次请求会重新挑账号。',
  },
  {
    id: 'setShortTimeout',
    title: '短请求超时',
    unit: 's',
    desc: '一次普通请求最多等多久，超时就换号重试。',
  },
  {
    id: 'setFirstByte',
    title: '聊天首字节超时',
    unit: 's',
    desc: '请求发出后，上游多久没有回应就放弃这次尝试。',
  },
  {
    id: 'setStreamIdle',
    title: '流空闲超时',
    unit: 's',
    desc: '流式输出中途停顿多久算卡死，超时会中断这次尝试。',
  },
  {
    id: 'setBindAddress',
    title: '监听 IP',
    unit: null,
    desc: '填 127.0.0.1 只有本机能访问，填 0.0.0.0 允许局域网访问。这里只填 IP，端口在下面两行。',
  },
  {
    id: 'setListenPort',
    title: '容器内端口',
    unit: null,
    desc: '网关在容器里监听的端口，保存后立即换绑，已经在途的请求不会被打断。',
  },
  {
    id: 'setHostPort',
    title: '容器外端口',
    unit: null,
    desc: '宿主机上访问用的端口，由 compose 的端口映射决定，本页改不了。',
  },
  {
    id: 'setUserAgent',
    title: '出站 User-Agent',
    unit: null,
    desc: '网关发给上游的客户端标识，一般不用改。',
  },
  {
    id: 'setLogRetention',
    title: '请求日志保留天数',
    unit: 'd',
    desc: '归档文件保留多少天，更早的会自动删掉。',
  },
  {
    id: 'setLogMaxMb',
    title: '请求日志容量上限',
    unit: 'MB',
    desc: '归档文件最多占多少空间，超出时从最旧的开始删。',
  },
  {
    id: 'setLogCaptureSource',
    title: '记录来源 IP 与浏览器标识',
    unit: null,
    desc: '开启后每条记录会带上来源 IP 和浏览器标识，方便查是谁在调用。',
  },
];

const GROUPS = [
  { title: '账号调度', ids: ['setMaxConcurrency', 'setSessionBinding', 'setSessionTtl'] },
  { title: '超时', ids: ['setShortTimeout', 'setFirstByte', 'setStreamIdle'] },
  {
    title: '网络与日志',
    ids: ['setBindAddress', 'setListenPort', 'setHostPort', 'setUserAgent', 'setLogRetention', 'setLogMaxMb', 'setLogCaptureSource'],
  },
];

/** 只取设置视图，避免日志页等别处的同名文案混进断言。 */
function settingsSection() {
  const start = HTML.indexOf('<section class="view" data-view="settings">');
  assert(start >= 0, '设置视图必须存在');
  const end = HTML.indexOf('</section>', start);
  assert(end > start, '设置视图必须有闭合标签');
  return HTML.slice(start, end);
}

/** 一项设置 = 一行「标题 + 控件 + 可选单位后缀 + 可选按钮」，紧跟一句说明。 */
function readItem(section, it) {
  const re = new RegExp(
    '<label[^>]*>([^<]+)</label>\\s*<input[^>]*id="' + it.id + '"[^>]*>\\s*' +
    '(?:<span class="set-unit">([^<]*)</span>\\s*)?' +
    '(?:<button[^>]*>[^<]*</button>\\s*)?' +
    '</div>\\s*<p class="set-desc"[^>]*>([\\s\\S]*?)</p>'
  );
  const m = section.match(re);
  assert(m, `设置项 ${it.id} 必须是「标题 + 控件 + 说明」的结构，且说明紧跟控件`);
  return { title: m[1].trim(), unit: m[2], desc: m[3].trim() };
}

function run() {
  const section = settingsSection();

  // ---- 1. 标题、单位后缀、说明 ----
  for (const it of ITEMS) {
    const row = readItem(section, it);
    assert.strictEqual(row.title, it.title, `设置项 ${it.id} 的标题应是一句人话`);
    assert(!/[（）]/.test(row.title), `标题不得再用括号补单位或解释：${row.title}`);
    // 单位只走输入框右侧的英文后缀；非秒类字段不能凭空冒出一个后缀。
    assert.strictEqual(row.unit, it.unit || undefined,
      it.unit ? `${it.id} 应在输入框右侧显示单位 ${it.unit}` : `${it.id} 不应显示单位后缀`);
    assert.strictEqual(row.desc, it.desc, `设置项 ${it.id} 的说明应与确认文案一致`);
    assert(!/[（）「」]/.test(row.desc), `说明不得用括号或引号补信息：${row.desc}`);
  }

  // 单位后缀只能出现在带单位的字段上，不能靠列表外的残留 span 凑数。
  // 数量与具体字段都写成硬期望：若有人删掉某条单位断言（或单位在页面里被摘掉），
  // 这里不会像「从 ITEMS 推导」那样跟着一起放宽。
  const UNIT_IDS = ['setSessionTtl', 'setShortTimeout', 'setFirstByte', 'setStreamIdle',
    'setLogRetention', 'setLogMaxMb'];
  const UNIT_VALUES = ['s', 's', 's', 's', 'd', 'MB'];
  assert.strictEqual((section.match(/class="set-unit"/g) || []).length, 6,
    '设置页应恰好有 6 个带单位的字段');
  const unitFields = [...section.matchAll(
    /<input[^>]*id="(set[A-Za-z]+)"[^>]*>\s*<span class="set-unit">([^<]*)<\/span>/g
  )].map((m) => [m[1], m[2]]);
  assert.deepStrictEqual(unitFields.map((u) => u[0]), UNIT_IDS,
    '带单位的字段应恰好是这 6 个，且顺序固定');
  assert.deepStrictEqual(unitFields.map((u) => u[1]), UNIT_VALUES,
    '这 6 个字段的单位后缀应依次为 s/s/s/s/d/MB');

  // ---- 2. 三组结构：标题可见、归位、组内与全局顺序固定 ----
  const headingAt = GROUPS.map((g) => {
    const i = section.indexOf(`<h3>${g.title}</h3>`);
    assert(i >= 0, `应有一组标题为「${g.title}」`);
    return i;
  });
  for (let i = 1; i < headingAt.length; i++) {
    assert(headingAt[i] > headingAt[i - 1], `分组顺序应为 ${GROUPS.map((g) => g.title).join(' / ')}`);
  }
  // 「网络与日志」之后是模型回落等既有区块，说明本组没有吞掉别的设置。
  const fallbackAt = section.indexOf('<h3>模型回落</h3>');
  assert(fallbackAt > headingAt[headingAt.length - 1], '网络与日志组应排在模型回落之前');

  GROUPS.forEach((g, gi) => {
    const from = headingAt[gi];
    const to = gi + 1 < headingAt.length ? headingAt[gi + 1] : section.length;
    const block = section.slice(from, to);
    let prev = -1;
    for (const id of g.ids) {
      const at = block.indexOf(`id="${id}"`);
      assert(at >= 0, `「${g.title}」组里应有 ${id}`);
      assert(at > prev, `「${g.title}」组内顺序应与文案一致`);
      prev = at;
    }
    for (const it of ITEMS) {
      if (g.ids.includes(it.id)) continue;
      assert(!block.includes(`id="${it.id}"`), `${it.id} 不属于「${g.title}」组`);
    }
  });

  let prevItem = -1;
  for (const it of ITEMS) {
    const at = section.indexOf(`id="${it.id}"`);
    assert(at > prevItem, `设置项全局顺序应与文案一致，${it.id} 位置不对`);
    prevItem = at;
  }

  // ---- 3. 脚本引用与页面控件对得上 ----
  const referenced = new Set([...HTML.matchAll(/\$\('(set[A-Za-z]+)'\)/g)].map((m) => m[1]));
  for (const id of referenced) {
    assert(HTML.includes(`id="${id}"`), `脚本引用了 ${id}，但页面上没有这个控件`);
  }
  for (const it of ITEMS) {
    assert(referenced.has(it.id), `设置项 ${it.id} 没有被 loadSettings / saveSettings 接线`);
  }

  // 数字输入保留取值范围提示：重排布局不该把 min/max 丢掉。
  for (const id of ['setMaxConcurrency', 'setSessionTtl', 'setShortTimeout', 'setFirstByte', 'setStreamIdle',
    'setListenPort', 'setHostPort', 'setLogRetention', 'setLogMaxMb']) {
    const tag = section.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`));
    assert(tag, `缺少数字输入 ${id}`);
    assert(/min="\d+"/.test(tag[0]) && /max="\d+"/.test(tag[0]), `${id} 应保留 min/max 提示`);
  }

  // ---- 4. 保存路径不变：仍走 /api/settings，未知键仍要提示 ----
  assert(/fetch\('\/api\/settings'/.test(HTML), '页面仍应通过 /api/settings 读写设置');
  assert(/method:\s*'PUT'/.test(HTML), '保存设置仍应是 PUT');
  assert(/已忽略/.test(HTML), '未知键被忽略时必须继续提示用户，不能静默丢弃');
  assert(/保存失败：/.test(HTML), '保存失败提示仍要可读');

  // ---- 5. 端口三件套：监听 IP / 容器内端口 / 容器外端口 ----
  assert(/当前生效/.test(HTML), '监听地址必须显示当前生效值');
  assert(/未生效/.test(HTML), '保存值与生效值不一致时必须明确提示，否则用户会以为已经换绑成功');
  const bindTag = section.match(/<input[^>]*id="setBindAddress"[^>]*>/);
  assert(bindTag && /maxlength="253"/.test(bindTag[0]),
    '监听 IP 只收 IP，长度按主机名上限，不该再让人往里写端口');
  assert(/id="setListenPort"/.test(section) && /id="setHostPort"/.test(section),
    '容器内、容器外端口要各有一个输入框');
  assert(/id="btnCopyPortCmd"/.test(section), '容器外端口改不了时，必须给出可复制的命令');
  assert(/set-port\.sh/.test(HTML), '复制出来的命令必须指向 scripts/set-port.sh');
  assert(/renderPortFields\(/.test(HTML), '外端口要按「是否容器」切换输入框与命令');
  assert(/disabled = true/.test(HTML), '非容器部署时外端口应跟随内端口，不能让人改出一个不存在的映射');

  console.log('✓ [All Passed] 设置页：三组归位 / 标题无单位 / 单位后缀 / 说明一句人话 / 保存路径不变 / 端口三件套');
}

run();
