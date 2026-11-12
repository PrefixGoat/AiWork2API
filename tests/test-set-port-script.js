'use strict';

// scripts/set-port.sh：宿主机端口与容器内端口的一键切换。
// 这里跑真脚本（--dry-run / --no-recreate），只断言它怎么改 .env，
// 不碰 Docker —— 重建容器那段由人工用真实部署验证。

const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'set-port.sh');
const TMP = path.join(os.tmpdir(), `aiwork-set-port-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

function seed(content) {
  fs.mkdirSync(TMP, { recursive: true });
  const file = path.join(TMP, `env-${Math.random().toString(36).slice(2, 8)}`);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

function run(args) {
  // Git Bash 在 Windows 上就是 bash.exe；Linux/CI 同样适用。
  const r = cp.spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', cwd: ROOT });
  assert(!r.error, `脚本没跑起来：${r.error && r.error.message}`);
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

// 1) 只改宿主机端口：容器内端口保持原样，其它行（含注释）原封不动
{
  const file = seed('# 说明\nAPI_KEYS=sk-test\nHOST_PORT=18080\nPUBLISH_ADDR=127.0.0.1\n');
  const r = run(['--host', '18081', '--env-file', file, '--no-recreate']);
  assert.strictEqual(r.code, 0, `应成功退出：${r.out}`);
  const text = fs.readFileSync(file, 'utf8');
  assert(/^HOST_PORT=18081$/m.test(text), `HOST_PORT 应改成 18081：\n${text}`);
  assert(!/^CONTAINER_PORT=/m.test(text), '没让改容器端口就不该凭空写一行 CONTAINER_PORT');
  assert(/^# 说明$/m.test(text) && /^PUBLISH_ADDR=127\.0\.0\.1$/m.test(text), '其它行不能被改动');
  assert.strictEqual(text.match(/HOST_PORT=/g).length, 1, 'HOST_PORT 只能有一条，不能重复追加');
}

// 2) 只改容器内端口：文件里没有这一行时要追加
{
  const file = seed('API_KEYS=sk-test\nHOST_PORT=18080\n');
  const r = run(['--container', '9000', '--env-file', file, '--no-recreate']);
  assert.strictEqual(r.code, 0, `应成功退出：${r.out}`);
  const text = fs.readFileSync(file, 'utf8');
  assert(/^CONTAINER_PORT=9000$/m.test(text), `应追加 CONTAINER_PORT=9000：\n${text}`);
  assert(/^HOST_PORT=18080$/m.test(text), '没让改宿主机端口就不该动它');
}

// 3) 两个一起改：各一条，且再跑一次不会重复写
{
  const file = seed('HOST_PORT=18080\nCONTAINER_PORT=8080\n');
  let r = run(['--host', '18085', '--container', '9005', '--env-file', file, '--no-recreate']);
  assert.strictEqual(r.code, 0, r.out);
  r = run(['--host', '18085', '--container', '9005', '--env-file', file, '--no-recreate']);
  assert.strictEqual(r.code, 0, r.out);
  const text = fs.readFileSync(file, 'utf8');
  assert.strictEqual(text.match(/^HOST_PORT=/gm).length, 1, 'HOST_PORT 不能重复');
  assert.strictEqual(text.match(/^CONTAINER_PORT=/gm).length, 1, 'CONTAINER_PORT 不能重复');
  assert(/^HOST_PORT=18085$/m.test(text) && /^CONTAINER_PORT=9005$/m.test(text), `两个值都要生效：\n${text}`);
}

// 4) --dry-run：只报告，不动文件
{
  const before = 'HOST_PORT=18080\n';
  const file = seed(before);
  const r = run(['--host', '18090', '--container', '8090', '--env-file', file, '--dry-run']);
  assert.strictEqual(r.code, 0, r.out);
  assert(/HOST_PORT=18090/.test(r.out) && /CONTAINER_PORT=8090/.test(r.out), `预览要写出目标值：${r.out}`);
  assert(/18090\s*→\s*容器\s*8090/.test(r.out), `预览要写清映射方向：${r.out}`);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before, '--dry-run 不许改文件');
}

// 5) 非法输入要拒绝，且不写文件
{
  for (const bad of ['0', '65536', 'abc', '18080.5', '-1']) {
    const file = seed('HOST_PORT=18080\n');
    const r = run(['--host', bad, '--env-file', file, '--no-recreate']);
    assert.notStrictEqual(r.code, 0, `--host ${bad} 必须失败`);
    assert(/1-65535/.test(r.out), `错误信息要说清范围：${r.out}`);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'HOST_PORT=18080\n', `非法值不许写文件：${bad}`);
  }
  const file = seed('HOST_PORT=18080\n');
  const none = run(['--env-file', file]);
  assert.notStrictEqual(none.code, 0, '一个端口都不给应当报错，而不是静默什么也不做');
  assert(/--host|--container/.test(none.out), `应提示该给哪个参数：${none.out}`);
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log('ok - set-port.sh：改一侧不动另一侧 / 缺行追加 / 幂等 / --dry-run 不落盘 / 非法值拒绝');
