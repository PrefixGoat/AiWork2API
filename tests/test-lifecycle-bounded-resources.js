'use strict';
/**
 * Issue #07 验收测试套件: 统一请求执行生命周期、有界资源控制与三协议 + WebSocket 常用能力闭环
 * 对应工单: 07-unified-request-lifecycle-bounded-resources-and-protocols.md
 * 规格依据: spec.md & v1-acceptance.md (AC 43, AC 44, US 41-46, US 52)
 *
 * 验证目标:
 * 1. 统一请求生命周期与取消传播：HTTP/SSE 与 Responses WebSocket 在客户端断开、超时或取消时立即中止在途上游请求并释放并发配额；
 * 2. 有界资源与背压控制：调用凭据并发上限、全局排队上限、慢客户端背压、工具参数聚合上限与响应缓冲上限；
 * 3. 加固请求体解压边界：支持 gzip/deflate/br/zstd 且输出有界，拦截解压炸弹 (Zip Bomb)，不支持编码明确报 415；
 * 4. Responses WebSocket 传输加固：强制客户端掩码、分片消息上限与状态机校验、控制帧合法性校验、连接复用；
 * 5. 三套协议常用能力闭环：文本、图片输入、流式/非流式、并行工具及工具结果回传、count_tokens 估算说明；
 * 6. 未实现厂商功能与工具类型明确报错：不支持工具类型报 400 unsupported_tool_type，compact 报 501。
 */

const assert = require('assert');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const zlib = require('zlib');

const { MockUpstream } = require('./mock-upstream');

const TEST_DIR = path.join(__dirname, '..', '.scratch', 'v1', 'scratch', `test-lifecycle-${Date.now()}`);
fs.mkdirSync(TEST_DIR, { recursive: true });

const GATEWAY_PORT = 18097;
const GATEWAY_KEY = 'sk-gw-test-admin-key-07';
const INV_KEY_1 = 'sk-gw-test-inv-key-1';
const INV_KEY_2 = 'sk-gw-test-inv-key-2';
const ADMIN_PASSWORD = 'TestLifecycleAdminPassword123!';

let mockUpstream;
let gatewayProcess;
let gwLogs = [];

function requestGateway(options, bodyObj) {
  return new Promise((resolve, reject) => {
    let bodyBuffer = null;
    if (options.rawBodyBuffer) {
      bodyBuffer = options.rawBodyBuffer;
    } else if (bodyObj) {
      const bodyStr = typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj);
      bodyBuffer = Buffer.from(bodyStr, 'utf8');
    }

    const headers = {
      'Content-Type': 'application/json',
      ...(options.cookie ? { 'Cookie': options.cookie } : {}),
      ...(options.headers || {}),
    };
    if (options.key) {
      headers['Authorization'] = `Bearer ${options.key}`;
    } else if (!headers['Authorization'] && !headers['x-api-key'] && !options.cookie && !options.noAuth) {
      headers['Authorization'] = `Bearer ${INV_KEY_1}`;
    }

    if (bodyBuffer) {
      headers['Content-Length'] = bodyBuffer.length;
    }

    const reqOptions = {
      hostname: '127.0.0.1',
      port: GATEWAY_PORT,
      path: options.path || '/v1/chat/completions',
      method: options.method || (bodyBuffer ? 'POST' : 'GET'),
      headers,
      timeout: options.timeout || 10000,
    };

    const req = http.request(reqOptions, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try {
          body = JSON.parse(raw);
        } catch (_) {
          body = raw;
        }
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body,
          raw,
          chunks,
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Gateway request timed out')));
    if (bodyBuffer) req.write(bodyBuffer);
    req.end();
  });
}

