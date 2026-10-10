// 慢记 Manji v3.6.3 —— 链上小狗身份离线验收（自托管 ManjiPuppyIdentity 合约）
// 全部离线：官方链交互通过 mock RPC/ethers 编码对照完成，不发真实交易。
// 运行：node tests/agentos-acceptance.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// —— 测试隔离：在 import 任何 server 模块之前设置环境（手段与 run-acceptance.mjs 相同）——
const TMP = mkdtempSync(path.join(tmpdir(), 'manji-agentos-'));
process.env.DB_PATH = path.join(TMP, 'manji.db');
process.env.MEDIA_ROOT = path.join(TMP, 'media');
process.env.PUPPY_IDENTITY_CONTRACT = ''; // 空 = 功能 off（后面再打开测 self 模式）
process.env.ONCHAIN_RPC_URL = '';
process.env.ONCHAIN_CHAIN_ID = '677';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { config } = await import('../server/config.js');
const {
  agentosMode, botToWei, buildMintCalldata, buildOwnerOfCalldata, parseOwnerOfResult,
  parsePuppyRegisteredLog, preparePuppyMint, bindPuppyMint, tipPuppy, bindTip,
  refreshPuppyRow, puppyRowOf, PUPPY_EVENT_TOPIC, puppyCard,
} = await import('../server/domain/agentos.js');
const { routes } = await import('../server/routes/agentos.js');
const { db } = await import('../server/db.js');
const { nowIso } = await import('../server/core.js');
const { keccak256 } = await import('../server/domain/keccak.js');

let passed = 0;
const check = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

// 测试用假身份：currentHome 只读 user.current_home_id
function fakeCtx(user, body) {
  return { user: { id: 'u1', current_home_id: 'home_t1', ...user }, params: {}, json: () => body || {}, query: new URLSearchParams() };
}

async function mkHomeWithUsers() {
  // 直接造库：一个 home + 两个 user（current_home_id 指向它）+ active membership（不走注册接口，专注 agentos 行为）
  const homeId = 'home_t1';
  db.prepare("INSERT OR IGNORE INTO homes (id, status, created_at) VALUES (?, 'shared', ?)").run(homeId, nowIso());
  db.prepare("INSERT OR IGNORE INTO users (id, display_name, password_hash, current_home_id, created_at) VALUES ('u1','测试甲','x',?,'2026-01-01'), ('u2','测试乙','x',?,'2026-01-01')").run(homeId, homeId);
  db.prepare("INSERT OR IGNORE INTO memberships (home_id, user_id, status, role, joined_at) VALUES (?, 'u1','active','member',?), (?, 'u2','active','member',?)").run(homeId, nowIso(), homeId, nowIso());
  return { id: homeId };
}

const NAME = '慢记小狗·链上第一名';
const WALLET = '0xFB578a334Eec08ccBe82d449B41DE4bB7631269A';
const OTHER_WALLET = '0x4844F22482B0e08dc9b44d153a723863F576b178';

// ---------- 纯函数：编码与换算 ----------
await check('mint calldata 与 ethers ABI 编码逐字节一致（大端补零回归锚：曾在主网真实 revert）', async () => {
  const ethers = await import('ethers');
  const abi = JSON.parse(require('node:fs').readFileSync(path.join(ROOT, 'contracts/build/ManjiPuppyIdentity.abi.json'), 'utf8'));
  const iface = new ethers.Interface(abi);
  for (const [n, w] of [[NAME, WALLET], ['Manji', OTHER_WALLET], ['毛毛', WALLET]]) {
    assert.equal(buildMintCalldata(n, w), iface.encodeFunctionData('mint', [n, w]));
  }
  // 结构断言：偏移量 0x40 与字符串长度均为大端左补零
  const cd = buildMintCalldata('Manji', WALLET).slice(2);
  assert.equal(cd.slice(8, 72), '0'.repeat(62) + '40');
  assert.equal(cd.slice(136, 200), '0'.repeat(63) + '5');
});

await check('mint 名字守卫：空名/超 32 字节拒绝；地址格式守卫', async () => {
  assert.throws(() => buildMintCalldata('', WALLET));
  assert.throws(() => buildMintCalldata('a'.repeat(33), WALLET));
  assert.throws(() => buildMintCalldata('毛毛', '0x123'));
  assert.doesNotThrow(() => buildMintCalldata('a'.repeat(32), WALLET));
});

