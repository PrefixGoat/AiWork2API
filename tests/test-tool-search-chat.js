'use strict';
/**
 * ADR-0021 决定 2 验收测试: 原生 Chat Completions 路径剥 defer_loading 假开关
 *
 * 验证目标:
 * 1. 函数工具定义上的 defer_loading 等非协议字段被剥掉，协议字段（name/parameters 等）完整，
 *    请求 2xx 成功（上游不再收到 defer_loading）；
 * 2. 同一请求重放两次，第二次仍正确、字段无叠加丢失（净化幂等，不破坏 parsed 复用）；
 * 3. 非 function 工具类型（custom_shell）仍本地 400 unsupported_tool_type（AC6 6c 语义不变）；
 * 4. defer_loading 不存在时不打 strip 日志（无日志噪音）。
 */

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const { MockUpstream } = require('./mock-upstream');

const TEST_DIR = path.join(__dirname, '..', '.scratch', 'v1', 'scratch', `test-tool-search-chat-${Date.now()}`);
fs.mkdirSync(TEST_DIR, { recursive: true });

const GATEWAY_PORT = 18103;
const INV_KEY = 'sk-gw-test-inv-key-chat-strip';

let mockUpstream;
let gatewayProcess;
let gwLogs = [];

function requestGateway(bodyObj) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(bodyObj);
    const bodyBuffer = Buffer.from(bodyStr, 'utf8');
    const req = http.request({
      hostname: '127.0.0.1',
      port: GATEWAY_PORT,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${INV_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': bodyBuffer.length,
      },
      timeout: 10000,
    }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try { body = JSON.parse(raw); } catch (_) { body = raw; }
        resolve({ statusCode: res.statusCode, body, raw });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Gateway request timed out')));
    req.write(bodyBuffer);
    req.end();
  });
}

// 日志经管道异步到达，轮询等待目标行出现
async function waitForLog(predicate, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate(gwLogs.join(''))) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return predicate(gwLogs.join(''));
}

async function waitForGatewayReady(timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await new Promise((resolve, reject) => {
        http.get({ hostname: '127.0.0.1', port: GATEWAY_PORT, path: '/healthz', timeout: 1000 }, (res) => {
          const chunks = [];
          res.on('data', (d) => chunks.push(d));
          res.on('end', () => resolve({ statusCode: res.statusCode, raw: Buffer.concat(chunks).toString('utf8') }));
        }).on('error', reject);
      });
      if (res.statusCode === 200 && res.raw.includes('ok')) return true;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Gateway failed to become ready within timeout');
}

const TOOL_WITH_DEFER = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'query weather',
    parameters: { type: 'object', properties: { city: { type: 'string' } } },
    defer_loading: true,
  },
};

// 工具条目 wrapper 顶层携带 defer_loading（Claude Code 对 chat 端点的实际形态）：
// 净化必须整体白名单重建，wrapper 层与 function 层都不能漏。
const TOOL_WITH_TOPLEVEL_DEFER = {
  type: 'function',
  defer_loading: true,
  function: {
    name: 'get_weather',
    description: 'query weather',
    parameters: { type: 'object', properties: { city: { type: 'string' } } },
  },
};

// stream 显式成参（默认 false）：不再把 stream:false 硬编码进夹具，
// 让流式请求可复用同一夹具（第 5 组用 stream:true 覆盖净化）。
function baseBody(extra) {
  const { stream = false, ...rest } = extra || {};
  return {
    model: 'deepseek-flash',
    messages: [{ role: 'user', content: 'hi' }],
    stream,
    ...rest,
  };
}

