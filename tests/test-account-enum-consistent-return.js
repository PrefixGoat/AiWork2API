'use strict';
/**
 * 账号枚举多态收敛（CODING_STANDARDS 条款 4）
 *
 * 背景：getAllowedAccounts() / getAllowedAccountsFromKey() 曾返回 null | Set | Array，
 * 逼迫调用方到处写 Array.isArray / instanceof Set 防御。条款 4 要求账号枚举与提取
 * 恒返回同质形状；「不限制（全部账号）」改用冻结结构对象上的显式语义表达。
 *
 * 领域约束（GLOSSARY「账号访问范围」+ credentials.js 模块约定 4）：
 *   指定集合为空 = 无账号权限，绝不降级为全部账号。因此「不限制」不能压成普通空集合，
 *   而是结构对象上的显式 unrestricted 标记（由 isUnrestrictedAccountScope 读取）。
 *
 * 形状约定（收口后）：accountAccessScope() 恒返回
 *   Object.freeze({ ids: string[], unrestricted: boolean })
 * 标记是对象自身属性，不再是数组上的 expando——spread / JSON 序列化后不丢失。
 *
 * Seams（被测公共边界）：
 *   - credentials.getAllowedAccountsFromKey(keyObj) / accountAccessScope()
 *   - credentials.isUnrestrictedAccountScope(scope) / isAccountAllowed(scope, id)
 *   - adapter-common.getAllowedAccounts(req)
 *   - AccountPool.getEligibleAccounts / getAllAvailableModels / reloadIfChanged
 *   - SessionRouter.getCandidates({ allowedAccounts })
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  getAllowedAccountsFromKey,
  accountAccessScope,
  normalizeAccountScope,
  isUnrestrictedAccountScope,
  isAccountAllowed,
  KeyStore,
} = require('../src/credentials');
const { getAllowedAccounts } = require('../src/adapter-common');
const { AccountPool } = require('../src/account-pool');
const { SessionRouter } = require('../src/session-router');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwork-acct-enum-'));
process.on('exit', () => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

/** 冻结结构对象：{ ids: string[], unrestricted: boolean }，且不可被就地篡改。 */
function isAccountScope(v) {
  return v !== null
    && typeof v === 'object'
    && !Array.isArray(v)
    && Array.isArray(v.ids)
    && typeof v.unrestricted === 'boolean';
}
function shapeOf(v) {
  if (v === null) return 'null';
  if (v instanceof Set) return 'Set';
  if (Array.isArray(v)) return 'Array';
  return typeof v;
}

const ALL_KEY = { id: 'k', account_policy: { mode: 'all', accounts: [] } };
const EXPLICIT_KEY = { id: 'k', account_policy: { mode: 'explicit', accounts: ['acc-a', 'acc-b'] } };
const EMPTY_KEY = { id: 'k', account_policy: { mode: 'explicit', accounts: [] } };
const LEGACY_ALL_KEY = { id: 'k', accounts_access_mode: 'all' };
const LEGACY_EXPLICIT_KEY = { id: 'k', accounts_access_mode: 'explicit', allowed_accounts: ['acc-a'] };

/* ------------------------------------------------------------------ */
/* 1. 提取函数恒返回冻结结构对象（钉住返回形状，杜绝 null / Set / 数组多态） */
/* ------------------------------------------------------------------ */
function checkExtractionAlwaysScope() {
  const cases = [
    ['无 keyObj（无结果）', getAllowedAccountsFromKey(null)],
    ['all 模式（不限制）', getAllowedAccountsFromKey(ALL_KEY)],
    ['explicit 非空（指定集合）', getAllowedAccountsFromKey(EXPLICIT_KEY)],
    ['explicit 空集（无账号权限）', getAllowedAccountsFromKey(EMPTY_KEY)],
    ['legacy all（不限制）', getAllowedAccountsFromKey(LEGACY_ALL_KEY)],
    ['legacy explicit（指定集合）', getAllowedAccountsFromKey(LEGACY_EXPLICIT_KEY)],
    ['无 req（无结果）', getAllowedAccounts(null)],
    ['req 无鉴权信息（无结果）', getAllowedAccounts({})],
    ['req.__allowedAccounts 为 Set（收敛）', getAllowedAccounts({ __allowedAccounts: new Set(['acc-a']) })],
    ['req.__allowedAccounts 为历史普通数组（收敛）', getAllowedAccounts({ __allowedAccounts: ['acc-a'] })],
    ['req.__keyObj 为 all', getAllowedAccounts({ __keyObj: ALL_KEY })],
    ['accountAccessScope 直建', accountAccessScope(['acc-a'], false)],
  ];
  for (const [label, scope] of cases) {
    assert(
      isAccountScope(scope),
      `${label}: 账号访问范围必须恒返回 { ids, unrestricted } 结构，实际为 ${shapeOf(scope)}（条款 4 禁止 null | Set | 数组多态）`
    );
    assert.ok(Object.isFrozen(scope), `${label}: 结构必须冻结，消费端不得就地篡改标记`);
  }
}

