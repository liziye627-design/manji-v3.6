// 慢记 Manji v3.6.3 —— 链上小狗身份域模块（自托管 ManjiPuppyIdentity 合约，BOT Chain 主网）
// 职责：给每个家的小狗铸一枚链上身份 NFT（名字上链、链上生日、存钱罐地址、data-URI 身份文件），
//       铸造由成员自己的钱包直接签名（C 端主网交互）；再管理成员打赏台账——打赏同样是钱包直发，
//       本应用只登记与对账，不接触任何私钥。
//
// 背景：官方 Agent OS 托管 API（ERC-8004 IdentityRegistry + Agent Wallet）按项目签发 key，
//       本应用暂未获批（申请话术见 docs/AGENTOS-APIKEY-申请话术.md，官方 API 规格见 docs/agentos-api-spec.md）。
//       本合约（contracts/ManjiPuppyIdentity.sol）实现同样的核心语义，且铸造/打赏全部由用户钱包签名。
//
// 设计原则（与公共链锚定 public-chain.js 一致）：
//   1. PUPPY_IDENTITY_CONTRACT 未配置 → 功能整体 off：接口如实返回未配置，主流程零影响；
//   2. 无任何机密：本模块不持私钥、不需要 API key（链上读写走公共链 RPC）；
//   3. 服务端边界不出现 BigInt：wei 金额唯一出口是 tip 响应的 amountWei 十进制字符串
//      （core.js sendJson 的 JSON.stringify 不认 BigInt）；同样禁止 Number(wei) 兑换；
//   4. 后台轮询复用 onchain 的 setInterval+unref 写法，逐行容错：单行失败只落 error，不阻塞后续行。
import { db } from '../db.js';
import { nowIso, newId, errors } from '../core.js';
import { config } from '../config.js';
import { rpc, explorerBase } from './public-chain.js';
import { getPet } from './permissions.js';
import { selectorOf, keccak256 } from './keccak.js';

// ---------- 合约接口（选择器来自 solc 0.8.24 对 ManjiPuppyIdentity.sol 的真实编译输出） ----------
export const PUPPY_SELECTORS = {
  mint: selectorOf('mint(string,address)'),
  ownerOf: selectorOf('ownerOf(uint256)'),
  getAgentWallet: selectorOf('getAgentWallet(uint256)'),
  totalSupply: selectorOf('totalSupply()'),
};
/** PuppyRegistered(uint256 indexed tokenId, address indexed owner, address indexed agentWallet, string name, uint64 bornAt) */
export const PUPPY_EVENT_TOPIC = '0x' + keccak256('PuppyRegistered(uint256,address,address,string,uint64)');

// ---------- 模式与守卫（纯函数，离线可测） ----------
export function agentosMode() {
  return config.puppyIdentity.contract ? 'self' : 'off';
}
export function puppyContract() {
  return config.puppyIdentity.contract || null;
}
export const EXPLORER = () => explorerBase();

// ---------- 金额换算（纯函数，离线可测） ----------
/**
 * BOT → wei（BigInt）：先 ×1e6 取整到微单位（Number 安全整数范围内无精度丢失），再 ×1e12 补足 18 位
 * ——避开「浮点直转 BigInt」的精度陷阱。返回 BigInt 仅供内部与测试，绝不能出现在路由返回值里。
 */
export function botToWei(amountBot) {
  const n = Number(amountBot);
  if (!Number.isFinite(n) || n <= 0) throw new Error('BOT 金额必须是正的有限数');
  const micro = Math.round(n * 1e6);
  if (!Number.isSafeInteger(micro)) throw new Error('BOT 金额超出精度上限');
  return BigInt(micro) * 10n ** 12n;
}

// ---------- calldata 组装与解码（纯函数，离线可测） ----------
/** 32 字节字（大端）：整数与偏移量必须左补零（曾因右补零在主网真实 revert 过，见 DEPLOYED-mainnet.json） */
const wordOfUint = (n) => BigInt(n).toString(16).padStart(64, '0');
/** 地址在 ABI 字里按 uint160 右对齐（左补 24 个零；与 ethers 编码逐字节一致，有离线验收锚定） */
const wordOfAddress = (addr) => String(addr).replace(/^0x/, '').toLowerCase().padStart(64, '0');