async function runTests() {
  console.log('--- 开始执行：原生 chat 路径剥 defer_loading 测试 ---');

  mockUpstream = new MockUpstream({ quiet: true });
  const mockUrl = await mockUpstream.start(0);
  console.log(`[Harness] MockUpstream 已在 ${mockUrl} 启动`);

  const accDir = path.join(TEST_DIR, 'acc-state');
  fs.mkdirSync(accDir, { recursive: true });
  fs.writeFileSync(path.join(accDir, '.env'), 'AGENTIX_CONFIG_MODELS_AIWORK_ROUTER_API_KEY=sk-mock-account-token\n');
  fs.writeFileSync(path.join(accDir, 'config.json'), JSON.stringify({
    config_protocol_version: '1.1',
    models: { 'aiwork-router': { models: [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }] } },
  }, null, 2));

  const dataDir = path.join(TEST_DIR, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'api-keys.json'), JSON.stringify({
    keys: [{
      id: 'key-test-chat-strip',
      name: 'Chat Strip Key',
      token: INV_KEY,
      created_at: new Date().toISOString(),
      revoked: false,
      account_policy: { mode: 'all' },
    }],
  }, null, 2));

  gatewayProcess = cp.spawn(process.execPath, [path.join(__dirname, '..', 'src', 'api-bridge.js')], {
    env: {
      ...process.env,
      PORT: String(GATEWAY_PORT),
      BIND: '127.0.0.1',
      GATEWAY_DATA_DIR: dataDir,
      STATE_PATH: path.join(dataDir, 'usage-state.json'),
      UPSTREAM_ACCOUNTS: JSON.stringify([{ id: 'acc1', name: 'AccOne', stateDir: accDir }]),
      ROUTER_BASE_URL: mockUrl,
      API_KEYS: INV_KEY,
      // 日志断言依赖网关 stdout 输出 strip 日志，强制非静默
      QUIET: '0',
      LOG_LEVEL: 'info',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  gatewayProcess.stdout.on('data', (d) => gwLogs.push(d.toString()));
  gatewayProcess.stderr.on('data', (d) => gwLogs.push(d.toString()));

  await waitForGatewayReady();
  console.log(`[Harness] 网关在 127.0.0.1:${GATEWAY_PORT} 就绪`);

  try {
    // =========================================================================
    // 1: defer_loading 被剥掉、协议字段完整、2xx 成功、strip 日志留痕
    // =========================================================================
    console.log('\n[1] defer_loading 剥除与日志留痕...');
    {
      mockUpstream.clear();
      const r1 = await requestGateway(baseBody({ tools: [TOOL_WITH_DEFER] }));
      assert.strictEqual(r1.statusCode, 200, '剥除后请求必须 2xx 成功');

      const recs = mockUpstream.getRecordedRequests('/v1/chat/completions');
      assert.strictEqual(recs.length, 1, 'mock 上游必须恰好收到一次请求');
      const sentFn = recs[0].body.tools[0].function;
      assert.strictEqual(sentFn.defer_loading, undefined, '上游收到的 function.defer_loading 必须不存在');
      assert.strictEqual(sentFn.name, 'get_weather', 'function.name 必须完整保留');
      assert.deepStrictEqual(sentFn.parameters, TOOL_WITH_DEFER.function.parameters, 'function.parameters 必须完整保留');
      assert.strictEqual(recs[0].body.tools[0].type, 'function', '工具条目 type 必须保留');

      const sawStripLog = await waitForLog((s) => s.includes('[chat] stripped non-protocol tool fields'));
      assert.ok(sawStripLog, '剥除发生时必须打 strip 日志留痕');
      console.log('  ✓ defer_loading 被剥除，协议字段完整，2xx 成功，strip 日志留痕');
    }

    // =========================================================================
    // 1b: wrapper 顶层 defer_loading 同样被剥（整条工具白名单重建）
    // =========================================================================
    console.log('\n[1b] wrapper 顶层 defer_loading 剥除...');
    {
      mockUpstream.clear();
      const r1b = await requestGateway(baseBody({ tools: [TOOL_WITH_TOPLEVEL_DEFER] }));
      assert.strictEqual(r1b.statusCode, 200, 'wrapper 顶层剥除后请求必须 2xx 成功');

      const recs = mockUpstream.getRecordedRequests('/v1/chat/completions');
      assert.strictEqual(recs.length, 1, 'mock 上游必须恰好收到一次请求');
      const sentTool = recs[0].body.tools[0];
      assert.strictEqual(sentTool.defer_loading, undefined, '上游收到的条目顶层 defer_loading 必须不存在');
      assert.deepStrictEqual(
        Object.keys(sentTool).sort(),
        ['function', 'type'],
        '工具条目必须整体白名单重建：只剩 type 与 function'
      );
      assert.strictEqual(sentTool.function.name, 'get_weather', 'function.name 必须完整保留');
      assert.deepStrictEqual(
        Object.keys(sentTool.function).sort(),
        ['description', 'name', 'parameters'],
        'function 字段必须恰好是协议内字段'
      );
      console.log('  ✓ wrapper 顶层 defer_loading 被剥除，条目只剩 type + 协议内 function 字段');
    }

    // =========================================================================
    // 2: 同一请求重放两次，第二次仍正确、字段无叠加丢失（幂等）
    // =========================================================================
    console.log('\n[2] 同一请求重放幂等性...');
    {
      const r2 = await requestGateway(baseBody({ tools: [TOOL_WITH_DEFER] }));
      assert.strictEqual(r2.statusCode, 200, '重放请求必须 2xx 成功');

      const recs = mockUpstream.getRecordedRequests('/v1/chat/completions');
      assert.ok(recs.length >= 2, 'mock 上游必须收到第二次请求');
      const sentFn2 = recs[recs.length - 1].body.tools[0].function;
      assert.strictEqual(sentFn2.defer_loading, undefined, '重放时 defer_loading 仍必须被剥掉');
      assert.strictEqual(sentFn2.name, 'get_weather', '重放时 function.name 不得丢失');
      assert.deepStrictEqual(sentFn2.parameters, TOOL_WITH_DEFER.function.parameters, '重放时 function.parameters 不得丢失');
      const keys = Object.keys(sentFn2).sort();
      assert.deepStrictEqual(keys, ['description', 'name', 'parameters'], `重放时 function 字段不得叠加: ${keys.join(',')}`);
      console.log('  ✓ 同一请求重放两次，净化幂等，字段无叠加丢失');
    }

    // =========================================================================
    // 3: custom_shell 仍本地 400 unsupported_tool_type（AC6 6c 语义不变）
    // =========================================================================
    console.log('\n[3] 非 function 工具类型仍 400...');
    {
      const r3 = await requestGateway(baseBody({
        tools: [{ type: 'custom_shell', function: { name: 'sh' } }],
      }));
      assert.strictEqual(r3.statusCode, 400, 'custom_shell 必须仍返回 400');
      assert.strictEqual(r3.body.error.code, 'unsupported_tool_type', '错误码必须为 unsupported_tool_type');
      console.log('  ✓ custom_shell 仍 400 unsupported_tool_type，拦截行为未变');
    }

    // =========================================================================
    // 4: defer_loading 不存在时不打 strip 日志
    // =========================================================================
    console.log('\n[4] 无剥除时无 strip 日志...');
    {
      const countStrips = (s) => (s.match(/stripped non-protocol tool fields/g) || []).length;
      const before = countStrips(gwLogs.join(''));

      const cleanTool = {
        type: 'function',
        function: { name: 'read_file', description: 'read a file', parameters: { type: 'object' } },
      };
      const r4 = await requestGateway(baseBody({ tools: [cleanTool] }));
      assert.strictEqual(r4.statusCode, 200, '干净请求必须 2xx 成功');

      await new Promise((r) => setTimeout(r, 300));
      const after = countStrips(gwLogs.join(''));
      assert.strictEqual(after, before, 'defer_loading 不存在时不得出现 strip 日志');

      const recs = mockUpstream.getRecordedRequests('/v1/chat/completions');
      const sentFn4 = recs[recs.length - 1].body.tools[0].function;
      assert.deepStrictEqual(
        Object.keys(sentFn4).sort(),
        ['description', 'name', 'parameters'],
        '干净工具的 function 字段必须原样保留'
      );
      console.log('  ✓ defer_loading 不存在时无 strip 日志，干净工具字段原样透传');
    }

    // =========================================================================
    // 5: stream:true 时上游收到的 payload 仍被净化（stream:true 覆盖缺口）
    // =========================================================================
    console.log('\n[5] stream:true 时净化仍生效...');
    {
      mockUpstream.clear();
      await requestGateway(baseBody({ stream: true, tools: [TOOL_WITH_DEFER] }));

      const recs = mockUpstream.getRecordedRequests('/v1/chat/completions');
      assert.strictEqual(recs.length, 1, 'mock 上游必须恰好收到一次流式请求');
      const sent = recs[0].body;
      assert.strictEqual(sent.stream, true, '流式标记透传到上游');
      const sentFn = sent.tools[0].function;
      assert.strictEqual(sentFn.defer_loading, undefined, 'stream:true 时 defer_loading 仍被剥除');
      assert.strictEqual(sentFn.name, 'get_weather', 'stream:true 时 function.name 仍完整');
      assert.deepStrictEqual(sentFn.parameters, TOOL_WITH_DEFER.function.parameters,
        'stream:true 时 function.parameters 仍完整');
      console.log('  ✓ stream:true 时 mock 上游收到的 payload 仍被净化');
    }

    console.log('\n>>> 全部用例测试通过 <<<');
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
  console.error('\n❌ 验收测试失败:', err.stack || err.message);
  if (gatewayProcess) {
    try { gatewayProcess.kill('SIGKILL'); } catch (_) {}
  }
  if (mockUpstream) {
    try { mockUpstream.stop(); } catch (_) {}
  }
  process.exit(1);
});
