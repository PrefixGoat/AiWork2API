'use strict';
/**
 * ADR-0022 接线测试。
 * seam 1：messages-adapter.translateRequest（已有模块导出）——thinking 入站映射
 *         与 assistant 历史 thinking 块 → reasoning_content 回传。
 * seam 2：responses-adapter.translateRequest——reasoning.effort 无门槛映射。
 * seam 3：网关端到端（MockUpstream）——出站方言与 400 摘参数重试（后续切片补）。
 */

const assert = require('assert');
const path = require('path');

const { translateRequest } = require(path.join(__dirname, '..', 'src', 'messages-adapter.js'));

// ---- 1. thinking 预算 → 内部档位词（由直连路径统一翻成上游方言） ----
{
  const { chat } = translateRequest({
    model: 'deepseek-flash', max_tokens: 100,
    thinking: { type: 'enabled', budget_tokens: 8000 },
    messages: [{ role: 'user', content: 'hi' }],
  }, {});
  assert.strictEqual(chat.reasoning_effort, 'medium', '8000 预算应落 medium 档');
}
{
  const { chat } = translateRequest({
    model: 'm', max_tokens: 10,
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: 'hi' }],
  }, {});
  assert.strictEqual(chat.reasoning_effort, 'off', '显式关闭要落 off 档');
}
{
  const { chat } = translateRequest({
    model: 'm', max_tokens: 10,
    messages: [{ role: 'user', content: 'hi' }],
  }, {});
  assert.strictEqual(chat.reasoning_effort, undefined, '客户端没表达就不注入');
}

// ---- 2. 历史 assistant thinking 块 → reasoning_content 回传（修工具多轮 400） ----
{
  const { chat } = translateRequest({
    model: 'm', max_tokens: 100,
    messages: [
      { role: 'user', content: '查天气' },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: '需要先调用工具查天气' },
        { type: 'tool_use', id: 'toolu_1', name: 'weather', input: { city: '北京' } },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: '晴 25 度' },
      ] },
    ],
  }, {});
  const asst = chat.messages.find((m) => m.role === 'assistant');
  assert.ok(asst, 'assistant 消息必须保留');
  assert.strictEqual(asst.reasoning_content, '需要先调用工具查天气',
    'thinking 块必须转成 reasoning_content 回传，否则思考模式下工具多轮会被上游 400');
  assert.ok(Array.isArray(asst.tool_calls) && asst.tool_calls[0].function.name === 'weather',
    'tool_use 照常翻译');
}

// ---- 3. redacted_thinking 无法还原文本：跳过但不报错 ----
{
  const { chat, notes } = translateRequest({
    model: 'm', max_tokens: 10,
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [
        { type: 'redacted_thinking', data: 'xxx' },
        { type: 'text', text: '答案' },
      ] },
    ],
  }, {});
  const asst = chat.messages[1];
  assert.strictEqual(asst.content, '答案');
  assert.strictEqual(asst.reasoning_content, undefined, 'redacted 无明文可回传');
  assert.strictEqual(notes.droppedBlocks.length, 0, '不能因为 redacted 块把整个请求 400 掉');
}

console.log('ok - messages 适配器：thinking 档位映射 / 历史回传 / redacted 跳过');

// ---- 4. responses 适配器：reasoning.effort 无门槛映射（ADR-0022 透传成为默认） ----
{
  const { translateRequest: tr } = require(path.join(__dirname, '..', 'src', 'responses-adapter.js'));
  const cases = [
    [{ effort: 'high' }, 'high'],
    [{ effort: 'none' }, 'off'],
    [{ effort: 'xhigh' }, 'xhigh'],
    [{ effort: 'turbo' }, 'turbo'], // 不认识的词原样保留，上游自己归一
  ];
  for (const [reasoning, expect] of cases) {
    const { chat } = tr({
      model: 'deepseek-flash', input: 'hi', stream: false,
      reasoning,
    }, {});
    assert.strictEqual(chat.reasoning_effort, expect,
      `reasoning.effort=${JSON.stringify(reasoning.effort)} 必须映射（无 REASONING 门槛）`);
  }
  {
    const { chat } = tr({ model: 'm', input: 'hi', stream: false }, {});
    assert.strictEqual(chat.reasoning_effort, undefined, '没给 reasoning 就不注入');
  }
}

console.log('ok - responses 适配器：reasoning.effort 无门槛映射 / 未知词透传');

// ---- 5. 网关端到端：出站方言与 400 摘参数重试（seam：HTTP 接口 + MockUpstream） ----
const http = require('http');
const fs = require('fs');
const cp = require('child_process');
const { MockUpstream } = require(path.join(__dirname, 'mock-upstream.js'));

