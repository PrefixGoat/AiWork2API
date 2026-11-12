/**
 * test-deployment-entrypoints.js
 *
 * 部署入口的行为契约：
 * 1. quickstart.sh 能识别官方 CLI 两种常见状态目录（~/.local/share/agentix、~/.agentix），
 *    并把识别到的路径写进 .env 的 AGENTIX_HOST_STATE_DIR
 * 2. start-systemd.sh 同样识别两种目录，并把 AGENTIX_STATE_DIR 写成识别到的路径
 * 3. .env.example 与 docker-compose.yml 暴露的 DEBUG_DUMP_* 变量名必须是源码真正读取的那些
 * 4. AGENTIX_STATE_DIR 指向不存在的目录时必须拒绝启动，且不改写配置
 * 5. 目录名含 sed 特殊字符（&）时，写进 .env 的值要原样保留
 * 6. 目录名含反斜杠时，写进 env 文件的值不能被 awk 的转义解析吞掉
 * 7. 端口被占用时要明确报错，不能静默退出
 * 8. .env 里用户已填的挂载源不能被脚本覆盖
 * 9. Windows 裸机脚本生成的 .env.windows 与 data-windows/ 不会进 git
 *
 * 这些脚本只面向 POSIX shell，没有 bash 的环境跳过并明确提示。
 */

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');

/** 取一个当前空闲的端口，避免撞上本机正在跑的网关（否则端口检查会先失败） */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function hasBash() {
  return spawnSync('bash', ['-c', 'exit 0']).status === 0;
}

/**
 * 造一个临时项目副本，外部命令换成桩，端口换成空闲端口，避免真的构建/启动
 * @param {number} [forcedPort] 指定端口（用于构造端口占用场景）
 */
async function makeFixture(forcedPort) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwork-entrypoint-'));
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });

  for (const f of ['docker-compose.yml', '.env.example']) {
    fs.copyFileSync(path.join(ROOT_DIR, f), path.join(dir, f));
  }
  fs.copyFileSync(path.join(ROOT_DIR, 'scripts', 'quickstart.sh'), path.join(dir, 'scripts', 'quickstart.sh'));
  fs.copyFileSync(path.join(ROOT_DIR, 'scripts', 'start-systemd.sh'), path.join(dir, 'scripts', 'start-systemd.sh'));
  fs.mkdirSync(path.join(dir, 'systemd'), { recursive: true });
  fs.copyFileSync(path.join(ROOT_DIR, 'systemd', 'aiwork-bridge.service'),
    path.join(dir, 'systemd', 'aiwork-bridge.service'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'api-bridge.js'), "console.log('stub');\n");

  // 端口固定成 8080 会让本机开着网关时测试失败，换成一个空闲端口
  const port = forcedPort || await freePort();
  const envExamplePath = path.join(dir, '.env.example');
  const envExample = fs.readFileSync(envExamplePath, 'utf8')
    .replace(/^HOST_PORT=.*$/m, `HOST_PORT=${port}`);
  assert.ok(envExample.includes(`HOST_PORT=${port}`), 'fixture 应把 .env.example 的 HOST_PORT 换成目标端口');
  fs.writeFileSync(envExamplePath, envExample);

  const stubs = {
    docker: [
      '#!/bin/sh',
      'if [ "$1" = "compose" ]; then',
      '  case "$2" in',
      '    version) echo "Docker Compose version v2.0.0"; exit 0 ;;',
      '    ps) exit 0 ;;',
      '    up) [ -n "${AIWORK_TEST_MARKER:-}" ] && echo up >> "$AIWORK_TEST_MARKER"; exit 0 ;;',
      '  esac',
      'fi',
      'exit 0',
    ].join('\n'),
    systemctl: [
      '#!/bin/sh',
      'if [ "$1" = "--user" ]; then',
      '  case "$2" in',
      '    show-environment|daemon-reload|enable|restart) exit 0 ;;',
      '    is-active) exit 1 ;;',
      '  esac',
      'fi',
      'exit 0',
    ].join('\n'),
    loginctl: '#!/bin/sh\nexit 0',
    node: '#!/bin/sh\necho v22.1.0',
    aiworkcn: '#!/bin/sh\nexit 0',
    curl: '#!/bin/sh\necho ok',
  };
  for (const [name, body] of Object.entries(stubs)) {
    const p = path.join(binDir, name);
    fs.writeFileSync(p, body + '\n');
    fs.chmodSync(p, 0o755);
  }

  return { dir, binDir, port };
}

