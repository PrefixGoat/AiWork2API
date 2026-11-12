/**
 * test-bridge-image-and-docs.js
 * 
 * Issue #09 验收测试：
 * 1. Dockerfile 仅桥接层校验（无官方 CLI 下载、无 python3、无智能体种子、包含许可证）
 * 2. scripts/entrypoint.sh 直连干净启动（无守护进程循环）与智能体模式实验隔离提示
 * 3. docker-compose.yml 宿主机端口默认安全回环（127.0.0.1）与官方目录只读挂载 (:ro)
 * 4. 实验智能体模式子进程安全：有界 stderr 消费（防卡死）、超时终止与客户端断连终止清理
 * 5. 公开文档与代码实现真实行为完全同步（无未验 JWT、无正文落盘、无自动跨模式回落）
 * 6. 构建上下文排除 .scratch/ 与凭据泄露防护
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { runChat } = require('../src/api-bridge');

const ROOT_DIR = path.resolve(__dirname, '..');

async function test1_DockerfileBridgeOnly() {
  console.log('[Test 1] 校验 Dockerfile 仅桥接层规范 (ADR-0005)...');
  const dockerfilePath = path.join(ROOT_DIR, 'Dockerfile');
  assert.ok(fs.existsSync(dockerfilePath), 'Dockerfile 必须存在');
  const content = fs.readFileSync(dockerfilePath, 'utf-8');

  // 严禁包含官方 CLI 下载与安装
  assert.ok(!content.includes('install-aiwork.sh'), '正式镜像不得包含 install-aiwork.sh 下载执行');
  assert.ok(!content.includes('aiwork-dl.dtagi.cn'), '正式镜像不得包含官方 CLI 下载域名');
  assert.ok(!content.includes('python3'), '桥接层不需要 python3');
  assert.ok(!content.includes('/opt/agentix-seed'), '正式镜像不得包含 /opt/agentix-seed 智能体初始化种子');
  assert.ok(!content.includes('aiworkcn --version'), '正式镜像不得依赖官方 CLI 存在性校验');

  // 必须包含许可证与必要组件
  assert.ok(content.includes('node:22-bookworm-slim'), '基底镜像使用 node:22-bookworm-slim');
  assert.ok(content.includes('COPY LICENSE THIRD-PARTY-NOTICES.md'), '必须拷贝开源许可与第三方通知');
  assert.ok(content.includes('COPY src/ /app/src/'), '必须拷贝 src/ 代码');
  assert.ok(content.includes('COPY scripts/ /app/scripts/'), '必须拷贝 scripts/ 脚本');
  assert.ok(content.includes('ENTRYPOINT ["/usr/bin/tini", "--", "/app/scripts/entrypoint.sh"]'), '使用 tini PID 1 入口');

  console.log('  ✓ Dockerfile 满足纯净桥接镜像规范');
}

async function test2_EntrypointBridgeOnly() {
  console.log('[Test 2] 校验 entrypoint.sh 启动逻辑规范...');
  const entrypointPath = path.join(ROOT_DIR, 'scripts', 'entrypoint.sh');
  assert.ok(fs.existsSync(entrypointPath), 'scripts/entrypoint.sh 必须存在');
  const content = fs.readFileSync(entrypointPath, 'utf-8');

  // 直连模式纯净
  assert.ok(!content.includes('watchdog'), '直连启动不得包含后台守护进程 watchdog');
  assert.ok(!content.includes('/opt/agentix-seed'), '直连启动不得包含智能体种子复制');
  assert.ok(content.includes('exec node /app/src/api-bridge.js'), '直连模式直接执行桥接层');

  // 智能体模式实验警告
  assert.ok(content.includes('[WARN] 实验智能体模式已启用'), '实验模式必须输出安全副作用警告');
  assert.ok(content.includes('command -v "$CLI"'), '实验模式必须校验 CLI 是否挂载存在');

  console.log('  ✓ entrypoint.sh 直连纯净启动与实验模式隔离逻辑正常');
}

async function test3_DockerComposeLoopbackDefaultAndDecoupling() {
  console.log('[Test 3] 校验 docker-compose.yml 回环默认与数据卷解耦...');
  const composePath = path.join(ROOT_DIR, 'docker-compose.yml');
  assert.ok(fs.existsSync(composePath), 'docker-compose.yml 必须存在');
  const content = fs.readFileSync(composePath, 'utf-8');

  // 宿主机端口发布默认必须为 127.0.0.1 回环
  assert.ok(content.includes('${PUBLISH_ADDR:-127.0.0.1}'), '宿主机端口发布默认必须绑定 127.0.0.1 回环地址');
  assert.ok(!content.includes('${PUBLISH_ADDR:-0.0.0.0}'), '宿主机端口发布不得默认绑定 0.0.0.0');

  // 网关数据卷独立持久化，CLI 目录只读挂载
  assert.ok(content.includes('gateway-data:/data'), '网关数据卷独立持久化于 /data');
  assert.ok(content.includes(':ro'), '官方 CLI 目录必须包含只读 (:ro) 挂载说明');
  // ADR-0012：默认不传 ADMIN_PASSWORD（管理权限随调用凭据），但必须保留启用说明。
  // 旧断言只检查字符串存在，注释掉的那一行也能让它通过，等于没有守护。
  const activeAdminPwd = content
    .split('\n')
    .filter((line) => /^\s*ADMIN_PASSWORD\s*:/.test(line));
  assert.strictEqual(
    activeAdminPwd.length, 0,
    `compose 默认不得启用 ADMIN_PASSWORD（ADR-0012），实际存在未注释的配置行：${activeAdminPwd.join(' | ')}`
  );
  assert.ok(
    /#\s*ADMIN_PASSWORD\s*:/.test(content),
    'compose 必须保留 ADMIN_PASSWORD 的启用说明（取消注释即可加固）'
  );

  // 淘汰过时配置
  assert.ok(!content.includes('UPSTREAM_FALLBACK:'), 'compose 不得包含已废弃的 UPSTREAM_FALLBACK');
  assert.ok(!content.includes('AUTH_ACCEPT_CHATGPT:'), 'compose 不得包含已移除的 AUTH_ACCEPT_CHATGPT');

  console.log('  ✓ docker-compose.yml 满足安全回环与卷解耦规范');
}

async function test4_ExperimentalAgentSubprocessSafety() {
  console.log('[Test 4] 校验实验模式子进程管道安全、超时与断连清理...');
  const tmpDir = path.join(ROOT_DIR, '.scratch', 'v1', 'scratch', `test-agent-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  // 1) 测试有界 stderr 消费：子进程持续向 stderr 输出 200KB 数据，若不消费会堵塞 64KB OS 管道
  const floodStderrScript = path.join(tmpDir, 'mock-flood-stderr.js');
  fs.writeFileSync(floodStderrScript, `
    // 输出大量 stderr
    const chunk = "E".repeat(1024);
    for (let i = 0; i < 200; i++) {
      process.stderr.write(chunk);
    }
    // 随后输出合法 NDJSON 完成帧
    process.stdout.write(JSON.stringify({ event: { name: 'stream.completed', data: { final_text: 'ok from flood' } } }) + "\\n");
    process.exit(0);
  `);

  const res1 = await new Promise((resolve) => {
    let capturedFinal = '';
    let capturedStderr = '';
    runChat('sess-flood', 'hi', {
      onText: () => {},
      onFinalText: (t) => { capturedFinal = t; },
      onModel: () => {},
      onError: (e) => {},
      onClose: (code, usage, completed, model, stderr) => {
        capturedStderr = stderr;
        resolve({ code, capturedFinal, capturedStderr });
      },
    }, {
      cliBin: process.execPath,
      distArgs: [floodStderrScript],
      timeoutMs: 5000,
    });
  });

  assert.strictEqual(res1.code, 0, '子进程应当正常退出，未被 200KB stderr 管道阻塞');
  assert.strictEqual(res1.capturedFinal, 'ok from flood', '输出帧被成功接收');
  assert.ok(res1.capturedStderr.length <= 65536 + 100, 'stderr 消费必须被限制在 64KB 上限范围内');
  assert.ok(res1.capturedStderr.includes('[stderr truncated]'), '超出 64KB 部分必须截断并带有标记');

  // 2) 测试子进程超时保护
  const hangScript = path.join(tmpDir, 'mock-hang.js');
  fs.writeFileSync(hangScript, `
    // 永远挂起
    setInterval(() => {}, 1000);
  `);

  const res2 = await new Promise((resolve) => {
    let timedOutError = '';
    let errorCount = 0;
    const child = runChat('sess-hang', 'hi', {
      onText: () => {},
      onFinalText: () => {},
      onModel: () => {},
      onError: (e) => { errorCount += 1; timedOutError = e; },
      onClose: (code, usage, completed, model, stderr, failed) => {
        resolve({ code, timedOutError, errorCount, failed, killed: child.killed });
      },
    }, {
      cliBin: process.execPath,
      distArgs: [hangScript],
      timeoutMs: 500, // 500ms 超时
    });
  });

  assert.ok(res2.timedOutError.includes('subprocess idle for 500ms'), '必须触发空闲超时错误');
  assert.ok(res2.killed, '超时后子进程必须被强制 kill');
  // 超时后子进程还会触发一次 close：必须只报一次错，并把「已失败」传给 onClose，
  // 否则调用方会在错误帧之后再补 finish_reason:'stop' + [DONE]（规范 2）。
  assert.strictEqual(res2.errorCount, 1, `超时只应报一次错误，实际 ${res2.errorCount} 次`);
  assert.strictEqual(res2.failed, true, 'onClose 必须收到 failed=true，调用方据此不写成功帧');

  // 2b) 空闲超时按「有没有新输出」计时：持续输出的长任务不能被总时长上限误杀
  const chattyScript = path.join(tmpDir, 'mock-chatty.js');
  fs.writeFileSync(chattyScript, `
    // 每 100ms 输出一次，共 1.2 秒——总时长超过 500ms 的空闲阈值，但间隔始终只有 100ms
    let count = 0;
    const timer = setInterval(() => {
      count++;
      process.stdout.write(JSON.stringify({ event: { name: 'stream.text_delta', data: { text: "c" + count } } }) + "\\n");
      if (count >= 12) {
        clearInterval(timer);
        process.stdout.write(JSON.stringify({ event: { name: 'stream.completed', data: { final_text: 'done' } } }) + "\\n");
        process.exit(0);
      }
    }, 100);
  `);

  const res2b = await new Promise((resolve) => {
    let err = '';
    let finalText = '';
    const child = runChat('sess-chatty', 'hi', {
      onText: () => {},
      onFinalText: (t) => { finalText = t; },
      onModel: () => {},
      onError: (e) => { err = e; },
      onClose: (code) => resolve({ code, err, finalText, killed: child.killed }),
    }, {
      cliBin: process.execPath,
      distArgs: [chattyScript],
      timeoutMs: 500,
    });
  });
  assert.strictEqual(res2b.err, '', `持续有输出的任务不应被判空闲超时：${res2b.err}`);
  assert.strictEqual(res2b.code, 0, '持续输出的任务应正常结束');
  assert.strictEqual(res2b.finalText, 'done', '持续输出的任务应拿到完成帧');

  // 2c) stderr 不算「活动」：卡在等上游的进程可以无限打重试日志，
  //     若 stderr 也重置空闲计时，超时就永远不触发（等于没有超时）。
  const stderrNoiseScript = path.join(tmpDir, 'mock-stderr-noise.js');
  fs.writeFileSync(stderrNoiseScript, `
    // 只打 stderr，永不产出 stdout
    setInterval(() => { process.stderr.write('retrying upstream...\\n'); }, 80);
  `);

  const res2c = await new Promise((resolve) => {
    let err = '';
    const child = runChat('sess-stderr-noise', 'hi', {
      onText: () => {},
      onFinalText: () => {},
      onModel: () => {},
      onError: (e) => { err = e; },
      onClose: (code, usage, completed, model, stderr, failed) => resolve({ err, failed, killed: child.killed }),
    }, {
      cliBin: process.execPath,
      distArgs: [stderrNoiseScript],
      timeoutMs: 400,
    });
  });
  assert.ok(res2c.err.includes('subprocess idle for 400ms'), `stderr 心跳不得阻止空闲超时，实际：${res2c.err || '(未触发)'}`);
  assert.strictEqual(res2c.failed, true, 'stderr 心跳场景同样要标记 failed');

  // 3) 测试客户端断连信号传播清理
  const slowScript = path.join(tmpDir, 'mock-slow.js');
  fs.writeFileSync(slowScript, `
    // 每 200ms 输出一次，持续 10 秒
    let count = 0;
    setInterval(() => {
      count++;
      process.stdout.write(JSON.stringify({ event: { name: 'stream.text_delta', data: { text: "chunk " + count } } }) + "\\n");
    }, 200);
  `);

  const controller = new AbortController();
  const res3 = await new Promise((resolve) => {
    let receivedChunks = 0;
    const child = runChat('sess-abort', 'hi', {
      onText: () => {
        receivedChunks++;
        if (receivedChunks === 2) {
          // 模拟下游客户端主动断开连接，触发 abort 信号
          controller.abort();
        }
      },
      onFinalText: () => {},
      onModel: () => {},
      onError: () => {},
      onClose: (code) => {
        resolve({ code, receivedChunks, killed: child.killed });
      },
    }, {
      cliBin: process.execPath,
      distArgs: [slowScript],
      signal: controller.signal,
      timeoutMs: 10000,
    });
  });

  assert.strictEqual(res3.receivedChunks, 2, '在第 2 个 chunk 时断开');
  assert.ok(res3.killed, '收到 abort 信号后子进程必须被终止');

  // 清理临时文件
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  console.log('  ✓ 实验智能体模式子进程管道有界、超时杀进程与断连清理测试全部通过');
}

async function test5_DocumentationSynchronization() {
  console.log('[Test 5] 校验文档与实现实际行为完全同步...');
  const readme = fs.readFileSync(path.join(ROOT_DIR, 'README.md'), 'utf-8');
  const privacy = fs.readFileSync(path.join(ROOT_DIR, 'PRIVACY.md'), 'utf-8');
  const security = fs.readFileSync(path.join(ROOT_DIR, 'SECURITY.md'), 'utf-8');
  const compliance = fs.readFileSync(path.join(ROOT_DIR, 'COMPLIANCE.md'), 'utf-8');
  const envExample = fs.readFileSync(path.join(ROOT_DIR, '.env.example'), 'utf-8');

  // 1) 严禁存在接受未签名 JWT 的过时说法
  for (const [name, doc] of [['README.md', readme], ['PRIVACY.md', privacy], ['SECURITY.md', security], ['COMPLIANCE.md', compliance], ['.env.example', envExample]]) {
    assert.ok(!doc.includes('AUTH_ACCEPT_CHATGPT=1 时额外接受'), `${name} 不得宣称支持 AUTH_ACCEPT_CHATGPT 未签名 JWT`);
    assert.ok(!doc.includes('当前实现不验证其签名'), `${name} 不得包含未验证签名的后门说明`);
  }

  // 2) 严禁宣称直连自动跨模式降级到智能体
  assert.ok(!readme.includes('`UPSTREAM_FALLBACK=1`（默认）时，直连失败会自动落到 agent'), 'README.md 不得宣称直连自动回落到 agent');
  assert.ok(!envExample.includes('UPSTREAM_FALLBACK=1'), '.env.example 不得推荐开启 UPSTREAM_FALLBACK');
  assert.ok(!compliance.includes('默认开启的失败回落可能将直连请求交给本地智能体'), 'COMPLIANCE.md 不得包含直连默认自动回落说明');

  // 3) 严禁宣称首条消息摘要或正文持久化到 usage-state.json
  assert.ok(!privacy.includes('首条用户消息前 40 个字符形成的摘要'), 'PRIVACY.md 不得宣称保存首条用户消息摘要');
  assert.ok(privacy.includes('默认严禁持久化任何聊天正文、提示词原文或首条消息文字摘要'), 'PRIVACY.md 必须明确零正文隐私保证');

  // 4) 鉴权边界与回环默认的文档一致性（ADR-0012：默认无口令，口令是可选加固）
  assert.ok(readme.includes('ADMIN_PASSWORD'), 'README.md 必须包含 ADMIN_PASSWORD 说明');
  assert.ok(readme.includes('PUBLISH_ADDR=127.0.0.1'), 'README.md 必须包含默认安全回环说明');
  assert.ok(envExample.includes('PUBLISH_ADDR=127.0.0.1'), '.env.example 必须默认配置 127.0.0.1 回环');
  // 不能只断言「出现过这个字符串」：注释掉或给个非空默认值都会让 ADR-0012 失真。
  const activeAdminPwdLine = envExample
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^ADMIN_PASSWORD\s*=/.test(line));
  assert.strictEqual(activeAdminPwdLine.length, 1, '.env.example 应有且仅有一行 ADMIN_PASSWORD 赋值');
  assert(
    /^ADMIN_PASSWORD\s*=\s*(""|'')?\s*$/.test(activeAdminPwdLine[0]),
    `.env.example 的 ADMIN_PASSWORD 默认必须为空（ADR-0012），实际：${activeAdminPwdLine[0]}`
  );
  assert.ok(security.includes('默认安全回环监听'), 'SECURITY.md 必须包含回环安全说明');
  assert.ok(
    !readme.includes('严格物理隔离'),
    'README.md 不得再宣称管理权限与调用凭据「严格物理隔离」（ADR-0012 已改为随调用凭据授予）'
  );
  assert.ok(!/\(`?\/admin`?\)/.test(readme), 'README.md 不得再指向不存在的 /admin 路由（控制台就在 / 的 TAB 里）');

  console.log('  ✓ 公开文档与代码实现严格一致');
}

async function test6_CleanReleaseAndAcceptanceTemplate() {
  console.log('[Test 6] 校验构建排他性与验收记录模板...');
  const dockerignore = fs.readFileSync(path.join(ROOT_DIR, '.dockerignore'), 'utf-8');
  assert.ok(dockerignore.includes('.scratch/'), '.dockerignore 必须排除 .scratch/');
  assert.ok(dockerignore.includes('.git'), '.dockerignore 必须排除 .git');
  assert.ok(dockerignore.includes('.env'), '.dockerignore 必须排除 .env');
  assert.ok(dockerignore.includes('tests/'), '.dockerignore 必须排除 tests/');

  const reportPath = path.join(ROOT_DIR, 'docs', 'acceptance', 'v1-acceptance-report.md');
  assert.ok(fs.existsSync(reportPath), 'v1-acceptance-report.md 验收报告模板必须存在');
  const report = fs.readFileSync(reportPath, 'utf-8');
  assert.ok(report.includes('离线模拟上游回归测试矩阵'), '验收报告模板必须明确离线模拟测试');
  assert.ok(report.includes('获授权环境的真实客户端烟测矩阵'), '验收报告模板必须明确获授权环境烟测');
  assert.ok(report.includes('未验证'), '验收报告必须对未在真实环境执行的项目明确标注');

  console.log('  ✓ 构建排他性与验收记录模板完备');
}

async function main() {
  console.log('================================================================');
  console.log('开始执行 Issue #09 验收测试：桥接层镜像、回环默认、智能体安全与文档');
  console.log('================================================================\n');

  try {
    await test1_DockerfileBridgeOnly();
    await test2_EntrypointBridgeOnly();
    await test3_DockerComposeLoopbackDefaultAndDecoupling();
    await test4_ExperimentalAgentSubprocessSafety();
    await test5_DocumentationSynchronization();
    await test6_CleanReleaseAndAcceptanceTemplate();

    console.log('\n================================================================');
    console.log('Issue #09 所有测试用例 100% 通过！');
    console.log('================================================================');
    process.exit(0);
  } catch (err) {
    console.error('\n❌ Issue #09 测试失败:', err);
    process.exit(1);
  }
}

main();
