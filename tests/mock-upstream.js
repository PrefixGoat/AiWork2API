'use strict';
/**
 * 可编排的模拟上游服务（Mock Upstream Server）
 *
 * 用于完全脱敏、无需真实网络与个人凭据的端到端回归测试：
 * 1. 模拟 AiWork Router / OpenAI 兼容服务端点：
 *    - POST /v1/chat/completions (支持 JSON / SSE 流式 / 错误码 / 延迟 / 中断)
 *    - GET  /v1/models
 *    - GET  /v1/dashboard/billing/usage
 *    - GET  /v1/dashboard/billing/subscription
 * 2. 完整记录请求历史（Headers, Method, URL, Body），用于断言鉴权头、模型名、请求体
 * 3. 支持队列式预设响应与动态处理器
 */

const http = require('http');

class MockUpstream {
  constructor(options = {}) {
    this.options = options;
    this.quiet = Boolean(options.quiet || process.env.QUIET === '1' || process.env.LOG_LEVEL === 'error');
    this.logBuffer = [];
    this.server = null;
    this.port = 0;
    this.url = '';
    this.recordedRequests = [];
    this.queuedResponses = new Map(); // path -> Array of response definitions
    this.customHandlers = new Map(); // path -> fn(req, res, body)
    this.defaultModels = [
      { id: 'qwen3.8-max', name: 'Qwen 3.8 Max', ratio: '1.0x', tags: '标准' },
      { id: 'deepseek-flash', name: 'DeepSeek Flash', ratio: '0.2x', tags: '低成本' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', ratio: '2.0x', tags: '高成本' },
    ];
  }

  dumpLogs() {
    if (this.logBuffer.length > 0) {
      console.error('\n--- [Mock Upstream Recorded Requests On Failure] ---');
      for (const entry of this.logBuffer) {
        console.error(entry);
      }
      console.error('--- [End Mock Upstream Logs] ---\n');
    }
  }

  async start(port = 0) {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this._handle(req, res));
      this.server.listen(port, '127.0.0.1', () => {
        this.port = this.server.address().port;
        this.url = `http://127.0.0.1:${this.port}`;
        resolve(this.url);
      });
      this.server.on('error', reject);
    });
  }

  async stop() {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  clear() {
    this.recordedRequests = [];
    this.queuedResponses.clear();
    this.customHandlers.clear();
  }

  getRecordedRequests(filterPath) {
    if (!filterPath) return [...this.recordedRequests];
    return this.recordedRequests.filter((r) => r.url.startsWith(filterPath));
  }

  queueResponse(pathUrl, responseDef) {
    const list = this.queuedResponses.get(pathUrl) || [];
    list.push(responseDef);
    this.queuedResponses.set(pathUrl, list);
  }

  setHandler(pathUrl, handlerFn) {
    this.customHandlers.set(pathUrl, handlerFn);
  }

  async _handle(req, res) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      let parsedBody = null;
      try { parsedBody = JSON.parse(rawBody); } catch (_) { parsedBody = rawBody; }

      const record = {
        method: req.method,
        url: req.url,
        headers: { ...req.headers },
        body: parsedBody,
        rawBody,
        time: Date.now(),
      };
      this.recordedRequests.push(record);
      this.logBuffer.push(`[${new Date().toISOString()}] ${req.method} ${req.url}`);

      const pathname = req.url.split('?')[0];

      // 1. 自定义 Handler 优先
      if (this.customHandlers.has(pathname)) {
        return this.customHandlers.get(pathname)(req, res, parsedBody);
      }

      // 2. 队列式预设响应
      const queue = this.queuedResponses.get(pathname);
      if (queue && queue.length > 0) {
        const nextDef = queue.shift();
        return this._executeResponse(req, res, nextDef, parsedBody);
      }

      // 3. 默认路由响应
      if (pathname === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({
          object: 'list',
          data: this.defaultModels,
        }));
      }

      if (pathname === '/v1/dashboard/billing/usage') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ total_usage: 12.34 }));
      }

      if (pathname === '/v1/dashboard/billing/subscription') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ hard_limit_usd: 100 }));
      }

      if (pathname === '/v1/chat/completions') {
        // 默认返回极简成功消息
        const stream = !!(parsedBody && parsedBody.stream);
        const model = (parsedBody && parsedBody.model) || 'deepseek-flash';
        if (!stream) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{
              index: 0,
              message: { role: 'assistant', content: 'mock reply' },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }));
        }
        // SSE 默认流
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        res.write(`data: ${JSON.stringify({
          id: 'chunk-1',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'mock ' }, finish_reason: null }],
        })}\n\n`);
        res.write(`data: ${JSON.stringify({
          id: 'chunk-2',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { content: 'stream' }, finish_reason: 'stop' }],
        })}\n\n`);
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      // 未匹配端点
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `mock upstream not found: ${pathname}` } }));
    });
  }

  async _executeResponse(req, res, def, body) {
    if (def.delayMs) {
      await new Promise((r) => setTimeout(r, def.delayMs));
    }

    if (def.abortPrematurely) {
      req.destroy();
      res.destroy();
      return;
    }

    const status = def.status || 200;
    const headers = { 'Content-Type': 'application/json; charset=utf-8', ...(def.headers || {}) };

    if (def.sseEvents) {
      res.writeHead(status, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        ...def.headers,
      });

      for (const ev of def.sseEvents) {
        if (ev.delayMs) await new Promise((r) => setTimeout(r, ev.delayMs));
        if (ev.abort) {
          res.destroy();
          return;
        }
        const text = typeof ev.data === 'object' ? JSON.stringify(ev.data) : String(ev.data);
        res.write(`data: ${text}\n\n`);
      }
      return res.end();
    }

    res.writeHead(status, headers);
    const respBody = typeof def.body === 'object' ? JSON.stringify(def.body) : String(def.body || '');
    res.end(respBody);
  }
}

module.exports = { MockUpstream };