/* ------------------------------------------------------------------ */
/* 2. 不限制 / 指定集合 语义一致，标记不随 spread 或 JSON 丢失             */
/* ------------------------------------------------------------------ */
function checkUnrestrictedSemantics() {
  const unrestrictedCases = [
    // 注意语境：这里的「无 req」是缺省（边界契约=不限制），与 isUnrestrictedAccountScope(null)=false
    // 不矛盾——后者说的是「显式传入 null scope」不是不限制，两者分属边界归一前后。
    ['无 keyObj', getAllowedAccountsFromKey(null)],
    ['all 模式', getAllowedAccountsFromKey(ALL_KEY)],
    ['legacy all', getAllowedAccountsFromKey(LEGACY_ALL_KEY)],
    ['无 req', getAllowedAccounts(null)],
    ['req 无鉴权信息', getAllowedAccounts({})],
  ];
  for (const [label, scope] of unrestrictedCases) {
    assert.strictEqual(scope.ids.length, 0, `${label}: 不限制情形 ids 必须为空`);
    assert.strictEqual(
      isUnrestrictedAccountScope(scope), true,
      `${label}: 「不限制」必须由显式独立语义表达，而不是靠返回 null`
    );
    assert.strictEqual(isAccountAllowed(scope, 'acc-a'), true, `${label}: 不限制必须放行任意账号`);
    // 曾经的 expando 标记在 spread / JSON 往返后会丢失，这里钉住结构属性版不丢。
    assert.strictEqual(isUnrestrictedAccountScope({ ...scope }), true, `${label}: spread 后标记不得丢失`);
    assert.strictEqual(
      isUnrestrictedAccountScope(JSON.parse(JSON.stringify(scope))), true,
      `${label}: JSON 往返后标记不得丢失`
    );
  }

  const restrictedCases = [
    ['explicit 非空', getAllowedAccountsFromKey(EXPLICIT_KEY), ['acc-a', 'acc-b']],
    ['explicit 空集', getAllowedAccountsFromKey(EMPTY_KEY), []],
    ['legacy explicit', getAllowedAccountsFromKey(LEGACY_EXPLICIT_KEY), ['acc-a']],
  ];
  for (const [label, scope, expected] of restrictedCases) {
    assert.deepStrictEqual(scope.ids, expected, `${label}: ids 必须等于指定集合`);
    assert.strictEqual(
      isUnrestrictedAccountScope(scope), false,
      `${label}: 指定集合（含空集）绝不能被当作不限制（空名单不得默认全部）`
    );
    assert.strictEqual(isAccountAllowed(scope, 'acc-a'), expected.includes('acc-a'), `${label}: 放行判定必须按集合`);
  }

  // null / undefined 不再是被承认的「不限制」第四态：只有结构对象能表达。
  assert.strictEqual(isUnrestrictedAccountScope(null), false, 'null 不得被当作不限制（边界须先归一）');
  assert.strictEqual(isUnrestrictedAccountScope(undefined), false, 'undefined 不得被当作不限制（边界须先归一）');

  // ---- 畸形输入必须 fail-closed：未知形状不得被解释为「全部账号」 ----
  for (const weird of ['all', 42, true, {}, { ids: 'x' }, { ids: [], unrestricted: 'yes' }]) {
    const scope = normalizeAccountScope(weird);
    assert.strictEqual(scope.unrestricted, false, `畸形输入 ${JSON.stringify(weird)} 必须收敛为无账号权限，不得 fail-open 放行全部`);
    assert.strictEqual(isAccountAllowed(scope, 'acc-a'), false, '畸形输入不得放行任何账号');
    assert.deepStrictEqual(scope.ids, [], '畸形输入的 ids 必须为空集合');
  }

  // null / undefined 不是可解释的 scope：放行判定必须 fail-closed，而不是抛错
  assert.strictEqual(isAccountAllowed(null, 'acc-a'), false, 'null scope 必须 fail-closed');
  assert.strictEqual(isAccountAllowed(undefined, 'acc-a'), false, 'undefined scope 必须 fail-closed');

  // ---- 未知策略模式必须 fail-closed：不认识的 mode 不得解释为「全部账号」 ----
  const unknownPolicy = getAllowedAccountsFromKey({ account_policy: { mode: 'weird', accounts: [] } });
  assert.strictEqual(unknownPolicy.unrestricted, false, '未知 account_policy.mode 必须 fail-closed');
  assert.deepStrictEqual(unknownPolicy.ids, [], '未知 mode 的 ids 必须为空集合');
  const unknownLegacy = getAllowedAccountsFromKey({ accounts_access_mode: 'weird' });
  assert.strictEqual(unknownLegacy.unrestricted, false, '未知 accounts_access_mode 必须 fail-closed');

  // 内层 ids 冻结：消费端不得就地扩权
  const frozen = accountAccessScope(['acc-a'], false);
  assert.ok(Object.isFrozen(frozen.ids), '内层 ids 必须冻结');
  assert.throws(() => frozen.ids.push('b'), TypeError, '内层 ids 不可就地扩权');

  // 谓词只认结构对象：直传数组/畸形对象必须 fail-closed
  assert.strictEqual(isAccountAllowed(['acc-a'], 'acc-a'), false, '历史数组必须 fail-closed');
  assert.strictEqual(isAccountAllowed({ ids: 'x' }, 'acc-a'), false, '畸形对象必须 fail-closed');
  assert.strictEqual(isAccountAllowed({ ids: [], unrestricted: true }, 'acc-a'), true, '不限制结构必须放行');

  // custom 归 explicit；缺 mode 与 parseAccountPolicy 对齐为 all
  const custom = getAllowedAccountsFromKey({ id: 'k', account_policy: { mode: 'custom', accounts: ['acc-a'] } });
  assert.strictEqual(custom.unrestricted, false, 'custom 必须按 explicit 处理');
  assert.deepStrictEqual(custom.ids, ['acc-a'], 'custom 的账号集合必须保留');
  const noMode = getAllowedAccountsFromKey({ id: 'k', account_policy: {} });
  // 注：缺 mode 视为「未设置」→ all（与 parseAccountPolicy 写边界一致）；未知值才 fail-closed
  assert.strictEqual(noMode.unrestricted, true, '缺 mode 必须与 parseAccountPolicy 对齐为 all');

  // 边界归一必须重新盖章：JSON 往返的结构对象可能未冻结
  const rt = JSON.parse(JSON.stringify(accountAccessScope(['acc-a'], false)));
  assert.ok(Object.isFrozen(normalizeAccountScope(rt)), 'JSON 往返后归一必须重新冻结外层');
  assert.throws(() => normalizeAccountScope(rt).ids.push('b'), TypeError, '归一后的 ids 不可就地扩权');

  // ids 恒为同质字符串数组：非字符串条目必须被过滤
  assert.deepStrictEqual(normalizeAccountScope([1, null, {}]).ids, [], '非字符串 id 必须被过滤');
  assert.deepStrictEqual(accountAccessScope([' a ', 'b'], false).ids, ['a', 'b'], 'ids 必须 trim');

  // 空串 mode 与缺省同义；大小写归一；畸形 account_policy 必须 fail-closed
  assert.strictEqual(
    getAllowedAccountsFromKey({ id: 'k', accounts_access_mode: '' }).unrestricted, true,
    '空串 mode 与缺省同义（all）',
  );
  assert.strictEqual(
    getAllowedAccountsFromKey({ id: 'k', accounts_access_mode: 'ALL' }).unrestricted, true,
    'mode 大小写归一',
  );
  assert.strictEqual(
    getAllowedAccountsFromKey({ id: 'k', account_policy: 'explicit' }).unrestricted, false,
    '畸形 account_policy 不得解释为全部账号',
  );
  assert.strictEqual(
    getAllowedAccountsFromKey({ id: 'k', account_policy: [] }).unrestricted, false,
    'account_policy 为数组属畸形，必须 fail-closed',
  );
  // 显式空名单但缺 mode：读侧与写/加载侧一致，必须无账号权限
  assert.strictEqual(
    getAllowedAccountsFromKey({ id: 'k', account_policy: { accounts: [] } }).unrestricted, false,
    '显式空名单缺 mode 读侧必须无权限',
  );
  assert.strictEqual(
    getAllowedAccountsFromKey({ id: 'k', account_policy: {} }).unrestricted, true,
    '空对象（未设置）仍为不限制',
  );
  // 缺 mode 但带非空名单：与写侧 derivePolicyMode 一致，必须收敛为 explicit
  const readOnlyList = getAllowedAccountsFromKey({ id: 'k', account_policy: { accounts: ['a1'] } });
  assert.strictEqual(readOnlyList.unrestricted, false, '缺 mode 带名单读侧必须收敛为 explicit');
  assert.deepStrictEqual(readOnlyList.ids, ['a1'], '缺 mode 带名单读侧必须保留名单');
  const readLegacyList = getAllowedAccountsFromKey({ id: 'k', allowed_accounts: ['a1'] });
  assert.strictEqual(readLegacyList.unrestricted, false, 'legacy 缺 mode 带名单读侧必须收敛为 explicit');
  assert.deepStrictEqual(readLegacyList.ids, ['a1'], 'legacy 缺 mode 带名单读侧必须保留名单');
  // 空白 mode 经 trim 后为空，与缺省同义（写边界 parseAccountPolicy 同样视空为 all）
  assert.strictEqual(
    getAllowedAccountsFromKey({ id: 'k', accounts_access_mode: '   ' }).unrestricted, true,
    '空白 mode 与缺省同义（all）',
  );
}

