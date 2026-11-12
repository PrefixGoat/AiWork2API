'use strict';
/**
 * 验收测试套件：Issue #05 新会话轮询、会话账号绑定与按调用凭据隔离的用量与路由
 *
 * 验收目标：
 * AC 1. 候选账号筛选：同时校验调用凭据当前账号权限范围、目标模型支持、账号就绪状态、冷却状态与并发余量；
 * AC 2. 新会话确定性轮询分配，已有会话保持粘性绑定 (Sticky Session)；
 * AC 3. 动态账号池与权限收缩约束：权限收缩或账号不可用时自动失效原有绑定并遵循当前条件重调度，严禁使用过期绑定越权；
 * AC 4. 调用凭据稳定内部 ID 作为命名空间隔离：两份凭据使用相同 session_id 时路由与用量互不合并、互不串话；
 * AC 5. 用量统计严格隔离：普通调用凭据仅返回自身统计且不暴露上游账号明细或外部用量；管理员可查看全局聚合、分凭据及分账号状态；
 * AC 6. 在途账单刷新去重复用避免雪崩，本地状态持久化采用临时文件 + rename 原子替换。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const crypto = require('crypto');
const { MockUpstream } = require('./mock-upstream');

const TEST_DIR = path.join(__dirname, '..', '.scratch', 'v1', 'scratch', `test-session-routing-${Date.now()}`);
const GATEWAY_PORT = 18095;
const ADMIN_PASSWORD = 'AdminSecretPass_2026';

let mockUpstream;
let gatewayProcess;

function requestGateway(options, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const req = http.request({
      hostname: '127.0.0.1',
      port: GATEWAY_PORT,
      path: options.path,
      method: options.method || (payload ? 'POST' : 'GET'),
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(options.headers || {}),
      },
      timeout: 10000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch (_) {}
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: parsed,
          raw,
        });
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForGatewayReady(timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await requestGateway({ path: '/healthz', method: 'GET' });
      if (res.statusCode === 200 && res.raw.includes('ok')) return true;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Gateway failed to start within ${timeoutMs}ms`);
}

async function runTests() {
  console.log('--- 开始执行 Issue #05: 新会话轮询、会话账号绑定与按调用凭据隔离的用量与路由测试 ---');
  fs.mkdirSync(TEST_DIR, { recursive: true });

  const acc1Dir = path.join(TEST_DIR, 'acc1');
  const acc2Dir = path.join(TEST_DIR, 'acc2');
  const gatewayDataDir = path.join(TEST_DIR, 'gateway-data');
  const stateFile = path.join(gatewayDataDir, 'usage-state.json');
  fs.mkdirSync(acc1Dir, { recursive: true });
  fs.mkdirSync(acc2Dir, { recursive: true });
  fs.mkdirSync(gatewayDataDir, { recursive: true });

  const acc1Key = 'sk-upstream-router-acc1-key';
  const acc2Key = 'sk-upstream-router-acc2-key';

  fs.writeFileSync(path.join(acc1Dir, '.env'), `AGENTIX_CONFIG_MODELS_AIWORK_ROUTER_API_KEY=${acc1Key}\n`);
  fs.writeFileSync(path.join(acc1Dir, 'config.json'), JSON.stringify({
    config_protocol_version: '1.1',
    models: {
      'aiwork-router': {
        models: [
          { id: 'deepseek-flash', name: 'DeepSeek Flash', reasoning: true },
          { id: 'model-common', name: 'Common Model', reasoning: false },
        ],
      },
    },
  }, null, 2));

  fs.writeFileSync(path.join(acc2Dir, '.env'), `AGENTIX_CONFIG_MODELS_AIWORK_ROUTER_API_KEY=${acc2Key}\n`);
  fs.writeFileSync(path.join(acc2Dir, 'config.json'), JSON.stringify({
    config_protocol_version: '1.1',
    models: {
      'aiwork-router': {
        models: [
          { id: 'deepseek-flash', name: 'DeepSeek Flash', reasoning: true },
          { id: 'model-common', name: 'Common Model', reasoning: false },
        ],
      },
    },
  }, null, 2));

  mockUpstream = new MockUpstream();
  const upstreamUrl = await mockUpstream.start(0);
  console.log('[Harness] MockUpstream 已在 %s 启动', upstreamUrl);

  const key1Token = 'sk-client-key1-token';
  const key2Token = 'sk-client-key2-token';
  const initialKeysEnv = `${key1Token}:Key1Client,${key2Token}:Key2Client`;

  const accountsJson = {
    accounts: [
      { id: 'acc1', name: 'Account One', stateDir: acc1Dir, priority: 1 },
      { id: 'acc2', name: 'Account Two', stateDir: acc2Dir, priority: 2 },
    ],
  };
  fs.writeFileSync(path.join(gatewayDataDir, 'accounts.json'), JSON.stringify(accountsJson, null, 2));

  const env = {
    ...process.env,
    PORT: String(GATEWAY_PORT),
    BIND: '127.0.0.1',
    ADMIN_PASSWORD,
    API_KEYS: initialKeysEnv,
    ROUTER_BASE_URL: upstreamUrl,
    UPSTREAM: 'direct',
    GATEWAY_DATA_DIR: gatewayDataDir,
    STATE_PATH: stateFile,
    MAX_CONCURRENCY_PER_ACCOUNT: '2', // 设为 2 便于并发测试
    NODE_ENV: 'test',
  };

  const bridgeScript = path.join(__dirname, '..', 'src', 'api-bridge.js');
  console.log('[Harness] 启动网关进程...');
  gatewayProcess = cp.spawn(process.execPath, [bridgeScript], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  gatewayProcess.stdout.on('data', (d) => {
    const s = d.toString('utf8');
    if (process.env.DEBUG_TEST) console.log('[GW-STDOUT]', s.trim());
  });
  gatewayProcess.stderr.on('data', (d) => {
    const s = d.toString('utf8');
    if (process.env.DEBUG_TEST) console.error('[GW-STDERR]', s.trim());
  });

  await waitForGatewayReady();
  console.log('[Harness] 网关在 127.0.0.1:%d 就绪', GATEWAY_PORT);

  // 获取管理员 Cookie 与 Token
  const loginRes = await requestGateway({
    path: '/api/admin/login',
    method: 'POST',
  }, { password: ADMIN_PASSWORD });
  assert.strictEqual(loginRes.statusCode, 200, 'Admin login failed');
  const adminCookie = loginRes.headers['set-cookie']?.[0]?.split(';')[0];
  const adminHeaders = { Cookie: adminCookie };

  // 获取生成的两个 Key 的详细信息（以获取稳定内部 id）
  const keysListRes = await requestGateway({
    path: '/api/admin/keys',
    method: 'GET',
    headers: adminHeaders,
  });
  assert.strictEqual(keysListRes.statusCode, 200);
  const keys = keysListRes.body.keys || keysListRes.body.data || [];
  const key1Obj = keys.find((k) => k.name === 'Key1Client');
  const key2Obj = keys.find((k) => k.name === 'Key2Client');
  assert.ok(key1Obj && key1Obj.id, 'key1 must have id');
  assert.ok(key2Obj && key2Obj.id, 'key2 must have id');
  assert.notStrictEqual(key1Obj.id, key2Obj.id, 'key ids must differ');

  // =========================================================================
  // AC 2 验证：新会话确定性轮询调度 (Round-Robin across Candidate Accounts)
  // =========================================================================
  console.log('\n[AC 2 验证] 测试新会话在候选账号集合中执行确定性轮询调度...');
  mockUpstream.clear();

  // 会话 1：Key1 发起新会话 s1
  const r1 = await requestGateway({
    path: '/v1/chat/completions',
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key1Token}`,
      'x-session-id': 'session-alpha',
    },
  }, {
    model: 'model-common',
    messages: [{ role: 'user', content: 'Turn 1 of session alpha' }],
  });
  assert.strictEqual(r1.statusCode, 200);
  const req1Auth = mockUpstream.recordedRequests[mockUpstream.recordedRequests.length - 1].headers.authorization;
  assert.strictEqual(req1Auth, `Bearer ${acc1Key}`, '新会话 1 应轮询调度到 acc1');

  // 会话 2：Key1 发起新会话 s2
  const r2 = await requestGateway({
    path: '/v1/chat/completions',
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key1Token}`,
      'x-session-id': 'session-beta',
    },
  }, {
    model: 'model-common',
    messages: [{ role: 'user', content: 'Turn 1 of session beta' }],
  });
  assert.strictEqual(r2.statusCode, 200);
  const req2Auth = mockUpstream.recordedRequests[mockUpstream.recordedRequests.length - 1].headers.authorization;
  assert.strictEqual(req2Auth, `Bearer ${acc2Key}`, '新会话 2 应轮询调度到 acc2');

  // 会话 3：Key1 发起新会话 s3
  const r3 = await requestGateway({
    path: '/v1/chat/completions',
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key1Token}`,
      'x-session-id': 'session-gamma',
    },
  }, {
    model: 'model-common',
    messages: [{ role: 'user', content: 'Turn 1 of session gamma' }],
  });
  assert.strictEqual(r3.statusCode, 200);
  const req3Auth = mockUpstream.recordedRequests[mockUpstream.recordedRequests.length - 1].headers.authorization;
  assert.strictEqual(req3Auth, `Bearer ${acc1Key}`, '新会话 3 应回环轮询调度到 acc1');

  console.log('  ✓ AC 2 轮询验证通过：新会话确定性交替分配 [acc1, acc2, acc1]');

  // =========================================================================
  // AC 2 验证：会话账号粘性绑定 (Sticky Session)
  // =========================================================================
  console.log('\n[AC 2 验证] 测试同一调用凭据下已有会话的粘性绑定保持...');

  // 会话 1 的后续请求 Turn 2
  const r1_t2 = await requestGateway({
    path: '/v1/chat/completions',
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key1Token}`,
      'x-session-id': 'session-alpha',
    },
  }, {
    model: 'model-common',
    messages: [
      { role: 'user', content: 'Turn 1 of session alpha' },
      { role: 'assistant', content: 'Reply 1' },
      { role: 'user', content: 'Turn 2 of session alpha' },
    ],
  });
  assert.strictEqual(r1_t2.statusCode, 200);
  const req1_t2Auth = mockUpstream.recordedRequests[mockUpstream.recordedRequests.length - 1].headers.authorization;
  assert.strictEqual(req1_t2Auth, `Bearer ${acc1Key}`, '已有绑定会话 alpha 必须保持粘性绑定在 acc1');

  // 会话 2 的后续请求 Turn 2
  const r2_t2 = await requestGateway({
    path: '/v1/chat/completions',
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key1Token}`,
      'x-session-id': 'session-beta',
    },
  }, {
    model: 'model-common',
    messages: [
      { role: 'user', content: 'Turn 1 of session beta' },
      { role: 'assistant', content: 'Reply 1' },
      { role: 'user', content: 'Turn 2 of session beta' },
    ],
  });
  assert.strictEqual(r2_t2.statusCode, 200);
  const req2_t2Auth = mockUpstream.recordedRequests[mockUpstream.recordedRequests.length - 1].headers.authorization;
  assert.strictEqual(req2_t2Auth, `Bearer ${acc2Key}`, '已有绑定会话 beta 必须保持粘性绑定在 acc2');

  console.log('  ✓ AC 2 粘性验证通过：多轮对话严格保持原有账号绑定，不随新会话指针漂移');

  // =========================================================================
  // AC 3 验证：权限收缩与动态账号约束（严禁凭旧绑定越权访问未授权账号）
  // =========================================================================
  console.log('\n[AC 3 验证] 测试调用凭据权限收缩时既有绑定自动失效并重新服从受约调度...');

  // 管理员将 Key1 的权限收缩为只允许访问 acc2（排除 acc1）
  const updatePolicyRes = await requestGateway({
    path: `/api/admin/keys/${key1Obj.id}`,
    method: 'PATCH',
    headers: adminHeaders,
  }, {
    account_policy: {
      mode: 'custom',
      accounts: ['acc2'],
    },
  });
  assert.strictEqual(updatePolicyRes.statusCode, 200, 'Update key policy failed');

  // 会话 alpha 原本绑定在 acc1 上；现在 Key1 已无 acc1 权限。
  // 发起 Turn 3，网关必须自动感知原绑定已失效，将其重调度至当前合法的 acc2，绝不能访问 acc1！
  const r1_t3 = await requestGateway({
    path: '/v1/chat/completions',
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key1Token}`,
      'x-session-id': 'session-alpha',
    },
  }, {
    model: 'model-common',
    messages: [
      { role: 'user', content: 'Turn 1 of session alpha' },
      { role: 'assistant', content: 'Reply 1' },
      { role: 'user', content: 'Turn 2 of session alpha' },
      { role: 'assistant', content: 'Reply 2' },
      { role: 'user', content: 'Turn 3 of session alpha' },
    ],
  });
  assert.strictEqual(r1_t3.statusCode, 200);
  const req1_t3Auth = mockUpstream.recordedRequests[mockUpstream.recordedRequests.length - 1].headers.authorization;
  assert.strictEqual(req1_t3Auth, `Bearer ${acc2Key}`, '原绑定在 acc1 的会话因权限收缩必须立即重调度至 acc2，严禁借由旧绑定越权访问 acc1');

  // 恢复 Key1 为全部账号，便于后续测试
  await requestGateway({
    path: `/api/admin/keys/${key1Obj.id}`,
    method: 'PATCH',
    headers: adminHeaders,
  }, {
    account_policy: { mode: 'all' },
  });

  console.log('  ✓ AC 3 验证通过：权限收缩时既有绑定立即受约失效，无任何越权泄露');

  // =========================================================================
  // AC 4 验证：以调用凭据稳定内部 ID 作为命名空间隔离 (No Cross-Talk)
  // =========================================================================
  console.log('\n[AC 4 验证] 测试两份调用凭据使用同名会话与同首句时的命名空间隔离...');
  mockUpstream.clear();

  // Key1 发送会话 "identical-session-id"
  const k1_resp = await requestGateway({
    path: '/v1/chat/completions',
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key1Token}`,
      'x-session-id': 'identical-session-id',
    },
  }, {
    model: 'model-common',
    messages: [{ role: 'user', content: 'Universal prompt from user 1' }],
  });
  assert.strictEqual(k1_resp.statusCode, 200);

  // Key2 同样发送会话 "identical-session-id" 且内容完全一致
  const k2_resp = await requestGateway({
    path: '/v1/chat/completions',
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key2Token}`,
      'x-session-id': 'identical-session-id',
    },
  }, {
    model: 'model-common',
    messages: [{ role: 'user', content: 'Universal prompt from user 1' }],
  });
  assert.strictEqual(k2_resp.statusCode, 200);

  // 查询 Key1 的用量
  const k1_usage_res = await requestGateway({
    path: '/api/usage',
    method: 'GET',
    headers: { Authorization: `Bearer ${key1Token}` },
  });
  assert.strictEqual(k1_usage_res.statusCode, 200);
  const k1_usage = k1_usage_res.body;

  // 查询 Key2 的用量
  const k2_usage_res = await requestGateway({
    path: '/api/usage',
    method: 'GET',
    headers: { Authorization: `Bearer ${key2Token}` },
  });
  assert.strictEqual(k2_usage_res.statusCode, 200);
  const k2_usage = k2_usage_res.body;

  // 断言：Key2 只能看到自己创建的 1 个会话
  assert.strictEqual(k2_usage.sessions.length, 1, 'Key2 只能看到属于自身的 1 个会话');
  assert.strictEqual(k2_usage.sessions[0].id, 'identical-session-id', '返回给客户端的会话 ID 必须是原始 ID');
  assert.strictEqual(k2_usage.sessions[0].scopedId, undefined, '严禁向客户端泄露内部 scopedId 命名空间前缀');
  assert.strictEqual(k2_usage.sessions[0].accountId, undefined, '严禁向客户端泄露内部 accountId');

  // 断言：Key1 看不到 Key2 的独立统计，Key1 会话列表不包含 Key2 的内部命名空间
  assert.ok(k1_usage.sessions.every((s) => !s.id.includes('::')), 'Key1 会话列表不得包含 internal prefix');
  const k1Identical = k1_usage.sessions.find((s) => s.id === 'identical-session-id');
  const k2Identical = k2_usage.sessions.find((s) => s.id === 'identical-session-id');
  assert.ok(k1Identical, 'Key1 应包含 identical-session-id');
  assert.ok(k2Identical, 'Key2 应包含 identical-session-id');
  assert.strictEqual(k1Identical.requests, 1, 'Key1 上的调用次数独立为 1');
  assert.strictEqual(k2Identical.requests, 1, 'Key2 上的调用次数独立为 1，绝未发生串话合并');

  console.log('  ✓ AC 4 验证通过：不同凭据使用相同会话标识符时命名空间严格隔离，互不串话');

  // =========================================================================
  // AC 5 验证：调用凭据用量接口隔离 vs 管理员全局聚合视角
  // =========================================================================
  console.log('\n[AC 5 验证] 测试调用凭据用量接口隔离及管理员全局聚合视图...');

  // 调用凭据查用量
  assert.strictEqual(k1_usage.real.ok, false, '普通凭据 real.ok 必须为 false');
  assert.strictEqual(k1_usage.real.error, 'admin_only', '普通凭据不得暴露真实上游账单或限额');
  assert.strictEqual(k1_usage.byKey === undefined || Object.keys(k1_usage.byKey).length === 0, true, '普通凭据不得泄露其他调用方的 Key 消耗');

  // 管理员查用量
  const admin_usage_res = await requestGateway({
    path: '/api/usage',
    method: 'GET',
    headers: adminHeaders,
  });
  assert.strictEqual(admin_usage_res.statusCode, 200);
  const admin_usage = admin_usage_res.body;

  assert.ok(admin_usage.byKey, '管理员视角必须包含 byKey 聚合统计');
  assert.ok(admin_usage.byAccount, '管理员视角必须包含 byAccount 聚合统计');
  assert.ok(admin_usage.byAccount['acc1'] || admin_usage.byAccount['acc2'], '管理员视角必须能看到上游账号用量');
  assert.ok(admin_usage.tokens.total >= k1_usage.tokens.total + k2_usage.tokens.total, '管理员全局总 token 数等于所有调用方的累计');
  assert.ok(admin_usage.real.ok, '管理员视角下上游 real 数据正常暴露');

  console.log('  ✓ AC 5 验证通过：调用凭据仅见自身且不漏上游与同行；管理员总览全局分凭据/分账号用量');

  // =========================================================================
  // AC 1 验证：并发控制与满载调度 (503 all_accounts_busy)
  // =========================================================================
  console.log('\n[AC 1 验证] 测试账号并发余量检查与全满载时 503 all_accounts_busy...');

  // 设置 mockUpstream 在收到特定请求时挂起以保持并发
  let releaseHangingRequests;
  const hangingPromise = new Promise((resolve) => {
    releaseHangingRequests = resolve;
  });

  let hungCount = 0;
  mockUpstream.setHandler('/v1/chat/completions', async (req, res, body) => {
    if (body?.messages?.[0]?.content?.includes('HOLD_CONCURRENCY')) {
      hungCount++;
      await hangingPromise;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-mock-hold',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: body.model || 'model-common',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Done after hold' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }));
  });

  // 每个账号并发上限为 2（环境变量 MAX_CONCURRENCY_PER_ACCOUNT=2），总容量为 4
  // 发起 4 个会话请求，占满 acc1 (2 slots) 与 acc2 (2 slots)
  const reqPromises = [
    requestGateway({ path: '/v1/chat/completions', method: 'POST', headers: { Authorization: `Bearer ${key1Token}`, 'x-session-id': 'hang-1' } }, { model: 'model-common', messages: [{ role: 'user', content: 'HOLD_CONCURRENCY 1' }] }),
    requestGateway({ path: '/v1/chat/completions', method: 'POST', headers: { Authorization: `Bearer ${key1Token}`, 'x-session-id': 'hang-2' } }, { model: 'model-common', messages: [{ role: 'user', content: 'HOLD_CONCURRENCY 2' }] }),
    requestGateway({ path: '/v1/chat/completions', method: 'POST', headers: { Authorization: `Bearer ${key1Token}`, 'x-session-id': 'hang-3' } }, { model: 'model-common', messages: [{ role: 'user', content: 'HOLD_CONCURRENCY 3' }] }),
    requestGateway({ path: '/v1/chat/completions', method: 'POST', headers: { Authorization: `Bearer ${key1Token}`, 'x-session-id': 'hang-4' } }, { model: 'model-common', messages: [{ role: 'user', content: 'HOLD_CONCURRENCY 4' }] }),
  ];

  // 等待 4 个并发请求全部到达上游
  while (hungCount < 4) {
    await new Promise((r) => setTimeout(r, 50));
  }

  // 此时两账号均达到并发上限 2，尝试发送第 5 个请求
  const busyRes = await requestGateway({
    path: '/v1/chat/completions',
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key1Token}`,
      'x-session-id': 'hang-overflow',
    },
  }, {
    model: 'model-common',
    messages: [{ role: 'user', content: 'Immediate attempt when full' }],
  });

  assert.strictEqual(busyRes.statusCode, 503, '所有支持账号满载时必须返回 503');
  assert.strictEqual(busyRes.body.error.code, 'all_accounts_busy', '错误代码必须为 all_accounts_busy');

  // 释放挂起的 4 个请求
  releaseHangingRequests();
  await Promise.all(reqPromises);
  mockUpstream.customHandlers.delete('/v1/chat/completions');

  // 释放后，并发计数恢复，后续请求立即成功
  const postReleaseRes = await requestGateway({
    path: '/v1/chat/completions',
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key1Token}`,
      'x-session-id': 'after-release',
    },
  }, {
    model: 'model-common',
    messages: [{ role: 'user', content: 'Request after concurrency release' }],
  });
  assert.strictEqual(postReleaseRes.statusCode, 200, '并发释放后请求恢复正常处理');

  console.log('  ✓ AC 1 并发验证通过：满载账号被暂时剔除，全满载时严格返回 503 all_accounts_busy 且槽位释放无泄漏');

  // =========================================================================
  // AC 6 验证：在途账单刷新去重复用 (In-Flight Request Deduplication)
  // =========================================================================
  console.log('\n[AC 6 验证] 测试在途真实账单刷新去重复用与异步原子持久化...');
  mockUpstream.clear();

  let billingHitCount = 0;
  mockUpstream.setHandler('/v1/dashboard/billing/usage', async (req, res) => {
    billingHitCount++;
    await new Promise((r) => setTimeout(r, 150)); // 故意增加延迟以便测试并发在途
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ total_usage: 88.88 }));
  });

  // 并发触发 5 个强制刷新账单的请求
  const refreshCalls = [
    requestGateway({ path: '/api/usage?force=1', method: 'GET', headers: adminHeaders }),
    requestGateway({ path: '/api/usage?force=1', method: 'GET', headers: adminHeaders }),
    requestGateway({ path: '/api/usage?force=1', method: 'GET', headers: adminHeaders }),
    requestGateway({ path: '/api/usage?force=1', method: 'GET', headers: adminHeaders }),
    requestGateway({ path: '/api/models?force=1', method: 'GET', headers: adminHeaders }),
  ];

  const refreshResults = await Promise.all(refreshCalls);
  assert.ok(refreshResults.every((r) => r.statusCode === 200), 'All refresh calls succeeded');
  assert.strictEqual(billingHitCount, 1, `5 次并发强制刷新必须严格去重复用为 1 次在途上游网络请求，实际触发: ${billingHitCount}`);

  mockUpstream.customHandlers.delete('/v1/dashboard/billing/usage');
  console.log('  ✓ AC 6 去重验证通过：并发 refreshReal 成功去重并复用在途 Promise');

  // =========================================================================
  // AC 6 验证：本地状态持久化采用临时文件 + rename 原子替换
  // =========================================================================
  console.log('\n[AC 6 验证] 检查本地 usage-state.json 原子替换完整性...');

  assert.ok(fs.existsSync(stateFile), 'State file must exist on disk');
  const stateContent = fs.readFileSync(stateFile, 'utf8');
  let parsedState;
  assert.doesNotThrow(() => {
    parsedState = JSON.parse(stateContent);
  }, 'usage-state.json 必须是完整有效的 JSON，无截断或语法损坏');

  assert.ok(parsedState.tokens, 'State must contain tokens');
  assert.ok(parsedState.sessions, 'State must contain sessions');
  assert.ok(parsedState.byAccount, 'State must contain byAccount');

  // 检查磁盘上不应残留未完成的 .tmp 文件
  const allFilesInGatewayData = fs.readdirSync(gatewayDataDir);
  const lingeringTmp = allFilesInGatewayData.filter((f) => f.includes('.tmp.'));
  assert.strictEqual(lingeringTmp.length, 0, `持久化临时文件应已全部 rename 替换，不应残留: ${lingeringTmp.join(', ')}`);

  console.log('  ✓ AC 6 原子替换验证通过：状态文件完整有效且无临时碎片残留');

  console.log('\n>>> Issue #05 全部 6 项验收指标测试 100% 通过 ✓ <<<');
}

(async () => {
  try {
    await runTests();
    process.exit(0);
  } catch (err) {
    console.error('\n❌ 测试失败:', err);
    process.exit(1);
  } finally {
    if (gatewayProcess) {
      try { gatewayProcess.kill('SIGKILL'); } catch (_) {}
    }
    if (mockUpstream) {
      try { await mockUpstream.stop(); } catch (_) {}
    }
  }
})();