/**
 * mint(string,address) calldata：选择器 + 偏移量(0x40) + 地址 + 字符串长度 + UTF-8 字节右补零到 32 的倍数。
 * 名字限制 1-32 字节（合约 MAX_NAME_BYTES），与链上守卫一致——服务端先拦，省一笔注定 revert 的 gas。
 */
export function buildMintCalldata(puppyName, agentWallet) {
  const nb = Buffer.from(String(puppyName), 'utf8');
  if (nb.length === 0 || nb.length > 32) throw new Error('名字长度必须是 1-32 字节（UTF-8，约 10 个汉字）');
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(agentWallet))) throw new Error('存钱罐地址格式无效');
  return (
    '0x' +
    PUPPY_SELECTORS.mint +
    wordOfUint(0x40) + // 首个（唯一）动态参数 string 的偏移：两个字头之后
    wordOfAddress(agentWallet) +
    wordOfUint(nb.length) +
    nb.toString('hex').padEnd(Math.ceil(nb.length / 32) * 64, '0')
  );
}

/** ownerOf(uint256) calldata：选择器 + tokenId 大端左补零 */
export function buildOwnerOfCalldata(tokenId) {
  const n = Number(tokenId);
  if (!Number.isInteger(n) || n < 0) throw new Error('tokenId 必须是非负整数');
  return '0x' + PUPPY_SELECTORS.ownerOf + wordOfUint(n);
}

/** ownerOf 返回值解码：单个 32 字节 word 的地址（取低 20 字节）；空响应/长度不足返回 null */
export function parseOwnerOfResult(resultHex) {
  const h = String(resultHex || '').replace(/^0x/, '');
  if (h.length < 64) return null;
  return '0x' + h.slice(24, 64).toLowerCase();
}

/**
 * 从 mint 交易的回执日志里解析 PuppyRegistered 事件：
 * topics[1]=tokenId（indexed） topics[2]=owner topics[3]=agentWallet；data 里是 name(string)+bornAt(uint64)。
 * 找不到事件返回 null（交上层按「交易不是 mint」处理）；tokenId 从 topics 解出，不碰 data 的字符串。
 */
export function parsePuppyRegisteredLog(receipt) {
  const contract = config.puppyIdentity.contract;
  for (const log of (receipt && receipt.logs) || []) {
    if ((log.address || '').toLowerCase() !== contract) continue;
    if (!log.topics || log.topics[0] !== PUPPY_EVENT_TOPIC) continue;
    const tokenId = Number(BigInt(log.topics[1]));
    return {
      tokenId,
      owner: '0x' + log.topics[2].slice(26).toLowerCase(),
      agentWallet: '0x' + log.topics[3].slice(26).toLowerCase(),
    };
  }
  return null;
}

// ---------- 链上只读（经公共链 RPC，带 curl 兜底；任何人可独立复现） ----------
export async function verifyPuppyOwnerOnChain(tokenId) {
  let raw;
  try {
    raw = await rpc('eth_call', [{ to: config.puppyIdentity.contract, data: buildOwnerOfCalldata(tokenId) }, 'latest']);
  } catch (err) {
    if (err && err.statusCode && /revert/i.test(String(err.message))) {
      return { found: false, reason: 'reverted', owner: null }; // ERC-721 语义：revert = 身份不存在
    }
    throw err; // 节点不可达等如实上抛，绝不谎报未登记
  }
  const owner = parseOwnerOfResult(raw);
  if (!owner) return { found: false, reason: 'empty', owner: null };
  return { found: true, reason: null, owner };
}

