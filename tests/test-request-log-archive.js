'use strict';
/**
 * 回归测试：请求日志落 JSONL 归档（工单 05）。
 *
 * 断言（模块层，全部在 os.tmpdir 下，不碰仓库）：
 *   A1) 追加一条记录后落盘一行合法 JSON，含账号 / 模型 / 结果 / 耗时 / 来源；
 *   A2) 关闭来源开关后，新行不含 ip 与 user_agent，旧行原样保留；
 *   A3) 保留天数：早于窗口的文件被删，窗口内的保留；
 *   A4) 容量上限：总量超限时从最旧的文件开始删，且绝不删最活跃的那份；
 *   A5) 单文件超限时轮转出 .part2.jsonl，同一天可多片；
 *   A6) 队列满只告警一次，不抛错；
 *   A7) 目录不可写时只告警一次，append/flush/cleanup 都不抛错，stats 说明原因。
 *   A8) 某批写失败时行放回队首重试（顺序不乱），超出队列上限的条数计入 stats().dropped。
 *
 * 断言（HTTP 层）：
 *   B1) 发一次请求后当天归档出现合法行，字段与内存记录一致；
 *   B2) GET /api/logs 带归档状态 enabled / files / bytes / oldest_day；
 *   B3) 关闭来源开关后新行没有 ip / user_agent，旧行不动；
 *   B4) 保存保留天数后立即清理，旧文件当场消失；
 *   B5) 保存容量上限后立即清理，总量回到上限以内；
 *   B6) 归档目录不可写时请求仍成功、只留一条告警、日志页仍能读内存记录；
 *   B7) 归档关闭时 /api/logs 明确回报 enabled=false，内存记录照常可用。
 *
 * 断言（页面）：设置页三项归位、日志页筛选栏旁显示归档占用。
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const { RequestLogArchive } = require('../src/request-log-archive');
const { dayKey, shiftDayKey } = require('../src/time-keys');
const { MockUpstream } = require('./mock-upstream');

const TMP_DIR = path.join(os.tmpdir(), `aiwork-log-archive-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
fs.mkdirSync(TMP_DIR, { recursive: true });
process.on('exit', () => {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
});

const MB = 1024 * 1024;

function todayKey() {
  return dayKey(new Date());
}

function listJsonl(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^requests-\d{4}-\d{2}-\d{2}(\.part\d+)?\.jsonl$/.test(f)).sort();
}

function readLines(dir, file) {
  return fs.readFileSync(path.join(dir, file), 'utf8').split('\n').filter((l) => l.trim() !== '');
}

function allLines(dir) {
  return listJsonl(dir).flatMap((f) => readLines(dir, f));
}

function rmDir(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {}
}

function sampleEntry(overrides) {
  return Object.assign({
    t: new Date().toISOString(),
    ip: '127.0.0.1',
    method: 'POST',
    path: '/v1/chat/completions',
    status: 200,
    ms: 42,
    key: 'log-archive-key',
    account: { name: '账号甲', short: 'abc123' },
    model: 'deepseek-flash',
    outcome: 'success',
    attempts: 0,
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
    error: '',
  }, overrides || {});
}

/* ------------------------------------------------------------------ */
/* A. 模块层                                                           */
/* ------------------------------------------------------------------ */

function makeArchive(dir, opts = {}) {
  const logs = [];
  const settings = Object.assign({
    retention_days: 14, max_mb: 200, capture_source: true,
  }, opts.settings || {});
  const archive = new RequestLogArchive({
    dir,
    settings: () => settings,
    log: (msg) => logs.push(msg),
    // 0 = 不装定时器，落盘时机完全由测试用 flush() 控制
    autoFlushMs: 0,
    maxQueue: opts.maxQueue,
    maxFileBytes: opts.maxFileBytes,
    enabled: opts.enabled,
  });
  return { archive, logs, settings };
}

