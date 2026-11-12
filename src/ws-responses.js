'use strict';
/**
 * Responses WebSocket 传输层（Codex Desktop / 新版 codex 的流式通道）
 * ---------------------------------------------------------------------------
 * 背景：Codex 在 provider=OpenAI 下，流式请求走的不是 POST + SSE，而是 WebSocket：
 *     GET /v1/responses   Upgrade: websocket   OpenAI-Beta: responses_websockets=2026-02-06
 * 建立连接后客户端发一个 JSON 文本帧：
 *     {"type":"response.create", "model":"...", "input":[...], "stream":true, ...}
 * 字段就是 Responses API 的请求体本身，外面套一层 type 标签。
 * 服务端把 response.created / response.output_text.delta / response.completed 这些
 * 标准 Responses 事件逐个作为 JSON 文本帧发回去；客户端收到 response.completed
 * 就结束本轮读取、**连接保留复用**（提前发 Close 帧会被客户端当成错误：
 * "websocket closed by server before response.completed"）。
 *
 * 实测日志（Codex Desktop）：
 *   transport="responses_websocket" api.path="/responses"
 *   connecting to websocket: wss://api.openai.com/v1/responses
 * 失败时每 15 秒重试一次并报 "request timed out"——这就是旧会话报超时的真正原因。
 *
 * 实现：握手 + 帧编解码手写（镜像里不装 npm 依赖），请求体转给 responses-adapter
 * 复用全部翻译逻辑——假 req 喂请求体，假 res(sink) 收它写出的 SSE，把 `data: {...}`
 * 拆出来当文本帧回发。HTTP 和 WS 两条通道共用一套协议翻译，不会各修各的。
 */

const crypto = require('crypto');
const { createSink } = require('./adapter-common');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME_PAYLOAD = 32 * 1024 * 1024;   // 请求体上限与 HTTP 侧一致即可

function acceptKey(key) {
  return crypto.createHash('sha1').update(String(key) + WS_GUID).digest('base64');
}

// 服务端 -> 客户端：不掩码
function encodeFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = body.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, body]);
}

/**
 * 帧解析器：客户端帧一定带掩码（RFC6455），要处理分片/控制帧/超大长度。
 * 事件：onText(str) / onBinary(buf) / onPing(buf) / onClose(code, reason) / onError(msg)
 */
class WsParser {
  constructor(handlers) {
    this.h = handlers || {};
    this.buf = Buffer.alloc(0);
    this.fragments = [];      // 分片缓存
    this.fragTotalBytes = 0;
    this.fragOpcode = 0;
    this.dead = false;
  }