/* ------------------------------------------------------------------ */
/* 3. 调用方不再需要多态防御：恒结构 scope 直接可用且语义不变             */
/* ------------------------------------------------------------------ */
function fakeAcc(id) {
  return {
    id,
    status: 'ready',
    routerKey: 'k-' + id,
    source: 'mount',
    stateDir: path.join(tmpDir, 'nonexistent-state'),
    models: [{ id: 'm1' }],
    modelIds: ['m1'],
    supportsModel: () => true,
    isChanged: () => false,
    reload() {},
  };
}

function makePool() {
  const pool = new AccountPool({ dataDir: tmpDir, upstreamAccounts: '', defaultStateDir: '' });
  pool.accounts.set('acc-a', fakeAcc('acc-a'));
  pool.accounts.set('acc-b', fakeAcc('acc-b'));
  return pool;
}

function checkConsumers() {
  const pool = makePool();

  // 状态同步方法恒返回数组，调用方无需 Array.isArray 守卫
  assert(Array.isArray(pool.reloadIfChanged()), 'reloadIfChanged() 必须恒返回数组');

  const unrestricted = getAllowedAccountsFromKey(ALL_KEY);
  const restricted = getAllowedAccountsFromKey(EXPLICIT_KEY);
  const empty = getAllowedAccountsFromKey(EMPTY_KEY);

  // getEligibleAccounts：不限制=全部 / 指定集合=按集合过滤 / 指定空集=无账号权限
  assert.deepStrictEqual(
    pool.getEligibleAccounts('m1', unrestricted).map((a) => a.id).sort(), ['acc-a', 'acc-b'],
    '不限制 scope 必须等价于全部账号，不得因收敛成结构对象而被误过滤'
  );
  assert.deepStrictEqual(
    pool.getEligibleAccounts('m1', restricted).map((a) => a.id).sort(), ['acc-a', 'acc-b'],
    '指定集合必须按集合过滤'
  );
  assert.deepStrictEqual(
    pool.getEligibleAccounts('m1', empty), [],
    '指定空集必须仍表示无账号权限（GLOSSARY / credentials 模块约定 4）'
  );
  assert.deepStrictEqual(
    pool.getEligibleAccounts('m1', null).map((a) => a.id).sort(), ['acc-a', 'acc-b'],
    '缺省 null 仍按不限制兼容（既有调用点零回归，边界归一一次）'
  );
  assert.deepStrictEqual(
    pool.getEligibleAccounts('m1', ['acc-a']).map((a) => a.id), ['acc-a'],
    '历史普通数组按「指定集合」兼容，不得被当成不限制'
  );

  // getAllAvailableModels 同样遵循 scope
  assert(pool.getAllAvailableModels(unrestricted).length > 0, '不限制 scope 必须能列出模型');
  assert.deepStrictEqual(pool.getAllAvailableModels(empty), [], '指定空集必须不列出任何模型');

  // SessionRouter.getCandidates：恒结构 scope 直接可用
  const router = new SessionRouter({ settings: () => ({}), maxConcurrency: 10 });
  const fakePool = {
    getReadyAccounts: () => pool.getReadyAccounts(),
    reloadIfChanged: () => [],
  };
  const cAll = router.getCandidates({
    accountPool: fakePool, allowedAccounts: unrestricted, checkConcurrency: false, skipReload: true,
  });
  assert.deepStrictEqual(
    cAll.map((a) => a.id).sort(), ['acc-a', 'acc-b'],
    'getCandidates 收到不限制 scope 必须给出全部候选'
  );
  const cEmpty = router.getCandidates({
    accountPool: fakePool, allowedAccounts: empty, checkConcurrency: false, skipReload: true,
  });
  assert.deepStrictEqual(cEmpty, [], 'getCandidates 收到指定空集必须给出零候选');
  const cNull = router.getCandidates({
    accountPool: fakePool, allowedAccounts: null, checkConcurrency: false, skipReload: true,
  });
  assert.deepStrictEqual(
    cNull.map((a) => a.id).sort(), ['acc-a', 'acc-b'],
    'getCandidates 缺省 null 仍按不限制兼容（边界归一一次）'
  );
}