async function partA() {
  // ---- A1 写一行合法 JSON ----
  {
    const dir = path.join(TMP_DIR, 'a1');
    fs.mkdirSync(dir, { recursive: true });
    const { archive } = makeArchive(dir);

    archive.append(sampleEntry(), 'curl/8.0');
    assert.deepStrictEqual(listJsonl(dir), [], 'append 只入内存队列，不能同步写盘');

    await archive.flush();
    const files = listJsonl(dir);
    assert.deepStrictEqual(files, [`requests-${todayKey()}.jsonl`], `应按天命名，实际 ${files.join(',')}`);
    const lines = readLines(dir, files[0]);
    assert.strictEqual(lines.length, 1, '一次请求恰好一行');

    const row = JSON.parse(lines[0]);
    assert.deepStrictEqual(row.account, { name: '账号甲', short: 'abc123' }, '归档行必须含账号');
    assert.strictEqual(row.model, 'deepseek-flash', '归档行必须含模型');
    assert.strictEqual(row.outcome, 'success', '归档行必须含结果');
    assert.strictEqual(row.ms, 42, '归档行必须含耗时');
    assert.strictEqual(row.total_tokens, 15, '归档行必须含 token');
    assert.strictEqual(row.ip, '127.0.0.1', '来源开关开着时应记录 IP');
    assert.strictEqual(row.user_agent, 'curl/8.0', '来源开关开着时应记录浏览器标识');
    assert(!/authorization|bearer\s/i.test(lines[0]), '归档不得写入 Authorization 之类的凭据');
    console.log('  ✓ A1 一条记录一行合法 JSON：账号/模型/结果/耗时/来源齐全');
  }

  // ---- A2 关闭来源开关 ----
  {
    const dir = path.join(TMP_DIR, 'a2');
    fs.mkdirSync(dir, { recursive: true });
    const { archive, settings } = makeArchive(dir);

    const first = sampleEntry({ path: '/v1/with-source' });
    archive.append(first, 'archive-agent/1.0');
    await archive.flush();

    settings.capture_source = false;
    archive.append(sampleEntry({ path: '/v1/without-source' }), 'archive-agent/2.0');
    await archive.flush();

    const rows = allLines(dir).map((l) => JSON.parse(l));
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].path, '/v1/with-source');
    assert.strictEqual(rows[0].ip, '127.0.0.1', '旧行必须保持原样');
    assert.strictEqual(rows[0].user_agent, 'archive-agent/1.0', '来源开关开着时写入浏览器标识');
    assert(!('user_agent' in first), '来源字段只进归档行，不得回写到内存记录');
    assert.strictEqual(rows[1].path, '/v1/without-source');
    assert(!('ip' in rows[1]), '关闭来源后新行不得含 ip 字段');
    assert(!('user_agent' in rows[1]), '关闭来源后新行不得含 user_agent 字段');
    console.log('  ✓ A2 来源开关关闭：新行无 ip/ua，旧行原样保留');
  }

  // ---- A3 保留天数 ----
  {
    const dir = path.join(TMP_DIR, 'a3');
    fs.mkdirSync(dir, { recursive: true });
    const oldFile = `requests-${shiftDayKey(Date.now(), -20)}.jsonl`;
    const keepFile = `requests-${shiftDayKey(Date.now(), -3)}.jsonl`;
    fs.writeFileSync(path.join(dir, oldFile), '{"t":"old"}\n');
    fs.writeFileSync(path.join(dir, keepFile), '{"t":"recent"}\n');

    const { archive } = makeArchive(dir, { settings: { retention_days: 14 } });
    const stats = archive.cleanup();
    const files = listJsonl(dir);
    assert(!files.includes(oldFile), `超过保留天数的 ${oldFile} 必须删除`);
    assert(files.includes(keepFile), `保留窗口内的 ${keepFile} 必须保留`);
    assert.strictEqual(stats.files, 1);
    assert.strictEqual(stats.oldest_day, shiftDayKey(Date.now(), -3), 'stats.oldest_day 应报最早文件日期');
    console.log('  ✓ A3 保留天数：超期文件删除，窗口内保留');
  }

  // ---- A4 容量上限 ----
  {
    const dir = path.join(TMP_DIR, 'a4');
    fs.mkdirSync(dir, { recursive: true });
    const chunk = Buffer.alloc(4 * MB, 'x');
    const names = [shiftDayKey(Date.now(), -3), shiftDayKey(Date.now(), -2), shiftDayKey(Date.now(), -1)];
    for (const day of names) fs.writeFileSync(path.join(dir, `requests-${day}.jsonl`), chunk);

    const { archive } = makeArchive(dir, { settings: { max_mb: 10 } });
    const stats = archive.cleanup();
    const files = listJsonl(dir);
    assert(!files.includes(`requests-${names[0]}.jsonl`), '容量超限时必须从最旧的文件开始删');
    assert.strictEqual(files.length, 2, `删到不超过上限即止，实际剩 ${files.length} 个文件`);
    assert(stats.bytes <= 10 * MB, `清理后总量必须回到上限内，实际 ${stats.bytes}`);
    assert.strictEqual(stats.oldest_day, names[1], 'oldest_day 应随清理更新');
    console.log('  ✓ A4 容量上限：从最旧开始删到上限以内');
  }

  // ---- A5 单文件轮转 ----
  {
    const dir = path.join(TMP_DIR, 'a5');
    fs.mkdirSync(dir, { recursive: true });
    const { archive } = makeArchive(dir, { maxFileBytes: 320 });

    for (let i = 0; i < 6; i++) archive.append(sampleEntry({ path: `/v1/rotate-${i}` }));
    await archive.flush();

    const files = listJsonl(dir);
    assert(files.length > 1, `单文件超过上限应轮转出多片，实际 ${files.join(',')}`);
    assert.strictEqual(files[0], `requests-${todayKey()}.jsonl`);
    assert.strictEqual(files[1], `requests-${todayKey()}.part2.jsonl`, '轮转片段应命名为 .part2.jsonl');
    const rows = allLines(dir).map((l) => JSON.parse(l));
    assert.strictEqual(rows.length, 6, '轮转不能丢行');
    assert.deepStrictEqual(rows.map((r) => r.path), [0, 1, 2, 3, 4, 5].map((i) => `/v1/rotate-${i}`), '轮转后行顺序不变');
    for (const f of files) {
      const size = fs.statSync(path.join(dir, f)).size;
      assert(size <= 320 + 256, `${f} 应在超出上限的下一行前轮转，实际 ${size} 字节`);
    }
    console.log('  ✓ A5 单文件超限轮转为 .part2.jsonl，行不丢、序不乱');
  }

  // ---- A6 队列满 ----
  {
    const dir = path.join(TMP_DIR, 'a6');
    fs.mkdirSync(dir, { recursive: true });
    const { archive, logs } = makeArchive(dir, { maxQueue: 2 });

    for (let i = 0; i < 5; i++) archive.append(sampleEntry({ path: `/v1/queue-${i}` }));
    await archive.flush();

    assert.strictEqual(allLines(dir).length, 2, '队列满时多余记录被丢弃，已入队的仍要落盘');
    const warns = logs.filter((m) => /队列|queue/i.test(m));
    assert.strictEqual(warns.length, 1, `队列满只告警一次，实际 ${warns.length} 次：${warns.join(' | ')}`);
    console.log('  ✓ A6 队列满：只告警一次，不抛错');
  }

  // ---- A7 目录不可写 ----
  {
    const dirPath = path.join(TMP_DIR, 'a7-logs');
    fs.writeFileSync(dirPath, 'this is a file, not a directory');
    const { archive, logs } = makeArchive(dirPath);

    archive.append(sampleEntry({ path: '/v1/unwritable-1' }));
    archive.append(sampleEntry({ path: '/v1/unwritable-2' }));
    await archive.flush();
    assert.doesNotThrow(() => archive.cleanup(), '目录不可写时 cleanup 不得抛错');

    const warns = logs.filter((m) => /fail|error|不可写/i.test(m));
    assert.strictEqual(warns.length, 1, `写失败只告警一次，实际 ${warns.length} 次：${warns.join(' | ')}`);
    const stats = archive.stats();
    assert.strictEqual(stats.writable, false, 'stats 必须说明目录不可写');
    assert(stats.error && stats.error.length > 0, 'stats 必须带可读原因');
    console.log('  ✓ A7 目录不可写：只告警一次，stats 给出原因');
  }

  // ---- A8 某批写失败：未写成功的行放回队首重试，放不下的才丢并计入 dropped ----
  {
    const dir = path.join(TMP_DIR, 'a8');
    fs.mkdirSync(dir, { recursive: true });
    const { archive } = makeArchive(dir, { maxQueue: 2 });

    const realAppend = fs.appendFile;
    let failCb = null;
    // 把这次写挂住，由测试决定何时失败 —— 这样「写失败时队列里已有新记录」是确定的。
    fs.appendFile = (p, data, enc, cb) => { failCb = cb; };
    try {
      archive.append(sampleEntry({ path: '/v1/retry-0' }));
      archive.append(sampleEntry({ path: '/v1/retry-1' }));
      const flushing = archive.flush();
      await new Promise((r) => setImmediate(r)); // 等写请求发出（此刻队列已被取空）
      assert(typeof failCb === 'function', '应该已经发出一次写请求');

      // 写还没完成时又来了新记录：它排在队首，失败的行要放回它前面。
      archive.append(sampleEntry({ path: '/v1/retry-2' }));
      failCb(new Error('boom: disk full'));
      await flushing;

      const failedStats = archive.stats();
      assert.strictEqual(failedStats.queued, 2, `失败的行应放回队列，实际排队 ${failedStats.queued}`);
      assert.strictEqual(failedStats.dropped, 1, '队列上限 2 放不下 3 条，多出的必须计入 dropped');
    } finally {
      fs.appendFile = realAppend;
    }

    await archive.flush();
    const rows = allLines(dir).map((l) => JSON.parse(l));
    assert.deepStrictEqual(rows.map((r) => r.path), ['/v1/retry-1', '/v1/retry-2'],
      '放回队列后顺序不乱；被丢的是最旧的那条');
    assert.strictEqual(allLines(dir).length, 2, '丢弃是可见的，不会静默多写');
    assert.strictEqual(archive.stats().dropped, 1, 'dropped 是累计值，重试成功后仍要能读到');
    console.log('  ✓ A8 写失败：行放回队首重试，超出队列上限的计入 dropped');
  }

  // ---- A9 close()：退出路径必须把队列写完再收尾（网关 shutdown 依赖这个语义） ----
  {
    const dir = path.join(TMP_DIR, 'a9');
    fs.mkdirSync(dir, { recursive: true });
    const { archive } = makeArchive(dir);

    archive.append(sampleEntry({ path: '/v1/close-1' }));
    archive.append(sampleEntry({ path: '/v1/close-2' }));
    assert.deepStrictEqual(listJsonl(dir), [], 'close 之前不应写盘');
    await archive.close();
    const rows = allLines(dir).map((l) => JSON.parse(l));
    assert.deepStrictEqual(rows.map((r) => r.path), ['/v1/close-1', '/v1/close-2'],
      'close() 必须把队列写完再 resolve');
    console.log('  ✓ A9 close()：退出前把队列写完');
  }
}

