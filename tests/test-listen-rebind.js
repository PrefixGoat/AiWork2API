'use strict';
/**
 * 回归测试：监听地址可在设置页修改并立即重绑（票 02）。
 *
 * 契约：
 *   - 地址存在 gateway-config.json 的 bind_address，启动时优先于 env BIND；
 *   - 保存后立即重绑：新地址能连上控制台，旧地址不再接受新连接，在途请求不被打断；
 *   - 绑定失败（格式非法 / 地址不属于本机 / 被占用）不落盘、不动现有监听，返回可读 4xx；
 *   - 重绑后 WebSocket upgrade 仍能握手成功；
 *   - 重绑过多次后收到 SIGTERM 仍能干净退出：所有 server 关掉、归档队列写完，不靠强退；
 *   - 端口仍由 PORT 决定，页面拿不到也改不了。
 *
 * 断言只落在 HTTP / TCP 这两个公开界面上，不碰内部实现，重构不该让它们变红。
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const TMP_DIR = path.join(os.tmpdir(), `aiwork-listen-rebind-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
fs.mkdirSync(TMP_DIR, { recursive: true });
process.on('exit', () => {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
});

const DATA_DIR = path.join(TMP_DIR, 'data');
const ADMIN_PASS = 'TestRebindPass123!';
const API_KEY = 'sk-rebind-client';
const PORT = 19800 + Math.floor(Math.random() * 150);
const CFG_PATH = path.join(DATA_DIR, 'gateway-config.json');

const children = [];
process.on('exit', () => { for (const c of children) { try { c.kill('SIGKILL'); } catch (_) {} } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request(host, method, urlPath, body = null, headers = {}, port = PORT) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, method, path: urlPath, headers, timeout: 10000 }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(d); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, json, text: d });
      });
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    if (body != null) {
      req.setHeader('Content-Type', 'application/json');
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

/** 只问一件事：这个地址这台端口现在能不能建立 TCP 连接。 */
function canConnect(host, timeoutMs = 1500, port = PORT) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok) => { try { sock.destroy(); } catch (_) {} resolve(ok); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

/** 原始 WS 握手：只断言状态行，不跑帧逻辑（帧逻辑由 ws-test.js 覆盖）。 */
function wsHandshake(host, token) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port: PORT }, () => {
      sock.write([
        'GET /v1/responses HTTP/1.1',
        `Host: ${host}:${PORT}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${Buffer.from(String(Math.random())).toString('base64')}`,
        'Sec-WebSocket-Version: 13',
        `Authorization: Bearer ${token}`,
        '', '',
      ].join('\r\n'));
    });
    let buf = '';
    const finish = (status) => { try { sock.destroy(); } catch (_) {} resolve(status); };
    sock.setTimeout(4000, () => finish(0));
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      const head = buf.split('\r\n')[0] || '';
      const m = head.match(/^HTTP\/1\.1 (\d{3})/);
      if (m) finish(Number(m[1]));
    });
    sock.on('error', () => finish(0));
  });
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const it of list || []) {
      if (it.family === 'IPv4' && !it.internal) out.push(it.address);
    }
  }
  return out;
}

