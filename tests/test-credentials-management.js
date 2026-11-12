'use strict';
/**
 * Issue #03 验收测试：管理凭据与调用凭据分离、登录会话及调用凭据管理闭环
 *
 * 覆盖验收标准：
 * 1. 移除通用默认管理口令、移除向公开页面自动注入令牌的逻辑，移除未验签第三方 JWT 兼容认证
 * 2. 独立管理口令校验及有时限的浏览器管理会话：登录、主动退出、会话过期失效及口令变更后使既有会话失效
 * 3. 严格隔离管理权限与调用凭据权限：未登录请求与普通调用凭据均无法访问或修改全局管理接口 (401/403)
 * 4. 支持调用凭据的独立创建、展示名称修改与撤销；撤销后后续 HTTP 与 WebSocket 请求立即拒绝 (401)
 * 5. 调用凭据支持显式配置账号访问范围；指定集合为空时明确无任何账号权限 (403)，绝不退化为全部账号
 * 6. 管理面板前端消除不可信字段的直接 HTML 拼接（0 innerHTML），端到端验证权限边界
 *
 * 运行方式: node tests/test-credentials-management.js
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const cp = require('child_process');
const net = require('net');
const crypto = require('crypto');
const { MockUpstream } = require('./mock-upstream');

const TEST_DIR = path.join(__dirname, '..', '.scratch', 'v1', 'scratch', 'cred-mgmt-test-' + Date.now());
const GATEWAY_PORT = 18093;
const ADMIN_PASSWORD = 'super_secret_admin_pwd_2026';
const INITIAL_INVOCATION_KEY = 'sk-initial-client-key-888';

let mockUpstream = null;
let gatewayProcess = null;

function cleanup() {
  if (gatewayProcess) {
    try { gatewayProcess.kill('SIGKILL'); } catch (_) {}
    gatewayProcess = null;
  }
  if (mockUpstream) {
    try { mockUpstream.stop(); } catch (_) {}
    mockUpstream = null;
  }
  try {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
  } catch (_) {}
}

function requestGateway(opts, payload, cookieHeader) {
  return new Promise((resolve, reject) => {
    const isPayload = payload !== undefined && payload !== null;
    const bodyStr = isPayload
      ? (typeof payload === 'string' ? payload : JSON.stringify(payload))
      : '';
    const headers = Object.assign({
      'Content-Type': 'application/json',
    }, opts.headers || {});
    if (isPayload && !headers['Content-Length']) {
      headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }
    if (cookieHeader) {
      headers['Cookie'] = cookieHeader;
    }

    const req = http.request({
      hostname: '127.0.0.1',
      port: GATEWAY_PORT,
      path: opts.path || '/',
      method: opts.method || (isPayload ? 'POST' : 'GET'),
      headers,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let body = null;
        try {
          body = JSON.parse(data);
        } catch (_) {
          body = data;
        }
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body,
          raw: data,
        });
      });
    });

    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function testWsResponses(token) {
  return new Promise((resolve, reject) => {
    const secKey = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(GATEWAY_PORT, '127.0.0.1', () => {
      const reqLines = [
        `GET /v1/responses HTTP/1.1`,
        `Host: 127.0.0.1:${GATEWAY_PORT}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${secKey}`,
        'Sec-WebSocket-Version: 13',
        'OpenAI-Beta: responses_websockets=2026-02-06',
        `Authorization: Bearer ${token}`,
      ];
      sock.write(reqLines.join('\r\n') + '\r\n\r\n');
    });

    let buf = Buffer.alloc(0);
    let handshakeDone = false;
    const textFrames = [];

    sock.on('data', (d) => {
      if (!handshakeDone) {
        buf = Buffer.concat([buf, d]);
        const idx = buf.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const head = buf.slice(0, idx).toString('utf8');
        const rest = buf.slice(idx + 4);
        handshakeDone = true;
        const status = Number((head.split('\r\n')[0].match(/^HTTP\/1\.1 (\d+)/) || [])[1] || 0);
        if (status !== 101) {
          sock.destroy();
          return resolve({ status, head, textFrames });
        }
        if (rest.length) handleFrameData(rest);
        return resolve({
          status,
          head,
          textFrames,
          sendFrame(obj) {
            const payload = Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8');
            const mask = crypto.randomBytes(4);
            const len = payload.length;
            let header;
            if (len < 126) {
              header = Buffer.alloc(2);
              header[1] = 0x80 | len;
            } else {
              header = Buffer.alloc(4);
              header[1] = 0x80 | 126;
              header.writeUInt16BE(len, 2);
            }
            header[0] = 0x81;
            const masked = Buffer.alloc(len);
            for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
            sock.write(Buffer.concat([header, mask, masked]));
          },
          waitForMessage(predicate, timeoutMs = 4000) {
            return new Promise((resWait, rejWait) => {
              const start = Date.now();
              const check = () => {
                for (const f of textFrames) {
                  if (predicate(f)) return resWait(f);
                }
                if (Date.now() - start > timeoutMs) {
                  return rejWait(new Error('waitForMessage timed out'));
                }
                setTimeout(check, 50);
              };
              check();
            });
          },
          close() {
            try { sock.destroy(); } catch (_) {}
          },
        });
      } else {
        handleFrameData(d);
      }
    });

    function handleFrameData(chunk) {
      if (!chunk.length) return;
      const len = chunk[1] & 0x7f;
      let payload;
      if (len < 126) payload = chunk.slice(2, 2 + len);
      else payload = chunk.slice(4, 4 + chunk.readUInt16BE(2));
      const str = payload.toString('utf8');
      try { textFrames.push(JSON.parse(str)); } catch (_) { textFrames.push(str); }
    }

    sock.on('error', (err) => {
      if (!handshakeDone) reject(err);
    });
  });
}

async function run() {
  console.log('--- 开始执行 Issue #03: 管理凭据与调用凭据分离及生命周期闭环测试 ---');

  fs.mkdirSync(TEST_DIR, { recursive: true });
  const dataDir = path.join(TEST_DIR, 'data');
  const stateDir = path.join(TEST_DIR, 'state');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  // 1. 启动 Mock 上游
  mockUpstream = new MockUpstream();
  const upstreamUrl = await mockUpstream.start();
  console.log(`[Harness] MockUpstream 已在 ${upstreamUrl} 启动`);

  // 注入合成账号凭据至 state 目录
  const routerKey = 'sk-mock-router-account-token-abc';
  fs.writeFileSync(path.join(stateDir, '.env'), `AGENTIX_CONFIG_MODELS_AIWORK_ROUTER_API_KEY=${routerKey}\n`);
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({
    config_protocol_version: '1.1',
    models: {
      'aiwork-router': {
        models: [
          { id: 'deepseek-flash', name: 'DeepSeek Flash' },
        ],
      },
    },
    aiwork: {
      router_usage: {
        model_costs: [],
      },
    },
  }, null, 2));

  // 2. 启动真实网关
  const gatewayEntry = path.join(__dirname, '..', 'src', 'api-bridge.js');
  gatewayProcess = cp.spawn(process.execPath, [gatewayEntry], {
    env: Object.assign({}, process.env, {
      PORT: String(GATEWAY_PORT),
      BIND: '127.0.0.1',
      UPSTREAM: 'direct',
      ROUTER_BASE_URL: upstreamUrl,
      ROUTER_BASE: upstreamUrl,
      AGENTIX_STATE_DIR: stateDir,
      GATEWAY_DATA_DIR: dataDir,
      STATE_PATH: path.join(dataDir, 'usage-state.json'),
      ADMIN_PASSWORD: ADMIN_PASSWORD,
      ADMIN_SESSION_TTL_SEC: '2', // 短时过期便于测试过期
      API_KEYS: `${INITIAL_INVOCATION_KEY}:InitialClient`,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  gatewayProcess.stderr.on('data', (d) => {
    const s = d.toString('utf8');
    if (s.includes('FATAL') || s.includes('Error')) console.error('[Gateway stderr]', s.trim());
  });

  // 等待网关就绪
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try {
      const res = await requestGateway({ path: '/status', method: 'GET' });
      if (res.statusCode === 200 && res.body.ready === true) {
        ready = true;
        break;
      }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(ready, '网关必须成功启动并在 /status 报告 ready: true');
  console.log(`[Harness] 网关在 127.0.0.1:${GATEWAY_PORT} 就绪\n`);

  // =========================================================================
  // AC 1 & AC 6 验证: 页面不注入密钥、无通用默认口令、移除未验签 JWT、前端零 innerHTML
  // =========================================================================
  console.log('[AC 1 & AC 6 验证] 检查公开页面无机密注入、移除未验签 JWT、无通用默认口令...');

  // 1.1 公开页面 GET /
  const indexRes = await requestGateway({ path: '/' });
  assert.strictEqual(indexRes.statusCode, 200);
  assert.ok(!indexRes.raw.includes('window.__API_TOKEN__'), '公开 HTML 绝不能注入 window.__API_TOKEN__');
  assert.ok(!indexRes.raw.includes(ADMIN_PASSWORD), '公开 HTML 绝不能泄露管理口令');
  assert.ok(!indexRes.raw.includes(INITIAL_INVOCATION_KEY), '公开 HTML 绝不能泄露调用凭据');

  // 1.2 前端代码无 innerHTML 拼接
  const indexHtmlPath = path.join(__dirname, '..', 'src', 'index.html');
  const indexHtmlContent = fs.readFileSync(indexHtmlPath, 'utf8');
  assert.strictEqual((indexHtmlContent.match(/\.innerHTML/g) || []).length, 0, 'src/index.html 必须彻底消除 innerHTML 拼接 (0 innerHTML)');

  // 1.3 尝试通用默认口令登录必须失败
  for (const weakPwd of ['admin', '123456', 'password', '', 'root']) {
    const weakLoginRes = await requestGateway({ path: '/api/admin/login' }, { password: weakPwd });
    assert.strictEqual(weakLoginRes.statusCode, 401, `通用默认/弱口令 "${weakPwd}" 必须被拒绝 (401)`);
  }

  // 1.4 未验签第三方 JWT 必须被彻底拒绝 (401)
  const fakeJwt = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhdHRhY2tlciIsImV4cCI6MjAwMDAwMDAwMH0.fake_signature_bytes';
  const jwtChatRes = await requestGateway({
    path: '/v1/chat/completions',
    headers: { Authorization: `Bearer ${fakeJwt}` },
  }, { model: 'deepseek-flash', messages: [{ role: 'user', content: 'test' }] });
  assert.strictEqual(jwtChatRes.statusCode, 401, '未验签 JWT 必须被立即拒绝 401，绝不放行');
  console.log('  ✓ AC 1 & AC 6 验证通过：公开页面干净无注入、零 innerHTML、无默认口令、未验签 JWT 拦截通过');

  // =========================================================================
  // AC 2 验证: 独立管理口令校验、有期限浏览器会话、主动退出、口令变更后既有会话失效
  // =========================================================================
  console.log('\n[AC 2 验证] 测试管理登录、会话获取、主动退出、过期失效及口令变更失效...');

  // 2.1 成功登录换取会话与 Cookie
  const loginRes = await requestGateway({ path: '/api/admin/login' }, { password: ADMIN_PASSWORD });
  assert.strictEqual(loginRes.statusCode, 200, '正确口令必须返回 200');
  assert.ok(loginRes.body.token, '返回报文必须包含 session token');
  const setCookie = loginRes.headers['set-cookie'];
  assert.ok(setCookie && setCookie[0].includes('aiwork_admin_session='), '必须下发 HttpOnly 会话 Cookie');
  assert.ok(setCookie[0].includes('HttpOnly'), 'Cookie 必须包含 HttpOnly');
  const sessionToken = loginRes.body.token;
  const cookieHeader = setCookie[0].split(';')[0];

  // 2.2 通过 Cookie 访问管理会话状态
  const checkSessionRes = await requestGateway({ path: '/api/admin/session' }, null, cookieHeader);
  assert.strictEqual(checkSessionRes.statusCode, 200);
  assert.strictEqual(checkSessionRes.body.authenticated, true, '持有效会话 Cookie 必须认证通过');

  // 2.3 主动退出登录
  const logoutRes = await requestGateway({ path: '/api/admin/logout', method: 'POST' }, {}, cookieHeader);
  assert.strictEqual(logoutRes.statusCode, 200);
  const afterLogoutRes = await requestGateway({ path: '/api/admin/session' }, null, cookieHeader);
  assert.strictEqual(afterLogoutRes.body.authenticated, false, '主动退出后原会话必须失效');

  // 2.4 会话过期失效测试 (网关设置了 ADMIN_SESSION_TTL_SEC: 2)
  const loginRes2 = await requestGateway({ path: '/api/admin/login' }, { password: ADMIN_PASSWORD });
  const cookie2 = loginRes2.headers['set-cookie'][0].split(';')[0];
  const beforeExpire = await requestGateway({ path: '/api/admin/session' }, null, cookie2);
  assert.strictEqual(beforeExpire.body.authenticated, true, '新会话初始有效');

  await new Promise((r) => setTimeout(r, 2200)); // 等待 2.2 秒让会话过期
  const afterExpire = await requestGateway({ path: '/api/admin/session' }, null, cookie2);
  assert.strictEqual(afterExpire.body.authenticated, false, 'TTL 到期后会话必须自动过期失效');

  // 2.5 口令变更后既有会话失效测试
  const loginRes3 = await requestGateway({ path: '/api/admin/login' }, { password: ADMIN_PASSWORD });
  const cookie3 = loginRes3.headers['set-cookie'][0].split(';')[0];
  // 管理员修改口令
  const changePwdRes = await requestGateway({
    path: '/api/admin/password',
    method: 'POST',
  }, { password: 'updated_new_admin_password_999' }, cookie3);
  assert.strictEqual(changePwdRes.statusCode, 200, '口令修改必须成功');

  // 验证之前的 cookie3 立即因口令变更而失效
  const checkInvalidated = await requestGateway({ path: '/api/admin/session' }, null, cookie3);
  assert.strictEqual(checkInvalidated.body.authenticated, false, '口令变更后既有会话必须立即失效');
  console.log('  ✓ AC 2 验证通过：管理口令登录、Cookie 下发、主动退出、超时过期与口令变更失效全部验证通过');

  // =========================================================================
  // AC 3 验证: 严格隔离管理权限与调用凭据权限 (401 / 403 边界)
  // =========================================================================
  console.log('\n[AC 3 验证] 测试管理与调用权限严格隔离：未登录 401，普通调用凭据访问管理接口 403...');

  // 管理接口清单
  const adminEndpoints = [
    { path: '/api/admin/keys', method: 'GET' },
    { path: '/api/admin/password', method: 'POST', payload: { password: 'test' } },
    { path: '/api/keys', method: 'GET' },
    { path: '/api/fallback', method: 'GET' },
    { path: '/api/balance', method: 'GET' },
  ];

  // 3.1 未登录请求访问全部管理接口 -> 401
  for (const ep of adminEndpoints) {
    const res = await requestGateway({ path: ep.path, method: ep.method }, ep.payload);
    assert.strictEqual(res.statusCode, 401, `未授权请求访问 ${ep.path} 必须返回 401`);
  }

  // 3.2 调用凭据尝试访问全部管理接口 -> 403 Forbidden
  for (const ep of adminEndpoints) {
    const res = await requestGateway({
      path: ep.path,
      method: ep.method,
      headers: { Authorization: `Bearer ${INITIAL_INVOCATION_KEY}` },
    }, ep.payload);
    assert.strictEqual(res.statusCode, 403, `调用凭据尝试访问管理接口 ${ep.path} 必须返回 403 Forbidden`);
    assert.ok(JSON.stringify(res.body).includes('forbidden') || JSON.stringify(res.body).includes('management'),
      `403 响应必须指明调用凭据不可访问管理资源`);
  }

  // 3.3 用量隔离验证：调用凭据只返回自身用量，不泄露全局用量与真实余额
  const scopedUsageRes = await requestGateway({
    path: '/api/usage',
    method: 'GET',
    headers: { Authorization: `Bearer ${INITIAL_INVOCATION_KEY}` },
  });
  assert.strictEqual(scopedUsageRes.statusCode, 200);
  assert.strictEqual(scopedUsageRes.body.balance, 0, '普通凭据用量接口不应暴露服务端全局真实余额');
  assert.strictEqual(scopedUsageRes.body.real.ok, false, '普通凭据用量接口不暴露管理员级真实账单详情');
  console.log('  ✓ AC 3 验证通过：管理权限与调用权限严格隔离，未登录 401，跨权调用 403，用量严格隔离');

  // =========================================================================
  // AC 4 验证: 调用凭据独立创建、展示名称修改、独立撤销及 HTTP/WS 立即拒绝
  // =========================================================================
  console.log('\n[AC 4 验证] 测试调用凭据创建、展示名称修改（保持内部 ID 稳定）与撤销后立即拒绝...');

  // 以新管理员口令重新登录
  const newLoginRes = await requestGateway({ path: '/api/admin/login' }, { password: 'updated_new_admin_password_999' });
  assert.strictEqual(newLoginRes.statusCode, 200);
  const adminCookie = newLoginRes.headers['set-cookie'][0].split(';')[0];

  // 4.1 管理员创建新调用凭据
  const createKeyRes = await requestGateway({
    path: '/api/admin/keys',
    method: 'POST',
  }, {
    name: 'Cursor IDE',
    account_policy: { mode: 'all' },
  }, adminCookie);
  assert.strictEqual(createKeyRes.statusCode, 201, '创建调用凭据必须返回 201');
  const newKeyObj = createKeyRes.body.key;
  assert.ok(newKeyObj.id.startsWith('key_'), '内部稳定 ID 必须存在且稳定');
  assert.strictEqual(newKeyObj.name, 'Cursor IDE');
  assert.strictEqual(newKeyObj.revoked, false);
  const cursorToken = newKeyObj.token;
  const cursorKeyId = newKeyObj.id;

  // 4.1b 凭据文件里是明文 Key：同机其它用户不该能读（Windows 上 chmod 语义不适用）
  if (process.platform !== 'win32') {
    const keysFile = path.join(dataDir, 'api-keys.json');
    const mode = fs.statSync(keysFile).mode & 0o777;
    assert.strictEqual(mode, 0o600, `api-keys.json 权限应为 0600，实际 ${mode.toString(8)}`);
  }

  // 4.2 使用新建凭据发起模型调用，应成功放行至模拟上游
  const chatCall1 = await requestGateway({
    path: '/v1/chat/completions',
    headers: { Authorization: `Bearer ${cursorToken}` },
  }, {
    model: 'deepseek-flash',
    messages: [{ role: 'user', content: 'test message' }],
  });
  assert.strictEqual(chatCall1.statusCode, 200, '正常新建的调用凭据必须能正常完成模型调用');

  // 4.3 修改展示名称：确认内部 ID 与 token 保持不变 (US 23)
  const patchKeyRes = await requestGateway({
    path: `/api/admin/keys/${cursorKeyId}`,
    method: 'PATCH',
  }, { name: 'Cursor IDE Renamed' }, adminCookie);
  assert.strictEqual(patchKeyRes.statusCode, 200);
  assert.strictEqual(patchKeyRes.body.key.id, cursorKeyId, '修改展示名称后内部 ID 必须保持不变');
  assert.strictEqual(patchKeyRes.body.key.name, 'Cursor IDE Renamed');

  // 改名后使用原 token 仍能正常调用
  const chatCall2 = await requestGateway({
    path: '/v1/chat/completions',
    headers: { Authorization: `Bearer ${cursorToken}` },
  }, {
    model: 'deepseek-flash',
    messages: [{ role: 'user', content: 'test message 2' }],
  });
  assert.strictEqual(chatCall2.statusCode, 200);

  // 4.4 建立 WebSocket 连接并保持活跃
  console.log('  -> 建立长连接 Responses WebSocket 测试活跃状态下的撤销拦截...');
  const wsClient = await testWsResponses(cursorToken);
  assert.strictEqual(wsClient.status, 101, '有效凭据 WebSocket 握手必须返回 101');

  // 4.5 管理员撤销凭据
  const revokeRes = await requestGateway({
    path: `/api/admin/keys/${cursorKeyId}/revoke`,
    method: 'POST',
  }, {}, adminCookie);
  assert.strictEqual(revokeRes.statusCode, 200);
  assert.strictEqual(revokeRes.body.key.revoked, true, '凭据必须被置为已撤销');

  // 4.6 撤销后 HTTP 调用立即拒绝 (401 revoked_key)
  const chatCallAfterRevoke = await requestGateway({
    path: '/v1/chat/completions',
    headers: { Authorization: `Bearer ${cursorToken}` },
  }, {
    model: 'deepseek-flash',
    messages: [{ role: 'user', content: 'test after revoke' }],
  });
  assert.strictEqual(chatCallAfterRevoke.statusCode, 401, '撤销后 HTTP 请求必须立即返回 401');
  assert.strictEqual(chatCallAfterRevoke.body.error.code, 'revoked_key', '错误码必须为 revoked_key');

  // 4.7 撤销后已有活跃 WebSocket 连接发送新帧立即拒绝并关闭连接
  wsClient.sendFrame({
    type: 'response.create',
    model: 'deepseek-flash',
    input: [{ role: 'user', content: 'ws query after revoke' }],
  });
  const wsErr = await wsClient.waitForMessage((m) => m && m.type === 'error' && m.code === 'revoked_key');
  assert.strictEqual(wsErr.code, 'revoked_key', 'WebSocket 文本帧必须立即返回 revoked_key 错误事件');
  assert.strictEqual(wsErr.status, 401);
  wsClient.close();
  console.log('  ✓ AC 4 验证通过：凭据创建、展示名称修改（保持 ID 稳定）及撤销后 HTTP/WS 立即拒绝验证通过');

  // =========================================================================
  // AC 5 验证: 账号访问范围控制（"全部账号" 与 "指定账号集合"，空集合拒绝访问）
  // =========================================================================
  console.log('\n[AC 5 验证] 测试账号范围策略：空指定集合拒绝访问 (403)，绝不退化为全部账号...');

  // 5.1 创建指定空集合凭据
  const emptyPolicyKeyRes = await requestGateway({
    path: '/api/admin/keys',
    method: 'POST',
  }, {
    name: 'Zero Account Client',
    account_policy: { mode: 'explicit', accounts: [] },
  }, adminCookie);
  assert.strictEqual(emptyPolicyKeyRes.statusCode, 201);
  const emptyToken = emptyPolicyKeyRes.body.key.token;

  // 5.2 发起请求应直接被 403 拦截，绝不退化为全部账号 (US 17)
  const emptyChatRes = await requestGateway({
    path: '/v1/chat/completions',
    headers: { Authorization: `Bearer ${emptyToken}` },
  }, {
    model: 'deepseek-flash',
    messages: [{ role: 'user', content: 'should fail' }],
  });
  assert.strictEqual(emptyChatRes.statusCode, 403, '空账号集合必须直接拒绝 403');
  assert.strictEqual(emptyChatRes.body.error.code, 'no_accounts_permitted', '错误码必须明确表达 no_accounts_permitted');

  // 5.3 WebSocket 升级握手也应直接返回 403
  const emptyWs = await testWsResponses(emptyToken);
  assert.strictEqual(emptyWs.status, 403, '空账号集合凭据 WebSocket 升级握手必须返回 403 Forbidden');

  // 5.4 验证 /v1/models 严格遵循调用凭据授权范围 (US 16)
  // 空账号集合直接拒绝访问 403
  const emptyModelsRes = await requestGateway({
    path: '/v1/models',
    headers: { Authorization: `Bearer ${emptyToken}` },
  });
  assert.strictEqual(emptyModelsRes.statusCode, 403, '空账号集合凭据获取模型列表必须返回 403');
  assert.strictEqual(emptyModelsRes.body.error.code, 'no_accounts_permitted');

  // 5.5 创建指定非存在账号的凭据，获取模型列表应为 200 且数据为空数组 (0 个模型)
  const noMatchKeyRes = await requestGateway({
    path: '/api/admin/keys',
    method: 'POST',
  }, {
    name: 'Nonexistent Account Client',
    account_policy: { mode: 'explicit', accounts: ['nonexistent_account'] },
  }, adminCookie);
  const noMatchToken = noMatchKeyRes.body.key.token;
  const noMatchModelsRes = await requestGateway({
    path: '/v1/models',
    headers: { Authorization: `Bearer ${noMatchToken}` },
  });
  assert.strictEqual(noMatchModelsRes.statusCode, 200);
  assert.strictEqual(noMatchModelsRes.body.data.length, 0, '未匹配到任何可用账号时模型列表必须为空');

  console.log('  ✓ AC 5 验证通过：空指定集合明确无任何账号访问权限 (403)，且 /v1/models 严格按授权范围隔离');

  console.log('\n>>> Issue #03 全部 6 项验收指标测试 100% 通过 ✓ <<<');
}

run().catch((err) => {
  console.error('\n❌ 测试失败:\n', err);
  process.exit(1);
}).finally(() => {
  cleanup();
});