/* ------------------------------------------------------------------ */
/* B. HTTP 层                                                          */
/* ------------------------------------------------------------------ */

const API_KEY = 'sk-log-archive-invocation';
const ACCOUNT_KEY = 'sk-log-archive-account';
const ACCOUNT_NAME = '归档账号';
const SECRET_TAIL = 'Q7Z9';
const UNNAMED_KEY = `sk-unnamed-log-archive-${SECRET_TAIL}`;

function httpRequest(port, method, urlPath, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: urlPath, method, headers, timeout: 15000,
    }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(d); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, json: j, text: d });
      });
    });
    req.on('error', reject);
    if (body) {
      const s = typeof body === 'string' ? body : JSON.stringify(body);
      req.setHeader('Content-Type', 'application/json');
      req.setHeader('Content-Length', Buffer.byteLength(s));
      req.write(s);
    }
    req.end();
  });
}

function writeAccount(baseDir, name) {
  const dir = path.join(baseDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.env'), `AGENTIX_CONFIG_MODELS_AIWORK_ROUTER_API_KEY=${ACCOUNT_KEY}\n`);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    config_protocol_version: '1.1',
    models: { 'aiwork-router': { models: [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }] } },
  }, null, 2));
}

function prepareDataDir(root) {
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'api-keys.json'), JSON.stringify({
    version: 1,
    keys: [
      {
        id: 'key-log-archive', token: API_KEY, name: 'log-archive-key',
        accountPolicy: { mode: 'all', allowedAccounts: [] }, createdAt: Date.now(), revoked: false,
      },
      {
        // 未命名凭据在磁盘上的样子：名字就是「key-<密钥末四位>」。
        // 归档不该原样记这个名字，否则密钥片段会落进 JSONL。
        id: 'key-log-unnamed', token: UNNAMED_KEY, name: `key-${SECRET_TAIL}`,
        accountPolicy: { mode: 'all', allowedAccounts: [] }, createdAt: Date.now(), revoked: false,
      },
    ],
  }, null, 2));
  return dataDir;
}