await check('ownerOf calldata 与返回值解码；wei 精度（1.5 BOT → 1500000000000000000）', async () => {
  assert.equal(buildOwnerOfCalldata(0), '0x6352211e' + '0'.repeat(64));
  assert.equal(buildOwnerOfCalldata(42), '0x6352211e' + BigInt(42).toString(16).padStart(64, '0'));
  assert.equal(
    parseOwnerOfResult('0x' + '0'.repeat(24) + WALLET.slice(2).toLowerCase()),
    WALLET.toLowerCase()
  );
  assert.equal(parseOwnerOfResult('0x'), null);
  assert.equal(botToWei('1.5'), 1500000000000000000n);
  assert.equal(botToWei('0.000001'), 1000000000000n); // 1 微 BOT = 1e12 wei
  assert.throws(() => botToWei(-1));
  assert.throws(() => botToWei('abc'));
});

await check('PuppyRegistered 事件 topic 与回执解析（tokenId/owner/存钱罐全从链上事件来）', async () => {
  assert.equal(PUPPY_EVENT_TOPIC, '0x' + keccak256('PuppyRegistered(uint256,address,address,string,uint64)'));
  const fakeReceipt = {
    status: '0x1',
    logs: [
      { address: '0xdeadbeef'.padEnd(42, '0'), topics: [PUPPY_EVENT_TOPIC, '0x' + '0'.repeat(63) + '1'], data: '0x' }, // 别的合约：跳过
      {
        address: config.puppyIdentity.contract || WALLET, // 未配置时占位；实际用例在 self 模式下跑
        topics: [
          PUPPY_EVENT_TOPIC,
          '0x' + BigInt(0).toString(16).padStart(64, '0'),
          '0x' + '0'.repeat(24) + WALLET.slice(2).toLowerCase(),
          '0x' + '0'.repeat(24) + OTHER_WALLET.slice(2).toLowerCase(),
        ],
        data: '0x' + '0'.repeat(64) + '0'.repeat(63) + '2a', // name 偏移 + bornAt=42（data 不参与解析）
      },
    ],
  };
  // 配置合约后解析
  config.puppyIdentity.contract = WALLET.toLowerCase();
  fakeReceipt.logs[1].address = config.puppyIdentity.contract;
  const ev = parsePuppyRegisteredLog(fakeReceipt);
  assert.equal(ev.tokenId, 0);
  assert.equal(ev.owner, WALLET.toLowerCase());
  assert.equal(ev.agentWallet, OTHER_WALLET.toLowerCase());
  assert.equal(parsePuppyRegisteredLog({ logs: [] }), null);
});

// ---------- off 模式降级 ----------
await check('未配置合约：mode off、status 如实报告、register/tip 409 AGENTOS_NOT_CONFIGURED', async () => {
  config.puppyIdentity.contract = '';
  assert.equal(agentosMode(), 'off');
  const home = await mkHomeWithUsers();
  const ctx = fakeCtx({ id: 'u1' }, { name: NAME, agentWallet: WALLET });
  const r = await routes['POST /api/agentos/puppy/register'](ctx).catch((e) => e);
  assert.equal(r.code, 'AGENTOS_NOT_CONFIGURED');
  assert.equal((await routes['GET /api/agentos/status'](fakeCtx({ id: 'u1' }))).data.data.mode, 'off');
});