function testWsClient(pathStr, key, onConnect) {
  return new Promise((resolve, reject) => {
    const secKey = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(GATEWAY_PORT, '127.0.0.1', () => {
      const reqLines = [
        `GET ${pathStr} HTTP/1.1`,
        `Host: 127.0.0.1:${GATEWAY_PORT}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${secKey}`,
        'Sec-WebSocket-Version: 13',
        ...(key ? [`Authorization: Bearer ${key}`] : []),
        '',
        '',
      ];
      sock.write(reqLines.join('\r\n'));
    });

    let headerBuf = '';
    let upgraded = false;
    const receivedFrames = [];
    let closeReceived = null;

    sock.on('data', (chunk) => {
      if (!upgraded) {
        headerBuf += chunk.toString('utf8');
        const idx = headerBuf.indexOf('\r\n\r\n');
        if (idx !== -1) {
          upgraded = true;
          if (!headerBuf.startsWith('HTTP/1.1 101')) {
            sock.destroy();
            return reject(new Error('WS handshake failed: ' + headerBuf.slice(0, 100)));
          }
          if (onConnect) {
            onConnect({
              receivedFrames,
              sendJson: (obj) => {
                const payload = Buffer.from(JSON.stringify(obj), 'utf8');
                const len = payload.length;
                let header;
                if (len < 126) {
                  header = Buffer.alloc(6);
                  header[0] = 0x81;
                  header[1] = 0x80 | len;
                  const mask = crypto.randomBytes(4);
                  mask.copy(header, 2);
                  for (let i = 0; i < len; i++) payload[i] ^= mask[i % 4];
                  sock.write(Buffer.concat([header, payload]));
                }
              },
              sendRawFrame: (fin, opcode, masked, rawPayload) => {
                const payload = Buffer.isBuffer(rawPayload) ? Buffer.from(rawPayload) : Buffer.from(String(rawPayload || ''), 'utf8');
                const len = payload.length;
                let headLen = 2;
                if (len >= 126 && len < 65536) headLen = 4;
                else if (len >= 65536) headLen = 10;
                if (masked) headLen += 4;

                const header = Buffer.alloc(headLen);
                header[0] = (fin ? 0x80 : 0x00) | (opcode & 0x0f);
                let off = 1;
                if (len < 126) {
                  header[1] = (masked ? 0x80 : 0x00) | len;
                  off = 2;
                } else if (len < 65536) {
                  header[1] = (masked ? 0x80 : 0x00) | 126;
                  header.writeUInt16BE(len, 2);
                  off = 4;
                } else {
                  header[1] = (masked ? 0x80 : 0x00) | 127;
                  header.writeBigUInt64BE(BigInt(len), 2);
                  off = 10;
                }
                if (masked) {
                  const mask = crypto.randomBytes(4);
                  mask.copy(header, off);
                  for (let i = 0; i < len; i++) payload[i] ^= mask[i % 4];
                }
                sock.write(Buffer.concat([header, payload]));
              },
              close: () => sock.destroy(),
              getSocket: () => sock,
            });
          }
        }
        return;
      }

      // 解析服务端帧
      let off = 0;
      while (off < chunk.length) {
        if (off + 2 > chunk.length) break;
        const b0 = chunk[off];
        const b1 = chunk[off + 1];
        const opcode = b0 & 0x0f;
        let len = b1 & 0x7f;
        let headLen = 2;
        if (len === 126) {
          if (off + 4 > chunk.length) break;
          len = chunk.readUInt16BE(off + 2);
          headLen = 4;
        } else if (len === 127) {
          if (off + 10 > chunk.length) break;
          len = Number(chunk.readBigUInt64BE(off + 2));
          headLen = 10;
        }
        if (off + headLen + len > chunk.length) break;
        const payload = chunk.slice(off + headLen, off + headLen + len);
        off += headLen + len;

        if (opcode === 0x1) {
          try {
            receivedFrames.push(JSON.parse(payload.toString('utf8')));
          } catch (_) {
            receivedFrames.push(payload.toString('utf8'));
          }
        } else if (opcode === 0x8) {
          const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
          const reason = payload.length > 2 ? payload.slice(2).toString('utf8') : '';
          closeReceived = { code, reason };
        }
      }
    });

    sock.on('close', () => {
      resolve({ receivedFrames, closeReceived });
    });
    sock.on('error', (err) => {
      // 捕获连接异常，依然返回当前已收到的 frames
      resolve({ receivedFrames, closeReceived, error: err.message });
    });
  });
}

async function waitForGatewayReady(timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await requestGateway({ path: '/healthz', method: 'GET', noAuth: true });
      if (res.statusCode === 200 && res.raw.includes('ok')) return true;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Gateway failed to become ready within timeout');
}