// 链上已铸小狗总数（卡片展示用）：60 秒缓存 + 3 秒预算，失败沿用上次成功值
let puppyCountCache = { value: null, at: 0 };
export async function cachedPuppyTotal() {
  if (puppyCountCache.value !== null && Date.now() - puppyCountCache.at < 60_000) return puppyCountCache.value;
  try {
    const raw = await Promise.race([
      rpc('eth_call', [{ to: config.puppyIdentity.contract, data: '0x' + PUPPY_SELECTORS.totalSupply }, 'latest']),
      new Promise((_, reject) => setTimeout(() => reject(new Error('totalSupply 查询超时')), 3000)),
    ]);
    const n = raw === '0x' ? 0 : Number(BigInt(raw));
    puppyCountCache = { value: n, at: Date.now() };
    return n;
  } catch {
    return puppyCountCache.value;
  }
}

// ---------- 台账读取 ----------
export function puppyRowOf(homeId) {
  return db.prepare('SELECT * FROM agentos_identities WHERE home_id = ?').get(homeId);
}

export function tipRowOf(tipId) {
  return db.prepare('SELECT * FROM agentos_tips WHERE id = ?').get(tipId);
}

/** 小狗身份卡片（API 载荷）：无 BigInt、无机密。status 是前端卡片状态机读的短名（与 identityStatus 同值） */
export function puppyCard(row) {
  const pet = getPet(row.home_id);
  const explorer = explorerBase();
  return {
    name: row.puppy_name || (pet && pet.name) || '慢记小狗',
    petName: (pet && pet.name) || '',
    externalAgentId: row.external_agent_id,
    accountAddress: row.account_address || null, // 存钱罐（打赏发这里；REGISTERED 后以链上事件为准）
    ownerAddress: row.owner_address || null,     // 铸造者（身份 owner）
    identityId: row.identity_id || null,         // 自链模式无官方 identity_id，保留字段兼容旧行
    identityStatus: row.identity_status,
    status: row.identity_status,
    agentTokenId: row.agent_token_id ?? null,
    mintTx: row.mint_tx || null,
    registeredAt: row.registered_at || null,
    error: row.error || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    explorerAddressUrl: row.account_address && explorer ? `${explorer}/address/${row.account_address}` : null,
    mintTxUrl: row.mint_tx && explorer ? `${explorer}/tx/${row.mint_tx}` : null,
  };
}

/**
 * 发起铸造（服务端只准备数据，不上链）：写/更行（PENDING + 名字 + 存钱罐），返回钱包直发所需的全部信息。
 * 幂等：REGISTERED 拒绝重铸（身份不可转让、名字不可改——想换名字铸新的一枚，那是另一行/另一次自愿）；
 * FAILED/PENDING/SUBMITTED 重来时覆盖待铸参数（还没上链的名字可以改）。
 */
export function preparePuppyMint(home, { name, agentWallet }) {
  const puppyName = String(name || '').trim();
  const nb = Buffer.from(puppyName, 'utf8');
  if (nb.length === 0 || nb.length > 32) {
    throw errors.invalid({ name: '名字长度必须是 1-32 字节（UTF-8，约 10 个汉字）' }, '小狗名字无效');
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(agentWallet))) {
    throw errors.invalid({ agentWallet: '存钱罐地址格式无效' }, '存钱罐地址无效');
  }
  const existing = puppyRowOf(home.id);
  if (existing && existing.identity_status === 'REGISTERED') {
    throw errors.conflict('ALREADY_REGISTERED', '这只小狗已经有链上身份了', { puppy: puppyCard(existing) });
  }
  if (!existing) {
    db.prepare(
      `INSERT INTO agentos_identities (home_id, external_agent_id, idem_wallet, idem_identity, puppy_name,
         account_address, identity_status, created_at, updated_at)
       VALUES (?, ?, '', '', ?, ?, 'PENDING', ?, ?)`
    ).run(home.id, `manji-${home.id}-puppy`, puppyName, String(agentWallet).toLowerCase(), nowIso(), nowIso());
  } else {
    db.prepare(
      `UPDATE agentos_identities SET puppy_name = ?, account_address = ?, identity_status = 'PENDING',
         mint_tx = NULL, error = NULL, updated_at = ? WHERE home_id = ?`
    ).run(puppyName, String(agentWallet).toLowerCase(), nowIso(), home.id);
  }
  return {
    contract: config.puppyIdentity.contract,
    chainId: Number(config.onchain.chainId) || null,
    calldata: buildMintCalldata(puppyName, agentWallet),
    explorer: explorerBase(),
    note: '用你的钱包把这笔 calldata 发给小狗身份合约（mint 函数）；确认后回来回填交易哈希。',
  };
}

