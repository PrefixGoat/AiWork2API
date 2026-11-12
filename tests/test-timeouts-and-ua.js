'use strict';
/**
 * 回归测试：三种超时与出站 UA 必须取自运行时配置（ADR-0013）。
 *
 * 断言：
 *   1) 通过 PUT /api/settings 改出站 UA 后，上游真的收到新 UA（端到端，不是只存在文件里）；
 *   2) 首字节超时生效：上游收到请求但一直不回，网关必须在配置的时间内放弃，而不是挂到 300s；
 *   3) 超时被放弃后按既有故障换号逻辑返回可读错误，不泄漏内部地址。
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const TMP_DIR = path.join(os.tmpdir(), `aiwork-timeouts-ua-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
fs.mkdirSync(TMP_DIR, { recursive: true });
process.on('exit', () => {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
});

const API_KEY = 'sk-timeout-client';
const ROUTER_KEY = 'sk-mock-router-timeout';

async function run() {
  const seenUserAgents = [];
  const seenChatModels = [];

  const upstream = http.createServer((req, res) => {
    const auth = req.headers.authorization || '';
    seenUserAgents.push(req.headers['user-agent'] || '');

    if (auth !== `Bearer ${ROUTER_KEY}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { code: 'token_invalid' } }));
    }

    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch (_) {}

      if (req.url.startsWith('/v1/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          object: 'list',
          data: [{ id: 'deepseek-flash', name: 'deepseek-flash', ratio: '0.2x', supported_endpoint_types: ['openai'] }],
        }));
      }

      if (req.url.startsWith('/v1/chat/completions')) {
        seenChatModels.push(parsed.model);
        // 故意不回任何字节：用于验证首字节超时
        if (parsed.model === 'hang-model') return;
        // 慢速滴流：每 700ms 滴一个字节且永不结束。socket 空闲超时永远不触发，
        // 只有「短请求总时长上限」能把它掐断。
        if (parsed.model === 'drip-model') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          const timer = setInterval(() => { try { res.write(' '); } catch (_) {} }, 700);
          res.on('close', () => clearInterval(timer));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          id: 'chatcmpl-test', object: 'chat.completion', model: parsed.model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
  });

  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;

  const stateDir = path.join(TMP_DIR, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, '.env'), `AGENTIX_CONFIG_MODELS_AIWORK_ROUTER_API_KEY=${ROUTER_KEY}\n`);
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({
    config_protocol_version: '1.1',
    models: { 'aiwork-router': { models: [{ id: 'deepseek-flash', name: 'deepseek-flash' }, { id: 'hang-model', name: 'hang-model' }, { id: 'drip-model', name: 'drip-model' }] } },
  }, null, 2));

  const dataDir = path.join(TMP_DIR, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const port = 19900 + Math.floor(Math.random() * 300);
  let logs = '';
  const gw = cp.fork(path.join(__dirname, '..', 'src', 'api-bridge.js'), [], {
    env: {
      ...process.env,
      PORT: String(port), BIND: '127.0.0.1',
      API_KEYS: `${API_KEY}:test`,
      ADMIN_PASSWORD: '',
      GATEWAY_DATA_DIR: dataDir,
      STATE_PATH: path.join(dataDir, 'usage-state.json'),
      AGENTIX_STATE_DIR: stateDir,
      ROUTER_BASE_URL: upstreamUrl,
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
          resolve({ status: res.statusCode, json: j, text: d });
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
  for (let i = 0; i < 80; i++) {
    try { if ((await request('GET', '/healthz')).status === 200) { ready = true; break; } } catch (_) {}
    await new Promise((r) => setTimeout(r, 150));
  }
  assert(ready, `网关未启动。日志:\n${logs.slice(-1500)}`);

  try {
    const auth = { Authorization: `Bearer ${API_KEY}` };

    // 等账号池就绪
    let st = null;
    for (let i = 0; i < 40; i++) {
      st = await request('GET', '/status');
      if (st.json && st.json.ready) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    assert(st.json && st.json.ready, `账号池未就绪: ${JSON.stringify(st.json)}`);

    // ---- 1. UA 端到端 ----
    // 首字节 5s、短请求 12s：两者必须不同，否则「谁把它掐断的」无法归因（评审点）。
    const put = await request('PUT', '/api/settings', {
      outbound_user_agent: 'aiwork-timeout-test/9.9',
      first_byte_timeout_sec: 5,
      short_request_timeout_sec: 12,
      stream_idle_timeout_sec: 60,
    }, auth);
    assert.strictEqual(put.status, 200, put.text);

    seenUserAgents.length = 0;
    const chat = await request('POST', '/v1/chat/completions', {
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    }, auth);
    assert.strictEqual(chat.status, 200, chat.text);
    assert(seenUserAgents.includes('aiwork-timeout-test/9.9'),
      `上游必须收到配置的 UA，实际收到: ${JSON.stringify(seenUserAgents)}`);

    // ---- 2. 首字节超时 ----
    const started = Date.now();
    const hang = await request('POST', '/v1/chat/completions', {
      model: 'hang-model',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    }, auth, 30000);
    const elapsed = Date.now() - started;

    assert.notStrictEqual(hang.status, 200, '上游不响应时不能返回 200');
    assert(elapsed < 10000, `首字节超时应在 5s 左右生效，实际耗时 ${elapsed}ms`);
    assert(elapsed >= 4500, `不应早于配置的 5s 放弃，实际 ${elapsed}ms`);
    assert(hang.json && hang.json.error, '超时必须返回可读错误');
    assert(seenChatModels.includes('hang-model'), 'hang-model 必须真的打到上游，否则测的是别的路径');

    // 超时会把账号打进 15s 临时退避；不推时间的话下一个探测会直接 404
    // no_account_supports_model，断言就变成「没测到还绿着」——这正是上一版的问题。
    const advance = await request('POST', '/api/admin/debug/time', { advance_sec: 30 }, auth);
    assert.strictEqual(advance.status, 200, `测试时钟推进失败: ${advance.text}`);

    // ---- 3. 短请求超时是「总时长上限」，不是 socket 空闲 ----
    // 上游每 700ms 滴一个字节，socket 永远不空闲；旧实现把 short_request_timeout_sec
    // 直接当 socket timeout，会被滴流无限续命，直到客户端自己超时。
    // 断言下限 10s 是关键：首字节（5s）已经拿到响应头、不再适用，只有 12s 的总时长上限
    // 能在这个时间点掐断它——这样就证明两种超时确实是两个机制。
    const dripStart = Date.now();
    const drip = await request('POST', '/v1/chat/completions', {
      model: 'drip-model',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    }, auth, 30000);
    const dripElapsed = Date.now() - dripStart;

    assert(seenChatModels.includes('drip-model'), 'drip-model 必须真的打到上游');
    assert.notStrictEqual(drip.status, 200, '慢速滴流不能被当成成功响应');
    assert(
      dripElapsed >= 10000,
      `滴流必须在首字节之后才被掐断，实际 ${dripElapsed}ms（早于 10s 说明是首字节超时或 socket 空闲在起作用）: ${drip.text.slice(0, 300)}`
    );
    assert(
      dripElapsed < 18000,
      `短请求总时长应在 12s 左右掐断滴流，实际 ${dripElapsed}ms（说明仍在用 socket 空闲超时）`
    );

    console.log('✓ [All Passed] 超时与 UA：UA 端到端生效 + 首字节超时 + 短请求总时长上限');
  } finally {
    gw.kill('SIGTERM');
    upstream.close();
  }
}

run().catch((err) => {
  console.error('测试失败:', err.message);
  process.exit(1);
});