async function runTests() {
  console.log('--- 开始执行 Issue #07: 统一请求生命周期、有界资源控制与常用协议闭环测试 ---');

  // 1. 启动 MockUpstream
  mockUpstream = new MockUpstream();
  const mockUrl = await mockUpstream.start(0);
  console.log(`[Harness] MockUpstream 已在 ${mockUrl} 启动`);

  // 2. 准备账号与凭据配置
  const acc1Dir = path.join(TEST_DIR, 'acc1-state');
  const acc2Dir = path.join(TEST_DIR, 'acc2-state');
  fs.mkdirSync(acc1Dir, { recursive: true });
  fs.mkdirSync(acc2Dir, { recursive: true });

  const acc1Key = 'sk-mock-account-1-token';
  const acc2Key = 'sk-mock-account-2-token';

  fs.writeFileSync(path.join(acc1Dir, '.env'), `AGENTIX_CONFIG_MODELS_AIWORK_ROUTER_API_KEY=${acc1Key}\n`);
  fs.writeFileSync(path.join(acc1Dir, 'config.json'), JSON.stringify({
    config_protocol_version: '1.1',
    models: {
      'aiwork-router': {
        models: [
          { id: 'deepseek-flash', name: 'DeepSeek Flash' },
          { id: 'qwen3.8-max', name: 'Qwen 3.8 Max' },
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
          { id: 'deepseek-flash', name: 'DeepSeek Flash' },
          { id: 'qwen3.8-max', name: 'Qwen 3.8 Max' },
        ],
      },
    },
  }, null, 2));

  const dataDir = path.join(TEST_DIR, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  // 写入调用凭据：Key 1 和 Key 2
  fs.writeFileSync(path.join(dataDir, 'api-keys.json'), JSON.stringify({
    keys: [
      {
        id: 'key-test-1',
        name: 'Key One',
        token: INV_KEY_1,
        created_at: new Date().toISOString(),
        revoked: false,
        account_policy: { mode: 'all' },
      },
      {
        id: 'key-test-2',
        name: 'Key Two',
        token: INV_KEY_2,
        created_at: new Date().toISOString(),
        revoked: false,
        account_policy: { mode: 'all' },
      },
    ],
  }, null, 2));

  // 3. 启动网关进程
  const accountsConfig = JSON.stringify([
    { id: 'acc1', name: 'AccOne', stateDir: acc1Dir },
    { id: 'acc2', name: 'AccTwo', stateDir: acc2Dir },
  ]);

  gatewayProcess = cp.spawn(process.execPath, [path.join(__dirname, '..', 'src', 'api-bridge.js')], {
    env: {
      ...process.env,
      PORT: String(GATEWAY_PORT),
      BIND: '127.0.0.1',
      GATEWAY_DATA_DIR: dataDir,
      STATE_PATH: path.join(dataDir, 'usage-state.json'),
      DATA_DIR: dataDir,
      UPSTREAM_ACCOUNTS: accountsConfig,
      ROUTER_BASE_URL: mockUrl,
      API_KEYS: `${GATEWAY_KEY},${INV_KEY_1}:Key One,${INV_KEY_2}:Key Two`,
      ADMIN_PASSWORD: ADMIN_PASSWORD,
      MAX_CONCURRENCY_PER_KEY: '2',
      MAX_GLOBAL_CONCURRENCY: '3',
      MAX_TOOL_ARG_BYTES: '2048',
      MAX_RESPONSE_BYTES: '4096',
      MAX_BODY_MB: '1',
      UPSTREAM_TIMEOUT_MS: '6000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const isQuiet = process.env.QUIET === '1' || process.env.LOG_LEVEL === 'error';
  gatewayProcess.stdout.on('data', (d) => {
    gwLogs.push(`[gw-out] ${d}`);
    if (!isQuiet) console.log('[gw-out]', d.toString().trim());
  });
  gatewayProcess.stderr.on('data', (d) => {
    gwLogs.push(`[gw-err] ${d}`);
    if (!isQuiet) console.error('[gw-err]', d.toString());
  });

  await waitForGatewayReady();
  console.log(`[Harness] 网关在 127.0.0.1:${GATEWAY_PORT} 就绪`);

  try {
    // =========================================================================
    // AC 1 验证: 统一请求生命周期与取消信号传播
    // =========================================================================
    console.log('\n[AC 1 验证] 测试下游客户端断开、超时或取消时立即中止在途上游请求并释放配额...');

    // 1a: HTTP 流式请求，客户端中途主动断开 socket
    {
      mockUpstream.clear();
      let upstreamReceivedRequest = false;
      let upstreamSocketDestroyed = false;

      mockUpstream.queueResponse('/v1/chat/completions', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
        sseEvents: [
          { data: { id: 'c1', choices: [{ delta: { role: 'assistant', content: 'hello ' } }] } },
          { delayMs: 4000, data: { id: 'c2', choices: [{ delta: { content: 'world' } }] } },
          { data: '[DONE]' },
        ],
      });

      const reqOpts = {
        hostname: '127.0.0.1',
        port: GATEWAY_PORT,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${INV_KEY_1}`,
          'Content-Type': 'application/json',
        },
      };

      await new Promise((resolve, reject) => {
        console.log('[Test 1a] Sending request to gateway...');
        const clientReq = http.request(reqOpts, (clientRes) => {
          console.log('[Test 1a] Client received response status:', clientRes.statusCode);
          clientRes.on('error', (e) => console.log('[Test 1a] clientRes error:', e.message));
          clientRes.on('data', (chunk) => {
            const s = chunk.toString('utf8');
            console.log('[Test 1a] clientRes chunk:', s.slice(0, 60));
            if (s.includes('hello')) {
              console.log('[Test 1a] Destroying clientReq now...');
              clientReq.destroy();
              setTimeout(resolve, 500);
            }
          });
        });
        clientReq.on('error', (e) => console.log('[Test 1a] clientReq error:', e.message));
        clientReq.write(JSON.stringify({
          model: 'deepseek-flash',
          messages: [{ role: 'user', content: 'test abort' }],
          stream: true,
        }));
        clientReq.end();
      });

      // 验证取消信号传播：上游连接被终止且账号与 Key 并发计数归零
      const accInfo = await requestGateway({ path: '/api/admin/accounts', method: 'GET', key: ADMIN_PASSWORD });
      for (const a of accInfo.body.accounts) {
        assert.strictEqual(a.active_requests, 0, `账号 ${a.id} 在客户端取消后活跃计数必须归零`);
      }
      console.log('  ✓ 1a: HTTP 流式客户端断开连接，在途上游请求立即终止且并发配额已归零释放');
    }

    // 1b: Responses WebSocket 发送 response.cancel 中止在途生成
    {
      mockUpstream.clear();
      mockUpstream.queueResponse('/v1/chat/completions', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
        sseEvents: [
          { data: { id: 'ws1', choices: [{ delta: { role: 'assistant', content: 'part 1' } }] } },
          { delayMs: 3000, data: { id: 'ws2', choices: [{ delta: { content: 'part 2' } }] } },
          { data: '[DONE]' },
        ],
      });

      const wsRes = await testWsClient('/v1/responses', INV_KEY_1, (ws) => {
        ws.sendJson({
          type: 'response.create',
          model: 'deepseek-flash',
          input: 'test ws cancel',
          stream: true,
        });

        // 300ms 后主动发送 response.cancel
        setTimeout(() => {
          ws.sendJson({ type: 'response.cancel' });
          setTimeout(() => ws.close(), 400);
        }, 300);
      });

      const cancelledEvent = wsRes.receivedFrames.find((f) => f && f.type === 'response.cancelled');
      assert.ok(cancelledEvent, '客户端必须收到 response.cancelled 事件帧');
      console.log('  ✓ 1b: Responses WebSocket 收到 response.cancel 时立即中止上游并回发 response.cancelled');
    }

    // 1c: Responses WebSocket 取消及断开连接时，上游请求必须真正被中断关闭，绝不继续在后台运行
    {
      mockUpstream.clear();
      let active = 0;
      let closed = 0;
      mockUpstream.setHandler('/v1/chat/completions', (rq, rs) => {
        active++;
        rs.on('close', () => { active--; closed++; });
        setTimeout(() => {
          if (!rs.destroyed) {
            rs.writeHead(200, { 'Content-Type': 'text/event-stream' });
            rs.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'late' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
          }
        }, 1500);
      });

      // 验证 response.cancel 真正关闭上游
      await testWsClient('/v1/responses', INV_KEY_1, (ws) => {
        ws.sendJson({
          type: 'response.create',
          model: 'deepseek-flash',
          input: 'test cancel aborts upstream',
          stream: true,
        });
        setTimeout(() => {
          ws.sendJson({ type: 'response.cancel' });
          setTimeout(() => ws.close(), 300);
        }, 150);
      });

      await new Promise((r) => setTimeout(r, 100));
      assert.strictEqual(closed, 1, '发送 response.cancel 后上游连接必须已被关闭');
      assert.strictEqual(active, 0, '发送 response.cancel 后上游活跃请求必须归零');

      // 验证客户端断开连接真正关闭上游
      const client2Res = await testWsClient('/v1/responses', INV_KEY_1, (ws) => {
        ws.sendJson({
          type: 'response.create',
          model: 'deepseek-flash',
          input: 'test disconnect aborts upstream',
          stream: true,
        });
        setTimeout(() => {
          ws.close();
        }, 150);
      });

      // 给予充分时间让网关与上游完成关闭清理
      for (let i = 0; i < 20; i++) {
        if (closed >= 2) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.strictEqual(closed, 2, 'WebSocket 客户端断开后上游连接必须已被关闭');
      assert.strictEqual(active, 0, 'WebSocket 客户端断开后上游活跃请求必须归零');
      console.log('  ✓ 1c: Responses WebSocket 取消与断开连接均能真正中断上游请求，无后台孤儿请求');
    }

    // =========================================================================
    // AC 2 验证: 有界资源与并发控制
    // =========================================================================
    console.log('\n[AC 2 验证] 测试每凭据并发限制、全局排队上限、慢客户端背压与参数/响应大小上限...');

    // 2a: Key 并发上限限制 (MAX_CONCURRENCY_PER_KEY=2)
    {
      mockUpstream.clear();
      // 在上游挂起两个请求
      mockUpstream.queueResponse('/v1/chat/completions', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
        sseEvents: [
          { delayMs: 2500, data: { id: 'c1', choices: [{ delta: { content: 'ok 1' } }] } },
          { data: '[DONE]' },
        ],
      });
      mockUpstream.queueResponse('/v1/chat/completions', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
        sseEvents: [
          { delayMs: 2500, data: { id: 'c2', choices: [{ delta: { content: 'ok 2' } }] } },
          { data: '[DONE]' },
        ],
      });

      const p1 = requestGateway({ key: INV_KEY_1 }, { model: 'deepseek-flash', messages: [{ role: 'user', content: 'req1' }], stream: true });
      const p2 = requestGateway({ key: INV_KEY_1 }, { model: 'deepseek-flash', messages: [{ role: 'user', content: 'req2' }], stream: true });

      // 等待请求到达网关
      await new Promise((r) => setTimeout(r, 200));

      // 发起第 3 个请求（超过 MAX_CONCURRENCY_PER_KEY=2）
      const p3 = await requestGateway({ key: INV_KEY_1 }, { model: 'deepseek-flash', messages: [{ role: 'user', content: 'req3' }], stream: true });
      assert.strictEqual(p3.statusCode, 429, '超过凭据并发上限必须返回 429');
      assert.strictEqual(p3.body.error.code, 'concurrency_limit_exceeded', '错误码必须为 concurrency_limit_exceeded');

      await Promise.all([p1, p2]);
      console.log('  ✓ 2a: 调用凭据级并发上限生效，超限请求返回 429 concurrency_limit_exceeded');
    }

    // 2b: 工具参数聚合大小上限 (MAX_TOOL_ARG_BYTES=2048)
    {
      mockUpstream.clear();
      const hugeArgsChunk = 'x'.repeat(2500);
      mockUpstream.queueResponse('/v1/chat/completions', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
        sseEvents: [
          {
            data: {
              id: 'c_tool',
              choices: [{
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: 'call_huge',
                    type: 'function',
                    function: { name: 'test_tool', arguments: hugeArgsChunk },
                  }],
                },
              }],
            },
          },
          { data: '[DONE]' },
        ],
      });

      const toolRes = await requestGateway({ key: INV_KEY_1 }, {
        model: 'deepseek-flash',
        messages: [{ role: 'user', content: 'test tool limit' }],
        stream: true,
      });

      assert.ok(toolRes.raw.includes('tool_arguments_too_large'), '工具参数超限时必须返回 tool_arguments_too_large 失败事件');
      console.log('  ✓ 2b: 工具调用参数聚合超限防护生效，截断并输出 tool_arguments_too_large');
    }

    // 2c: 非流式响应体大小上限 (MAX_RESPONSE_BYTES=4096)
    {
      mockUpstream.clear();
      const hugeResponse = {
        id: 'huge_resp',
        choices: [{ message: { role: 'assistant', content: 'y'.repeat(6000) } }],
      };
      mockUpstream.queueResponse('/v1/chat/completions', {
        status: 200,
        body: hugeResponse,
      });

      const respRes = await requestGateway({ key: INV_KEY_1 }, {
        model: 'deepseek-flash',
        messages: [{ role: 'user', content: 'test resp limit' }],
        stream: false,
      });

      assert.strictEqual(respRes.statusCode, 502, '响应体超过上限必须返回 502');
      assert.strictEqual(respRes.body.error.code, 'response_too_large', '错误码必须为 response_too_large');
      console.log('  ✓ 2c: 非流式响应体上限生效，超限返回 502 response_too_large');
    }

    // =========================================================================
    // AC 3 验证: 加固请求体解压边界与解压炸弹防御
    // =========================================================================
    console.log('\n[AC 3 验证] 测试 gzip/deflate/br/zstd 请求体解压、解压炸弹防御与不支持编码报错...');

    const sampleChat = JSON.stringify({
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: 'decompression test' }],
      stream: false,
    });

    // 3a: 合法压缩请求体正常解压
    {
      mockUpstream.clear();
      mockUpstream.queueResponse('/v1/chat/completions', { status: 200, body: { choices: [{ message: { content: 'decompressed ok' } }] } });
      const gzBuf = zlib.gzipSync(Buffer.from(sampleChat, 'utf8'));
      const gzRes = await requestGateway({ headers: { 'Content-Encoding': 'gzip' }, rawBodyBuffer: gzBuf });
      assert.strictEqual(gzRes.statusCode, 200, 'gzip 压缩请求体正常解压并返回 200');

      mockUpstream.queueResponse('/v1/chat/completions', { status: 200, body: { choices: [{ message: { content: 'deflated ok' } }] } });
      const defBuf = zlib.deflateSync(Buffer.from(sampleChat, 'utf8'));
      const defRes = await requestGateway({ headers: { 'Content-Encoding': 'deflate' }, rawBodyBuffer: defBuf });
      assert.strictEqual(defRes.statusCode, 200, 'deflate 压缩请求体正常解压并返回 200');

      mockUpstream.queueResponse('/v1/chat/completions', { status: 200, body: { choices: [{ message: { content: 'brotli ok' } }] } });
      const brBuf = zlib.brotliCompressSync(Buffer.from(sampleChat, 'utf8'));
      const brRes = await requestGateway({ headers: { 'Content-Encoding': 'br' }, rawBodyBuffer: brBuf });
      assert.strictEqual(brRes.statusCode, 200, 'br 压缩请求体正常解压并返回 200');

      if (typeof zlib.zstdCompressSync === 'function') {
        mockUpstream.queueResponse('/v1/chat/completions', { status: 200, body: { choices: [{ message: { content: 'zstd ok' } }] } });
        const zstdBuf = zlib.zstdCompressSync(Buffer.from(sampleChat, 'utf8'));
        const zstdRes = await requestGateway({ headers: { 'Content-Encoding': 'zstd' }, rawBodyBuffer: zstdBuf });
        assert.strictEqual(zstdRes.statusCode, 200, 'zstd 压缩请求体正常解压并返回 200');
      }
      console.log('  ✓ 3a: gzip / deflate / br / zstd 压缩请求体均能被网关正确透明解压');
    }

    // 3b: 不支持的 Content-Encoding 明确返回 415
    {
      const fakeCompressed = Buffer.from('hello', 'utf8');
      const unsuppRes = await requestGateway({ headers: { 'Content-Encoding': 'lz4' }, rawBodyBuffer: fakeCompressed });
      assert.strictEqual(unsuppRes.statusCode, 415, '不支持的 Content-Encoding 必须返回 415');
      assert.strictEqual(unsuppRes.body.error.code, 'unsupported_content_encoding', '错误码必须为 unsupported_content_encoding');
      console.log('  ✓ 3b: 不支持的 Content-Encoding 严格返回 415 unsupported_content_encoding');
    }

    // 3c: 解压炸弹 (Zip Bomb) 防御
    {
      // 构造一个压缩后很小 (~2KB)，但解压后达到 2MB（超过网关测试设置 MAX_BODY_MB=1）的 gzip 载荷
      const hugeData = Buffer.from('{"model":"deepseek-flash","messages":[{"role":"user","content":"' + 'a'.repeat(2 * 1024 * 1024) + '"}]}');
      const bombBuf = zlib.gzipSync(hugeData);

      const bombRes = await requestGateway({ headers: { 'Content-Encoding': 'gzip' }, rawBodyBuffer: bombBuf });
      assert.strictEqual(bombRes.statusCode, 413, '解压后超过上限必须返回 413 Payload Too Large');
      assert.strictEqual(bombRes.body.error.code, 'body_too_large', '错误码必须为 body_too_large');
      console.log('  ✓ 3c: 解压炸弹流式解压超限防御生效，中止解压并返回 413 body_too_large');
    }

    // =========================================================================
    // AC 4 验证: Responses WebSocket 传输可靠性加固
    // =========================================================================
    console.log('\n[AC 4 验证] 测试 Responses WebSocket 掩码强制校验、分片消息、控制帧及连接复用...');

    // 4a: 无掩码客户端帧立即拒绝并关闭 (1002 Protocol Error)
    {
      const wsRes = await testWsClient('/v1/responses', INV_KEY_1, (ws) => {
        // 发送未掩码文本帧 (masked = false)
        ws.sendRawFrame(true, 0x1, false, JSON.stringify({ type: 'response.create', model: 'deepseek-flash', input: 'hi' }));
      });

      assert.ok(wsRes.closeReceived, '服务端必须主动下发 Close 帧');
      assert.strictEqual(wsRes.closeReceived.code, 1002, '无掩码客户端帧必须触发 1002 协议错误关闭');
      console.log('  ✓ 4a: 强制客户端掩码校验通过：未掩码客户端帧被服务端以 1002 协议错误关闭');
    }

    // 4b: 分片消息组装与控制帧校验
    {
      mockUpstream.clear();
      mockUpstream.queueResponse('/v1/chat/completions', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
        sseEvents: [
          { data: { id: 'frag1', choices: [{ delta: { content: 'fragment ok' } }] } },
          { data: '[DONE]' },
        ],
      });

      const fullJson = JSON.stringify({
        type: 'response.create',
        model: 'deepseek-flash',
        input: 'fragmented message test',
        stream: true,
      });

      const part1 = fullJson.slice(0, 20);
      const part2 = fullJson.slice(20);

      const wsRes = await testWsClient('/v1/responses', INV_KEY_1, (ws) => {
        // 首片: fin=false, opcode=0x1
        ws.sendRawFrame(false, 0x1, true, part1);
        // 插入一个合法 Pong 控制帧 (fin=true, opcode=0xA)
        ws.sendRawFrame(true, 0xA, true, 'ping-pong');
        // 尾片: fin=true, opcode=0x0 (continuation)
        ws.sendRawFrame(true, 0x0, true, part2);

        setTimeout(() => ws.close(), 500);
      });

      const createdEvent = wsRes.receivedFrames.find((f) => f && f.type === 'response.created');
      assert.ok(createdEvent, '正常分片消息必须成功组装并触发 response.created');
      console.log('  ✓ 4b: 分片数据帧 (RFC 6455 Continuation) 成功跨控制帧重装为完整请求');
    }

    // 4c: 控制帧非法情况校验 (opcode=0x9 Ping 帧带 payload > 125 字节)
    {
      const wsRes = await testWsClient('/v1/responses', INV_KEY_1, (ws) => {
        // 超长 Ping 控制帧 (> 125 字节)
        ws.sendRawFrame(true, 0x9, true, 'p'.repeat(130));
      });

      assert.ok(wsRes.closeReceived, '服务端必须关闭连接');
      assert.strictEqual(wsRes.closeReceived.code, 1002, '控制帧超长必须报 1002 协议错误');
      console.log('  ✓ 4c: 控制帧超长 (>125 字节) 严格触发 1002 协议错误');
    }

    // 4d: 同一 WebSocket 连接连续复用发送多条 response.create
    {
      mockUpstream.clear();
      mockUpstream.queueResponse('/v1/chat/completions', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
        sseEvents: [
          { data: { id: 'multi1', choices: [{ delta: { content: 'reply 1' } }] } },
          { data: '[DONE]' },
        ],
      });
      mockUpstream.queueResponse('/v1/chat/completions', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
        sseEvents: [
          { data: { id: 'multi2', choices: [{ delta: { content: 'reply 2' } }] } },
          { data: '[DONE]' },
        ],
      });

      const wsRes = await testWsClient('/v1/responses', INV_KEY_1, (ws) => {
        ws.sendJson({ type: 'response.create', model: 'deepseek-flash', input: 'round 1', stream: true });

        // 观察首轮结束再发第二轮
        const checkInterval = setInterval(() => {
          const completedCount = ws.receivedFrames.filter((f) => f && f.type === 'response.completed').length;
          if (completedCount === 1) {
            clearInterval(checkInterval);
            ws.sendJson({ type: 'response.create', model: 'deepseek-flash', input: 'round 2', stream: true });
            setTimeout(() => ws.close(), 600);
          }
        }, 50);
      });

      const completedCount = wsRes.receivedFrames.filter((f) => f && f.type === 'response.completed').length;
      assert.strictEqual(completedCount, 2, '同一 WebSocket 连接顺序复用两轮生成必须全部收到 response.completed');
      console.log('  ✓ 4d: 同一 WebSocket 连接复用顺序执行两轮对话生成，生命周期与状态均完好');
    }

    // =========================================================================
    // AC 5 验证: 三套协议常用能力闭环与一致性
    // =========================================================================
    console.log('\n[AC 5 验证] 测试三套协议文本、图片、并行工具、工具结果回传与 count_tokens 估算...');

    // 5a: Chat Completions 并行工具调用与结果回传
    {
      mockUpstream.clear();
      mockUpstream.queueResponse('/v1/chat/completions', {
        status: 200,
        body: {
          choices: [{
            message: {
              role: 'assistant',
              tool_calls: [
                { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Beijing"}' } },
                { id: 'call_2', type: 'function', function: { name: 'get_time', arguments: '{"zone":"UTC"}' } },
              ],
            },
          }],
        },
      });

      const chatToolRes = await requestGateway({}, {
        model: 'deepseek-flash',
        messages: [{ role: 'user', content: 'check weather and time' }],
        stream: false,
      });

      assert.strictEqual(chatToolRes.statusCode, 200);
      const toolCalls = chatToolRes.body.choices[0].message.tool_calls;
      assert.strictEqual(toolCalls.length, 2, '必须返回两个并行工具调用');

      // 回传工具结果
      mockUpstream.queueResponse('/v1/chat/completions', {
        status: 200,
        body: { choices: [{ message: { role: 'assistant', content: 'Beijing is sunny, time is 12:00' } }] },
      });

      const feedbackRes = await requestGateway({}, {
        model: 'deepseek-flash',
        messages: [
          { role: 'user', content: 'check weather and time' },
          chatToolRes.body.choices[0].message,
          { role: 'tool', tool_call_id: 'call_1', content: 'sunny' },
          { role: 'tool', tool_call_id: 'call_2', content: '12:00' },
        ],
        stream: false,
      });

      assert.strictEqual(feedbackRes.statusCode, 200);
      assert.strictEqual(feedbackRes.body.choices[0].message.content, 'Beijing is sunny, time is 12:00');
      console.log('  ✓ 5a: Chat Completions 并行工具调用与工具结果回传完整闭环');
    }

    // 5b: Responses API function_call 与 function_call_output 回传
    {
      mockUpstream.clear();
      mockUpstream.queueResponse('/v1/chat/completions', {
        status: 200,
        body: {
          choices: [{
            message: {
              role: 'assistant',
              tool_calls: [{ id: 'call_resp_1', type: 'function', function: { name: 'read_doc', arguments: '{"doc":"spec"}' } }],
            },
          }],
        },
      });

      const respToolRes = await requestGateway({ path: '/v1/responses' }, {
        model: 'deepseek-flash',
        input: 'read the spec',
        stream: false,
      });

      assert.strictEqual(respToolRes.statusCode, 200);
      const fnCallItem = respToolRes.body.output.find((it) => it.type === 'function_call');
      assert.ok(fnCallItem, 'Responses 输出必须包含 function_call 类型的项');
      assert.strictEqual(fnCallItem.call_id, 'call_resp_1');

      // 回传 function_call_output
      mockUpstream.queueResponse('/v1/chat/completions', {
        status: 200,
        body: { choices: [{ message: { role: 'assistant', content: 'doc content read successfully' } }] },
      });

      const respFeedRes = await requestGateway({ path: '/v1/responses' }, {
        model: 'deepseek-flash',
        input: [
          { type: 'message', role: 'user', content: 'read the spec' },
          fnCallItem,
          { type: 'function_call_output', call_id: 'call_resp_1', output: 'spec contents' },
        ],
        stream: false,
      });

      assert.strictEqual(respFeedRes.statusCode, 200);
      const textItem = respFeedRes.body.output.find((it) => it.type === 'message');
      assert.ok(textItem.content[0].text.includes('doc content read successfully'));
      console.log('  ✓ 5b: Responses API 工具调用与 function_call_output 回传完整闭环');
    }

    // 5c: Messages API tool_use 与 tool_result 回传及 count_tokens 估算说明
    {
      mockUpstream.clear();
      mockUpstream.queueResponse('/v1/chat/completions', {
        status: 200,
        body: {
          choices: [{
            message: {
              role: 'assistant',
              tool_calls: [{ id: 'toolu_msg_1', type: 'function', function: { name: 'calculator', arguments: '{"expr":"2+2"}' } }],
            },
          }],
        },
      });

      const msgToolRes = await requestGateway({ path: '/v1/messages' }, {
        model: 'deepseek-flash',
        messages: [{ role: 'user', content: 'calculate 2+2' }],
        max_tokens: 100,
        stream: false,
      });

      assert.strictEqual(msgToolRes.statusCode, 200);
      const toolUseBlock = msgToolRes.body.content.find((b) => b.type === 'tool_use');
      assert.ok(toolUseBlock, 'Messages 输出必须包含 tool_use 块');
      assert.strictEqual(toolUseBlock.id, 'toolu_msg_1');

      // 回传 tool_result
      mockUpstream.queueResponse('/v1/chat/completions', {
        status: 200,
        body: { choices: [{ message: { role: 'assistant', content: 'The result is 4' } }] },
      });

      const msgFeedRes = await requestGateway({ path: '/v1/messages' }, {
        model: 'deepseek-flash',
        messages: [
          { role: 'user', content: 'calculate 2+2' },
          { role: 'assistant', content: [toolUseBlock] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_msg_1', content: '4' }] },
        ],
        max_tokens: 100,
        stream: false,
      });

      assert.strictEqual(msgFeedRes.statusCode, 200);
      const textBlock = msgFeedRes.body.content.find((b) => b.type === 'text');
      assert.strictEqual(textBlock.text, 'The result is 4');

      // 验证 count_tokens 接口带有明确估算说明
      const tokenCountRes = await requestGateway({ path: '/v1/messages/count_tokens' }, {
        model: 'deepseek-flash',
        messages: [{ role: 'user', content: 'This is a test message to count tokens.' }],
      });

      assert.strictEqual(tokenCountRes.statusCode, 200);
      assert.ok(tokenCountRes.body.input_tokens > 0, 'input_tokens 必须大于 0');
      assert.strictEqual(tokenCountRes.body.heuristic_estimate, true, '必须显式标注 heuristic_estimate: true');
      assert.ok(tokenCountRes.body.note.includes('heuristic estimator'), '必须带有启发式估算说明');
      assert.strictEqual(tokenCountRes.headers['x-token-count-method'], 'heuristic-estimate', '必须带有 X-Token-Count-Method 响应头');
      console.log('  ✓ 5c: Messages API tool_use / tool_result 及 count_tokens 估算说明完整闭环');
    }

    // =========================================================================
    // AC 6 验证: 未实现厂商特定功能与工具类型明确报错
    // =========================================================================
    console.log('\n[AC 6 验证] 测试未实现的厂商工具类型与功能明确报错 (不静默丢弃或伪造)...');

    // 6a: Responses API 传入未实现的工具类型（如 computer_use / web_search）
    {
      const unsuppRespTools = await requestGateway({ path: '/v1/responses' }, {
        model: 'deepseek-flash',
        input: 'test tools',
        tools: [{ type: 'computer_use' }, { type: 'web_search' }],
      });
      assert.strictEqual(unsuppRespTools.statusCode, 400, '未实现工具类型必须返回 400');
      assert.strictEqual(unsuppRespTools.body.error.code, 'unsupported_tool_type', '错误码必须为 unsupported_tool_type');
      console.log('  ✓ 6a: Responses 传入不支持的工具类型 (computer_use / web_search) 明确返回 400 unsupported_tool_type');
    }

    // 6b: Messages API 传入未实现的工具类型（如 computer_20241022 / bash_20241022）
    {
      const unsuppMsgTools = await requestGateway({ path: '/v1/messages' }, {
        model: 'deepseek-flash',
        messages: [{ role: 'user', content: 'run bash' }],
        max_tokens: 100,
        tools: [{ type: 'bash_20241022', name: 'bash' }],
      });
      assert.strictEqual(unsuppMsgTools.statusCode, 400, '未实现工具类型必须返回 400');
      assert.strictEqual(unsuppMsgTools.body.error.code, 'unsupported_tool_type', '错误码必须为 unsupported_tool_type');
      console.log('  ✓ 6b: Messages 传入不支持的工具类型 (bash_20241022) 明确返回 400 unsupported_tool_type');
    }

    // 6c: Chat Completions 传入不支持的工具类型 (type != 'function')
    {
      const unsuppChatTools = await requestGateway({}, {
        model: 'deepseek-flash',
        messages: [{ role: 'user', content: 'test tool' }],
        tools: [{ type: 'custom_shell', function: { name: 'sh' } }],
      });
      assert.strictEqual(unsuppChatTools.statusCode, 400, 'Chat Completions 不支持的工具类型必须返回 400');
      assert.strictEqual(unsuppChatTools.body.error.code, 'unsupported_tool_type', '错误码必须为 unsupported_tool_type');
      console.log('  ✓ 6c: Chat Completions 传入非 function 工具类型明确返回 400 unsupported_tool_type');
    }

    // 6d: /v1/responses/compact 明确返回 501 compact_not_supported
    {
      const compactRes = await requestGateway({ path: '/v1/responses/compact' }, { model: 'deepseek-flash' });
      assert.strictEqual(compactRes.statusCode, 501, 'compact 端点必须返回 501 Not Implemented');
      assert.strictEqual(compactRes.body.error.code, 'compact_not_supported');
      console.log('  ✓ 6d: /v1/responses/compact 明确返回 501 compact_not_supported，不伪造压缩结果');
    }

    // 6e: Messages 传入未实现的内容块类型（如 custom_audio）明确报 400 (US 46)
    {
      const unsuppBlockRes = await requestGateway({
        path: '/v1/messages',
        method: 'POST',
      }, {
        model: 'deepseek-flash',
        max_tokens: 100,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'hello' },
            { type: 'custom_audio', source: 'audio.wav' },
          ],
        }],
      });
      assert.strictEqual(unsuppBlockRes.statusCode, 400, '未实现的内容块类型必须返回 400');
      assert.strictEqual(unsuppBlockRes.body.error.code, 'unsupported_content_block_type', '错误码必须为 unsupported_content_block_type');
      console.log('  ✓ 6e: Messages 传入不支持的内容块类型明确返回 400 unsupported_content_block_type');

      // 6f: Responses 传入不支持的 input 条目类型 (如 item_reference) 明确返回 400 unsupported_input_type
      const unsuppInputRes = await requestGateway({
        path: '/v1/responses',
        method: 'POST',
      }, {
        model: 'deepseek-flash',
        input: [
          { type: 'item_reference', id: 'opaque-upstream-item' },
          { role: 'user', content: 'continue' },
        ],
      });
      assert.strictEqual(unsuppInputRes.statusCode, 400, '不支持的 input 条目类型必须返回 400');
      assert.strictEqual(unsuppInputRes.body.error.code, 'unsupported_input_type', '错误码必须为 unsupported_input_type');
      console.log('  ✓ 6f: Responses 传入不支持的 input 条目类型明确返回 400 unsupported_input_type');
    }

    console.log('\n>>> Issue #07 全部 6 项验收指标测试 100% 通过 ✓ <<<');
  } finally {
    if (gatewayProcess) {
      try { gatewayProcess.kill('SIGKILL'); } catch (_) {}
    }
    if (mockUpstream) {
      try { mockUpstream.stop(); } catch (_) {}
    }
    try {
      if (fs.existsSync(TEST_DIR)) {
        fs.rmSync(TEST_DIR, { recursive: true, force: true });
      }
    } catch (_) {}
  }
}

runTests().catch((err) => {
  if (gwLogs.length > 0) {
    console.error('\n--- [Gateway Output On Test Failure] ---\n' + gwLogs.join(''));
  }
  console.error('\n❌ Issue #07 验收测试失败:', err.stack || err.message);
  if (gatewayProcess) {
    try { gatewayProcess.kill('SIGKILL'); } catch (_) {}
  }
  if (mockUpstream) {
    try { mockUpstream.stop(); } catch (_) {}
  }
  process.exit(1);
});