/** 钱包已发出铸造交易：回填哈希置 SUBMITTED，出块对账交后台 poller */
export function bindPuppyMint(home, txHash) {
  const row = puppyRowOf(home.id);
  if (!row) throw errors.notFound('这只小狗还没有发起过铸造');
  if (row.identity_status === 'REGISTERED') return puppyRowOf(home.id); // 已确认不降级
  db.prepare("UPDATE agentos_identities SET identity_status = 'SUBMITTED', mint_tx = ?, error = NULL, updated_at = ? WHERE home_id = ?")
    .run(txHash, nowIso(), home.id);
  return puppyRowOf(home.id);
}

/**
 * 打赏登记：守卫全部通过才 INSERT pending 行，实际转账由成员钱包在前端直发（to=存钱罐，value=amountWei）。
 */
export function tipPuppy(home, userId, amountBotRaw) {
  const row = puppyRowOf(home.id);
  if (!row) throw errors.notFound('这只小狗还没有链上身份');
  if (!row.account_address || row.identity_status !== 'REGISTERED') {
    throw errors.conflict('PUPPY_NOT_READY', '小狗的链上身份还没就绪，暂时不能打赏');
  }
  const n = Number(amountBotRaw);
  if (!Number.isFinite(n) || n <= 0 || n > 1000) {
    throw errors.invalid({ amountBot: '金额必须是大于 0 且不超过 1000 的 BOT 数' }, '打赏金额无效');
  }
  const tipId = newId('tip');
  db.prepare(
    `INSERT INTO agentos_tips (id, home_id, from_user_id, amount_bot, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?)`
  ).run(tipId, home.id, userId, String(amountBotRaw), nowIso(), nowIso());
  return { tipId, toAddress: row.account_address, amountWei: botToWei(n).toString() };
}

/** 成员钱包已发出打赏交易：回填哈希置 submitted，链上对账交后台 poller */
export function bindTip(home, tipId, txHash) {
  const row = tipRowOf(tipId);
  if (!row || row.home_id !== home.id) throw errors.notFound('没有这笔打赏');
  if (row.status === 'confirmed') return row;
  db.prepare("UPDATE agentos_tips SET status = 'submitted', tx_hash = ?, error = NULL, updated_at = ? WHERE id = ?")
    .run(txHash, nowIso(), tipId);
  return tipRowOf(tipId);
}

// ---------- 逐行复核（照 refreshSealRow 粒度：单行失败只落 error，不动状态，不阻塞后续行） ----------
/**
 * 复核一行铸造：SUBMITTED → 查回执 →
 *   成功且解析出 PuppyRegistered 事件 → REGISTERED：tokenId、owner、存钱罐全部以链上事件为准落库；
 *   成功但不是本合约的 mint 交易 → FAILED（哈希对不上）；reverted → FAILED；未出块 → 保持 SUBMITTED。
 * token id 晚到（REGISTERED 但 agent_token_id 为空，理论不该发生）也会继续补查。
 */
