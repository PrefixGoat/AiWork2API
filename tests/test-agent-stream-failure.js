'use strict';
/**
 * 回归测试：智能体模式的失败必须「只报一次、只收一次」。
 *
 * 背景（ADR-0015 §1 / §14）：
 *   - 空闲超时会先 onError，随后子进程 close 又触发 onClose。调用方若在 onClose 里照常
 *     补 finish_reason:'stop' + [DONE]，客户端会把一次失败读成正常结束。
 *   - 修复后 runChat 把「已失败」作为第 6 个参数交给 onClose，两条路径都不再写成功帧。
 *
 * 这里用 HTTP 层端到端验证，而不是只直调 runChat：真正的回归点是调用方的收尾逻辑。
 *
 * 断言：
 *   1) 流式：只出现错误帧，绝不出现 [DONE] / finish_reason:'stop'；
 *   2) 非流式：返回 502 且带可读原因，不返回 200 JSON；
 *   3) 两种响应都不回显 API Key 或 CLI 路径；
 *   4) 仪表盘不计成功，但账本要为这两次「失败且无 usage」各记一次尝试（token 0）。
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const TMP_DIR = path.join(os.tmpdir(), `aiwork-agent-fail-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
fs.mkdirSync(TMP_DIR, { recursive: true });
process.on('exit', () => {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
});

const API_KEY = 'sk-agent-fail-client';
const IDLE_SEC = 5;

async function run() {
  // 假 CLI：auth status 报 active；chat 输出一个 delta 后就一直沉默（触发空闲超时）。
  const cliScript = path.join(TMP_DIR, 'fake-cli.js');
  fs.writeFileSync(cliScript, `
    const argv = process.argv.slice(2);
    if (argv.includes('status') && argv.includes('auth')) {
      process.stdout.write(JSON.stringify({ status: 'active' }) + '\\n');
      process.exit(0);
    }
    if (argv.includes('chat')) {
      process.stdout.write(JSON.stringify({ event: { name: 'stream.text_delta', data: { text: 'partial' } } }) + '\\n');
      setInterval(() => {}, 1000); // 永不结束，也永不产出新数据
      return;
    }
    process.exit(0);
  `);

  const stateDir = path.join(TMP_DIR, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  // 模型解析仍然要过账号池（agent 模式也一样），所以得有一个「就绪」的挂载账号；
  // 这里的 Router Key 不会被真正使用（上游是假 CLI）。
  fs.writeFileSync(path.join(stateDir, '.env'), 'AGENTIX_CONFIG_MODELS_AIWORK_ROUTER_API_KEY=sk-agent-fail-router\n');
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({
    config_protocol_version: '1.1',
    models: { 'aiwork-router': { models: [{ id: 'deepseek-flash', name: 'deepseek-flash' }] } },
  }, null, 2));

  const dataDir = path.join(TMP_DIR, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const port = 20300 + Math.floor(Math.random() * 300);
  let logs = '';
  const gw = cp.fork(path.join(__dirname, '..', 'src', 'api-bridge.js'), [], {
    env: {
      ...process.env,
      PORT: String(port), BIND: '127.0.0.1',
      UPSTREAM: 'agent',
      DTCODER_BIN: process.execPath,
      CLI_DIST_ARGS: cliScript,
      AGENTIX_STATE_DIR: stateDir,
      GATEWAY_DATA_DIR: dataDir,
      STATE_PATH: path.join(dataDir, 'usage-state.json'),
      API_KEYS: `${API_KEY}:agent-fail`,
      ADMIN_PASSWORD: '',
      QUIET: '1', LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  gw.stdout.on('data', (d) => { logs += d; });
  gw.stderr.on('data', (d) => { logs += d; });

  const base = `http://127.0.0.1:${port}`;
  function request(method, urlPath, body = null, headers = {}, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const req = http.request(new URL(urlPath, base), { method, headers, timeout: timeoutMs }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          let j = null;
          try { j = JSON.parse(d); } catch (_) {}
          resolve({ status: res.statusCode, headers: res.headers, json: j, text: d });
        });
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('client timeout')));
      if (body) {
        req.setHeader('Content-Type', 'application/json');
        req.write(typeof body === 'string' ? body : JSON.stringify(body));
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
    const auth = { Authorization: `Bearer ${API_KEY}` };
    const put = await request('PUT', '/api/settings', { stream_idle_timeout_sec: IDLE_SEC }, auth);
    assert.strictEqual(put.status, 200, put.text);

    // ---- 1. 流式：错误帧之后不能再有成功帧 ----
    const streamStart = Date.now();
    const sse = await request('POST', '/v1/chat/completions', {
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    }, auth, 25000);
    const streamElapsed = Date.now() - streamStart;

    assert.strictEqual(sse.status, 200, `SSE 头应在建连时发出，实际 ${sse.status}: ${sse.text.slice(0, 300)}`);
    assert(sse.text.includes('"error"'), `流式失败必须下发错误帧，实际：${sse.text.slice(0, 300)}`);
    assert(sse.text.includes('idle'), `错误帧应说明是空闲超时，实际：${sse.text.slice(0, 300)}`);
    assert(!sse.text.includes('[DONE]'), '失败之后绝不能补 [DONE]（客户端会读成正常结束）');
    assert(!sse.text.includes('"finish_reason":"stop"'), '失败之后绝不能补 finish_reason:stop');
    assert(!sse.text.includes('"tool_calls"'), '失败尝试不应产出工具调用帧');
    assert(streamElapsed >= IDLE_SEC * 1000 - 500, `应在空闲阈值之后才失败，实际 ${streamElapsed}ms`);
    assert(!sse.text.includes(API_KEY), '响应不得回显 API Key');
    assert(!sse.text.includes(cliScript), '响应不得回显 CLI 路径');

    // ---- 2. 非流式：502 + 可读原因，不能是 200 JSON ----
    const plain = await request('POST', '/v1/chat/completions', {
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    }, auth, 25000);
    assert.strictEqual(plain.status, 502, `非流式失败应返回 502，实际 ${plain.status} ${plain.text.slice(0, 200)}`);
    assert(plain.text.includes('idle'), `非流式错误应说明是空闲超时，实际：${plain.text.slice(0, 300)}`);
    assert(!plain.text.includes('[DONE]'), '非流式响应不应出现 [DONE]');
    assert(!plain.text.includes(API_KEY), '响应不得回显 API Key');

    // ---- 3. 失败不应被计成一次成功调用 ----
    const usage = await request('GET', '/api/usage?force=1', null, auth);
    assert.strictEqual(usage.status, 200, usage.text);
    assert.strictEqual(usage.json.requests, 0, `失败尝试不应计入请求数，实际 ${usage.json.requests}`);
    assert.strictEqual(usage.json.tokens.total, 0, '失败且无 usage 时不应凭空记 token');

    // ---- 4. 但账本必须记下这两次尝试（token 0、ok=false），否则失败在历史里凭空消失 ----
    // 账本按「尝试」计，仪表盘按「成功」计（ADR-0017 §8），两条口径刻意不同。
    // 非流式的 502 在 onError 就回了，账本那次尝试要等子进程 close 才记，所以这里轮询等它。
    let buckets = null;
    for (let i = 0; i < 40; i++) {
      const r = await request('GET', '/api/usage/buckets?hours=1', null, auth);
      assert.strictEqual(r.status, 200, r.text);
      if (r.json.requests >= 2) { buckets = r.json; break; }
      await new Promise((res) => setTimeout(res, 100));
    }
    assert(buckets, '两次失败尝试都必须进账本（失败且无 usage 时 token 记 0）');
    assert.strictEqual(buckets.requests, 2, `失败且无 usage 的两次尝试都要进账本，实际 ${buckets.requests}`);
    assert.strictEqual(buckets.errors, 2, '两次都必须是失败');
    assert.strictEqual(buckets.total_tokens, 0, '没有 usage 时不凭空造 token');

    console.log('✓ [All Passed] 智能体模式失败：只报一次错 + 不发 [DONE] + 不计成功');
  } finally {
    gw.kill('SIGTERM');
  }
}

run().catch((err) => {
  console.error('测试失败:', err.message);
  process.exit(1);
});
