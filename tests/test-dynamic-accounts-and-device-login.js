'use strict';
/**
 * 动态账号管理与设备授权流集成测试 (tests/test-dynamic-accounts-and-device-login.js)
 *
 * 验证 ADR-0006 决策：
 * 1. 双源账号共存：动态账号 (/data/accounts/<id>) 与外部只读挂载账号共存于账号池。
 * 2. 动态账号 CRUD：支持在管理后台导入、重命名、启停、删除；只读挂载账号禁止被网页删除。
 * 3. 设备授权流 (Device Code Flow) 状态机：支持发起会话、返回授权 URL、轮询检测与落盘热重载。
 * 4. 额度看板缓存与端点权限：Billing 聚合查询支持 60s 内存缓存；接口严格受管理员鉴权保护。
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');

const TMP_DIR = path.join(os.tmpdir(), `aiwork-dyn-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
fs.mkdirSync(TMP_DIR, { recursive: true });

const MOCK_MOUNT_DIR = path.join(TMP_DIR, 'mock-mount-acc');
fs.mkdirSync(MOCK_MOUNT_DIR, { recursive: true });
fs.writeFileSync(path.join(MOCK_MOUNT_DIR, '.env'), 'AGENTIX_CONFIG_MODELS_AIWORK_ROUTER_API_KEY=mock-mount-key-123\n');
fs.writeFileSync(path.join(MOCK_MOUNT_DIR, 'config.json'), JSON.stringify({
  models: {
    'aiwork-router': {
      models: [{ id: 'mock-model-1', name: 'Mock Model 1' }]
    }
  }
}));

const DYN_DATA_DIR = path.join(TMP_DIR, 'data');
fs.mkdirSync(DYN_DATA_DIR, { recursive: true });

process.on('exit', () => {
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch (_) {}
});

async function run() {
  console.log('--- 测试 1: 动态账号管理模块与双源共存 ---');
  let DynamicAccountManager;
  try {
    DynamicAccountManager = require('../src/dynamic-accounts').DynamicAccountManager;
  } catch (err) {
    console.log('DynamicAccountManager 模块尚未实现 (预期失败):', err.message);
    throw err;
  }

  const dynMgr = new DynamicAccountManager({
    dataDir: DYN_DATA_DIR,
    mountAccounts: [
      { id: 'mount_default', name: 'Mount Default', stateDir: MOCK_MOUNT_DIR, enabled: true }
    ],
  });

  const initialList = dynMgr.listAccounts();
  assert.strictEqual(initialList.length, 1);
  assert.strictEqual(initialList[0].id, 'mount_default');
  assert.strictEqual(initialList[0].source, 'mount');
  assert.strictEqual(initialList[0].ready, true);

  console.log('--- 测试 2: 快捷导入动态账号 ---');
  const imported = dynMgr.importAccount({
    name: '我的工作主号',
    routerKey: 'aw-dyn-key-001',
    userId: 'user_dyn_123',
    models: [{ id: 'gpt-4o', name: 'GPT-4o' }]
  });
  assert.strictEqual(imported.name, '我的工作主号');
  assert.strictEqual(imported.source, 'dynamic');
  assert.strictEqual(imported.ready, true);
  assert.strictEqual(imported.userId, 'user_dyn_123');

  // 验证目录结构与文件持久化
  const accDir = path.join(DYN_DATA_DIR, 'accounts', imported.id);
  assert(fs.existsSync(path.join(accDir, '.env')), '.env 必须持久化');
  assert(fs.existsSync(path.join(accDir, 'auth.json')), 'auth.json 必须持久化');
  assert(fs.existsSync(path.join(accDir, 'config.json')), 'config.json 必须持久化');

  console.log('--- 测试 3: 相同 userId 再次导入执行原地覆盖更新 ---');
  const updated = dynMgr.importAccount({
    name: '工作主号(已更新)',
    routerKey: 'aw-dyn-key-002',
    userId: 'user_dyn_123',
    models: [{ id: 'gpt-4o', name: 'GPT-4o' }, { id: 'claude-3-5', name: 'Claude 3.5' }]
  });
  assert.strictEqual(updated.id, imported.id, '相同 userId 应原地覆盖相同 ID');
  assert.strictEqual(updated.name, '工作主号(已更新)');
  assert.strictEqual(updated.modelsCount, 2);

  console.log('--- 测试 4: 动态账号启停与删除保护 ---');
  dynMgr.patchAccount(imported.id, { enabled: false });
  let cur = dynMgr.getAccount(imported.id);
  assert.strictEqual(cur.enabled, false);

  dynMgr.patchAccount(imported.id, { enabled: true });
  cur = dynMgr.getAccount(imported.id);
  assert.strictEqual(cur.enabled, true);

  // 验证删除保护：只读挂载账号禁止删除
  assert.throws(() => {
    dynMgr.deleteAccount('mount_default');
  }, /只读挂载账号受到保护/);

  // 动态账号可以删除
  dynMgr.deleteAccount(imported.id);
  assert.strictEqual(dynMgr.getAccount(imported.id), null);
  assert(!fs.existsSync(accDir), '删除后物理目录应被移除');

  console.log('--- 测试 5: 真实官方设备授权流 (Device Login) 状态机 ---');
  // 启动 Mock 官方鉴权服务端，验证协议握手、UserCode 分发与真实 Token 换取
  let mockAuthorized = false;
  const mockAuthServer = http.createServer((req, res) => {
    let bodyStr = '';
    req.on('data', (c) => (bodyStr += c));
    req.on('end', () => {
      let b = {};
      try { b = JSON.parse(bodyStr); } catch (_) {}

      if (req.url === '/api/v1/auth/device/authorize' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: true,
          data: {
            deviceCode: 'dc_official_test_12345',
            userCode: '76A0-D6BE',
            verificationUri: 'https://aiwork.dtagi.cn/account/auth/device?type=gui',
            verificationUriComplete: 'https://aiwork.dtagi.cn/account/auth/device?user_code=76A0-D6BE&type=gui',
            expiresIn: 180,
            interval: 2,
          }
        }));
      }

      if (req.url === '/api/v1/auth/device/token' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (!mockAuthorized) {
          return res.end(JSON.stringify({
            success: true,
            data: { accessToken: null, refreshToken: null, expiresIn: 0 }
          }));
        }
        return res.end(JSON.stringify({
          success: true,
          data: {
            accessToken: 'real_upstream_access_token_888',
            refreshToken: 'real_refresh_token_999',
            expiresIn: 7200,
            userId: 'user_oauth_777',
          }
        }));
      }

      // 官方 Router Key 换票端点：accessToken(JWT) -> 真正的 Router API Key
      if (req.url === '/api/v1/router/apikey/exchange' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: true,
          data: {
            sk: 'sk-exchanged-router-key-001',
            memberId: 'member_mock_42',
            newApiUserId: 44265,
            routerBaseUrl: 'http://127.0.0.1:1',
            availableModels: ['model-a', 'model-b'],
            models: [],
          }
        }));
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
  });

  await new Promise((resolve) => mockAuthServer.listen(0, '127.0.0.1', resolve));
  const mockAuthPort = mockAuthServer.address().port;
  const mockAuthBaseUrl = `http://127.0.0.1:${mockAuthPort}`;

  const devMgr = dynMgr.deviceLoginManager;
  assert(devMgr, '必须包含 deviceLoginManager');

  // 发起设备授权：必须向上游官方接口请求，获取官方签发的合法 userCode，严禁本地伪造
  const sess = await devMgr.startSession({
    name: '扫码测试号',
    authBaseUrl: mockAuthBaseUrl,
  });

  assert.strictEqual(sess.userCode, '76A0-D6BE', 'userCode 必须由官方上游签发');
  assert.strictEqual(
    sess.verificationUri,
    'https://aiwork.dtagi.cn/account/auth/device?user_code=76A0-D6BE&type=gui',
    'verificationUri 必须使用上游官方生成的合法完整跳转 URL'
  );

  // 网页未授权前，轮询结果必须为 pending
  const polled1 = await devMgr.pollSession(sess.sessionId);
  assert.strictEqual(polled1.status, 'pending');

  // 模拟用户在官方网页端点击“确认授权”
  mockAuthorized = true;

  // 再次轮询：网关后端必须向官方 Token 端点换取凭据并自动完成账号落盘入池
  const polled2 = await devMgr.pollSession(sess.sessionId);
  assert.strictEqual(polled2.status, 'confirmed');
  assert(polled2.accountId, '完成时必须返回新账号 ID');

  const dynAcc = dynMgr.getAccount(polled2.accountId);
  assert(dynAcc, '动态账号池中必须能查询到新账号');
  assert.strictEqual(dynAcc.name, '扫码测试号');
  assert.strictEqual(dynAcc.ready, true);
  assert.strictEqual(dynAcc.routerKey, 'sk-exchanged-router-key-001',
    '必须持久化官方换票接口签发的 Router API Key，而不是账号访问令牌');
  assert.strictEqual(dynAcc.userId, 'user_oauth_777');
  assert.strictEqual(dynAcc.models.length, 2, '降级时应使用换票响应中的模型目录，而不是硬编码占位模型');
  const dynCfg = JSON.parse(fs.readFileSync(path.join(DYN_DATA_DIR, 'accounts', dynAcc.id, 'config.json'), 'utf8'));
  assert.deepStrictEqual(dynCfg.models['aiwork-router'].models.map((m) => m.id), ['model-a', 'model-b']);

  mockAuthServer.close();

  console.log('--- 测试 6: 额度查询与 60s 内存缓存 ---');
  let mockFetchCallCount = 0;
  dynMgr.setBillingFetcher(async (account) => {
    mockFetchCallCount++;
    return {
      total_usage_usd: 1.5,
      hard_limit_usd: 50.0,
      currency: 'USD'
    };
  });

  const bill1 = await dynMgr.getBillingOverview();
  assert(bill1[dynAcc.id], '应包含动态账号账单');
  assert.strictEqual(mockFetchCallCount, 2); // 1 mount + 1 dynamic = 2 accounts

  // 60s 缓存测试：立即再次查询应命中缓存，不触发二次 fetch
  const bill2 = await dynMgr.getBillingOverview();
  assert.strictEqual(mockFetchCallCount, 2, '命中缓存时 fetch 次数不应增加');
  assert.strictEqual(bill2[dynAcc.id].cached, true);

  console.log('--- 测试 7: HTTP API 端点集成测试 ---');
  const cp = require('child_process');
  const HTTP_PASS = 'TestAdminPass123!';
  const HTTP_KEY = 'sk-dyn-test-inv-key';

  // 额度取数地址的默认值与覆盖规则：不设环境变量时必须仍是官方地址，设了则只改这一处取数。
  const prevBillingBase = process.env.AIWORK_BILLING_BASE_URL;
  delete process.env.AIWORK_BILLING_BASE_URL;
  try {
    const defaultMgr = new DynamicAccountManager({ dataDir: DYN_DATA_DIR });
    assert.strictEqual(defaultMgr.billingBaseUrl, 'https://aiwork-api.dtagi.cn',
      '未设置 AIWORK_BILLING_BASE_URL 时额度取数默认地址必须保持不变');
    assert.strictEqual(
      `${defaultMgr.billingBaseUrl}/v1/dashboard/billing/subscription`,
      'https://aiwork-api.dtagi.cn/v1/dashboard/billing/subscription',
      '默认额度取数端点必须与历史硬编码地址完全一致'
    );

    process.env.AIWORK_BILLING_BASE_URL = 'http://127.0.0.1:9/local-billing/';
    const overriddenMgr = new DynamicAccountManager({ dataDir: DYN_DATA_DIR });
    assert.strictEqual(overriddenMgr.billingBaseUrl, 'http://127.0.0.1:9/local-billing',
      '设置 AIWORK_BILLING_BASE_URL 后额度取数必须指向该地址（去掉尾部斜杠）');
  } finally {
    if (prevBillingBase === undefined) delete process.env.AIWORK_BILLING_BASE_URL;
    else process.env.AIWORK_BILLING_BASE_URL = prevBillingBase;
  }

  // 本地 mock 授权服务：随机端口，网关通过 DTCODER_EXTERNAL_AUTH_BASE_URL 指过来。
  // 用例因此不再访问真实官方域名，网络抖动/限流不会造成偶发 502。
  let httpMockAuthorized = false;
  let httpMockAuthorizeHits = 0;
  let httpMockTokenHits = 0;
  let httpMockExchangeHits = 0;
  let httpMockBillingHits = 0;
  const httpMockBillingAuths = [];
  let httpMockBaseUrl = '';
  const HTTP_MOCK_USER_CODE = 'HT7P-QR01';
  const HTTP_MOCK_VERIFY_URI = 'https://mock-auth.local/account/auth/device?user_code=HT7P-QR01&type=gui';

  const httpMockAuthServer = http.createServer((req, res) => {
    let bodyStr = '';
    req.on('data', (c) => (bodyStr += c));
    req.on('end', () => {
      const send = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if (req.url === '/api/v1/auth/device/authorize' && req.method === 'POST') {
        httpMockAuthorizeHits++;
        return send(200, {
          success: true,
          data: {
            deviceCode: 'dc_http_mock_777',
            userCode: HTTP_MOCK_USER_CODE,
            verificationUri: 'https://mock-auth.local/account/auth/device?type=gui',
            verificationUriComplete: HTTP_MOCK_VERIFY_URI,
            expiresIn: 180,
            interval: 1,
          }
        });
      }

      if (req.url === '/api/v1/auth/device/token' && req.method === 'POST') {
        httpMockTokenHits++;
        if (!httpMockAuthorized) {
          return send(200, { success: true, data: { accessToken: null, refreshToken: null, expiresIn: 0 } });
        }
        return send(200, {
          success: true,
          data: {
            accessToken: 'mock_account_access_token_777',
            refreshToken: 'mock_refresh_token_777',
            expiresIn: 7200,
            userId: 'user_http_mock_777',
          }
        });
      }

      if (req.url === '/api/v1/router/apikey/exchange' && req.method === 'POST') {
        httpMockExchangeHits++;
        return send(200, {
          success: true,
          data: {
            sk: 'sk-http-exchanged-router-key-777',
            memberId: 'member_http_mock',
            newApiUserId: 51777,
            routerBaseUrl: httpMockBaseUrl,
            availableModels: ['model-local-1'],
            models: [],
          }
        });
      }

      // 额度聚合取数：用例通过 AIWORK_BILLING_BASE_URL 把它指到这里，证明没有访问官方域名。
      if (req.url === '/v1/dashboard/billing/subscription' && req.method === 'GET') {
        httpMockBillingHits++;
        httpMockBillingAuths.push(req.headers.authorization || '');
        return send(200, { hard_limit_usd: 100, total_usage: 12.5, currency: 'USD' });
      }

      // 换票后网关会拉实时模型目录，这里也由本地 mock 应答，避免访问真实 Router。
      if (req.url === '/v1/models' && req.method === 'GET') {
        return send(200, { object: 'list', data: [{ id: 'model-local-1', name: 'Local Model 1', ratio: '1x' }] });
      }

      return send(404, { error: 'not found' });
    });
  });

  await new Promise((resolve) => httpMockAuthServer.listen(0, '127.0.0.1', resolve));
  httpMockBaseUrl = `http://127.0.0.1:${httpMockAuthServer.address().port}`;

  const gwDataDir = path.join(TMP_DIR, 'http-gw-data');
  fs.mkdirSync(gwDataDir, { recursive: true });

  const gwProc = cp.fork(path.join(__dirname, '..', 'src', 'api-bridge.js'), [], {
    env: {
      ...process.env,
      // PORT=0 让系统分配随机端口，多个实例并行跑不会互相抢占。
      PORT: '0',
      BIND: '127.0.0.1',
      ADMIN_PASSWORD: HTTP_PASS,
      API_KEYS: `${HTTP_KEY}:test-user`,
      GATEWAY_DATA_DIR: gwDataDir,
      STATE_PATH: path.join(gwDataDir, 'usage-state.json'),
      AGENTIX_STATE_DIR: MOCK_MOUNT_DIR,
      DTCODER_EXTERNAL_AUTH_BASE_URL: httpMockBaseUrl,
      AIWORK_BILLING_BASE_URL: httpMockBaseUrl,
      // 看板启动时的固有用量刷新也指向不可达的本地地址，模拟断网且不产生真实外网请求。
      ROUTER_BASE_URL: 'http://127.0.0.1:9',
      // 需要 info 级别的 listening 行来取回随机端口；请求日志仍关闭，避免噪声。
      QUIET: '0',
      LOG_LEVEL: 'info',
      LOG_REQUESTS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  // 从启动日志里取回系统分配的端口；QUIET 关闭才能看到 listening 行（其中不含密钥）。
  const gwPort = await new Promise((resolve, reject) => {
    let buf = '';
    const onChunk = (chunk) => {
      buf += chunk.toString();
      const m = buf.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) resolve(Number(m[1]));
    };
    gwProc.stdout.on('data', onChunk);
    gwProc.stderr.on('data', onChunk);
    gwProc.once('exit', (code) => reject(new Error(`网关子进程提前退出 (code=${code})`)));
    setTimeout(() => reject(new Error('等待网关端口超时')), 15000).unref();
  });

  const baseUrl = `http://127.0.0.1:${gwPort}`;

  function request(method, path, body = null, headers = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, baseUrl);
      const req = http.request(url, { method, headers, timeout: 5000 }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch (_) {}
          resolve({ status: res.statusCode, headers: res.headers, json, text: data });
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

  // 等待网关启动
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      const h = await request('GET', '/healthz');
      if (h.status === 200) { ready = true; break; }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 200));
  }
  try {
    assert(ready, '网关子进程未能在预期时间内启动就绪');

    // 1. 无凭据访问被拒绝
    const unauthRes = await request('GET', '/api/admin/accounts');
    assert.strictEqual(unauthRes.status, 401, '未鉴权必须 401 拦截');

    // 2. 登录管理员换取 session cookie
    const loginRes = await request('POST', '/api/admin/login', { password: HTTP_PASS });
    assert.strictEqual(loginRes.status, 200);
    const adminCookie = loginRes.headers['set-cookie'][0].split(';')[0];
    const adminHeaders = { Cookie: adminCookie };

    // 3. 开启设备授权流：必须由本地 mock 授权服务签发，不触碰真实官方域名
    const devStart = await request('POST', '/api/admin/accounts/device-login/start', { name: '网页扫码新账号' }, adminHeaders);
    assert.strictEqual(devStart.status, 200);
    assert(devStart.json.ok);
    assert(devStart.json.sessionId);
    assert(devStart.json.userCode);
    assert(devStart.json.verificationUri);
    assert.strictEqual(devStart.json.userCode, HTTP_MOCK_USER_CODE, 'userCode 必须来自本地 mock 授权服务');
    assert.strictEqual(devStart.json.verificationUri, HTTP_MOCK_VERIFY_URI,
      'verificationUri 必须来自本地 mock 授权服务，说明网关使用的是 DTCODER_EXTERNAL_AUTH_BASE_URL');
    assert(httpMockAuthorizeHits >= 1, '本地 mock 授权服务必须被请求过（用例不依赖外网）');

    // 4. 轮询授权流：未授权时为 pending，模拟用户确认后轮询到 confirmed
    const pollPath = `/api/admin/accounts/device-login/poll?session_id=${devStart.json.sessionId}`;
    const devPoll = await request('GET', pollPath, null, adminHeaders);
    if (devPoll.status !== 200) {
      console.log('devPoll 失败原因:', devPoll.status, devPoll.text, 'pollPath:', pollPath);
    }
    assert.strictEqual(devPoll.status, 200);
    assert.strictEqual(devPoll.json.status, 'pending');

    httpMockAuthorized = true;
    let confirmed = null;
    for (let i = 0; i < 10; i++) {
      const r = await request('GET', pollPath, null, adminHeaders);
      if (r.json && r.json.status === 'confirmed') { confirmed = r.json; break; }
      await new Promise((r2) => setTimeout(r2, 100));
    }
    assert(confirmed, '设备授权必须轮询到 confirmed');
    assert(confirmed.accountId, '授权成功后必须返回新账号 ID');
    assert.strictEqual(httpMockExchangeHits, 1, '必须向本地 mock 换票接口换取 Router Key');

    // 5. 快捷导入新动态账号
    const importRes = await request('POST', '/api/admin/accounts/import', {
      name: 'API导入测试号',
      routerKey: 'aw-http-test-key-999',
      userId: 'user_http_test_999',
      models: [{ id: 'gpt-4o', name: 'GPT-4o' }]
    }, adminHeaders);
    assert.strictEqual(importRes.status, 201);
    assert.strictEqual(importRes.json.ok, true);
    const createdId = importRes.json.account.id;

    // 6. 获取账号列表
    const listRes = await request('GET', '/api/admin/accounts', null, adminHeaders);
    assert.strictEqual(listRes.status, 200);
    assert(listRes.json.accounts.some((a) => a.id === createdId && a.source === 'dynamic'));

    // 7. 额度聚合看板
    const billRes = await request('GET', '/api/admin/accounts/billing', null, adminHeaders);
    assert.strictEqual(billRes.status, 200);
    assert(billRes.json.billing);
    assert(httpMockBillingHits >= 1, '额度聚合必须打到本地 billing mock（AIWORK_BILLING_BASE_URL 生效）');
    assert(httpMockBillingAuths.every((h) => /^Bearer \S+$/.test(h)),
      '额度请求必须继续携带 Bearer 凭据');
    const billValues = Object.values(billRes.json.billing);
    assert(billValues.some((b) => b.hard_limit_usd === 100 && b.total_usage_usd === 12.5),
      '额度数值必须来自本地 mock，而不是官方地址');

    // 8. 启停与重命名
    const patchRes = await request('PATCH', `/api/admin/accounts/${createdId}`, { name: '已重命名账号', enabled: false }, adminHeaders);
    assert.strictEqual(patchRes.status, 200);
    assert.strictEqual(patchRes.json.account.name, '已重命名账号');
    assert.strictEqual(patchRes.json.account.enabled, false);

    // 9. 删除保护：只读挂载账号禁止删除
    const delMountRes = await request('DELETE', '/api/admin/accounts/default', null, adminHeaders);
    assert.strictEqual(delMountRes.status, 403, '只读挂载账号删除必须返回 403');

    // 10. 删除动态账号
    const delRes = await request('DELETE', `/api/admin/accounts/${createdId}`, null, adminHeaders);
    assert.strictEqual(delRes.status, 200);
    assert.strictEqual(delRes.json.ok, true);

    // 全流程只应命中本地 mock 授权服务，不产生任何真实外网授权请求
    assert(httpMockAuthorizeHits >= 1, '设备授权 start 必须命中本地 mock');
    assert(httpMockTokenHits >= 1, '设备授权轮询必须命中本地 mock');
  } finally {
    gwProc.kill('SIGTERM');
    await new Promise((resolve) => httpMockAuthServer.close(resolve));
  }

  console.log('✓ [All Passed] test-dynamic-accounts-and-device-login 运行完成！');
}

run().catch((err) => {
  console.error('测试失败:', err);
  process.exit(1);
});