async function waitForHealth(port, getLogs) {
  for (let i = 0; i < 80; i++) {
    try { if ((await httpRequest(port, 'GET', '/healthz')).status === 200) return; } catch (_) {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`网关未启动。日志:\n${(getLogs() || '').slice(-1500)}`);
}

async function waitFor(fn, hint, tries = 60, gap = 50) {
  for (let i = 0; i < tries; i++) {
    try { const v = await fn(); if (v) return v; } catch (_) {}
    await new Promise((r) => setTimeout(r, gap));
  }
  throw new Error(`等不到期望结果：${hint}`);
}

async function chat(port, sessionId, ua) {
  const res = await httpRequest(port, 'POST', '/v1/chat/completions', {
    model: 'deepseek-flash',
    messages: [{ role: 'user', content: 'ping' }],
    stream: false,
  }, { Authorization: `Bearer ${API_KEY}`, 'x-session-id': sessionId, 'User-Agent': ua });
  assert.strictEqual(res.status, 200, `chat 失败: ${res.status} ${res.text.slice(0, 300)}`);
  return res;
}

async function partB() {
  const mock = new MockUpstream({ quiet: true });
  await mock.start(0);
  const accountsRoot = path.join(TMP_DIR, 'accounts');
  writeAccount(accountsRoot, 'acc_main');

  const upstreamAnswer = () => {
    mock.clear();
    mock.queueResponse('/v1/chat/completions', {
      status: 200,
      body: {
        id: 'chatcmpl-archive',
        model: 'deepseek-flash',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 },
      },
    });
  };

  const startGateway = (port, dataDir, extraEnv = {}) => {
    let logs = '';
    const proc = cp.fork(path.join(__dirname, '..', 'src', 'api-bridge.js'), [], {
      env: {
        ...process.env,
        PORT: String(port), BIND: '127.0.0.1',
        UPSTREAM: 'direct', UPSTREAM_FALLBACK: '0', ROUTER_BASE_URL: mock.url,
        UPSTREAM_ACCOUNTS: JSON.stringify([{ id: 'acc_main', name: ACCOUNT_NAME, stateDir: path.join(accountsRoot, 'acc_main') }]),
        GATEWAY_DATA_DIR: dataDir,
        STATE_PATH: path.join(dataDir, 'usage-state.json'),
        AGENTIX_STATE_DIR: path.join(TMP_DIR, 'nonexistent-default-state'),
        QUIET: '1', LOG_LEVEL: 'error',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    proc.stdout.on('data', (d) => { logs += d; });
    proc.stderr.on('data', (d) => { logs += d; });
    return { proc, getLogs: () => logs };
  };

  const children = [];
  try {
    // ================= 主实例：正常归档 =================
    const root = path.join(TMP_DIR, 'b1');
    const dataDir = prepareDataDir(root);
    const port = 19700 + Math.floor(Math.random() * 200);
    const gw = startGateway(port, dataDir);
    children.push(gw.proc);
    await waitForHealth(port, gw.getLogs);

    const logsDir = path.join(dataDir, 'logs');

    // ---- B1 一行合法归档 ----
    upstreamAnswer();
    await chat(port, 'sess-archive-1', 'archive-agent/1.0');

    const logFile = () => path.join(logsDir, `requests-${todayKey()}.jsonl`);
    const firstLine = await waitFor(() => {
      if (!fs.existsSync(logFile())) return null;
      const lines = readLines(logsDir, `requests-${todayKey()}.jsonl`);
      return lines.length ? lines[0] : null;
    }, '当天归档文件出现一行');

    const row = JSON.parse(firstLine);
    assert.strictEqual(row.path, '/v1/chat/completions');
    assert.strictEqual(row.method, 'POST');
    assert.strictEqual(row.status, 200);
    assert.strictEqual(row.outcome, 'success');
    assert.deepStrictEqual(row.account && row.account.name, ACCOUNT_NAME, '归档行必须含账号');
    assert.strictEqual(row.model, 'deepseek-flash', '归档行必须含模型');
    assert.strictEqual(row.total_tokens, 15, '归档行必须含 token');
    assert(Number.isFinite(row.ms), '归档行必须含耗时');
    assert(/127\.0\.0\.1|::ffff:127\.0\.0\.1/.test(String(row.ip)), `应记录来源 IP，实际 ${row.ip}`);
    assert(String(row.user_agent).includes('archive-agent/1.0'), '应记录浏览器标识');
    console.log('  ✓ B1 一次请求 → 当天归档一行，账号/模型/结果/耗时齐全');

    // ---- B2 /api/logs 归档状态 ----
    const logsRes = await httpRequest(port, 'GET', '/api/logs?limit=10', null, { Authorization: `Bearer ${API_KEY}` });
    assert.strictEqual(logsRes.status, 200, logsRes.text);
    const ar = logsRes.json.archive;
    assert(ar, 'GET /api/logs 必须返回 archive 状态');
    assert.strictEqual(ar.enabled, true);
    assert(ar.files >= 1, `archive.files 应 >= 1，实际 ${ar.files}`);
    assert(ar.bytes > 0, 'archive.bytes 应大于 0');
    assert.strictEqual(ar.oldest_day, todayKey(), 'archive.oldest_day 应是当天');
    console.log('  ✓ B2 /api/logs 带归档状态：enabled / files / bytes / oldest_day');

    // ---- B3 关闭来源开关 ----
    upstreamAnswer();
    await chat(port, 'sess-archive-2', 'archive-agent/2.0');
    await waitFor(() => readLines(logsDir, `requests-${todayKey()}.jsonl`).length >= 2, '第二行归档');

    const off = await httpRequest(port, 'PUT', '/api/settings', { request_log_capture_source: false },
      { Authorization: `Bearer ${API_KEY}` });
    assert.strictEqual(off.status, 200, off.text);
    assert.strictEqual(off.json.settings.request_log_capture_source, false, '设置必须立即生效');

    upstreamAnswer();
    await chat(port, 'sess-archive-3', 'archive-agent/3.0');

    const rows = await waitFor(() => {
      const parsed = readLines(logsDir, `requests-${todayKey()}.jsonl`).map((l) => JSON.parse(l));
      return parsed.length >= 3 ? parsed : null;
    }, '第三行归档');

    assert.strictEqual(rows[0].ip !== undefined, true, '旧行不得被改写');
    assert.strictEqual(rows[1].ip !== undefined, true, '旧行不得被改写');
    assert(!('ip' in rows[2]), '关闭来源后新行不得含 ip');
    assert(!('user_agent' in rows[2]), '关闭来源后新行不得含 user_agent');
    console.log('  ✓ B3 关闭来源开关：新行无 ip/ua，旧行原样');

    // ---- B4 保留天数保存后立即清理 ----
    const staleDay = shiftDayKey(Date.now(), -10);
    fs.writeFileSync(path.join(logsDir, `requests-${staleDay}.jsonl`), '{"t":"stale"}\n');
    assert(fs.existsSync(path.join(logsDir, `requests-${staleDay}.jsonl`)));

    const retentionPut = await httpRequest(port, 'PUT', '/api/settings', { request_log_retention_days: 5 },
      { Authorization: `Bearer ${API_KEY}` });
    assert.strictEqual(retentionPut.status, 200, retentionPut.text);
    assert(!fs.existsSync(path.join(logsDir, `requests-${staleDay}.jsonl`)),
      '保存保留天数后必须立即清理超出窗口的文件');
    assert(fs.existsSync(logFile()), '当天的归档文件不能被保留天数清掉');
    console.log('  ✓ B4 保存保留天数：立即清理旧文件');

    // ---- B5 容量上限保存后立即清理 ----
    const bigChunk = Buffer.alloc(6 * MB, 'x');
    const bigDay1 = shiftDayKey(Date.now(), -2);
    const bigDay2 = shiftDayKey(Date.now(), -1);
    fs.writeFileSync(path.join(logsDir, `requests-${bigDay1}.jsonl`), bigChunk);
    fs.writeFileSync(path.join(logsDir, `requests-${bigDay2}.jsonl`), bigChunk);

    const capPut = await httpRequest(port, 'PUT', '/api/settings', { request_log_max_mb: 10 },
      { Authorization: `Bearer ${API_KEY}` });
    assert.strictEqual(capPut.status, 200, capPut.text);
    assert(!fs.existsSync(path.join(logsDir, `requests-${bigDay1}.jsonl`)),
      '容量超限时最旧的大文件必须被删');
    const sizeNow = listJsonl(logsDir).reduce((n, f) => n + fs.statSync(path.join(logsDir, f)).size, 0);
    assert(sizeNow <= 10 * MB, `清理后总量必须回到上限内，实际 ${sizeNow}`);
    const logsAfterCleanup = await httpRequest(port, 'GET', '/api/logs?limit=10', null, { Authorization: `Bearer ${API_KEY}` });
    assert(logsAfterCleanup.json.archive.bytes <= 10 * MB, '归档状态里的 bytes 必须是清理后的值');
    console.log('  ✓ B5 保存容量上限：立即从最旧清理到上限以内');

    // ---- B8 未命名凭据：归档不落密钥末四位，改用 id 短哈希 ----
    // 默认名是「key-<密钥末四位>」，直接记名字等于把密钥片段写进磁盘。
    upstreamAnswer();
    const unnamedCall = await httpRequest(port, 'POST', '/v1/chat/completions', {
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: 'unnamed key' }],
      stream: false,
    }, { Authorization: `Bearer ${UNNAMED_KEY}`, 'x-session-id': 'sess-unnamed-key', 'User-Agent': 'unnamed-agent/1.0' });
    assert.strictEqual(unnamedCall.status, 200, unnamedCall.text);

    const unnamedRow = await waitFor(() => {
      const parsed = readLines(logsDir, `requests-${todayKey()}.jsonl`).map((l) => JSON.parse(l));
      return parsed.find((r) => r.key && r.key !== 'log-archive-key') || null;
    }, '未命名凭据的归档行');

    assert.match(unnamedRow.key, /^[0-9a-f]{6}$/, `未命名凭据应记 id 短哈希，实际 ${unnamedRow.key}`);
    assert.notStrictEqual(unnamedRow.key, `key-${SECRET_TAIL}`, '归档不能写默认名（等于密钥末四位）');
    const archiveText = listJsonl(logsDir)
      .map((f) => fs.readFileSync(path.join(logsDir, f), 'utf8'))
      .join('');
    assert(!archiveText.includes(SECRET_TAIL), `归档文件里不得出现密钥末四位 ${SECRET_TAIL}`);
    assert(!archiveText.includes(UNNAMED_KEY), '归档文件里不得出现凭据明文');
    console.log('  ✓ B8 未命名凭据：归档记 id 短哈希，不落密钥末四位');

    gw.proc.kill('SIGTERM');

    // ================= 不可写实例 =================
    const root2 = path.join(TMP_DIR, 'b2');
    const dataDir2 = prepareDataDir(root2);
    fs.writeFileSync(path.join(dataDir2, 'logs'), 'not a directory');
    const port2 = 20000 + Math.floor(Math.random() * 200);
    const gw2 = startGateway(port2, dataDir2);
    children.push(gw2.proc);
    await waitForHealth(port2, gw2.getLogs);

    // ---- B6 目录不可写 ----
    upstreamAnswer();
    await chat(port2, 'sess-unwritable-1', 'blocked-agent/1.0');
    upstreamAnswer();
    await chat(port2, 'sess-unwritable-2', 'blocked-agent/2.0');

    const logsUnwritable = await httpRequest(port2, 'GET', '/api/logs?limit=10', null, { Authorization: `Bearer ${API_KEY}` });
    assert.strictEqual(logsUnwritable.status, 200, logsUnwritable.text);
    assert((logsUnwritable.json.entries || []).length >= 2, '归档不可写时，内存里的最近记录必须照常可读');
    assert.strictEqual(logsUnwritable.json.archive.enabled, true);
    assert.strictEqual(logsUnwritable.json.archive.writable, false, '不可写时 archive.writable 必须是 false');
    assert(logsUnwritable.json.archive.error, '不可写时 archive.error 必须说明原因');

    const warnCount = (gw2.getLogs().match(/request log archive[^\n]*/g) || []).length;
    assert.strictEqual(warnCount, 1, `归档写失败只应告警一次，实际 ${warnCount} 次`);
    console.log('  ✓ B6 目录不可写：请求仍成功，只告警一次，内存记录照常可读');
    gw2.proc.kill('SIGTERM');

    // ================= 归档关闭实例 =================
    const root3 = path.join(TMP_DIR, 'b3');
    const dataDir3 = prepareDataDir(root3);
    const port3 = 20300 + Math.floor(Math.random() * 200);
    const gw3 = startGateway(port3, dataDir3, { REQUEST_LOG_ARCHIVE: '0' });
    children.push(gw3.proc);
    await waitForHealth(port3, gw3.getLogs);

    // ---- B7 归档关闭 ----
    upstreamAnswer();
    await chat(port3, 'sess-disabled-1', 'disabled-agent/1.0');

    const logsDisabled = await httpRequest(port3, 'GET', '/api/logs?limit=10', null, { Authorization: `Bearer ${API_KEY}` });
    assert.strictEqual(logsDisabled.status, 200, logsDisabled.text);
    assert.strictEqual(logsDisabled.json.archive.enabled, false, '归档关闭时必须明确回报 enabled=false');
    assert((logsDisabled.json.entries || []).length >= 1, '归档关闭时日志页仍要能用内存里的最近记录');
    assert(!fs.existsSync(path.join(dataDir3, 'logs')) || listJsonl(path.join(dataDir3, 'logs')).length === 0,
      '归档关闭时不得写盘');
    console.log('  ✓ B7 归档关闭：enabled=false，内存记录照常可用');
  } finally {
    for (const c of children) { try { c.kill('SIGTERM'); } catch (_) {} }
    await mock.stop();
  }
}

/* ------------------------------------------------------------------ */
/* C. 页面                                                             */
/* ------------------------------------------------------------------ */

function partC() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');

  const start = html.indexOf('<section class="view" data-view="settings">');
  const end = html.indexOf('</section>', start);
  const settingsView = html.slice(start, end);
  const netGroupAt = settingsView.indexOf('<h3>网络与日志</h3>');
  assert(netGroupAt >= 0, '设置页应有「网络与日志」组');
  const netBlock = settingsView.slice(netGroupAt, settingsView.indexOf('<h3>模型回落</h3>'));
  for (const id of ['setLogRetention', 'setLogMaxMb', 'setLogCaptureSource']) {
    assert(netBlock.includes(`id="${id}"`), `「网络与日志」组里应有 ${id}`);
  }

  const logsStart = html.indexOf('<section class="view" data-view="logs">');
  const logsEnd = html.indexOf('</section>', logsStart);
  const logsView = html.slice(logsStart, logsEnd);
  assert(/id="logArchive"/.test(logsView), '日志页筛选栏旁必须有归档占用位置');
  const filtersAt = logsView.indexOf('class="log-filters"');
  const archiveAt = logsView.indexOf('id="logArchive"');
  assert(filtersAt >= 0 && archiveAt > filtersAt, '归档占用应放在筛选栏区域内');
  assert(/归档/.test(html) && /oldest_day|oldestDay/.test(html), '页面要渲染归档占用与最早日期');

  console.log('  ✓ C 设置页三项归位，日志页筛选栏旁显示归档占用');
}

async function run() {
  await partA();
  await partB();
  partC();
  console.log('\n✓ [All Passed] 请求日志 JSONL 归档：落盘 / 来源开关 / 保留与容量 / 轮转 / 不可写 / 页面状态');
}

run().catch((err) => {
  console.error('测试失败:', err.message);
  process.exit(1);
});