/* 5. 写边界：畸形 account_policy 拒绝；仅给 allowed_accounts 推导 explicit */
function checkWriteBoundary() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwork-key-write-'));
  try {
    const store = new KeyStore({ dataDir: dir });
    for (const bad of ['explicit', [], true]) {
      assert.throws(
        () => store.createKey({ account_policy: bad }),
        /account_policy 必须是对象/,
        `畸形 account_policy ${JSON.stringify(bad)} 必须抛错（不得建成全权限 Key）`,
      );
    }
    const k = store.createKey({ name: 'w1', allowed_accounts: ['acc-a'] });
    assert.strictEqual(k.account_policy.mode, 'explicit', '仅给 allowed_accounts 必须推导 explicit');
    assert.deepStrictEqual(k.account_policy.accounts, ['acc-a']);
    const k2 = store.createKey({ name: 'w2', accounts_access_mode: 'ALL', allowed_accounts: ['acc-a'] });
    assert.strictEqual(k2.account_policy.mode, 'all', '显式 ALL 必须尊重为 all（不得改写成 explicit）');
    assert.deepStrictEqual(k2.account_policy.accounts, [], '全放行必须清空名单');
    store.updateKey(k.id, { allowed_accounts: ['acc-b'] });
    const got = store.getKeyById(k.id);
    assert.strictEqual(got.account_policy.mode, 'explicit', 'updateKey 缩权必须保持 explicit');
    assert.deepStrictEqual(got.account_policy.accounts, ['acc-b']);

    // 存量 all + 仅改 allowed_accounts：必须转 explicit（不能沿用 all 吞掉缩权）
    const kAll = store.createKey({ name: 'w3', account_policy: { mode: 'all' } });
    assert.strictEqual(kAll.account_policy.mode, 'all');
    store.updateKey(kAll.id, { allowed_accounts: ['acc-c'] });
    assert.strictEqual(store.getKeyById(kAll.id).account_policy.mode, 'explicit', '存量 all 改名单必须转 explicit');

    // updateKey 畸形拒绝
    assert.throws(() => store.updateKey(k.id, { account_policy: 'explicit' }), /account_policy 必须是对象/);

    // 对象式策略缺 mode 但带名单：必须推导 explicit（不得静默全放行）
    const kObj = store.createKey({ name: 'w4', account_policy: { accounts: ['acc-d'] } });
    assert.strictEqual(kObj.account_policy.mode, 'explicit', '对象式缺 mode 带名单必须推导 explicit');

    // updateKey 对象式分支（PATCH 唯一入口）：缺 mode 带名单同样推导 explicit
    store.updateKey(kObj.id, { account_policy: { accounts: ['acc-e'] } });
    assert.strictEqual(
      store.getKeyById(kObj.id).account_policy.mode, 'explicit',
      'updateKey 对象式缺 mode 必须推导 explicit',
    );

    // 全放行清空名单；重启加载仍是 all（不被误读为缩权）
    store.updateKey(kObj.id, { accounts_access_mode: 'all' });
    assert.deepStrictEqual(store.getKeyById(kObj.id).account_policy.accounts, [], '全放行必须清空名单');
    const reloaded = new KeyStore({ dataDir: dir });
    assert.strictEqual(reloaded.getKeyById(kObj.id).account_policy.mode, 'all', '全放行重启后必须仍是 all');

    // 显式 all + 空名单：必须仍是 all（不得被推导成 explicit）
    const kAllEmpty = store.createKey({ name: 'w5', account_policy: { mode: 'all', accounts: [] } });
    assert.strictEqual(kAllEmpty.account_policy.mode, 'all', '显式 all + 空名单必须仍是 all');
    const kAllBare = store.createKey({ name: 'w6', account_policy: { mode: 'all' } });
    assert.strictEqual(kAllBare.account_policy.mode, 'all', '显式 all 无名单必须仍是 all');

    // 显式空名单但缺 mode：语义是「无账号权限」（GLOSSARY：空名单不得默认全部），fail-closed
    const kEmptyList = store.createKey({ name: 'w7', account_policy: { accounts: [] } });
    assert.strictEqual(kEmptyList.account_policy.mode, 'explicit', '显式空名单缺 mode 必须为 explicit');
    assert.deepStrictEqual(kEmptyList.account_policy.accounts, [], '显式空名单必须无账号权限');

    // 存量数据加载：mode all + 名单 → explicit；未知 mode → explicit/[] 且不丢 key
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwork-key-load-'));
    try {
      fs.writeFileSync(path.join(dir2, 'api-keys.json'), JSON.stringify({
        keys: [
          { id: 'a', name: 'a', token: 'ta', account_policy: { mode: 'all', accounts: ['acc-a'] } },
          { id: 'b', name: 'b', token: 'tb', account_policy: { mode: 'deny' } },
          { id: 'c', name: 'c', token: 'tc', account_policy: { mode: 'explicit', accounts: ['acc-c'] } },
          { id: 'd', name: 'd', token: 'td', accounts_access_mode: 'deny', allowed_accounts: ['acc-d'] },
        ],
      }));
      const loaded = new KeyStore({ dataDir: dir2 });
      const ids = loaded.listKeys().map((x) => x.id).sort();
      assert.deepStrictEqual(ids, ['a', 'b', 'c', 'd'], '单条坏 mode 不得导致其它 key 丢失');
      // 存量 all+名单由旧版缺省落 all 产生，加载时收紧为 explicit（新写入不会再有该形态）
      assert.strictEqual(loaded.getKeyById('a').account_policy.mode, 'explicit', '存量 all+名单加载必须收紧为 explicit');
      assert.strictEqual(loaded.getKeyById('b').account_policy.mode, 'explicit', '未知 mode 加载必须 fail-closed 为 explicit');
      assert.deepStrictEqual(loaded.getKeyById('b').account_policy.accounts, [], '未知 mode 加载不得放行任何账号');
      assert.strictEqual(loaded.getKeyById('d').account_policy.mode, 'explicit', 'legacy 未知 mode 必须 fail-closed');
    } finally {
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const checks = [
  ['提取函数恒返回冻结结构对象', checkExtractionAlwaysScope],
  ['不限制与指定集合语义一致且标记不丢', checkUnrestrictedSemantics],
  ['调用方不再需要多态防御', checkConsumers],
  ['写边界：畸形 policy 拒绝、仅给 allowed_accounts 推导 explicit', checkWriteBoundary],
];

let passed = 0;
for (const [name, fn] of checks) {
  fn();
  console.log(`  ✓ ${name}`);
  passed++;
}
console.log(`\n✓ 账号枚举一致集合返回：${passed}/${checks.length} 组断言通过`);
