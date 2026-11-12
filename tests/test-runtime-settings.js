'use strict';
/**
 * 回归测试：运行时配置（设置页的数据源）。
 *
 * 约束（ADR 0013）：
 *   - 配置存 GATEWAY_DATA_DIR/gateway-config.json，env 只作初始默认值。
 *   - 页面可通过 GET/PUT /api/settings 读写，写完立即生效，不需要重启。
 *   - 白名单键 + 范围校验：越界值必须拒绝并给出可读错误，不能写进文件。
 *   - 未知键忽略，不报错也不落盘。
 *
 * 断言：
 *   1) 未写过配置时返回 10 项默认值；
 *   2) PUT 合法值后 GET 立即反映，且文件已落盘；
 *   3) 越界/类型错误返回 400 且不改变已有值；
 *   4) 未知键被忽略；
 *   5) 未授权访问被拒绝。
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const TMP_DIR = path.join(os.tmpdir(), `aiwork-runtime-settings-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
fs.mkdirSync(TMP_DIR, { recursive: true });
process.on('exit', () => {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
});

const ADMIN_PASS = 'TestSettingsPass123!';
const API_KEY = 'sk-settings-client';

async function run() {
  const dataDir = path.join(TMP_DIR, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const port = 19400 + Math.floor(Math.random() * 300);

  let childLogs = '';
  const gwProc = cp.fork(path.join(__dirname, '..', 'src', 'api-bridge.js'), [], {
    env: {
      ...process.env,
      PORT: String(port), BIND: '127.0.0.1',
      ADMIN_PASSWORD: ADMIN_PASS, API_KEYS: `${API_KEY}:test`,
      GATEWAY_DATA_DIR: dataDir,
      STATE_PATH: path.join(dataDir, 'usage-state.json'),
      AGENTIX_STATE_DIR: path.join(TMP_DIR, 'nonexistent-default-state'),
      QUIET: '1', LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  gwProc.stdout.on('data', (d) => { childLogs += d; });
  gwProc.stderr.on('data', (d) => { childLogs += d; });

  const base = `http://127.0.0.1:${port}`;
  function request(method, urlPath, body = null, headers = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request(new URL(urlPath, base), { method, headers, timeout: 10000 }, (res) => {
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
        req.setHeader('Content-Type', 'application/json');
        req.write(typeof body === 'string' ? body : JSON.stringify(body));
      }
      req.end();
    });
  }

  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { if ((await request('GET', '/healthz')).status === 200) { ready = true; break; } } catch (_) {}
    await new Promise((r) => setTimeout(r, 150));
  }
  assert(ready, `网桥未能在预期时间内启动。日志:\n${childLogs.slice(-1500)}`);

  try {
    const login = await request('POST', '/api/admin/login', { password: ADMIN_PASS });
    assert.strictEqual(login.status, 200, login.text);
    const adminHeaders = { Cookie: login.headers['set-cookie'][0].split(';')[0] };

    // ---- 5. 未授权 ----
    const anon = await request('GET', '/api/settings');
    assert([401, 403].includes(anon.status), `未授权读取设置应被拒绝，实际 ${anon.status}`);

    // ---- 1. 默认值 ----
    const initial = await request('GET', '/api/settings', null, adminHeaders);
    assert.strictEqual(initial.status, 200, initial.text);
    const s = initial.json.settings;
    assert(s, '响应必须包含 settings');
    assert.strictEqual(s.max_concurrency_per_account, 10, '默认单账号最大在途');
    assert.strictEqual(s.session_binding_ttl_sec, 3600, '默认粘性 TTL');
    assert.strictEqual(s.session_binding_enabled, true, '默认开启粘性路由');
    assert.strictEqual(s.short_request_timeout_sec, 120, '默认短请求超时');
    assert.strictEqual(s.first_byte_timeout_sec, 120, '默认首字节超时');
    assert.strictEqual(s.stream_idle_timeout_sec, 300, '默认流空闲超时');
    assert.strictEqual(s.outbound_user_agent, 'aiwork-gateway/1.0', '默认出站 UA');
    assert.strictEqual(s.request_log_retention_days, 14, '默认请求日志保留天数');
    assert.strictEqual(s.request_log_max_mb, 200, '默认请求日志容量上限');
    assert.strictEqual(s.request_log_capture_source, true, '默认记录来源 IP 与浏览器标识');

    // ---- 2. 合法写入 + 立即生效 ----
    const put = await request('PUT', '/api/settings', {
      max_concurrency_per_account: 3,
      session_binding_ttl_sec: 1800,
      session_binding_enabled: false,
      short_request_timeout_sec: 45,
      first_byte_timeout_sec: 30,
      stream_idle_timeout_sec: 240,
      outbound_user_agent: 'aiwork-test/2.0',
      request_log_retention_days: 7,
      request_log_max_mb: 50,
      request_log_capture_source: false,
    }, adminHeaders);
    assert.strictEqual(put.status, 200, put.text);

    const after = await request('GET', '/api/settings', null, adminHeaders);
    const s2 = after.json.settings;
    assert.strictEqual(s2.max_concurrency_per_account, 3);
    assert.strictEqual(s2.session_binding_ttl_sec, 1800);
    assert.strictEqual(s2.session_binding_enabled, false);
    assert.strictEqual(s2.short_request_timeout_sec, 45);
    assert.strictEqual(s2.first_byte_timeout_sec, 30);
    assert.strictEqual(s2.stream_idle_timeout_sec, 240);
    assert.strictEqual(s2.outbound_user_agent, 'aiwork-test/2.0');
    assert.strictEqual(s2.request_log_retention_days, 7);
    assert.strictEqual(s2.request_log_max_mb, 50);
    assert.strictEqual(s2.request_log_capture_source, false);

    const cfgPath = path.join(dataDir, 'gateway-config.json');
    assert(fs.existsSync(cfgPath), '配置必须落盘到 gateway-config.json');
    const onDisk = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    assert.strictEqual(onDisk.max_concurrency_per_account, 3, '落盘内容必须是新值');
    assert.strictEqual(onDisk.outbound_user_agent, 'aiwork-test/2.0');

    // ---- 3. 越界/类型错误被拒绝，且不改变已有值 ----
    const bad = await request('PUT', '/api/settings', {
      max_concurrency_per_account: 0, short_request_timeout_sec: -1, request_log_retention_days: 0,
    }, adminHeaders);
    assert.strictEqual(bad.status, 400, `越界值必须 400，实际 ${bad.status} ${bad.text}`);
    assert(bad.json && bad.json.error, '400 必须带可读错误');
    const afterBad = await request('GET', '/api/settings', null, adminHeaders);
    assert.strictEqual(afterBad.json.settings.max_concurrency_per_account, 3, '非法写入不能改动已有值');
    assert.strictEqual(afterBad.json.settings.short_request_timeout_sec, 45, '非法写入不能改动已有值');
    assert.strictEqual(afterBad.json.settings.request_log_retention_days, 7, '非法写入不能改动已有值');

    const badType = await request('PUT', '/api/settings', {
      session_binding_enabled: 'yes-please',
    }, adminHeaders);
    assert.strictEqual(badType.status, 400, '布尔字段收到字符串必须 400');

    // ---- 4. 未知键忽略，但要回报；一个已知键都没有则拒绝 ----
    const unknown = await request('PUT', '/api/settings', {
      max_concurrency_per_account: 5, not_a_real_key: 'x',
    }, adminHeaders);
    assert.strictEqual(unknown.status, 200, unknown.text);
    assert.deepStrictEqual(unknown.json.ignored, ['not_a_real_key'], '未知键应回报而非静默丢弃');
    const afterUnknown = await request('GET', '/api/settings', null, adminHeaders);
    assert.strictEqual(afterUnknown.json.settings.max_concurrency_per_account, 5);
    assert.strictEqual(afterUnknown.json.settings.not_a_real_key, undefined, '未知键不能出现在结果里');
    assert(!fs.readFileSync(cfgPath, 'utf8').includes('not_a_real_key'), '未知键不能落盘');

    // ADR-0014 §5 否掉了 { sessions: {...} } 包裹层：不能 200 却一个字段都不写。
    const nested = await request('PUT', '/api/settings', {
      sessions: { max_concurrency_per_account: 2 },
    }, adminHeaders);
    assert.strictEqual(nested.status, 400, `嵌套包裹层必须 400，实际 ${nested.status} ${nested.text}`);
    const afterNested = await request('GET', '/api/settings', null, adminHeaders);
    assert.strictEqual(afterNested.json.settings.max_concurrency_per_account, 5, '被拒绝的写入不能改动已有值');

    console.log('✓ [All Passed] 运行时配置：默认值 / 热写入 / 越界拒绝 / 未知键回报 / 嵌套包裹层拒绝');
  } finally {
    gwProc.kill('SIGTERM');
  }
}

run().catch((err) => {
  console.error('测试失败:', err.message);
  process.exit(1);
});
