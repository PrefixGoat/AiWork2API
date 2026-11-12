'use strict';
/**
 * 调用凭据的「默认脱敏 + 按需查看」契约。
 *
 * 现状（改前）：`GET /api/admin/keys` 直接返回明文 token，页面把它整段打在卡片上，
 * 谁打开控制台谁就能看到全部 Key。目标：
 *   1) 列表默认只给脱敏值（sk-abc...wxyz），响应体里不出现明文；
 *   2) 需要时通过 `GET /api/admin/keys/:id/token` 单独取一次明文；
 *   3) 该端点仍受管理权限保护，且不可缓存。
 *
 * 接缝：HTTP 接口 + 页面静态接线（本仓库没有 DOM 测试环境，页面用静态断言守护）。
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const TMP_DIR = path.join(os.tmpdir(), `aiwork-key-reveal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
fs.mkdirSync(TMP_DIR, { recursive: true });
process.on('exit', () => {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
});

const API_KEY = 'sk-reveal-demo-0123456789abcdef';
const ADMIN_PASS = 'RevealPass123!';

async function run() {
  const dataDir = path.join(TMP_DIR, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const port = 20900 + Math.floor(Math.random() * 300);
  let logs = '';
  const gw = cp.fork(path.join(__dirname, '..', 'src', 'api-bridge.js'), [], {
    env: {
      ...process.env,
      PORT: String(port), BIND: '127.0.0.1',
      GATEWAY_DATA_DIR: dataDir,
      STATE_PATH: path.join(dataDir, 'usage-state.json'),
      AGENTIX_STATE_DIR: path.join(TMP_DIR, 'no-state'),
      API_KEYS: `${API_KEY}:review`,
      ADMIN_PASSWORD: ADMIN_PASS,
      QUIET: '1', LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  gw.stdout.on('data', (d) => { logs += d; });
  gw.stderr.on('data', (d) => { logs += d; });

  const base = `http://127.0.0.1:${port}`;
  function request(method, urlPath, body = null, headers = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request(new URL(urlPath, base), { method, headers, timeout: 15000 }, (res) => {
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
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  let ready = false;
  for (let i = 0; i < 80; i++) {
    try { if ((await request('GET', '/healthz')).status === 200) { ready = true; break; } } catch (_) {}
    await new Promise((r) => setTimeout(r, 150));
  }
  assert(ready, `网关未启动。日志:\n${logs.slice(-1500)}`);

  try {
    const login = await request('POST', '/api/admin/login', { password: ADMIN_PASS });
    assert.strictEqual(login.status, 200, login.text);
    const cookie = { Cookie: login.headers['set-cookie'][0].split(';')[0] };

    // ---- 1. 列表必须脱敏：响应体里不能出现明文 ----
    const list = await request('GET', '/api/admin/keys', null, cookie);
    assert.strictEqual(list.status, 200, list.text);
    assert.strictEqual(list.json.keys.length, 1, '应只有一把种子凭据');
    const row = list.json.keys[0];
    assert.notStrictEqual(row.token, API_KEY, '列表不得返回明文 token');
    assert(row.token.includes('...'), `列表 token 应为脱敏形式，实际 ${row.token}`);
    assert(row.token.length < API_KEY.length, '脱敏值必须短于明文');
    assert(row.token.startsWith('sk-'), '脱敏值应保留可识别的前缀');
    assert(row.token.endsWith(API_KEY.slice(-4)), '脱敏值应保留末 4 位以便核对');
    assert(!list.text.includes(API_KEY), '列表响应体里不得出现明文 token');

    // ---- 2. 眼睛按钮走的按需接口：返回一次明文 ----
    const reveal = await request('GET', `/api/admin/keys/${row.id}/token`, null, cookie);
    assert.strictEqual(reveal.status, 200, `按需查看应成功，实际 ${reveal.status} ${reveal.text}`);
    assert.strictEqual(reveal.json.ok, true);
    assert.strictEqual(reveal.json.token, API_KEY, '按需查看必须返回完整明文');
    assert.strictEqual(String(reveal.headers['cache-control'] || '').includes('no-store'), true,
      '明文响应必须禁止缓存');

    // ---- 3. 权限与错误分支 ----
    const anon = await request('GET', `/api/admin/keys/${row.id}/token`);
    assert([401, 403].includes(anon.status), `未授权必须拒绝，实际 ${anon.status}`);
    assert(!anon.text.includes(API_KEY), '未授权响应不得包含明文');

    const missing = await request('GET', '/api/admin/keys/key_does_not_exist/token', null, cookie);
    assert.strictEqual(missing.status, 404, `未知 id 应 404，实际 ${missing.status}`);

    const wrongMethod = await request('POST', `/api/admin/keys/${row.id}/token`, {}, cookie);
    assert.strictEqual(wrongMethod.status, 405, `只读端点应拒绝 POST，实际 ${wrongMethod.status}`);
    assert.strictEqual(wrongMethod.headers.allow, 'GET', '405 必须带 Allow: GET');

    // ---- 4. 页面接线：默认脱敏，眼睛按需拉明文 ----
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
    assert(
      /\/api\/admin\/keys\/\$\{[^}]+\}\/token/.test(html),
      '页面必须通过 /api/admin/keys/:id/token 按需取明文，而不是让列表直接下发'
    );
    assert(
      /(aria-label=['"]显示完整 Key['"]|setAttribute\(['"]aria-label['"],\s*['"]显示完整 Key['"]\))/.test(html),
      '眼睛按钮需要可访问名称（显示完整 Key）'
    );
    assert(/key-token/.test(html), 'token 需要独立节点，便于就地切换明文/脱敏');

    console.log('✓ [All Passed] 调用凭据：列表默认脱敏 + 按需查看 + 权限边界');
  } finally {
    gw.kill('SIGTERM');
  }
}

run().catch((err) => {
  console.error('测试失败:', err.message);
  process.exit(1);
});