function startGateway(env = {}) {
  const state = { logs: '' };
  const proc = cp.fork(path.join(__dirname, '..', 'src', 'api-bridge.js'), [], {
    env: {
      ...process.env,
      PORT: String(PORT), BIND: '127.0.0.1',
      ADMIN_PASSWORD: ADMIN_PASS, API_KEYS: `${API_KEY}:rebind-client`,
      GATEWAY_DATA_DIR: DATA_DIR,
      STATE_PATH: path.join(DATA_DIR, 'usage-state.json'),
      AGENTIX_STATE_DIR: path.join(TMP_DIR, 'nonexistent-default-state'),
      QUIET: '1', LOG_LEVEL: 'error',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  proc.stdout.on('data', (d) => { state.logs += d; });
  proc.stderr.on('data', (d) => { state.logs += d; });
  state.proc = proc;
  children.push(proc);
  return state;
}

async function waitReady(state, port = PORT) {
  for (let i = 0; i < 80; i++) {
    try { if ((await request('127.0.0.1', 'GET', '/healthz', null, {}, port)).status === 200) return; } catch (_) {}
    await sleep(150);
  }
  assert.fail(`网桥未能在预期时间内启动。日志:\n${state.logs.slice(-1500)}`);
}

async function stop(state) {
  if (!state || !state.proc || state.proc.killed) return;
  await new Promise((resolve) => {
    state.proc.once('exit', resolve);
    state.proc.kill('SIGTERM');
    setTimeout(resolve, 4000);
  });
}

async function adminHeaders(port = PORT) {
  const login = await request('127.0.0.1', 'POST', '/api/admin/login', { password: ADMIN_PASS }, {}, port);
  assert.strictEqual(login.status, 200, login.text);
  return { Cookie: login.headers['set-cookie'][0].split(';')[0] };
}

/** 找一个当前空闲的本机端口，用来验证「改端口」这条路径。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function readConfig() {
  if (!fs.existsSync(CFG_PATH)) return null;
  return JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
}

async function run() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let gw = startGateway();
  await waitReady(gw);

  try {
    const headers = await adminHeaders();

    // ---- 1. 默认：用 env BIND，且页面能看到当前生效地址 ----
    const initial = await request('127.0.0.1', 'GET', '/api/settings', null, headers);
    assert.strictEqual(initial.status, 200, initial.text);
    assert.strictEqual(initial.json.settings.bind_address, '127.0.0.1', '默认监听地址应取 env BIND');
    assert(initial.json.effective, '必须下发当前生效地址，否则页面分不清保存值和生效值');
    assert.strictEqual(initial.json.effective.bind_address, '127.0.0.1');
    assert.strictEqual(initial.json.effective.bind_port, PORT, '响应要带上真实端口，页面才能显示 host:port');
    assert.strictEqual(initial.json.container, false, '裸进程要报告「不是容器」，页面据此决定外端口给不给命令');

    // ---- 2. 非法格式：整体拒绝、可读错误、不落盘、旧监听不动 ----
    for (const bad of ['999.1.1.1', 'http://example.com', '127.0.0.1:0', '127.0.0.1:65536', '127.0.0.1:abc', '127.0.0.1:', ':8080', '   ', 'a b']) {
      const res = await request('127.0.0.1', 'PUT', '/api/settings', { bind_address: bad }, headers);
      assert.strictEqual(res.status, 400, `非法监听地址 ${JSON.stringify(bad)} 必须 400，实际 ${res.status} ${res.text}`);
      assert(res.json && res.json.error && res.json.error.message, `400 必须带可读原因：${res.text}`);
      assert(/bind_address|监听地址/.test(res.json.error.message), `错误信息应点明是哪一项：${res.json.error.message}`);
      assert(!readConfig() || readConfig().bind_address === undefined,
        `非法地址不能落盘：${JSON.stringify(readConfig())}`);
      assert.strictEqual((await request('127.0.0.1', 'GET', '/healthz')).status, 200, '旧监听必须继续服务');
    }
    const afterInvalid = await request('127.0.0.1', 'GET', '/api/settings', null, headers);
    assert.strictEqual(afterInvalid.json.effective.bind_address, '127.0.0.1', '非法值不能改变生效地址');

    // ---- 3. 本机没有的地址：绑定失败要回滚，配置不能被改写 ----
    const badBind = await request('127.0.0.1', 'PUT', '/api/settings', { bind_address: '10.255.255.1' }, headers);
    assert(badBind.status >= 400 && badBind.status < 500,
      `绑定失败必须返回 4xx，实际 ${badBind.status} ${badBind.text}`);
    assert(badBind.json && badBind.json.error && badBind.json.error.message, '绑定失败必须带可读原因');
    assert(!readConfig() || readConfig().bind_address === undefined,
      `绑定失败不能落盘：${JSON.stringify(readConfig())}`);
    const afterBadBind = await request('127.0.0.1', 'GET', '/api/settings', null, headers);
    assert.strictEqual(afterBadBind.json.effective.bind_address, '127.0.0.1', '绑定失败后旧监听必须继续生效');
    assert.strictEqual((await request('127.0.0.1', 'GET', '/healthz')).status, 200, '绑定失败后旧地址仍可访问');

    // ---- 3b. 地址被别的进程占着：EADDRINUSE 同样要回滚，不能把网关搞挂 ----
    const lan = lanAddresses()[0];
    if (lan) {
      const blocker = net.createServer(() => {});
      await new Promise((resolve, reject) => {
        blocker.once('error', reject);
        blocker.listen(PORT, lan, resolve);
      });
      try {
        const busy = await request('127.0.0.1', 'PUT', '/api/settings', { bind_address: lan }, headers);
        assert(busy.status >= 400 && busy.status < 500,
          `地址被占用时必须 4xx，实际 ${busy.status} ${busy.text}`);
        assert(/占用|EADDRINUSE/.test(busy.json && busy.json.error && busy.json.error.message || ''),
          `占用失败要说出原因：${busy.text}`);
        assert.strictEqual((await request('127.0.0.1', 'GET', '/healthz')).status, 200,
          '绑定失败后旧监听必须继续服务，进程不能退出');
        assert.strictEqual((await request('127.0.0.1', 'GET', '/api/settings', null, headers)).json.effective.bind_address,
          '127.0.0.1', '绑定失败后生效地址不能变');
      } finally {
        await new Promise((r) => blocker.close(r));
      }
    }

    // ---- 4. 保存 0.0.0.0：立即重绑、落盘、旧地址（被 0.0.0.0 覆盖）仍可访问 ----
    const toAny = await request('127.0.0.1', 'PUT', '/api/settings', { bind_address: '0.0.0.0' }, headers);
    assert.strictEqual(toAny.status, 200, `改成 0.0.0.0 必须成功，实际 ${toAny.status} ${toAny.text}`);
    assert.strictEqual(toAny.json.effective.bind_address, '0.0.0.0', '响应里要带上新的生效地址');

    const afterRebind = await request('127.0.0.1', 'GET', '/api/settings', null, headers);
    assert.strictEqual(afterRebind.json.settings.bind_address, '0.0.0.0', '保存值应为 0.0.0.0');
    assert.strictEqual(afterRebind.json.effective.bind_address, '0.0.0.0', '生效值应立即跟着变，不需要重启');
    const onDisk = readConfig();
    assert(onDisk && onDisk.bind_address === '0.0.0.0', `新地址必须落盘：${JSON.stringify(onDisk)}`);
    assert.strictEqual((await request('127.0.0.1', 'GET', '/healthz')).status, 200, '重绑后必须仍能访问控制台');

    // ---- 5. 重绑后 WebSocket 仍能握手 ----
    assert.strictEqual(await wsHandshake('127.0.0.1', API_KEY), 101, '重绑后 WS 端点必须仍能升级成功');

    // ---- 6. 改回具体地址：旧的通配监听不再接受新连接 ----
    const toLoopback = await request('127.0.0.1', 'PUT', '/api/settings', { bind_address: '127.0.0.1' }, headers);
    assert.strictEqual(toLoopback.status, 200, `改回 127.0.0.1 必须成功，实际 ${toLoopback.status} ${toLoopback.text}`);
    for (const lan of lanAddresses()) {
      assert.strictEqual(
        await canConnect(lan), false,
        `改回只监听回环后，旧的通配地址 ${lan}:${PORT} 不应再接受新连接`
      );
    }
    assert.strictEqual(await canConnect('127.0.0.1'), true, '回环地址必须仍可连接');

    // ---- 7. 重启后沿用已保存的地址，env 只是初始默认值 ----
    await stop(gw);
    assert.strictEqual(readConfig().bind_address, '127.0.0.1');
    // 先把文件里的地址写成 0.0.0.0 的形式，重启验证「文件优先于 env」
    fs.writeFileSync(CFG_PATH, JSON.stringify({ ...readConfig(), bind_address: '0.0.0.0' }, null, 2), 'utf8');

    gw = startGateway({ BIND: '127.0.0.1' });
    await waitReady(gw);
    const headers2 = await adminHeaders();
    const restarted = await request('127.0.0.1', 'GET', '/api/settings', null, headers2);
    assert.strictEqual(restarted.status, 200, restarted.text);
    assert.strictEqual(restarted.json.settings.bind_address, '0.0.0.0', '重启后应读配置文件而不是 env');
    assert.strictEqual(restarted.json.effective.bind_address, '0.0.0.0', '重启后应按已保存地址监听');

    // ---- 7b. 改端口：绑上新端口、旧端口释放、落盘，重启后仍在新端口 ----
    const altPort = await freePort();
    const toPort = await request('127.0.0.1', 'PUT', '/api/settings', { bind_address: `0.0.0.0:${altPort}` }, headers2);
    assert.strictEqual(toPort.status, 200, `改端口必须成功，实际 ${toPort.status} ${toPort.text}`);
    assert.strictEqual(toPort.json.effective.bind_address, `0.0.0.0:${altPort}`, '生效地址要带上新端口');
    assert.strictEqual(toPort.json.effective.bind_port, altPort, '生效端口要跟着变');
    assert.strictEqual((await request('127.0.0.1', 'GET', '/healthz', null, {}, altPort)).status, 200,
      '新端口必须立刻可用');
    assert.strictEqual(await canConnect('127.0.0.1', 1200, PORT), false, '换成新端口后旧端口必须释放');
    assert.strictEqual(readConfig().bind_address, `0.0.0.0:${altPort}`, `带端口的地址必须落盘：${JSON.stringify(readConfig())}`);

    // 重启：env 仍是 PORT/127.0.0.1，配置文件里的端口必须优先
    await stop(gw);
    gw = startGateway({ BIND: '127.0.0.1' });
    await waitReady(gw, altPort);
    const headers3 = await adminHeaders(altPort);
    const restartedPort = await request('127.0.0.1', 'GET', '/api/settings', null, headers3, altPort);
    assert.strictEqual(restartedPort.status, 200, restartedPort.text);
    assert.strictEqual(restartedPort.json.settings.bind_address, `0.0.0.0:${altPort}`, '重启后应沿用配置里的端口');
    assert.strictEqual(restartedPort.json.effective.bind_port, altPort, '重启后应监听配置端口');
    assert.strictEqual(await canConnect('127.0.0.1', 1200, PORT), false, '重启后不该回到 env 的 PORT');

    // 只写地址 = 回到默认端口：保证老配置的语义不变
    const backToDefault = await request('127.0.0.1', 'PUT', '/api/settings', { bind_address: '0.0.0.0' }, headers3, altPort);
    assert.strictEqual(backToDefault.status, 200, `改回默认端口必须成功，实际 ${backToDefault.status} ${backToDefault.text}`);
    assert.strictEqual(backToDefault.json.effective.bind_port, PORT, '不写端口时应回到 env PORT');
    assert.strictEqual((await request('127.0.0.1', 'GET', '/healthz')).status, 200, '默认端口必须恢复可用');
    assert.strictEqual(await canConnect('127.0.0.1', 1200, altPort), false, '改回默认端口后新端口必须释放');

    // ---- 8. 关停：重绑过之后仍要一次干净退出（所有 server 关掉、归档写完再走） ----
    // 先造一条要进归档的记录（/v1/* 才入归档），随后立刻 SIGTERM：
    // 归档队列里可能还压着它，退出前必须等它落盘，而且不能靠强退掐断。
    // Windows 上 child.kill() 是 TerminateProcess（没有 POSIX 信号），观察不到优雅退出，
    // 所以这组断言只在 POSIX 上跑；归档队列写完这一条另有模块级断言（test-request-log-archive A9）。
    if (process.platform === 'win32') {
      console.log('  · 跳过 SIGTERM 关停断言：Windows 无 POSIX 信号，kill 是强杀');
    } else {
      const models = await request('127.0.0.1', 'GET', '/v1/models', null, { Authorization: `Bearer ${API_KEY}` });
      assert.strictEqual(models.status, 200, models.text);

      const exitInfo = await new Promise((resolve) => {
        const startedAt = Date.now();
        gw.proc.once('exit', (code, signal) => resolve({ code, signal, ms: Date.now() - startedAt }));
        gw.proc.kill('SIGTERM');
        setTimeout(() => resolve({ code: 'timeout', signal: null, ms: Date.now() - startedAt }), 6000);
      });
      assert.strictEqual(exitInfo.code, 0, `SIGTERM 后应以 0 退出，实际 ${exitInfo.code}（${exitInfo.ms}ms）`);
      assert(exitInfo.ms < 4500, `关停不应依赖强退兜底，实际耗时 ${exitInfo.ms}ms`);
      assert.strictEqual(await canConnect('127.0.0.1', 600), false, '退出后端口必须释放');

      const logDir = path.join(DATA_DIR, 'logs');
      const archived = fs.existsSync(logDir)
        ? fs.readdirSync(logDir)
          .filter((f) => /^requests-\d{4}-\d{2}-\d{2}(\.part\d+)?\.jsonl$/.test(f))
          .flatMap((f) => fs.readFileSync(path.join(logDir, f), 'utf8').split('\n').filter((l) => l.trim()))
        : [];
      assert(archived.some((line) => line.includes('"/v1/models"')),
        `退出前必须把归档队列写完，实际归档 ${archived.length} 行`);
    }

    console.log('✓ [All Passed] 监听地址：默认生效 / 非法值拒绝（含端口越界）/ 绑定失败回滚 / 保存即重绑 / 改端口与重启沿用 / WS 仍握手 / 关停干净');
  } finally {
    await stop(gw);
  }
}

run().catch((err) => {
  console.error('测试失败:', err.message);
  process.exit(1);
});
