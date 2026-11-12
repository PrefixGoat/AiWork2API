#!/usr/bin/env node
'use strict';
/**
 * Responses WebSocket 协议自检（对应 Codex Desktop 的 stream_responses_websocket）
 *
 * 测什么：
 *   [1] 握手 101 + Sec-WebSocket-Accept 正确
 *   [2] response.create（旧模型名）→ 回落生效，事件流 response.created → ... → response.completed
 *   [3] 同一条连接上第二个 response.create（连接复用，Codex 会这么干）
 *   [4] 不带鉴权头 → 401
 *   [5] 错误路径（非 /responses 的 upgrade）→ 404
 *
 * 用法：
 *   node tests/ws-test.js
 *   BASE=ws://127.0.0.1:18080/v1/responses KEY=sk-xxx MODEL=deepseek-flash node tests/ws-test.js
 */
const net = require('net');
const crypto = require('crypto');
const { URL } = require('url');

const BASE = process.env.BASE || 'ws://127.0.0.1:18080/v1/responses';
const KEY = process.env.KEY || 'sk-docker-test-001';
const MODEL = process.env.MODEL || 'gpt-6.1-sol';   // 故意用旧模型名，验证回落
const FALLBACK_EXPECT = process.env.FALLBACK_EXPECT || '';  // 可选：断言实际模型

