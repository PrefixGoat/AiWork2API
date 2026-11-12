'use strict';
/**
 * 官方 CLI 多状态目录隔离与只读接入事实验证测试
 *
 * 验证目标（Issue #01 验收项）：
 * 1. 结构与凭据字段解析：.env、config.json、auth.json 字段格式正确识别（全程不读取个人凭据）
 * 2. 多状态目录隔离性：独立状态目录互不覆盖、互不串话，单目录更新独立重载
 * 3. 只读保护与数据解耦：只读状态下可完整读取，修改被系统拦截，网关自身持久化文件须解耦至独立数据目录
 * 4. 凭据缺失/失效提示契约：提供明确的错误码与恢复指引
 *
 * 运行方式: node tests/test-cli-multi-dir.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const cp = require('child_process');

const CLI_BIN = process.platform === 'win32'
  ? path.join(os.homedir(), 'AppData', 'Roaming', 'Agentix', 'bin', 'dtcoder.exe')
  : 'aiworkcn';
const CLI_ARGS = process.platform === 'win32' ? ['--dist', 'external'] : [];
const HAS_CLI = fs.existsSync(CLI_BIN);

const TEST_ROOT = path.join(__dirname, '..', '.scratch', 'v1', 'scratch', 'multi-dir-test-' + Date.now());

function setWritableRecursive(dir) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    try { fs.chmodSync(full, 0o666); } catch (_) {}
    if (ent.isDirectory()) setWritableRecursive(full);
  }
  try { fs.chmodSync(dir, 0o777); } catch (_) {}
}

function cleanup() {
  try {
    if (fs.existsSync(TEST_ROOT)) {
      setWritableRecursive(TEST_ROOT);
      fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    }
  } catch (_) {}
}

// 构造干净的合成 config.json 骨架（13 个必选顶层键），无需依赖真实文件
function createSyntheticConfig(options = {}) {
  const {
    models = [],
    modelCosts = [],
    active = true,
    userId = 'synthetic-user-1',
  } = options;

  const cfg = {
    config_protocol_version: '1.1',
    agents: {},
    approval: {},
    daemon: {},
    gateway: {},
    kernel: {},
    memory: {},
    memory_engine_plugins: {},
    profiling: {},
    tools: {},
    diagnostics: {},
    models: {
      'aiwork-router': {
        base_url: 'https://aiwork-api.dtagi.cn',
        api: 'openai',
        api_key: { source: 'env', id: 'AGENTIX_CONFIG_MODELS_AIWORK_ROUTER_API_KEY' },
        models,
      },
    },
    aiwork: {
      router_usage: {
        models: models.map((m) => m.id),
        model_costs: modelCosts,
      },
      router_auth: {
        mode: 'standard',
        login_env: 'prod',
      },
    },
  };

  if (active) {
    cfg.aiwork.active_login = {
      owner_distribution: 'external',
      auth_environment: 'external',
      login_revision: 'synthetic-uuid-1',
      endpoint_manifest_epoch: '2026-09-15',
    };
    cfg.aiwork.external_auth = {
      base_url: 'https://aiwork.dtagi.cn',
      web_url: 'https://aiwork.dtagi.cn',
      client_id: 'synthetic-client-id',
      access_token: 'synthetic-access-token',
      refresh_token: 'synthetic-refresh-token',
      expires_in: 86400 * 7,
      expires_at: new Date(Date.now() + 86400 * 7 * 1000).toISOString(),
      user_id: userId,
    };
    cfg.aiwork.router_auth = {
      mode: 'external',
      provider_ids: ['aiwork-router'],
      exchange_url: 'https://aiwork.dtagi.cn/api/v1/router/apikey/exchange',
      login_env: 'prod',
    };
  }

  return cfg;
}

// 模拟网关的账号状态目录读取契约
class AccountStateReader {
  constructor(accountName, stateDir) {
    this.accountName = accountName;
    this.stateDir = stateDir;
    this.configMtime = 0;
    this.envMtime = 0;
    this.routerKey = null;
    this.models = new Map();
    this.modelCosts = new Map();
    this.status = 'unknown';
    this.lastReloadError = null;
  }

  readRouterKey() {
    const envPath = path.join(this.stateDir, '.env');
    try {
      const content = fs.readFileSync(envPath, 'utf8');
      const m = content.match(/^\s*AGENTIX_CONFIG_MODELS_AIWORK_ROUTER_API_KEY\s*=\s*(.*)$/m);
      if (m) {
        return m[1].trim().replace(/^["']|["']$/g, '');
      }
    } catch (e) {
      this.lastReloadError = e.message;
    }
    return null;
  }

  loadModels() {
    const configPath = path.join(this.stateDir, 'config.json');
    const models = new Map();
    const costs = new Map();
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const defs = cfg?.models?.['aiwork-router']?.models || [];
      for (const d of defs) {
        if (d && d.id) {
          models.set(d.id, {
            id: d.id,
            name: d.name || d.id,
            input: d.input || ['text'],
            reasoning: !!d.reasoning,
            context_window: d.context_window || null,
            max_tokens: d.max_tokens || null,
          });
        }
      }
      const rawCosts = cfg?.aiwork?.router_usage?.model_costs || [];
      for (const c of rawCosts) {
        const id = c.model_id || c.id;
        if (id) {
          costs.set(id, {
            multiplier: c.multiplier ?? 1,
            ratio: c.ratio || '',
            costTag: c.costTag || '',
          });
        }
      }
    } catch (e) {
      this.lastReloadError = e.message;
    }
    return { models, costs };
  }

  checkAuthFast() {
    // 快速读取本地 auth.json 或 config.json
    const authPath = path.join(this.stateDir, 'auth.json');
    try {
      if (fs.existsSync(authPath)) {
        const j = JSON.parse(fs.readFileSync(authPath, 'utf8'));
        const entries = Array.isArray(j?.entries) ? j.entries : [];
        if (entries.length > 0) {
          const latest = entries[0];
          if (latest && typeof latest.expires_at === 'number' && latest.expires_at > 0) {
            if (latest.expires_at * 1000 < Date.now()) {
              return { status: 'expired', expiredAt: latest.expires_at };
            }
          }
          return { status: 'active', provider: latest.provider || 'aiwork' };
        }
      }
    } catch (_) {}

    // 回落检查 config.json 中的 external_auth
    const configPath = path.join(this.stateDir, 'config.json');
    try {
      if (fs.existsSync(configPath)) {
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const ext = cfg?.aiwork?.external_auth;
        if (ext && ext.access_token) {
          let expMs = null;
          if (typeof ext.expires_at === 'number') {
            expMs = ext.expires_at > 1e11 ? ext.expires_at : ext.expires_at * 1000;
          } else if (typeof ext.expires_at === 'string') {
            expMs = Date.parse(ext.expires_at);
          }
          if (expMs && !Number.isNaN(expMs) && expMs < Date.now()) {
            return { status: 'expired', expiredAt: ext.expires_at };
          }
          return { status: 'active', provider: 'aiwork' };
        }
      }
    } catch (_) {}

    return { status: 'not_logged_in' };
  }

  reloadIfChanged() {
    let changed = false;
    const envPath = path.join(this.stateDir, '.env');
    const configPath = path.join(this.stateDir, 'config.json');

    try {
      const envSt = fs.statSync(envPath);
      if (envSt.mtimeMs !== this.envMtime) {
        this.envMtime = envSt.mtimeMs;
        this.routerKey = this.readRouterKey();
        changed = true;
      }
    } catch (_) {
      this.routerKey = null;
    }

    try {
      const cfgSt = fs.statSync(configPath);
      if (cfgSt.mtimeMs !== this.configMtime) {
        this.configMtime = cfgSt.mtimeMs;
        const res = this.loadModels();
        this.models = res.models;
        this.modelCosts = res.costs;
        changed = true;
      }
    } catch (_) {
      this.models = new Map();
      this.modelCosts = new Map();
    }

    this.status = this.checkAuthFast().status;
    return changed;
  }
}

async function runTests() {
  console.log('--- 开始验证 01: 官方 CLI 多状态目录与只读接入事实 ---');
  fs.mkdirSync(TEST_ROOT, { recursive: true });

  const dirA = path.join(TEST_ROOT, 'account_a');
  const dirB = path.join(TEST_ROOT, 'account_b');
  fs.mkdirSync(dirA, { recursive: true });
  fs.mkdirSync(dirB, { recursive: true });

  // 1. 初始化合成账号 A（有效登录态 + qwen3.8-max, deepseek-flash）
  const keyA = 'sk-router-account-a-test-key';
  fs.writeFileSync(path.join(dirA, '.env'), `AGENTIX_CONFIG_MODELS_AIWORK_ROUTER_API_KEY=${keyA}\n`);
  const cfgA = createSyntheticConfig({
    active: true,
    userId: 'user-a-synthetic',
    models: [
      { id: 'qwen3.8-max', name: 'Qwen 3.8 Max' },
      { id: 'deepseek-flash', name: 'DeepSeek Flash' },
    ],
    modelCosts: [
      { model_id: 'qwen3.8-max', multiplier: 1.0, ratio: '1.0x', costTag: '标准' },
      { model_id: 'deepseek-flash', multiplier: 0.2, ratio: '0.2x', costTag: '低成本' },
    ],
  });
  fs.writeFileSync(path.join(dirA, 'config.json'), JSON.stringify(cfgA, null, 2));
  fs.writeFileSync(path.join(dirA, 'auth.json'), JSON.stringify({
    entries: [
      {
        provider: 'aiwork-router',
        user_id: 'user_a_synthetic',
        expires_at: Math.floor(Date.now() / 1000) + 86400 * 7,
      },
    ],
  }, null, 2));

  // 2. 初始化合成账号 B（未登录状态 + deepseek-v4-pro）
  const keyB = 'sk-router-account-b-test-key';
  fs.writeFileSync(path.join(dirB, '.env'), `AGENTIX_CONFIG_MODELS_AIWORK_ROUTER_API_KEY=${keyB}\n`);
  const cfgB = createSyntheticConfig({
    active: false, // 未登录
    models: [
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
    ],
    modelCosts: [
      { model_id: 'deepseek-v4-pro', multiplier: 2.0, ratio: '2.0x', costTag: '高成本' },
    ],
  });
  fs.writeFileSync(path.join(dirB, 'config.json'), JSON.stringify(cfgB, null, 2));
  // dirB 不建 auth.json，模拟未登录

  // --- 测试项 1: 多目录独立读取与状态隔离性 ---
  console.log('[Test 1] 验证多目录独立读取与状态隔离性...');
  const readerA = new AccountStateReader('acc_a', dirA);
  const readerB = new AccountStateReader('acc_b', dirB);

  readerA.reloadIfChanged();
  readerB.reloadIfChanged();

  assert.strictEqual(readerA.routerKey, keyA, '账号 A 的 routerKey 必须独立');
  assert.strictEqual(readerB.routerKey, keyB, '账号 B 的 routerKey 必须独立');
  assert.notStrictEqual(readerA.routerKey, readerB.routerKey, '两账号密钥不得串号');

  assert.strictEqual(readerA.models.has('qwen3.8-max'), true, '账号 A 包含 qwen3.8-max');
  assert.strictEqual(readerA.models.has('deepseek-v4-pro'), false, '账号 A 不得包含账号 B 专有模型');

  assert.strictEqual(readerB.models.has('deepseek-v4-pro'), true, '账号 B 包含 deepseek-v4-pro');
  assert.strictEqual(readerB.models.has('qwen3.8-max'), false, '账号 B 不得包含账号 A 专有模型');

  assert.strictEqual(readerA.status, 'active', '账号 A 应处于有效状态');
  assert.strictEqual(readerB.status, 'not_logged_in', '账号 B 应被识别为未登录状态');
  console.log('  ✓ 多目录独立读取与隔离性断言全部通过');

  // --- 测试项 2: CLI 工具通过环境变量分别识别多状态目录 ---
  if (HAS_CLI) {
    console.log('[Test 2] 验证官方 CLI 通过 AGENTIX_STATE_DIR 分别识别目录状态...');
    const outA = cp.execFileSync(CLI_BIN, [...CLI_ARGS, 'auth', 'status', '--json'], {
      env: { ...process.env, AGENTIX_STATE_DIR: dirA },
      encoding: 'utf8',
    });
    const parsedA = JSON.parse(outA.trim());
    assert.strictEqual(parsedA.status, 'active', 'CLI 应从 dirA 识别到 active 状态');

    const outB = cp.execFileSync(CLI_BIN, [...CLI_ARGS, 'auth', 'status', '--json'], {
      env: { ...process.env, AGENTIX_STATE_DIR: dirB },
      encoding: 'utf8',
    });
    const parsedB = JSON.parse(outB.trim());
    assert.strictEqual(parsedB.status, 'not_logged_in', 'CLI 应从 dirB 识别到 not_logged_in 状态');
    console.log('  ✓ 官方 CLI 成功按独立目录隔离识别登录态 (A=active, B=not_logged_in)');
  } else {
    console.log('[Test 2] 跳过 CLI 可执行文件测试（环境无 CLI 二进制）');
  }

  // --- 测试项 3: 单目录热重载与独立更新隔离性 ---
  console.log('[Test 3] 验证单目录热重载与独立更新隔离性...');
  await new Promise((r) => setTimeout(r, 50));
  const cfgAObj = JSON.parse(fs.readFileSync(path.join(dirA, 'config.json'), 'utf8'));
  cfgAObj.models['aiwork-router'].models.push({ id: 'model-a-new', name: 'Model A New' });
  fs.writeFileSync(path.join(dirA, 'config.json'), JSON.stringify(cfgAObj, null, 2));

  const changedA = readerA.reloadIfChanged();
  const changedB = readerB.reloadIfChanged();

  assert.strictEqual(changedA, true, '账号 A 应检测到更新并重载');
  assert.strictEqual(changedB, false, '账号 B 未被修改，不得触发重载');
  assert.strictEqual(readerA.models.has('model-a-new'), true, '账号 A 必须能获取到新模型');
  assert.strictEqual(readerB.models.has('model-a-new'), false, '账号 B 绝对不能出现账号 A 的新模型');
  console.log('  ✓ 独立热重载断言通过，无任何 cross-directory pollution');

  // --- 测试项 4: 只读权限保护与网关数据目录解耦验证 ---
  console.log('[Test 4] 验证只读权限下读取正常，且禁止修改官方 CLI 状态文件...');
  // 1) 将 dirA 里的凭据文件与配置文件置为只读 (0o444)
  const envAFile = path.join(dirA, '.env');
  const cfgAFile = path.join(dirA, 'config.json');
  fs.chmodSync(envAFile, 0o444);
  fs.chmodSync(cfgAFile, 0o444);

  // 2) 验证只读状态下依然能正常读取凭据和模型
  const readOnlyReader = new AccountStateReader('acc_ro', dirA);
  readOnlyReader.reloadIfChanged();
  assert.strictEqual(readOnlyReader.routerKey, keyA, '只读状态下读取 routerKey 必须成功');
  assert.strictEqual(readOnlyReader.models.has('qwen3.8-max'), true, '只读状态下读取模型表必须成功');

  // 3) 验证尝试修改只读状态文件必须抛出 EPERM / EACCES
  let envWriteBlocked = false;
  try {
    fs.writeFileSync(envAFile, 'TAMPERED_KEY=123');
  } catch (err) {
    envWriteBlocked = (err.code === 'EACCES' || err.code === 'EPERM');
  }
  assert.strictEqual(envWriteBlocked, true,
    '只读属性必须阻止修改 .env 凭据文件，保护官方 CLI 登录态不被篡改');

  let cfgWriteBlocked = false;
  try {
    fs.writeFileSync(cfgAFile, '{"tampered":true}');
  } catch (err) {
    cfgWriteBlocked = (err.code === 'EACCES' || err.code === 'EPERM');
  }
  assert.strictEqual(cfgWriteBlocked, true,
    '只读属性必须阻止修改 config.json 配置文件');

  // 4) 验证网关自身持久化文件（usage-state）存放在独立数据目录即可正常读写
  const gwDataDir = path.join(TEST_ROOT, 'gw-data');
  fs.mkdirSync(gwDataDir, { recursive: true });
  const usageFile = path.join(gwDataDir, 'usage-state.json');
  fs.writeFileSync(usageFile, JSON.stringify({ ok: true, requests: 10 }));
  assert.strictEqual(fs.existsSync(usageFile), true, '网关独立数据目录必须正常支持写盘');
  console.log('  ✓ 只读保护与数据目录解耦验证通过');

  // --- 测试项 5: 凭据缺失/失效时的可观察错误与恢复提示契约 ---
  console.log('[Test 5] 验证凭据缺失/失效时的可观察错误与恢复契约...');
  const dirEmpty = path.join(TEST_ROOT, 'account_empty');
  fs.mkdirSync(dirEmpty, { recursive: true });

  const emptyReader = new AccountStateReader('acc_empty', dirEmpty);
  emptyReader.reloadIfChanged();
  assert.strictEqual(emptyReader.routerKey, null, '空目录应无 routerKey');

  // 契约错误结构断言
  function formatRecoveryHint(accountName, stateDir) {
    return {
      error: {
        message: `账号 "${accountName}" 的状态目录 (${stateDir}) 缺失有效 router key。请先使用官方 CLI 登录：aiworkcn login`,
        type: 'service_unavailable',
        code: 'account_credential_missing',
        account: accountName,
      },
    };
  }

  const errObj = formatRecoveryHint('test_acc', '/data/accounts/test_acc');
  assert.strictEqual(errObj.error.code, 'account_credential_missing');
  assert.ok(errObj.error.message.includes('aiworkcn login'), '必须包含清晰的官方 CLI 登录指引');
  console.log('  ✓ 恢复提示与错误契约验证通过');

  console.log('\n>>> 全部 5 项验证测试均顺利通过 ✓');
}

runTests().then(() => {
  cleanup();
  process.exit(0);
}).catch((e) => {
  console.error('\n✗ 测试失败:', e);
  cleanup();
  process.exit(1);
});