  push(chunk) {
    if (this.dead) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (!this.dead) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;

      // RFC 6455 5.1: 客户端发往服务端的帧必须带有掩码，否则必须关闭连接并报 1002 协议错误
      if (!masked) {
        return this.fail('client frame must be masked', 1002);
      }

      // 控制帧 (opcode >= 0x8) 校验 (RFC 6455 5.5)
      if (opcode >= 0x8) {
        if (!fin) return this.fail('control frames cannot be fragmented', 1002);
        if (opcode !== 0x8 && opcode !== 0x9 && opcode !== 0xA) {
          return this.fail('reserved control opcode ' + opcode, 1002);
        }
      } else {
        // 数据帧保留 opcode 检查 (0x3 - 0x7 为保留)
        if (opcode > 0x2) {
          return this.fail('reserved data opcode ' + opcode, 1002);
        }
      }

      let len = b1 & 0x7f;
      let off = 2;

      // 控制帧载荷上限 125 字节 (RFC 6455 5.5)
      if (opcode >= 0x8 && len > 125) {
        return this.fail('control frame payload exceeds 125 bytes', 1002);
      }

      if (len === 126) {
        if (this.buf.length < off + 2) return;
        len = this.buf.readUInt16BE(off);
        off += 2;
      } else if (len === 127) {
        if (this.buf.length < off + 8) return;
        const big = this.buf.readBigUInt64BE(off);
        if (big > BigInt(MAX_FRAME_PAYLOAD)) return this.fail('frame too large', 1009);
        len = Number(big);
        off += 8;
      }
      if (len > MAX_FRAME_PAYLOAD) return this.fail('frame too large', 1009);

      let mask = null;
      if (masked) {
        if (this.buf.length < off + 4) return;
        mask = this.buf.slice(off, off + 4);
        off += 4;
      }
      if (this.buf.length < off + len) return;
      let payload = this.buf.slice(off, off + len);
      this.buf = this.buf.slice(off + len);
      if (mask) {
        const out = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
        payload = out;
      }

      switch (opcode) {
        case 0x0: { // continuation
          if (this.fragOpcode === 0) return this.fail('unexpected continuation frame', 1002);
          this.fragTotalBytes += payload.length;
          if (this.fragTotalBytes > MAX_FRAME_PAYLOAD) return this.fail('fragmented message too large', 1009);
          this.fragments.push(payload);
          if (!fin) break;
          const full = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments);
          const op = this.fragOpcode;
          this.fragments = [];
          this.fragTotalBytes = 0;
          this.fragOpcode = 0;
          if (op === 0x1) { if (this.h.onText) this.h.onText(full.toString('utf8')); }
          else if (this.h.onBinary) this.h.onBinary(full);
          break;
        }
        case 0x1:   // text
        case 0x2: { // binary
          if (this.fragOpcode !== 0) return this.fail('expected continuation frame', 1002);
          if (!fin) {
            this.fragOpcode = opcode;
            this.fragments = [payload];
            this.fragTotalBytes = payload.length;
            if (this.fragTotalBytes > MAX_FRAME_PAYLOAD) return this.fail('fragmented message too large', 1009);
            break;
          }
          if (opcode === 0x1) { if (this.h.onText) this.h.onText(payload.toString('utf8')); }
          else if (this.h.onBinary) this.h.onBinary(payload);
          break;
        }
        case 0x8: { // close
          const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
          const reason = payload.length > 2 ? payload.slice(2).toString('utf8') : '';
          this.dead = true;
          if (this.h.onClose) this.h.onClose(code, reason);
          return;
        }
        case 0x9:   // ping -> 由外层回 pong
          if (this.h.onPing) this.h.onPing(payload);
          break;
        case 0xA:   // pong
          if (this.h.onPong) this.h.onPong(payload);
          break;
        default:
          return this.fail('unknown opcode ' + opcode, 1002);
      }
    }
  }

  fail(msg, code = 1002) {
    this.dead = true;
    if (this.h.onError) this.h.onError(msg, code);
  }
}

// 假 req：只提供 responses-adapter.handle 需要的东西
// （readBody 吃 data/end 事件；sessionFingerprint 读 headers；clientIp 读 socket）
function fakeReq(bodyStr, headers, ip) {
  const listeners = Object.create(null);
  const rq = {
    headers: headers || {},
    method: 'POST',
    url: '/v1/responses',
    socket: { remoteAddress: ip || '-' },
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return this; },
    once(ev, fn) { return this.on(ev, fn); },
    removeListener(ev, fn) {
      if (!listeners[ev]) return this;
      listeners[ev] = listeners[ev].filter((f) => f !== fn);
      return this;
    },
    emit(ev, ...args) {
      const arr = (listeners[ev] || []).slice();
      for (const fn of arr) fn(...args);
      return this;
    },
    emitBody() {
      const buf = Buffer.from(bodyStr, 'utf8');
      for (const fn of (listeners.data || [])) fn(buf);
      for (const fn of (listeners.end || [])) fn();
    },
    abort() {
      if (rq.__abortController) {
        try { rq.__abortController.abort(); } catch { /* ignore */ }
      }
      this.emit('close');
    },
  };
  return rq;
}