const GW_PORT = 18099;
const GW_KEY = 'sk-thinking-inv-key';

function gwRequest(bodyObj, port = GW_PORT) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(bodyObj);
    const req = http.request({
      hostname: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
      headers: {
        'Authorization': `Bearer ${GW_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
      timeout: 15000,
    }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try { body = JSON.parse(raw); } catch (_) { body = raw; }
        resolve({ statusCode: res.statusCode, body: raw });
      });
    });
    req.on('error', reject);
    req.end(bodyStr);
  });
}

/** POST /v1/messages，返回 {statusCode, raw}；流式时 raw 是完整 SSE 文本。 */
function messagesRequest(port, bodyObj) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(bodyObj);
    const req = http.request({
      hostname: '127.0.0.1', port, path: '/v1/messages', method: 'POST',
      headers: {
        'Authorization': `Bearer ${GW_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
      timeout: 15000,
    }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({ statusCode: res.statusCode, raw: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(bodyStr);
  });
}

function sseEvents(raw) {
  return raw.split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim())
    .filter((s) => s && s !== '[DONE]')
    .map((s) => { try { return JSON.parse(s); } catch (_) { return null; } })
    .filter(Boolean);
}

/** fork 一个网关并等 /healthz 就绪。envExtra 里放 REASONING 等差异项。 */
async function forkGateway(port, dataDir, accDir, envExtra, mockUrl) {
  const gw = cp.fork(path.join(__dirname, '..', 'src', 'api-bridge.js'), [], {
    env: {
      ...process.env,
      PORT: String(port), BIND: '127.0.0.1',
      UPSTREAM: 'direct', UPSTREAM_FALLBACK: '0',
      ROUTER_BASE_URL: mockUrl,
      UPSTREAM_ACCOUNTS: JSON.stringify([{ id: 'acc-' + port, name: 'Acc' + port, stateDir: accDir }]),
      GATEWAY_DATA_DIR: dataDir,
      STATE_PATH: path.join(dataDir, 'usage-state.json'),
      ...envExtra,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  gw.stdout.on('data', (d) => { if (process.env.VERBOSE) console.log('[gw]', String(d).trim()); });
  gw.stderr.on('data', (d) => { if (process.env.VERBOSE) console.error('[gw]', String(d).trim()); });
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    const ok = await new Promise((resolve) => {
      const r = http.get({ host: '127.0.0.1', port, path: '/healthz', timeout: 800 }, (res) => {
        res.resume(); resolve(res.statusCode === 200);
      });
      r.on('error', () => resolve(false));
      r.on('timeout', () => { r.destroy(); resolve(false); });
    });
    if (ok) return gw;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`gateway on ${port} failed to start within 8s`);
}

async function runE2E() {
  const mock = new MockUpstream();
  const mockUrl = await mock.start(0);

  const dataDir = path.join(__dirname, '..', '.scratch', 'v1', 'scratch', `test-thinking-${Date.now()}`);
  fs.mkdirSync(dataDir, { recursive: true });
  const accDir = path.join(dataDir, 'acc1');
  fs.mkdirSync(accDir, { recursive: true });
  fs.writeFileSync(path.join(accDir, '.env'), 'AGENTIX_CONFIG_MODELS_AIWORK_ROUTER_API_KEY=sk-upstream-acc1\n');
  fs.writeFileSync(path.join(dataDir, 'api-keys.json'), JSON.stringify({
    version: 1,
    keys: [{
      id: 'key-thinking-inv', token: GW_KEY, name: 'thinking-inv',
      accountPolicy: { mode: 'all', allowedAccounts: [] },
      createdAt: Date.now(), revoked: false,
    }],
  }, null, 2));

  const chatOk = {
    status: 200,
    body: { id: 'cmpl-1', object: 'chat.completion', model: 'deepseek-flash',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
  };
  fs.writeFileSync(path.join(accDir, 'config.json'), JSON.stringify({
    config_protocol_version: '1.1',
    models: { 'aiwork-router': { models: [
      { id: 'deepseek-flash', name: 'DeepSeek Flash' },
      { id: 'qwen3.8-max', name: 'Qwen 3.8 Max' },
      { id: 'thinking-model', name: 'Thinking Model' },
    ] } },
  }, null, 2));

  // 模型清单：默认三件套 + thinking-model（mock 的默认列表没有它，覆盖 /v1/models）
  mock.setHandler('/v1/models', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ object: 'list', data: [
      { id: 'qwen3.8-max', name: 'Qwen 3.8 Max' },
      { id: 'deepseek-flash', name: 'DeepSeek Flash' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      { id: 'thinking-model', name: 'Thinking Model' },
    ] }));
  });

  // qwen3.8-max：带思考参数一律 400（unknown parameter）；deepseek-flash：恒 200；
  // thinking-model：会输出思考内容（stream 给 SSE reasoning 增量，非 stream 给 JSON）。
  mock.setHandler('/v1/chat/completions', (req, res, body) => {
    const rejectThinking = body && body.model === 'qwen3.8-max' && (body.reasoning_effort || body.thinking);
    if (rejectThinking) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({
        error: { message: 'Invalid parameter: reasoning_effort is not supported by this model', type: 'invalid_request_error' },
      }));
    }
    if (body && body.model === 'thinking-model') {
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
        res.write('data: {"choices":[{"delta":{"role":"assistant","reasoning_content":"思考草稿第一段。"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{"reasoning_content":"第二段。"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{"content":"答案是 42。"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
        return res.end('data: [DONE]\n\n');
      }
      return res.end(JSON.stringify({
        id: 'cmpl-think', object: 'chat.completion', model: 'thinking-model',
        choices: [{ index: 0, message: { role: 'assistant', content: '答案是 42。',
          reasoning_content: '非流式的思考草稿。' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(chatOk.body));
  });

  const gw = await forkGateway(GW_PORT, dataDir, accDir, {}, mockUrl);

  try {
    // 5a. medium → 上游收到 high + thinking.enabled（REASONING=off 也不影响档位映射）
    await gwRequest({ model: 'deepseek-flash', reasoning_effort: 'medium',
      messages: [{ role: 'user', content: 'a' }], max_tokens: 16 });
    let sent = mock.getRecordedRequests('/v1/chat/completions').at(-1).body;
    assert.strictEqual(sent.reasoning_effort, 'high', 'medium 必须翻成上游的 high');
    assert.deepStrictEqual(sent.thinking, { type: 'enabled' }, '必须显式带上 thinking 开关');

    // 5b. none → 只带 thinking.disabled，不带 effort
    await gwRequest({ model: 'deepseek-flash', reasoning_effort: 'none',
      messages: [{ role: 'user', content: 'b' }], max_tokens: 16 });
    sent = mock.getRecordedRequests('/v1/chat/completions').at(-1).body;
    assert.deepStrictEqual(sent.thinking, { type: 'disabled' });
    assert.strictEqual(sent.reasoning_effort, undefined, 'off 档不残留 effort');

    // 5c. 什么都没给 → 请求体不带任何思考参数（行为不变）
    await gwRequest({ model: 'deepseek-flash',
      messages: [{ role: 'user', content: 'c' }], max_tokens: 16 });
    sent = mock.getRecordedRequests('/v1/chat/completions').at(-1).body;
    assert.strictEqual(sent.reasoning_effort, undefined);
    assert.strictEqual(sent.thinking, undefined, '客户端没表达就不注入');

    // 5d. mock-strict 对思考参数 400：网关必须摘掉参数重试一次，客户端拿到 200
    const strictRes = await gwRequest({ model: 'qwen3.8-max', reasoning_effort: 'medium',
      messages: [{ role: 'user', content: 'd' }], max_tokens: 16 });
    assert.strictEqual(strictRes.statusCode, 200, `摘参数重试后必须成功：${strictRes.body.slice(0, 120)}`);
    const strictReqs = mock.getRecordedRequests('/v1/chat/completions')
      .filter((r) => r.body && r.body.model === 'qwen3.8-max');
    assert.strictEqual(strictReqs.length, 2, `必须恰好两次上游请求，实际 ${strictReqs.length}`);
    assert.strictEqual(strictReqs[0].body.reasoning_effort, 'high', '首试按映射带 high');
    assert.strictEqual(strictReqs[1].body.reasoning_effort, undefined, '重试不带 effort');
    assert.strictEqual(strictReqs[1].body.thinking, undefined, '重试不带 thinking');

    // 5e. 同模型下一发：进程已记住，首试就不带（不再浪费一次 400）
    const before = strictReqs.length;
    const memRes = await gwRequest({ model: 'qwen3.8-max',
      messages: [{ role: 'user', content: 'e' }], max_tokens: 16 });
    assert.strictEqual(memRes.statusCode, 200);
    const after = mock.getRecordedRequests('/v1/chat/completions')
      .filter((r) => r.body && r.body.model === 'qwen3.8-max');
    assert.strictEqual(after.length, before + 1, '记住后只发一次');
    assert.strictEqual(after.at(-1).body.reasoning_effort, undefined);
    assert.strictEqual(after.at(-1).body.thinking, undefined);

    // ---- 切片 6：/v1/messages 响应侧 thinking 块与历史回传（REASONING=auto） ----
    const accConf = fs.readFileSync(path.join(accDir, 'config.json'), 'utf8');
    const dataDir2 = path.join(dataDir, 'gw2-data');
    fs.mkdirSync(dataDir2, { recursive: true });
    fs.writeFileSync(path.join(dataDir2, 'api-keys.json'), JSON.stringify({
      version: 1,
      keys: [{
        id: 'key-thinking-inv', token: GW_KEY, name: 'thinking-inv',
        accountPolicy: { mode: 'all', allowedAccounts: [] },
        createdAt: Date.now(), revoked: false,
      }],
    }, null, 2));
    const accDir2 = path.join(dataDir, 'acc2');
    fs.mkdirSync(accDir2, { recursive: true });
    fs.writeFileSync(path.join(accDir2, '.env'), 'AGENTIX_CONFIG_MODELS_AIWORK_ROUTER_API_KEY=sk-upstream-acc2\n');
    fs.writeFileSync(path.join(accDir2, 'config.json'), accConf);
    const gw2 = await forkGateway(18100, dataDir2, accDir2, { REASONING: 'auto' }, mockUrl);

    try {
      // 6a. 流式：reasoning_content 增量 → Anthropic thinking 块（在 text 之前）
      const streamRes = await messagesRequest(18100, {
        model: 'thinking-model', max_tokens: 200, stream: true,
        thinking: { type: 'enabled', budget_tokens: 8000 },
        messages: [{ role: 'user', content: '问题' }],
      });
      assert.strictEqual(streamRes.statusCode, 200, streamRes.raw.slice(0, 200));
      const events = sseEvents(streamRes.raw);
      const blockStarts = events.filter((e) => e.type === 'content_block_start');
      const thinkingStart = blockStarts.find((e) => e.content_block && e.content_block.type === 'thinking');
      assert.ok(thinkingStart, `必须有 thinking content_block，实际事件类型：${[...new Set(events.map((e) => e.type))].join(',')}`);
      const textStart = blockStarts.find((e) => e.content_block && e.content_block.type === 'text');
      assert.ok(textStart, '正文 text 块必须保留');
      assert.ok(thinkingStart.index < textStart.index, 'thinking 块必须排在 text 之前');
      const thinkingText = events
        .filter((e) => e.type === 'content_block_delta' && e.delta && e.delta.type === 'thinking_delta')
        .map((e) => e.delta.thinking).join('');
      assert.ok(thinkingText.includes('思考草稿第一段。') && thinkingText.includes('第二段。'),
        `思考增量必须完整转发，实际：${thinkingText}`);
      const textContent = events
        .filter((e) => e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta')
        .map((e) => e.delta.text).join('');
      assert.strictEqual(textContent, '答案是 42。', `思考内容不得混进正文，实际正文：${textContent}`);
      assert.ok(events.some((e) => e.type === 'content_block_delta' && e.delta && e.delta.type === 'signature_delta'),
        'thinking 块收尾要带 signature_delta，客户端回传时才有形状');

      // 6b. 非流式：reasoning_content → 首个 thinking 块
      const onceRes = await messagesRequest(18100, {
        model: 'thinking-model', max_tokens: 200, stream: false,
        thinking: { type: 'enabled', budget_tokens: 8000 },
        messages: [{ role: 'user', content: '问题' }],
      });
      assert.strictEqual(onceRes.statusCode, 200, onceRes.raw.slice(0, 200));
      const onceMsg = JSON.parse(onceRes.raw);
      assert.strictEqual(onceMsg.content[0].type, 'thinking', '首个块必须是 thinking');
      assert.strictEqual(onceMsg.content[0].thinking, '非流式的思考草稿。');
      assert.ok(onceMsg.content.some((b) => b.type === 'text' && b.text === '答案是 42。'));

      // 6c. 历史 assistant thinking 块 → reasoning_content 回传（端到端闭环）
      await messagesRequest(18100, {
        model: 'thinking-model', max_tokens: 200, stream: true,
        thinking: { type: 'enabled', budget_tokens: 8000 },
        messages: [
          { role: 'user', content: '查天气' },
          { role: 'assistant', content: [
            { type: 'thinking', thinking: '需要先调用工具查天气' },
            { type: 'tool_use', id: 'toolu_1', name: 'weather', input: { city: '北京' } },
          ] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '晴 25 度' }] },
        ],
      });
      const sentMsgs = mock.getRecordedRequests('/v1/chat/completions').at(-1).body.messages;
      const asst = sentMsgs.find((m) => m.role === 'assistant');
      assert.ok(asst, '上游必须收到 assistant 消息');
      assert.strictEqual(asst.reasoning_content, '需要先调用工具查天气',
        '历史 thinking 必须以 reasoning_content 回传，否则思考模式工具多轮会被上游 400');
      assert.ok(Array.isArray(asst.tool_calls) && asst.tool_calls[0].function.name === 'weather');
    } finally {
      gw2.kill();
      await new Promise((r) => gw2.on('exit', r));
    }

    // ---- 切片 7：agent 路径——客户端显式档位覆盖 THINKING_LEVEL ----
    const argvLog = path.join(dataDir, 'argv.log');
    const cliScript = path.join(dataDir, 'fake-cli.js');
    fs.writeFileSync(cliScript, `
      const fs = require('fs');
      const argv = process.argv.slice(2);
      if (argv.includes('status') && argv.includes('auth')) {
        process.stdout.write(JSON.stringify({ status: 'active' }) + '\\n');
        process.exit(0);
      }
      if (argv.includes('chat')) {
        fs.appendFileSync(process.env.ARGV_LOG, JSON.stringify(argv) + '\\n');
        process.stdout.write(JSON.stringify({ event: { name: 'stream.text_delta', data: { text: 'ok' } } }) + '\\n');
        process.stdout.write(JSON.stringify({ event: { name: 'stream.completed', data: { final_text: 'ok' } } }) + '\\n');
        process.exit(0);
      }
      process.exit(0);
    `);
    const accDir3 = path.join(dataDir, 'acc3');
    fs.mkdirSync(accDir3, { recursive: true });
    fs.writeFileSync(path.join(accDir3, '.env'), 'AGENTIX_CONFIG_MODELS_AIWORK_ROUTER_API_KEY=sk-upstream-acc3\n');
    fs.writeFileSync(path.join(accDir3, 'config.json'), accConf);
    const gw3 = await forkGateway(18101, dataDir, accDir3, {
      UPSTREAM: 'agent',
      DTCODER_BIN: process.execPath,
      CLI_DIST_ARGS: cliScript,
      AGENTIX_STATE_DIR: accDir3,
      THINKING_LEVEL: 'low',
      ARGV_LOG: argvLog,
    }, mockUrl);
    try {
      // 7a. 客户端显式 high：覆盖环境里的 low
      await gwRequest({ model: 'deepseek-flash', reasoning_effort: 'high',
        messages: [{ role: 'user', content: 'a' }], max_tokens: 16 }, 18101);
      // 7b. xhigh → CLI 只认 adaptive
      await gwRequest({ model: 'deepseek-flash', reasoning_effort: 'xhigh',
        messages: [{ role: 'user', content: 'b' }], max_tokens: 16 }, 18101);
      // 7c. 客户端没表达：回落到环境 THINKING_LEVEL=low
      await gwRequest({ model: 'deepseek-flash',
        messages: [{ role: 'user', content: 'c' }], max_tokens: 16 }, 18101);

      const lines = fs.readFileSync(argvLog, 'utf8').trim().split('\n')
        .map((l) => JSON.parse(l))
        .filter((argv) => argv.includes('chat'));
      assert.strictEqual(lines.length, 3, `假 CLI 必须被调用三次，实际 ${lines.length}`);
      const levels = lines.map((argv) => {
        const i = argv.indexOf('--thinking-level');
        return i >= 0 ? argv[i + 1] : null;
      });
      assert.deepStrictEqual(levels, ['high', 'adaptive', 'low'],
        `--thinking-level 应为 [客户端high覆盖env, xhigh→adaptive, 无表达→env low]，实际 ${JSON.stringify(levels)}`);
    } finally {
      gw3.kill();
      await new Promise((r) => gw3.on('exit', r));
    }
    console.log('ok - agent 路径：客户端档位覆盖 THINKING_LEVEL / xhigh→adaptive / 无表达回落 env');
  } finally {
    gw.kill();
    await new Promise((r) => gw.on('exit', r));
    await mock.stop().catch(() => {});
  }
  console.log('ok - 网关端到端：出站方言 medium→high / none→disabled / 未表达不注入');
  console.log('ok - messages 响应侧：thinking 块（流式+非流式）/ 历史回传闭环');
}

runE2E().then(() => {
  console.log('ok - 全部接线切片通过');
}).catch((e) => {
  console.error(e && e.message || e);
  process.exit(1);
});