function runScript(fixture, scriptRelPath, homeDir, extraEnv = {}) {
  return spawnSync('bash', [scriptRelPath], {
    cwd: fixture.dir,
    env: {
      ...process.env,
      HOME: homeDir,
      PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH}`,
      ...extraEnv,
    },
    encoding: 'utf8',
  });
}

function mkHome(stateDirRel) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwork-home-'));
  if (stateDirRel) fs.mkdirSync(path.join(home, stateDirRel), { recursive: true });
  return home;
}

function cleanup(...dirs) {
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
  }
}

function envLine(envPath, key) {
  if (!fs.existsSync(envPath)) return null;
  const line = fs.readFileSync(envPath, 'utf8')
    .split('\n').find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() : null;
}

async function test1_QuickstartDetectsDotAgentix() {
  console.log('[Test 1] quickstart 识别 ~/.agentix 并按该路径启用挂载...');
  const fixture = await makeFixture();
  const home = mkHome('.agentix');           // 只有 ~/.agentix，没有 ~/.local/share/agentix
  try {
    const r = runScript(fixture, 'scripts/quickstart.sh', home);
    assert.strictEqual(r.status, 0,
      `quickstart 应以 0 退出，实际 ${r.status}（端口 ${fixture.port}）\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);

    const foundLine = r.stdout.split('\n').find((l) => l.includes('找到登录态目录'));
    assert.ok(foundLine, `应报告找到登录态目录\nstdout:\n${r.stdout}`);
    assert.ok(foundLine.includes('.agentix'), `识别到的目录应是 .agentix，实际这一行：${foundLine}`);

    const hostDir = envLine(path.join(fixture.dir, '.env'), 'AGENTIX_HOST_STATE_DIR');
    assert.ok(hostDir, '.env 应写入 AGENTIX_HOST_STATE_DIR');
    assert.ok(hostDir.endsWith('/.agentix'), `挂载源应指向 .agentix，实际：${hostDir}`);
    assert.ok(!hostDir.endsWith('/.local/share/agentix'),
      `不应误选 .local/share/agentix，实际：${hostDir}`);

    const compose = fs.readFileSync(path.join(fixture.dir, 'docker-compose.yml'), 'utf8');
    assert.ok(compose.includes('${AGENTIX_HOST_STATE_DIR:-~/.local/share/agentix}:/accounts/default:ro'),
      'compose 应保留变量形式的只读挂载，宿主机路径不写进 YAML');
    assert.ok(compose.includes(':/accounts/default:ro'),
      '挂载行默认就是启用的，用户无需取消注释');
  } finally {
    cleanup(fixture.dir, home);
  }
}