export async function refreshPuppyRow(row) {
  if (!row.mint_tx || row.identity_status === 'REGISTERED') return puppyRowOf(row.home_id);
  try {
    const receipt = await rpc('eth_getTransactionReceipt', ['0x' + row.mint_tx]).catch(() => null);
    if (!receipt) return puppyRowOf(row.home_id); // 尚未出块：下一轮再看
    if (receipt.status !== '0x1') {
      db.prepare("UPDATE agentos_identities SET identity_status = 'FAILED', error = '铸造交易在链上执行失败（reverted）', updated_at = ? WHERE home_id = ? AND identity_status != 'REGISTERED'")
        .run(nowIso(), row.home_id);
      return puppyRowOf(row.home_id);
    }
    const ev = parsePuppyRegisteredLog(receipt);
    if (!ev) {
      db.prepare("UPDATE agentos_identities SET identity_status = 'FAILED', error = '交易成功但不是小狗身份合约的铸造交易', updated_at = ? WHERE home_id = ? AND identity_status != 'REGISTERED'")
        .run(nowIso(), row.home_id);
      return puppyRowOf(row.home_id);
    }
    db.prepare(
      `UPDATE agentos_identities SET identity_status = 'REGISTERED', agent_token_id = ?, owner_address = ?,
         account_address = ?, registered_at = COALESCE(registered_at, ?), error = NULL, updated_at = ?
       WHERE home_id = ? AND identity_status != 'REGISTERED'`
    ).run(ev.tokenId, ev.owner, ev.agentWallet, nowIso(), nowIso(), row.home_id);
  } catch (err) {
    db.prepare('UPDATE agentos_identities SET error = ?, updated_at = ? WHERE home_id = ? AND identity_status != \'REGISTERED\'')
      .run(String(err && err.message).slice(0, 300), nowIso(), row.home_id);
  }
  return puppyRowOf(row.home_id);
}

/**
 * 复核一笔已回填交易的打赏：查回执——status=0x1 且收款地址=存钱罐 → confirmed；reverted → failed。
 * 已知限制（首版）：不校验交易金额。
 */
export async function refreshTipRow(row) {
  if (!config.onchain.rpcUrl) return { row, skipped: true };
  try {
    if (!row.tx_hash) return { row, skipped: true };
    const receipt = await rpc('eth_getTransactionReceipt', ['0x' + row.tx_hash]).catch(() => null);
    if (!receipt) return { row, skipped: true };
    const puppy = puppyRowOf(row.home_id);
    const to = String(receipt.to || '').toLowerCase();
    if (receipt.status === '0x1' && puppy && puppy.account_address && to === String(puppy.account_address).toLowerCase()) {
      db.prepare("UPDATE agentos_tips SET status = 'confirmed', error = NULL, updated_at = ? WHERE id = ? AND status != 'confirmed'")
        .run(nowIso(), row.id);
    } else if (receipt.status !== '0x1') {
      db.prepare("UPDATE agentos_tips SET status = 'failed', error = '交易在链上执行失败（reverted）', updated_at = ? WHERE id = ? AND status = 'submitted'")
        .run(nowIso(), row.id);
    } else {
      db.prepare("UPDATE agentos_tips SET status = 'failed', error = '交易收款地址与小狗存钱罐不一致', updated_at = ? WHERE id = ? AND status = 'submitted'")
        .run(nowIso(), row.id);
    }
  } catch (err) {
    db.prepare('UPDATE agentos_tips SET error = ?, updated_at = ? WHERE id = ?')
      .run(String(err && err.message).slice(0, 300), nowIso(), row.id);
  }
  return { row: tipRowOf(row.id), skipped: false };
}

// ---------- 后台循环：铸造出块对账 + 打赏对账（写法照 startOnchainSubmitter） ----------
let pollerStarted = false;
let pollerTicking = false; // 互斥：一轮未结束绝不开始下一轮

export function startAgentosPoller() {
  if (pollerStarted) return;
  pollerStarted = true;
  const tick = async () => {
    if (pollerTicking) return;
    pollerTicking = true;
    try {
      if (agentosMode() === 'off' || !config.onchain.rpcUrl) return;
      const minting = db.prepare(
        "SELECT * FROM agentos_identities WHERE identity_status = 'SUBMITTED' OR (identity_status = 'REGISTERED' AND agent_token_id IS NULL) LIMIT 32"
      ).all();
      for (const row of minting) await refreshPuppyRow(row);
      const tips = db.prepare("SELECT * FROM agentos_tips WHERE status = 'submitted' ORDER BY created_at ASC LIMIT 64").all();
      for (const row of tips) await refreshTipRow(row);
    } catch (err) {
      console.warn('[manji] 链上小狗轮询循环异常：', err && err.message);
    } finally {
      pollerTicking = false;
    }
  };
  setInterval(tick, 15_000).unref();
}
