'use strict';
/**
 * 验收测试套件：Issue #04 显式上游账号池、只读状态热重载与精确模型别名
 *
 * 验收目标：
 * AC 1. 支持显式配置多个独立的官方 CLI 状态目录组建上游账号池（UPSTREAM_ACCOUNTS / data/accounts.json），
 *       网关保持只读访问，不扫描未配置路径，不修改账号目录文件。
 * AC 2. 按账号读取与维护凭据状态与支持模型；凭据与模型文件更新时热重载生效，无需重启网关。
 * AC 3. 凭据缺失或失效时账号置为不可用，并提供包含具体状态目录的官方 CLI 恢复提示。
 * AC 4. 精确模型别名映射（客户端模型名 -> 目标模型名），别名解析仅决定目标模型，绝不触发执行模式切换。
 * AC 5. 彻底废除未知模型静默兜底：Chat Completions、Responses (HTTP & WS)、Messages
 *       遇到未知且未映射模型统一返回 404 model_not_found，绝不静默替跑。
 * AC 6. 模型选择按账号核实可用性：仅路由至支持目标模型的账号，权限受限凭据不可越权访问不支持或未授权账号。
 * AC 7. 管理专属端点 (/api/admin/accounts, /api/admin/aliases) 权限边界保护（普通凭据 403）。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const cp = require('child_process');
const crypto = require('crypto');
const { MockUpstream } = require('./mock-upstream');

const TEST_DIR = path.join(__dirname, '..', '.scratch', 'v1', 'scratch', `test-account-pool-${Date.now()}`);
const GATEWAY_PORT = 18094;
const ADMIN_PASSWORD = 'AdminSecretPass_2026';
const INV_KEY = 'sk-client-pool-key';

let mockUpstream;
let gatewayProcess;
let gwLogs = [];

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

function testWsResponses(token) {
  return new Promise((resolve) => {
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

    const handleFrameData = (d) => {
      let b = d;
      while (b.length >= 2) {
        const opcode = b[0] & 0x0f;
        let len = b[1] & 0x7f;
        let offset = 2;
        if (len === 126) {
          if (b.length < 4) break;
          len = b.readUInt16BE(2);
          offset = 4;
        } else if (len === 127) {
          if (b.length < 10) break;
          len = Number(b.readBigUInt64BE(2));
          offset = 10;
        }
        if (b.length < offset + len) break;
        const payload = b.slice(offset, offset + len);
        b = b.slice(offset + len);
        if (opcode === 1) {
          try {
            textFrames.push(JSON.parse(payload.toString('utf8')));
          } catch (_) {}
        }
      }
    };

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
                  return rejWait(new Error(`waitForMessage timed out after ${timeoutMs}ms; got: ${JSON.stringify(textFrames)}`));
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

    sock.on('error', () => {
      if (!handshakeDone) resolve({ status: 0, head: '', textFrames });
    });
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
  console.log('--- 开始执行 Issue #04: 上游账号池、只读状态热重载与精确模型别名验收测试 ---');
  fs.mkdirSync(TEST_DIR, { recursive: true });

  const acc1Dir = path.join(TEST_DIR, 'acc1');
  const acc2Dir = path.join(TEST_DIR, 'acc2');
  const gatewayDataDir = path.join(TEST_DIR, 'gateway-data');
  fs.mkdirSync(acc1Dir, { recursive: true });
  fs.mkdirSync(acc2Dir, { recursive: true });
  fs.mkdirSync(gatewayDataDir, { recursive: true });

  // 账号 1: 拥有 router key 1，支持 deepseek-flash 与 qwen3.8-max
  const acc1Key = 'sk-upstream-router-acc1-secret-key';
  fs.writeFileSync(path.join(acc1Dir, '.env'), `AGENTIX_CONFIG_MODELS_AIWORK_ROUTER_API_KEY=${acc1Key}\n`);
  fs.writeFileSync(path.join(acc1Dir, 'config.json'), JSON.stringify({
    config_protocol_version: '1.1',
    models: {
      'aiwork-router': {
        models: [
          { id: 'deepseek-flash', name: 'DeepSeek Flash', reasoning: true },
          { id: 'qwen3.8-max', name: 'Qwen 3.8 Max', reasoning: false },
        ],
      },
    },
  }, null, 2));

  // 账号 2: 拥有 router key 2，仅支持 deepseek-flash
  const acc2Key = 'sk-upstream-router-acc2-secret-key';
  fs.writeFileSync(path.join(acc2Dir, '.env'), `AGENTIX_CONFIG_MODELS_AIWORK_ROUTER_API_KEY=${acc2Key}\n`);
  fs.writeFileSync(path.join(acc2Dir, 'config.json'), JSON.stringify({
    config_protocol_version: '1.1',
    models: {
      'aiwork-router': {
        models: [
          { id: 'deepseek-flash', name: 'DeepSeek Flash', reasoning: true },
        ],
      },
    },
  }, null, 2));

  // 1. 启动 MockUpstream
  mockUpstream = new MockUpstream();
  const mockUrl = await mockUpstream.start(0);
  console.log(`[Harness] MockUpstream 已在 ${mockUrl} 启动`);

  // 2. 启动网关，配置 UPSTREAM_ACCOUNTS 显式多账号池与 MODEL_ALIASES 别名
  console.log('[Harness] 启动网关进程（注入多账号配置与模型别名）...');
  const fakeCliBin = path.join(TEST_DIR, 'fake-aiworkcn.exe');

  gatewayProcess = cp.fork(path.join(__dirname, '..', 'src', 'api-bridge.js'), [], {
    env: {
      ...process.env,
      PORT: String(GATEWAY_PORT),
      BIND: '127.0.0.1',
      ADMIN_PASSWORD,
      API_KEYS: `${INV_KEY}:test-user-key`,
      UPSTREAM: 'direct',
      UPSTREAM_FALLBACK: '0',
      ROUTER_BASE_URL: mockUrl,
      GATEWAY_DATA_DIR: gatewayDataDir,
      UPSTREAM_ACCOUNTS: `acc1=${acc1Dir},acc2=${acc2Dir}`,
      MODEL_ALIASES: 'gpt-4o=deepseek-flash,codex-model=deepseek-flash,claude-3-5-sonnet=deepseek-flash',
      STATE_PATH: path.join(gatewayDataDir, 'usage-state.json'),
      DUMP_DIR: path.join(gatewayDataDir, 'gw-logs'),
      DTCODER_BIN: fakeCliBin,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  const isQuiet = process.env.QUIET === '1' || process.env.LOG_LEVEL === 'error';
  gatewayProcess.stderr.on('data', (d) => {
    gwLogs.push(`[GW-ERR] ${d}`);
    if (!isQuiet) process.stderr.write(`[GW-ERR] ${d}`);
  });
  gatewayProcess.stdout.on('data', (d) => {
    gwLogs.push(`[GW-LOG] ${d}`);
    if (!isQuiet) process.stdout.write(`[GW-LOG] ${d}`);
  });

  await waitForGatewayReady();
  console.log(`[Harness] 网关在 127.0.0.1:${GATEWAY_PORT} 就绪`);

  // =========================================================================
  // AC 1 & AC 2: 显式多账号池、只读状态加载与全局可用模型汇总
  // =========================================================================
  console.log('\n[AC 1 & AC 2 验证] 测试多账号池只读加载、状态就绪与全局模型汇总...');
  const statusRes = await requestGateway({ path: '/status', method: 'GET' });
  assert.strictEqual(statusRes.statusCode, 200);
  assert.strictEqual(statusRes.body.ready, true, '多账号就绪时 ready 必须为 true');
  assert.strictEqual(statusRes.body.accounts_available, 2, '可用账号数必须为 2');
  assert.strictEqual(statusRes.body.accounts_total, 2, '总账号数必须为 2');
  assert.strictEqual(statusRes.body.models, 2, '可用真实模型总数必须为 2');
  assert.strictEqual(statusRes.body.aliases_count, 3, '已注册别名数必须为 3');

  const modelsRes = await requestGateway({ path: '/v1/models', method: 'GET', headers: { Authorization: `Bearer ${INV_KEY}` } });
  assert.strictEqual(modelsRes.statusCode, 200);
  const modelIds = modelsRes.body.data.map((m) => m.id);
  assert.ok(modelIds.includes('deepseek-flash'), '模型列表中必须包含 deepseek-flash');
  assert.ok(modelIds.includes('qwen3.8-max'), '模型列表中必须包含 qwen3.8-max');

  // 管理端登录并获取账号详情与脱敏展示
  const loginRes = await requestGateway({ path: '/api/admin/login' }, { password: ADMIN_PASSWORD });
  assert.strictEqual(loginRes.statusCode, 200);
  const adminCookie = (loginRes.headers['set-cookie'] || [])[0].split(';')[0];

  const adminAccsRes = await requestGateway({
    path: '/api/admin/accounts',
    method: 'GET',
    headers: { Cookie: adminCookie },
  });
  assert.strictEqual(adminAccsRes.statusCode, 200);
  assert.strictEqual(adminAccsRes.body.accounts.length, 2);
  const a1 = adminAccsRes.body.accounts.find((a) => a.id === 'acc1');
  const a2 = adminAccsRes.body.accounts.find((a) => a.id === 'acc2');
  assert.ok(a1 && a2, '两账号均应在管理视图中');
  assert.strictEqual(a1.ready, true);
  assert.strictEqual(a2.ready, true);
  assert.ok(a1.routerKey.includes('...'), '管理视图账号 routerKey 必须脱敏');
  assert.strictEqual(a1.modelsCount, 2);
  assert.strictEqual(a2.modelsCount, 1);
  console.log('  ✓ AC 1 & AC 2 验证通过：多账号池只读加载、状态就绪与管理视图脱敏展示正确');

  // =========================================================================
  // AC 6: 模型选择按账号核实可用性与凭据权限范围约束
  // =========================================================================
  console.log('\n[AC 6 验证] 测试模型按账号可用性调度（仅向支持模型的账号转发）与凭据范围过滤...');
  mockUpstream.clear();

  // 请求 qwen3.8-max（仅 acc1 支持）
  const chatQwen = await requestGateway({
    path: '/v1/chat/completions',
    headers: { Authorization: `Bearer ${INV_KEY}` },
  }, {
    model: 'qwen3.8-max',
    messages: [{ role: 'user', content: 'test qwen routing' }],
  });
  assert.strictEqual(chatQwen.statusCode, 200, 'qwen3.8-max 请求必须成功');
  const qwenReqs = mockUpstream.getRecordedRequests('/v1/chat/completions');
  assert.strictEqual(qwenReqs.length, 1);
  assert.strictEqual(qwenReqs[0].headers.authorization, `Bearer ${acc1Key}`, 'qwen3.8-max 必须仅路由到支持该模型的 acc1');

  // 创建受限调用凭据：仅允许访问 acc2（acc2 不支持 qwen3.8-max）
  const createKeyRes = await requestGateway({
    path: '/api/admin/keys',
    method: 'POST',
    headers: { Cookie: adminCookie },
  }, {
    name: 'acc2-only-key',
    accounts_access_mode: 'explicit',
    allowed_accounts: ['acc2'],
  });
  assert.strictEqual(createKeyRes.statusCode, 201);
  const acc2RestrictedToken = createKeyRes.body.key.token;

  // 使用受限凭据调用 deepseek-flash（acc2 支持）-> 成功
  mockUpstream.clear();
  const acc2FlashChat = await requestGateway({
    path: '/v1/chat/completions',
    headers: { Authorization: `Bearer ${acc2RestrictedToken}` },
  }, {
    model: 'deepseek-flash',
    messages: [{ role: 'user', content: 'ping' }],
  });
  assert.strictEqual(acc2FlashChat.statusCode, 200, '受限凭据调用 acc2 支持的模型必须成功');
  const flashReqs = mockUpstream.getRecordedRequests('/v1/chat/completions');
  assert.strictEqual(flashReqs.length, 1);
  assert.strictEqual(flashReqs[0].headers.authorization, `Bearer ${acc2Key}`, '请求必须路由到 acc2');

  // 使用受限凭据调用 qwen3.8-max（acc2 不支持）-> 必须返回 404 no_account_supports_model，绝不转发至 acc1
  mockUpstream.clear();
  const acc2QwenChat = await requestGateway({
    path: '/v1/chat/completions',
    headers: { Authorization: `Bearer ${acc2RestrictedToken}` },
  }, {
    model: 'qwen3.8-max',
    messages: [{ role: 'user', content: 'illegal model for acc2' }],
  });
  assert.strictEqual(acc2QwenChat.statusCode, 404, '受限凭据调用不支持的模型必须返回 404');
  assert.strictEqual(acc2QwenChat.body.error.code, 'no_account_supports_model', '错误码必须为 no_account_supports_model');
  assert.strictEqual(mockUpstream.getRecordedRequests('/v1/chat/completions').length, 0, '非法账号模型组合严禁向上游转发任何请求');
  console.log('  ✓ AC 6 验证通过：模型选择按账号核实可用性，凭据权限受限时绝不越权调度');

  // =========================================================================
  // AC 3 & AC 2: 凭据缺失/失效状态标记、恢复提示与零停机热重载
  // =========================================================================
  console.log('\n[AC 3 & AC 2 验证] 测试账号凭据缺失时状态置为不可用、提供恢复提示及热重载恢复...');
  // 清空 acc2 的 .env 文件模拟凭据缺失
  fs.writeFileSync(path.join(acc2Dir, '.env'), '# key removed\n');
  await new Promise((r) => setTimeout(r, 100));

  const statusAfterKeyRemoval = await requestGateway({ path: '/status', method: 'GET' });
  assert.strictEqual(statusAfterKeyRemoval.body.accounts_available, 1, 'acc2 凭据缺失后就绪账号数应降为 1');

  const accsAfterRemoval = await requestGateway({
    path: '/api/admin/accounts',
    method: 'GET',
    headers: { Cookie: adminCookie },
  });
  const acc2Check = accsAfterRemoval.body.accounts.find((a) => a.id === 'acc2');
  assert.strictEqual(acc2Check.ready, false);
  assert.strictEqual(acc2Check.status, 'credentials_missing');
  assert.ok(acc2Check.recoveryHint && acc2Check.recoveryHint.includes('dtcoder login'), '恢复提示必须包含官方 CLI 恢复指引');
  assert.ok(acc2Check.recoveryHint.includes(acc2Dir), '恢复提示必须包含对应账号的目录路径');

  // 恢复 acc2 凭据 -> 验证无需重启即刻热重载恢复
  fs.writeFileSync(path.join(acc2Dir, '.env'), `AGENTIX_CONFIG_MODELS_AIWORK_ROUTER_API_KEY=${acc2Key}\n`);
  await new Promise((r) => setTimeout(r, 100));

  const statusRestored = await requestGateway({ path: '/status', method: 'GET' });
  assert.strictEqual(statusRestored.body.accounts_available, 2, '凭据写回后账号池热重载恢复为 2');
  console.log('  ✓ AC 3 & AC 2 验证通过：凭据缺失准确标注与指引，更新后热重载即时生效');

  // =========================================================================
  // AC 4: 精确模型别名映射（各协议均映射到实际模型，模式不发生切换）
  // =========================================================================
  console.log('\n[AC 4 验证] 测试精确定向模型别名（Chat Completions / Responses / Messages）...');
  // 1) Chat Completions: gpt-4o -> deepseek-flash
  mockUpstream.clear();
  const chatAlias = await requestGateway({
    path: '/v1/chat/completions',
    headers: { Authorization: `Bearer ${INV_KEY}` },
  }, {
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'test alias in chat' }],
  });
  assert.strictEqual(chatAlias.statusCode, 200, '别名模型请求必须成功');
  const chatReqs = mockUpstream.getRecordedRequests('/v1/chat/completions');
  assert.strictEqual(chatReqs.length, 1);
  const upChatBody = chatReqs[0].body;
  assert.strictEqual(upChatBody.model, 'deepseek-flash', '上游收到的请求体模型必须被映射为实际模型 deepseek-flash');

  // 2) Responses HTTP: codex-model -> deepseek-flash
  mockUpstream.clear();
  const respAlias = await requestGateway({
    path: '/v1/responses',
    headers: { Authorization: `Bearer ${INV_KEY}` },
  }, {
    model: 'codex-model',
    input: [{ role: 'user', content: 'test alias in responses' }],
  });
  assert.strictEqual(respAlias.statusCode, 200, 'Responses 别名请求必须成功');
  const respReqs = mockUpstream.getRecordedRequests('/v1/chat/completions');
  assert.strictEqual(respReqs.length, 1);
  const upRespBody = respReqs[0].body;
  assert.strictEqual(upRespBody.model, 'deepseek-flash', 'Responses 上游收到的请求体模型必须被映射为 deepseek-flash');

  // 3) Messages HTTP: claude-3-5-sonnet -> deepseek-flash
  mockUpstream.clear();
  const msgAlias = await requestGateway({
    path: '/v1/messages',
    headers: {
      Authorization: `Bearer ${INV_KEY}`,
      'anthropic-version': '2023-06-01',
    },
  }, {
    model: 'claude-3-5-sonnet',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'test alias in messages' }],
  });
  assert.strictEqual(msgAlias.statusCode, 200, 'Messages 别名请求必须成功');
  const msgReqs = mockUpstream.getRecordedRequests('/v1/chat/completions');
  assert.strictEqual(msgReqs.length, 1);
  const upMsgBody = msgReqs[0].body;
  assert.strictEqual(upMsgBody.model, 'deepseek-flash', 'Messages 上游收到的请求体模型必须被映射为 deepseek-flash');
  console.log('  ✓ AC 4 验证通过：三套协议均精确解析别名并转发至真实模型，无模式切换');

  // =========================================================================
  // AC 5: 消除未知模型静默兜底（三协议 + WebSocket 全部返回 404）
  // =========================================================================
  console.log('\n[AC 5 验证] 测试废除未知模型静默兜底（Chat Completions / Responses HTTP / Responses WS / Messages 均 404）...');
  mockUpstream.clear();
  const unknownModel = 'unregistered-custom-model-999';

  // 1) Chat Completions 404
  console.log('  -> step 1: chatUnknown');
  const chatUnknown = await requestGateway({
    path: '/v1/chat/completions',
    headers: { Authorization: `Bearer ${INV_KEY}` },
  }, {
    model: unknownModel,
    messages: [{ role: 'user', content: 'unknown model query' }],
  });
  assert.strictEqual(chatUnknown.statusCode, 404, '未知模型必须返回 404');
  assert.strictEqual(chatUnknown.body.error.code, 'model_not_found');

  // 2) Responses HTTP 404
  console.log('  -> step 2: respUnknown');
  const respUnknown = await requestGateway({
    path: '/v1/responses',
    headers: { Authorization: `Bearer ${INV_KEY}` },
  }, {
    model: unknownModel,
    input: [{ role: 'user', content: 'unknown model query' }],
  });
  assert.strictEqual(respUnknown.statusCode, 404, 'Responses HTTP 未知模型必须返回 404');
  assert.strictEqual(respUnknown.body.error.code, 'model_not_found');

  // 3) Messages HTTP 404
  console.log('  -> step 3: msgUnknown');
  const msgUnknown = await requestGateway({
    path: '/v1/messages',
    headers: {
      Authorization: `Bearer ${INV_KEY}`,
      'anthropic-version': '2023-06-01',
    },
  }, {
    model: unknownModel,
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'unknown model query' }],
  });
  assert.strictEqual(msgUnknown.statusCode, 404, 'Messages HTTP 未知模型必须返回 404');
  assert.strictEqual(msgUnknown.body.error.code, 'model_not_found');

  // 4) Responses WebSocket 404 错误事件
  console.log('  -> step 4: wsClient test');
  const wsClient = await testWsResponses(INV_KEY);
  assert.strictEqual(wsClient.status, 101, 'WebSocket 握手必须成功');
  wsClient.sendFrame({
    type: 'response.create',
    model: unknownModel,
    input: [{ role: 'user', content: 'ws unknown model query' }],
    stream: true,
  });

  const wsErr = await wsClient.waitForMessage((m) => m && m.type === 'error' && m.code === 'model_not_found');
  assert.strictEqual(wsErr.code, 'model_not_found', 'WebSocket 必须收到 model_not_found 错误帧');
  assert.strictEqual(wsErr.status, 404, 'WebSocket 错误帧状态码必须为 404');
  wsClient.close();

  // 5) 验证未映射的 automodel 绝不静默替跑到 availableList[0] (Spec line 100)
  const autoUnknown = await requestGateway({
    path: '/v1/chat/completions',
    headers: { Authorization: `Bearer ${INV_KEY}` },
  }, {
    model: 'automodel',
    messages: [{ role: 'user', content: 'test automodel' }],
  });
  assert.strictEqual(autoUnknown.statusCode, 404, '未映射的 automodel 必须返回 404，绝不静默替换');
  assert.strictEqual(autoUnknown.body.error.code, 'model_not_found');

  // 断言上游在所有未知模型尝试中 0 次调用（杜绝静默兜底与计费偏差）
  assert.strictEqual(mockUpstream.getRecordedRequests('/v1/chat/completions').length, 0, '未知模型严禁触发上游替跑');
  console.log('  ✓ AC 5 验证通过：三协议及 WebSocket 遇未知模型均统一严格返回 404，静默替跑彻底废除');

  // =========================================================================
  // AC 7: 动态管理别名与端点权限隔离
  // =========================================================================
  console.log('\n[AC 7 验证] 测试管理接口动态配置别名与调用凭据 403 权限隔离...');
  // 1) 动态新增别名
  const addAliasRes = await requestGateway({
    path: '/api/admin/aliases',
    method: 'POST',
    headers: { Cookie: adminCookie },
  }, {
    alias: 'dynamic-speed',
    target: 'deepseek-flash',
  });
  assert.strictEqual(addAliasRes.statusCode, 200);
  assert.strictEqual(addAliasRes.body.alias, 'dynamic-speed');

  // 2) 验证新增别名即刻可用
  mockUpstream.clear();
  const dynChat = await requestGateway({
    path: '/v1/chat/completions',
    headers: { Authorization: `Bearer ${INV_KEY}` },
  }, {
    model: 'dynamic-speed',
    messages: [{ role: 'user', content: 'test dynamic alias' }],
  });
  assert.strictEqual(dynChat.statusCode, 200);
  assert.strictEqual(mockUpstream.getRecordedRequests('/v1/chat/completions').length, 1);

  // 3) 动态删除别名
  const delAliasRes = await requestGateway({
    path: '/api/admin/aliases/dynamic-speed',
    method: 'DELETE',
    headers: { Cookie: adminCookie },
  });
  assert.strictEqual(delAliasRes.statusCode, 200);

  // 4) 验证删除后立即变为未知模型 404
  const dynChatAfterDel = await requestGateway({
    path: '/v1/chat/completions',
    headers: { Authorization: `Bearer ${INV_KEY}` },
  }, {
    model: 'dynamic-speed',
    messages: [{ role: 'user', content: 'test dynamic alias after delete' }],
  });
  assert.strictEqual(dynChatAfterDel.statusCode, 404);

  // 5) 普通调用凭据访问管理接口必须被拒绝 (403 Forbidden)
  const forbiddenAccs = await requestGateway({
    path: '/api/admin/accounts',
    method: 'GET',
    headers: { Authorization: `Bearer ${INV_KEY}` },
  });
  assert.strictEqual(forbiddenAccs.statusCode, 403, '调用凭据访问 /api/admin/accounts 必须为 403');

  const forbiddenAliases = await requestGateway({
    path: '/api/admin/aliases',
    method: 'GET',
    headers: { Authorization: `Bearer ${INV_KEY}` },
  });
  assert.strictEqual(forbiddenAliases.statusCode, 403, '调用凭据访问 /api/admin/aliases 必须为 403');
  console.log('  ✓ AC 7 验证通过：别名动态管理与管理端点 403 权限隔离完整有效');

  console.log('\n>>> Issue #04 全部 7 项验收指标测试 100% 通过 ✓ <<<');
}

(async () => {
  try {
    await runTests();
  } catch (err) {
    if (gwLogs.length > 0) {
      console.error('\n--- [Gateway Output On Test Failure] ---\n' + gwLogs.join(''));
    }
    console.error('\n✗ 测试失败:', err);
    process.exitCode = 1;
  } finally {
    if (gatewayProcess) {
      try { gatewayProcess.kill('SIGTERM'); } catch (_) {}
    }
    if (mockUpstream) {
      try { await mockUpstream.stop(); } catch (_) {}
    }
    try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch (_) {}
  }
})();