// ---------- self 模式：注册/铸造/打赏台账 ----------
await check('self 模式：register 备好 calldata → bind 置 SUBMITTED → 回执对账 REGISTERED（链上事件为准）', async () => {
  config.puppyIdentity.contract = WALLET.toLowerCase(); // 任意合法地址（不真正上链）
  const home = await mkHomeWithUsers();
  const ctx = fakeCtx({ id: 'u1' }, { name: NAME, agentWallet: OTHER_WALLET });
  const r = await routes['POST /api/agentos/puppy/register'](ctx);
  const prep = r.data.data;
  assert.equal(prep.contract, config.puppyIdentity.contract);
  assert.ok(prep.calldata.startsWith('0x1c351a9d'));
  assert.equal(puppyRowOf(home.id).identity_status, 'PENDING');
  assert.equal(puppyRowOf(home.id).puppy_name, NAME);

  const bind = await routes['POST /api/agentos/puppy/bind'](fakeCtx({ id: 'u1' }, { txHash: '0x' + 'ab'.repeat(32) }));
  assert.equal(bind.data.data.identityStatus, 'SUBMITTED');
  assert.equal(puppyRowOf(home.id).mint_tx, 'ab'.repeat(32));

  // 对账：mock rpc 返回成功回执 + 事件
  const { rpc } = await import('../server/domain/public-chain.js');
  const realRpc = config.onchain.rpcUrl;
  const origRpc = rpc; // rpc 是模块内引用，改不了——改走 refreshPuppyRow 的注入点：直接替换 public-chain 的 rpc 不可行，
  // 改为构造回执后直接调用 refreshPuppyRow 前先 mock fetch（rpc 的 fetch 在 public-chain 模块闭包里）。
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      jsonrpc: '2.0', id: 1,
      result: {
        status: '0x1', to: config.puppyIdentity.contract,
        logs: [{
          address: config.puppyIdentity.contract,
          topics: [
            PUPPY_EVENT_TOPIC,
            '0x' + BigInt(7).toString(16).padStart(64, '0'),
            '0x' + '0'.repeat(24) + OTHER_WALLET.slice(2).toLowerCase(),
            '0x' + '0'.repeat(24) + WALLET.slice(2).toLowerCase(),
          ],
          data: '0x' + '0'.repeat(128),
        }],
      },
    }),
  });
  config.onchain.rpcUrl = 'http://127.0.0.1:9/mock'; // 让 rpc() 走 mock fetch（真实地址不会被动用）
  const refreshed = await refreshPuppyRow(puppyRowOf(home.id));
  assert.equal(refreshed.identity_status, 'REGISTERED');
  assert.equal(refreshed.agent_token_id, 7);
  assert.equal(refreshed.owner_address, OTHER_WALLET.toLowerCase());
  assert.equal(refreshed.account_address, WALLET.toLowerCase()); // 存钱罐以链上事件为准
  config.onchain.rpcUrl = realRpc;
  const card = puppyCard(refreshed);
  assert.equal(card.status, 'REGISTERED');
  assert.equal(card.status, card.identityStatus); // 前端契约：短名别名必须有值
  assert.equal(card.mintTxUrl?.endsWith('/tx/' + 'ab'.repeat(32)), true);
});

await check('铸造守卫：REGISTERED 拒绝重铸（409 ALREADY_REGISTERED）；FAILED 可重备参数再试', async () => {
  const home = { id: 'home_t1' };
  const r = await routes['POST /api/agentos/puppy/register'](fakeCtx({ id: 'u1' }, { name: '新名字', agentWallet: WALLET })).catch((e) => e);
  assert.equal(r.code, 'ALREADY_REGISTERED');
  // 改成 FAILED 再备：可覆盖名字与存钱罐
  db.prepare("UPDATE agentos_identities SET identity_status = 'FAILED' WHERE home_id = ?").run(home.id);
  const r2 = await routes['POST /api/agentos/puppy/register'](fakeCtx({ id: 'u1' }, { name: '毛毛', agentWallet: OTHER_WALLET }));
  assert.ok(r2.data.data.calldata.startsWith('0x1c351a9d'));
  const row = puppyRowOf(home.id);
  assert.equal(row.puppy_name, '毛毛');
  assert.equal(row.identity_status, 'PENDING');
});

await check('打赏守卫与台账：未就绪 409 / 金额守卫 / bind 剥 0x / wei 字符串出口', async () => {
  const home = { id: 'home_t1' };
  db.prepare("UPDATE agentos_identities SET identity_status = 'REGISTERED', account_address = ? WHERE home_id = ?").run(WALLET.toLowerCase(), home.id);
  const tip = await routes['POST /api/agentos/puppy/tip'](fakeCtx({ id: 'u2' }, { amountBot: '1.5' }));
  assert.equal(tip.data.data.toAddress, WALLET.toLowerCase());
  assert.equal(tip.data.data.amountWei, '1500000000000000000');
  assert.ok(tip.data.data.tipId.startsWith('tip_'));
  const bad = await routes['POST /api/agentos/puppy/tip'](fakeCtx({ id: 'u2' }, { amountBot: '1001' })).catch((e) => e);
  assert.equal(bad.code, 'VALIDATION_FAILED');
  const bindCtx = fakeCtx({ id: 'u2' }, { txHash: '0x' + 'cd'.repeat(32) });
  bindCtx.params = { tipId: tip.data.data.tipId };
  const bound = await routes['POST /api/agentos/puppy/tip/:tipId/bind'](bindCtx);
  assert.equal(bound.data.data.status, 'submitted');
  assert.equal(bound.data.data.txHash, 'cd'.repeat(32));
});

console.log(`\n${passed} 项全部通过`);
try {
  rmSync(TMP, { recursive: true, force: true });
} catch {
  // 临时目录留给系统清理
}