/**
 * 把 WebSocket 升级请求接到 responses-adapter 上。
 * opts: { server, adapter, log, authOn, findKey, credentialsContext, ipAllowed, clientIpOf, sessionRouter, rateLimitCheck }
 */
function attachResponsesWs(opts) {
  const { server, adapter, log, authOn, findKey, credentialsContext, ipAllowed, clientIpOf, sessionRouter, rateLimitCheck } = opts;

  server.on('upgrade', (req, socket, head) => {
    const ip = (clientIpOf ? clientIpOf(req) : (req.socket && req.socket.remoteAddress)) || '-';

    // 归一化路径（有些客户端请求行里写绝对 URL）
    let fullUrl = req.url || '';
    if (/^https?:\/\//i.test(fullUrl)) {
      try { fullUrl = new URL(fullUrl).pathname; } catch { /* 保持原样 */ }
    }
    const path = fullUrl.split('?')[0];

    const reject = (code, msg) => {
      try {
        socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      } catch { /* ignore */ }
      socket.destroy();
    };

    // 只接管 Responses 的 WS 端点；其余 upgrade（未来的别的 WS）一律拒掉，不留半开连接。
    // 路径形态取决于客户端把哪套 base_url 指过来：
    //   openai_base_url  = http://host/v1        -> /v1/responses
    //   chatgpt_base_url = http://host/          -> /codex/responses
    // 一律以 /responses 结尾为准。
    if (!/\/responses\/?$/.test(path)) {
      log('[ws] 拒绝非 Responses 的 upgrade: %s %s', req.method, path);
      return reject('404', 'Not Found');
    }

    // IP 白名单
    if (ipAllowed && !ipAllowed(ip)) {
      log('[ws] IP 不在白名单: %s %s', ip, path);
      return reject('403', 'Forbidden');
    }

    // 鉴权与 HTTP 侧一致：调用凭据校验（或 Bearer/x-api-key）
    let keyObj = null;
    let keyName = null;
    if (credentialsContext) {
      const authRes = credentialsContext.authenticateInvocation(req);
      if (!authRes.ok) {
        log('[ws] 鉴权失败 %s %s: %s', ip, path, authRes.error);
        return reject(String(authRes.status || 401), authRes.status === 403 ? 'Forbidden' : 'Unauthorized');
      }
      keyObj = authRes.key;
      keyName = keyObj.name || null;
    } else if (authOn) {
      const auth = req.headers['authorization'] || '';
      let token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
      if (!token) token = String(req.headers['x-api-key'] || '').trim();
      const hit = token && findKey ? findKey(token) : null;
      if (!hit) {
        log('[ws] 鉴权失败 %s %s', ip, path);
        return reject('401', 'Unauthorized');
      }
      keyObj = hit;
      keyName = hit.name || null;
    }

    const key = req.headers['sec-websocket-key'];
    if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') {
      return reject('400', 'Bad Request');
    }

    // ---- 握手成功，之后全是帧 ----
    try {
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n'
        + 'Upgrade: websocket\r\n'
        + 'Connection: Upgrade\r\n'
        + `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n`
        // 不回 Sec-WebSocket-Extensions：客户端请求了 permessage-deflate，
        // 不协商扩展就双方都用未压缩帧（tungstenite 允许服务端不选扩展）。
        + '\r\n',
      );
    } catch (e) {
      log('[ws] 握手写失败: %s', e.message);
      return socket.destroy();
    }

    socket.setNoDelay(true);
    log('[ws] Responses WebSocket 已连接 ip=%s key=%s path=%s', ip, keyName || '-', path);

    const send = (opcode, payload) => {
      try { socket.write(encodeFrame(opcode, payload)); } catch { /* 连接已断 */ }
    };
    const sendText = (str) => send(0x1, str);
    // 客户端只认 type:"error" 的包装错误事件（parse_wrapped_websocket_error_event）
    const sendError = (code, message, status) => {
      sendText(JSON.stringify({ type: 'error', code: code || 'error', message: String(message || 'error'), status: status || 500 }));
    };

    // 逐条处理 response.create（客户端一条连接可能连发多轮）
    let chain = Promise.resolve();
    let closed = false;
    const activeAbortControllers = new Set();

    function abortAll(reason) {
      closed = true;
      if (activeAbortControllers.size > 0) {
        log('[ws] abortAll (%s), active controllers=%d', reason || 'unknown', activeAbortControllers.size);
        for (const ac of activeAbortControllers) {
          try { ac.abort(); } catch { /* ignore */ }
        }
        activeAbortControllers.clear();
      }
    }

    const parser = new WsParser({
      onText: (text) => {
        let msg;
        try { msg = JSON.parse(text); } catch {
          sendError('bad_json', 'WS 文本帧不是合法 JSON', 400);
          return;
        }
        const t = msg && msg.type;
        if (t === 'response.create') {
          if (credentialsContext && keyObj && keyObj.id) {
            const currentKey = credentialsContext.keyStore.getKeyById(keyObj.id);
            if (!currentKey || currentKey.revoked) {
              log('[ws] 连接上的 Key 已被撤销，立即拒绝后续请求 id=%s', keyObj.id);
              sendError('revoked_key', 'api key has been revoked', 401);
              closed = true;
              socket.destroy();
              return;
            }
            if (!credentialsContext.keyStore.hasAnyAccountAccess(currentKey)) {
              log('[ws] 连接上的 Key 账号权限为空，立即拒绝后续请求 id=%s', keyObj.id);
              sendError('no_accounts_permitted', 'no accounts permitted for this api key', 403);
              closed = true;
              socket.destroy();
              return;
            }
          }
          const reqAc = new AbortController();
          activeAbortControllers.add(reqAc);
          chain = chain.then(() => runOne(msg, reqAc)).catch(() => {});
        } else if (t === 'response.cancel') {
          // Issue #07 & US-52: 客户端发送取消信号，立即中断在途上游请求
          log('[ws] 收到 response.cancel，正在中止在途生成');
          for (const ac of activeAbortControllers) {
            try { ac.abort(); } catch { /* ignore */ }
          }
          sendText(JSON.stringify({ type: 'response.cancelled' }));
        } else {
          log('[ws] 忽略未知消息类型: %j', t);
        }
      },
      onBinary: () => sendError('unexpected_binary', '本网关只接受 JSON 文本帧', 400),
      onPing: (payload) => send(0xA, payload),
      onClose: (code, reason) => {
        abortAll(`client_close_${code}`);
        try { socket.write(encodeFrame(0x8, Buffer.concat([Buffer.from([(code >> 8) & 0xff, code & 0xff]), Buffer.from(reason || '', 'utf8')]))); } catch { /* ignore */ }
        socket.destroy();
      },
      onError: (msg, code = 1002) => {
        log('[ws] 帧解析错误: %s (code=%d)', msg, code);
        abortAll(`frame_error_${code}`);
        try {
          socket.write(encodeFrame(0x8, Buffer.concat([Buffer.from([(code >> 8) & 0xff, code & 0xff]), Buffer.from(msg || '', 'utf8')])));
        } catch { /* ignore */ }
        try { socket.destroy(); } catch { /* ignore */ }
      },
    });

    parser.push(head && head.length ? head : Buffer.alloc(0));
    socket.on('data', (d) => parser.push(d));
    socket.on('error', (e) => {
      abortAll(`socket_error: ${e.message}`);
    });
    socket.on('end', () => {
      abortAll('socket_end');
      try { socket.destroy(); } catch { /* ignore */ }
    });
    socket.on('close', () => {
      abortAll('socket_close');
    });

    async function runOne(msg, reqAc) {
      if (!reqAc) {
        reqAc = new AbortController();
        activeAbortControllers.add(reqAc);
      }
      if (reqAc.signal.aborted || closed) {
        activeAbortControllers.delete(reqAc);
        return;
      }
      const keyId = keyObj ? keyObj.id : 'default';

      // 1. 每条请求校验速率限制 (Rate limit per request)
      if (typeof rateLimitCheck === 'function' && !rateLimitCheck(keyId)) {
        activeAbortControllers.delete(reqAc);
        log('[ws] Key 限流超限: %s', keyId);
        sendError('rate_limit_error', 'rate limit exceeded', 429);
        return;
      }

      // 2. 每条请求校验并发与全局排队上限 (Key & Global concurrency limit)
      let keyAcquired = false;
      if (sessionRouter && typeof sessionRouter.acquireKey === 'function') {
        const acq = sessionRouter.acquireKey(keyId);
        if (!acq.ok) {
          activeAbortControllers.delete(reqAc);
          log('[ws] 并发/排队上限拒绝: %s %s', keyId, acq.message);
          sendError(acq.code || 'concurrency_limit_exceeded', acq.message, acq.status || 429);
          return;
        }
        keyAcquired = true;
      }

      const bodyObj = Object.assign({}, msg);
      delete bodyObj.type;
      // WS 通道天然是流式；强制 stream 让适配层走 runStreaming（事件流）路径
      if (bodyObj.stream !== true) {
        log('[ws] response.create 未带 stream:true，已强制流式');
        bodyObj.stream = true;
      }

      const bodyStr = JSON.stringify(bodyObj);
      const rq = fakeReq(bodyStr, req.headers, ip);
      rq.__keyObj = keyObj;
      rq.__keyName = keyName;
      rq.__keyId = keyId;

      rq.__abortController = reqAc;
      rq.on('close', () => {
        try { reqAc.abort(); } catch { /* ignore */ }
      });

      const sink = createSink((chunk) => {
        if (closed) return;
        const s = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        // 正常输出是 SSE：`event: X\ndata: {...}\n\n`；错误路径是裸 JSON
        const lines = s.split('\n');
        let forwarded = false;
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const payload = line.slice(6).trim();
            if (payload && payload !== '[DONE]') { sendText(payload); forwarded = true; }
          }
        }
        if (!forwarded) {
          // 适配层写出的非 SSE 内容 = 错误体（sendError/sendJson），翻成 error 事件
          try {
            const parsed = JSON.parse(s);
            const err = (parsed && parsed.error) || parsed || {};
            sendError(err.code || 'upstream_error', err.message || s, sink.statusCode || 500);
          } catch {
            sendError('upstream_error', s.slice(0, 500), sink.statusCode || 500);
          }
        }
      });

      const waitForSink = new Promise((resolve) => {
        if (sink.writableEnded || sink.finished) return resolve();
        sink.once('finish', resolve);
        sink.once('close', resolve);
        reqAc.signal.addEventListener('abort', resolve, { once: true });
      });

      const t0 = Date.now();
      try {
        // handle() 同步注册好 data/end 监听后才挂起在 await readBody 上，
        // 所以紧接着 emitBody() 就能把请求体喂进去。
        const done = adapter.handle(rq, sink, keyName);
        rq.emitBody();
        await done;
        await waitForSink;
      } catch (e) {
        log('[ws] 适配层异常: %s', e.message);
        if (!closed) sendError('internal_error', e.message, 500);
      } finally {
        activeAbortControllers.delete(reqAc);
        if (keyAcquired && sessionRouter && typeof sessionRouter.releaseKey === 'function') {
          sessionRouter.releaseKey(keyId);
        }
      }
      // 注意：这里**不**关连接——客户端收到 response.completed 自己结束本轮读取，
      // 连接留着复用。提前 Close 会被当成 "closed before response.completed" 报错。
      if (!closed) {
        log('[ws] response.create 处理完成 %dms', Date.now() - t0);
      }
    }
  });
}

module.exports = { attachResponsesWs, acceptKey, encodeFrame, WsParser };