async function test2_SystemdScriptDetectsDotAgentix() {
  console.log('[Test 2] start-systemd 识别 ~/.agentix 并写入 AGENTIX_STATE_DIR...');
  const fixture = await makeFixture();
  const home = mkHome('.agentix');
  try {
    const r = runScript(fixture, 'scripts/start-systemd.sh', home);
    assert.strictEqual(r.status, 0,
      `start-systemd 应以 0 退出，实际 ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);

    const envPath = path.join(home, '.config', 'aiwork-gateway.env');
    assert.ok(fs.existsSync(envPath), '应生成 ~/.config/aiwork-gateway.env');
    const value = envLine(envPath, 'AGENTIX_STATE_DIR');
    assert.ok(value, '配置里必须有 AGENTIX_STATE_DIR');
    // bash 与 Node 在 Windows 上对同一目录的写法不同（/tmp/... vs C:\...\Temp\...），
    // 只比较语义：落在 .agentix 上，且没有误选 .local/share/agentix。
    assert.ok(value.endsWith('/.agentix'), `AGENTIX_STATE_DIR 应指向 .agentix，实际：${value}`);
    assert.ok(!value.includes('/.local/share/agentix'), `不应误选 .local/share/agentix，实际：${value}`);

    // 抓包目录也不能留在容器的 /data 上，否则裸机开 DEBUG_DUMP=1 会写盘失败
    const dumpDir = envLine(envPath, 'DUMP_DIR');
    assert.ok(dumpDir && dumpDir.endsWith('/data/gw-logs'),
      `DUMP_DIR 应落在安装目录下，实际：${dumpDir}`);
    assert.ok(!/^\/data\//.test(dumpDir), `DUMP_DIR 不应指向容器的 /data，实际：${dumpDir}`);
  } finally {
    cleanup(fixture.dir, home);
  }
}

function test3_DumpLimitVarsMatchCode() {
  console.log('[Test 3] .env.example 与 compose 的 DEBUG_DUMP_* 变量名与源码一致...');
  const code = fs.readFileSync(path.join(ROOT_DIR, 'src', 'api-bridge.js'), 'utf8');
  const readByCode = new Set(
    [...code.matchAll(/process\.env\.(DEBUG_DUMP[A-Z_]*|DEBUG_CAPTURE)/g)].map((m) => m[1]),
  );
  assert.ok(readByCode.size > 0, '应能从源码提取到 DEBUG_DUMP 变量');

  const envExample = fs.readFileSync(path.join(ROOT_DIR, '.env.example'), 'utf8');
  const templateKeys = [...envExample.matchAll(/^(DEBUG_DUMP[A-Z_]*)=/gm)].map((m) => m[1]);

  const compose = fs.readFileSync(path.join(ROOT_DIR, 'docker-compose.yml'), 'utf8');
  const composeKeys = [...compose.matchAll(/^\s+(DEBUG_DUMP[A-Z_]*):/gm)].map((m) => m[1]);

  const unknown = [...new Set([...templateKeys, ...composeKeys])].filter((k) => !readByCode.has(k));
  assert.deepStrictEqual(unknown, [],
    `配置里出现了源码不读的变量（配了也不会生效）：${unknown.join(', ')}`);

  // 代码会读的三个上限开关，必须都能从 .env 经 compose 传进容器，否则用户没法调
  const limits = ['DEBUG_DUMP_MAX_FILES', 'DEBUG_DUMP_MAX_BYTES', 'DEBUG_DUMP_MAX_AGE_SEC'];
  for (const key of limits) {
    assert.ok(readByCode.has(key), `源码应读取 ${key}`);
    assert.ok(templateKeys.includes(key), `.env.example 应提供 ${key}`);
    assert.ok(composeKeys.includes(key), `docker-compose.yml 应透传 ${key}`);
  }

  // 面向用户的文档里也不能出现假变量名（ADR 属于历史记录，允许引用旧名）
  const publicDocs = [
    'README.md', 'PRIVACY.md', 'SECURITY.md', 'COMPLIANCE.md',
    'docs/README.md', 'docs/api-reference.md', 'docs/configuration.md', 'docs/troubleshooting.md',
    'docs/clients/codex.md', 'docs/clients/claude-code.md',
  ];
  const offenders = [];
  for (const rel of publicDocs) {
    const p = path.join(ROOT_DIR, rel);
    if (!fs.existsSync(p)) continue;
    const text = fs.readFileSync(p, 'utf8');
    for (const m of text.matchAll(/`(DEBUG_DUMP[A-Z_]*)`/g)) {
      if (!readByCode.has(m[1])) offenders.push(`${rel}: ${m[1]}`);
    }
  }
  assert.deepStrictEqual(offenders, [],
    `公开文档里出现了源码不读的抓包变量：\n${offenders.join('\n')}`);
}

async function test4_QuickstartRejectsMissingStateDir() {
  console.log('[Test 4] AGENTIX_STATE_DIR 指向不存在的目录时应拒绝启动...');
  const fixture = await makeFixture();
  const home = mkHome(null);                 // HOME 下一个候选都没有
  const before = fs.readFileSync(path.join(fixture.dir, 'docker-compose.yml'), 'utf8');
  try {
    const r = runScript(fixture, 'scripts/quickstart.sh', home, {
      AGENTIX_STATE_DIR: path.join(home, 'does-not-exist'),
    });
    assert.notStrictEqual(r.status, 0,
      `目录不存在时不应继续启动\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    const output = `${r.stdout}${r.stderr}`;
    assert.ok(output.includes('没有找到登录态目录'), `应明确报告找不到登录态目录，实际输出：\n${output}`);

    const after = fs.readFileSync(path.join(fixture.dir, 'docker-compose.yml'), 'utf8');
    assert.strictEqual(after, before, '失败时不应改写 docker-compose.yml');
  } finally {
    cleanup(fixture.dir, home);
  }
}

async function test5_MountPathWithAmpersandSurvives() {
  console.log('[Test 5] 账号目录名含 & 时 .env 里的挂载源要原样保留...');
  const fixture = await makeFixture();
  const home = mkHome(null);
  const oddRel = 'acc&x';                    // & 在 sed 替换串里是「整个匹配」的反向引用
  fs.mkdirSync(path.join(fixture.dir, oddRel), { recursive: true });
  try {
    const r = runScript(fixture, 'scripts/quickstart.sh', home, { AGENTIX_STATE_DIR: oddRel });
    assert.strictEqual(r.status, 0, `应成功，实际 ${r.status}\n${r.stdout}${r.stderr}`);
    const hostDir = envLine(path.join(fixture.dir, '.env'), 'AGENTIX_HOST_STATE_DIR');
    assert.ok(hostDir && hostDir.endsWith(`acc&x`),
      `挂载源应原样保留 acc&x（& 不能被当替换引用），实际：${hostDir}`);
  } finally {
    cleanup(fixture.dir, home);
  }
}

async function test6_StateDirWithBackslashSurvives() {
  console.log('[Test 6] 账号目录名含反斜杠时 env 值不能被转义解析吞掉...');
  if (process.platform === 'win32') {
    console.log('  跳过：Windows 不允许目录名含反斜杠');
    return;
  }
  const fixture = await makeFixture();
  const home = mkHome(null);
  const oddRel = 'bak\\slash';               // awk -v 会把 \s 解析成 s
  fs.mkdirSync(path.join(fixture.dir, oddRel), { recursive: true });
  try {
    const r = runScript(fixture, 'scripts/start-systemd.sh', home, { AGENTIX_STATE_DIR: oddRel });
    assert.strictEqual(r.status, 0, `应成功，实际 ${r.status}\n${r.stdout}${r.stderr}`);
    const value = envLine(path.join(home, '.config', 'aiwork-gateway.env'), 'AGENTIX_STATE_DIR');
    assert.strictEqual(value, oddRel,
      `AGENTIX_STATE_DIR 应原样写成 ${oddRel}，实际：${value}`);
  } finally {
    cleanup(fixture.dir, home);
  }
}

async function test7_PortBusyFailsLoudly() {
  console.log('[Test 7] 端口被其他程序占用时要明确报错、不继续启动...');
  // 真占住一个端口，让脚本的 /dev/tcp 探测命中
  const holder = net.createServer();
  await new Promise((resolve) => holder.listen(0, '127.0.0.1', resolve));
  const busyPort = holder.address().port;
  const marker = path.join(os.tmpdir(), `aiwork-up-marker-${Date.now()}`);
  try {
    const fixture = await makeFixture(busyPort);
    const home = mkHome('.agentix');
    try {
      const r = runScript(fixture, 'scripts/quickstart.sh', home, { AIWORK_TEST_MARKER: marker });
      const output = `${r.stdout}${r.stderr}`;
      assert.notStrictEqual(r.status, 0,
        `端口被占时应失败，实际 ${r.status}\n输出：\n${output}`);
      assert.ok(output.includes('已被其他程序占用'),
        `应明确说明端口被占（不能静默退出），实际输出：\n${output}`);
      assert.ok(!fs.existsSync(marker), '端口检查失败时不应继续执行 compose up');
    } finally {
      cleanup(fixture.dir, home);
    }
  } finally {
    await new Promise((resolve) => holder.close(resolve));
    cleanup(marker);
  }
}

async function test8_ExistingEnvValueWins() {
  console.log('[Test 8] .env 里已填的挂载源不能被脚本覆盖...');
  const fixture = await makeFixture();
  const home = mkHome('.agentix');
  const custom = path.join(fixture.dir, 'my-state');
  fs.mkdirSync(custom, { recursive: true });
  const envPath = path.join(fixture.dir, '.env');
  fs.writeFileSync(envPath, fs.readFileSync(path.join(fixture.dir, '.env.example'), 'utf8')
    .replace(/^AGENTIX_HOST_STATE_DIR=.*$/m, `AGENTIX_HOST_STATE_DIR=${custom}`));
  try {
    const r = runScript(fixture, 'scripts/quickstart.sh', home);
    assert.strictEqual(r.status, 0, `应成功，实际 ${r.status}\n${r.stdout}${r.stderr}`);
    assert.strictEqual(envLine(envPath, 'AGENTIX_HOST_STATE_DIR'), custom,
      '用户显式填写的挂载源应优先，不能被探测结果改写');
  } finally {
    cleanup(fixture.dir, home);
  }
}

function test9_WindowsArtifactsAreIgnored() {
  console.log('[Test 9] Windows 裸机产物不会进 git，README 给出启动入口...');
  const ignored = (p) => {
    try {
      execFileSync('git', ['check-ignore', '-q', p], { cwd: ROOT_DIR, stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  };
  assert.ok(ignored('.env.windows'), '.env.windows 含调用密钥，必须被 .gitignore 忽略');
  assert.ok(ignored('data-windows/usage-state.json'), 'data-windows/ 必须被 .gitignore 忽略');
  const readme = fs.readFileSync(path.join(ROOT_DIR, 'README.md'), 'utf8');
  assert.ok(readme.includes('start-windows.ps1'), 'README 应给出 Windows 启动命令');
  assert.ok(!readme.includes('——'), 'README 不应使用破折号');
}

async function main() {
  if (!hasBash()) {
    const msg = '跳过：当前环境没有 bash，部署脚本无法执行';
    if (process.env.CI) {
      console.error(`失败：CI 环境必须有 bash。${msg}`);
      return 1;
    }
    console.log(`${msg}（本地开发环境，允许跳过）`);
    return 0;
  }
  await test1_QuickstartDetectsDotAgentix();
  await test2_SystemdScriptDetectsDotAgentix();
  test3_DumpLimitVarsMatchCode();
  await test4_QuickstartRejectsMissingStateDir();
  await test5_MountPathWithAmpersandSurvives();
  await test6_StateDirWithBackslashSurvives();
  await test7_PortBusyFailsLoudly();
  await test8_ExistingEnvValueWins();
  test9_WindowsArtifactsAreIgnored();
  console.log('\n全部通过');
  return 0;
}

main().then(
  (code) => { process.exitCode = code; },
  (err) => { console.error(err); process.exitCode = 1; },
);