const u = new URL(BASE);
const results = [];
function ok(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

// ---------- 极简 WS 客户端 ----------
function connect(path, extraHeaders) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(Number(u.port || 80), u.hostname, () => {
      const hdrs = [
        `GET ${path} HTTP/1.1`,
        `Host: ${u.host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        'OpenAI-Beta: responses_websockets=2026-02-06',
      ];
      for (const [k, v] of Object.entries(extraHeaders || {})) hdrs.push(`${k}: ${v}`);
      sock.write(hdrs.join('\r\n') + '\r\n\r\n');
    });
    sock.once('error', reject);
    let buf = Buffer.alloc(0);
    let handshakeDone = false;
    const parserState = { buf: Buffer.alloc(0), fragments: [], fragOpcode: 0, frames: [], waiter: null };

    sock.on('data', (d) => {
      if (!handshakeDone) {
        buf = Buffer.concat([buf, d]);
        const idx = buf.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const head = buf.slice(0, idx).toString('utf8');
        const rest = buf.slice(idx + 4);
        handshakeDone = true;
        const status = Number((head.split('\r\n')[0].match(/^HTTP\/1\.1 (\d+)/) || [])[1] || 0);
        const accept = (head.match(/sec-websocket-accept:\s*(.+)/i) || [])[1];
        const expectAccept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        resolve({
          sock, status, accept: (accept || '').trim(), expectAccept, head,
          frames: parserState.frames,
          send(obj) {
            const payload = Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8');
            const mask = crypto.randomBytes(4);
            let header;
            const len = payload.length;
            if (len < 126) { header = Buffer.alloc(2); header[1] = 0x80 | len; }
            else if (len < 65536) { header = Buffer.alloc(4); header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
            else { header = Buffer.alloc(10); header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
            header[0] = 0x81;
            const body = Buffer.allocUnsafe(len);
            for (let i = 0; i < len; i++) body[i] = payload[i] ^ mask[i & 3];
            sock.write(Buffer.concat([header, mask, body]));
          },
          close() { try { sock.destroy(); } catch { /* ignore */ } },
        });
        if (rest.length) feed(parserState, rest);
        return;
      }
      feed(parserState, d);
    });

    function feed(st, chunk) {
      st.buf = st.buf.length ? Buffer.concat([st.buf, chunk]) : chunk;
      for (;;) {
        if (st.buf.length < 2) return;
        const b0 = st.buf[0], b1 = st.buf[1];
        const fin = (b0 & 0x80) !== 0, opcode = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
        let len = b1 & 0x7f, off = 2;
        if (len === 126) { if (st.buf.length < 4) return; len = st.buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (st.buf.length < 10) return; len = Number(st.buf.readBigUInt64BE(2)); off = 10; }
        let mask = null;
        if (masked) { if (st.buf.length < off + 4) return; mask = st.buf.slice(off, off + 4); off += 4; }
        if (st.buf.length < off + len) return;
        let payload = st.buf.slice(off, off + len);
        st.buf = st.buf.slice(off + len);
        if (mask) {
          const out = Buffer.allocUnsafe(len);
          for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
          payload = out;
        }
        if (opcode === 0x8) { st.frames.push({ type: 'close', payload }); return; }
        if (opcode === 0x9) continue; // ping
        if (opcode === 0xA) continue; // pong
        if (opcode === 0x0) { st.fragments.push(payload); if (!fin) continue; payload = Buffer.concat(st.fragments); st.fragments = []; }
        else { st.fragments = [payload]; if (!fin) continue; payload = st.fragments[0]; st.fragments = []; }
        st.frames.push({ type: 'text', text: payload.toString('utf8') });
      }
    }
  });
}

function waitForFrames(conn, pred, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      const hit = conn.frames.find(pred);
      if (hit) { clearInterval(timer); resolve(hit); }
      else if (Date.now() - t0 > timeoutMs) { clearInterval(timer); resolve(null); }
    }, 25);
  });
}

function eventsOf(conn) {
  return conn.frames
    .filter((f) => f.type === 'text')
    .map((f) => { try { return JSON.parse(f.text); } catch { return { type: 'unparsed' }; } });
}

async function main() {
  console.log(`WS 自检 ${BASE}  key=${KEY}  model=${MODEL}`);
  const headers = { Authorization: `Bearer ${KEY}` };

  // [1] 握手
  let conn = await connect('/v1/responses', headers);
  ok('[1] 握手返回 101', conn.status === 101, `status=${conn.status}`);
  ok('[1] Sec-WebSocket-Accept 正确', conn.accept === conn.expectAccept, conn.accept.slice(0, 12) + '…');

  // [2] 旧模型名 → 回落 + 事件流
  const req = {
    type: 'response.create',
    model: MODEL,
    instructions: '',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '只回答两个字：好了' }] }],
    tool_choice: 'auto',
    parallel_tool_calls: true,
    store: false,
    stream: true,
    include: [],
  };
  conn.send(req);
  const done1 = await waitForFrames(conn, (f) => {
    if (f.type !== 'text') return false;
    try { return JSON.parse(f.text).type === 'response.completed'; } catch { return false; }
  }, 90000);
  const evs1 = eventsOf(conn);
  const types1 = evs1.map((e) => e.type);
  ok('[2] 收到 response.created', types1.includes('response.created'), types1.slice(0, 3).join(' → '));
  ok('[2] 收到 response.completed', !!done1, `事件数 ${types1.length}`);
  const text1 = evs1.filter((e) => e.type === 'response.output_text.delta').map((e) => e.delta).join('');
  ok('[2] 有正文输出', text1.length > 0, JSON.stringify(text1.slice(0, 40)));
  const model1 = (evs1.find((e) => e.type === 'response.completed') || {}).response;
  const usedModel = model1 && model1.model;
  if (FALLBACK_EXPECT) {
    ok('[2] 回落到 ' + FALLBACK_EXPECT, usedModel === FALLBACK_EXPECT, `实际 ${usedModel}`);
  } else {
    console.log(`      （实际使用模型: ${usedModel}）`);
  }

  // [3] 同连接第二个请求（连接复用）
  const before = conn.frames.length;
  conn.send(Object.assign({}, req, {
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '再回两个字：收到' }] }],
  }));
  const done2 = await waitForFrames(conn, (f) => {
    if (f.type !== 'text') return false;
    try {
      const e = JSON.parse(f.text);
      return e.type === 'response.completed' && conn.frames.indexOf(f) >= before;
    } catch { return false; }
  }, 90000);
  const evs2 = conn.frames.slice(before).filter((f) => f.type === 'text').map((f) => { try { return JSON.parse(f.text); } catch { return {}; } });
  const text2 = evs2.filter((e) => e.type === 'response.output_text.delta').map((e) => e.delta).join('');
  ok('[3] 复用连接的第二轮完成', !!done2, JSON.stringify(text2.slice(0, 40)));
  conn.close();

  // [4] 无鉴权
  try {
    const bad = await connect('/v1/responses', {});
    ok('[4] 无鉴权被拒', bad.status === 401, `status=${bad.status}`);
    bad.close();
  } catch (e) {
    ok('[4] 无鉴权被拒', true, '连接直接断开');
  }

  // [5] 错误路径
  try {
    const wrong = await connect('/v1/other', headers);
    ok('[5] 非 /responses 路径 404', wrong.status === 404, `status=${wrong.status}`);
    wrong.close();
  } catch (e) {
    ok('[5] 非 /responses 路径 404', true, '连接直接断开');
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  if (failed.length) { console.log('失败项：'); failed.forEach((f) => console.log('  -', f.name, f.detail || '')); process.exit(1); }
  console.log('全部通过 ✓');
  process.exit(0);
}

main().catch((e) => { console.error('自检异常:', e); process.exit(1); });
