// 慢记 Manji v3.6 —— 公共链锚定域模块（BOT Chain / 任意 EVM 兼容链）
// 职责：把本地永恒之链已镌刻的承诺（日记/约定）与本地链头部，提交到公共链合约 ManjiEternalChain。
//
// 三种运行模式（由 .env 决定，全部可降级，绝不影响本地永恒之链的正常镌刻）：
//   off     未配置合约地址：功能整体关闭，API 如实返回未配置；
//   manual  配置了 RPC + 合约地址：可实时核验已上链承诺；新请求进入待办队列，
//           运营者用 Remix / MetaMask 把给出的 calldata 发送上链，再回填交易哈希自动确认；
//   auto    另配置了统一代提交私钥（需要 `npm i ethers`）：后台每 15 秒把待办承诺
//           查重后批量（sealBatch）发上链，并在出块后自动回填登记序号与时间。
//
// 隐私原则（《心动铃铛-关系上链隐私与退出机制研究》）：
//   发上链的只有承诺哈希与本地链头部哈希——没有正文、照片、成员身份或关系状态；
//   交易由统一 relayer 账户发送，成员地址不进入任何交易。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { db } from '../db.js';
import { nowIso, sha256 } from '../core.js';
import { config } from '../config.js';
import { selectorOf, keccak256 } from './keccak.js';
import { latestBlock, chainIdExisting } from './chain.js';

const execFileAsync = promisify(execFile);

// ---------- 合约接口（选择器已在 keccak.js 里与编译器输出比对过） ----------
export const CONTRACT_NAME = 'ManjiEternalChain';
export const SELECTORS = {
  seal: selectorOf('seal(bytes32)'),
  sealBatch: selectorOf('sealBatch(bytes32[])'),
  sealOf: selectorOf('sealOf(bytes32)'),
  anchorHead: selectorOf('anchorHead(bytes16,bytes32,uint64)'),
  headOf: selectorOf('headOf(bytes16)'),
  sealCount: selectorOf('sealCount()'),
  version: selectorOf('VERSION()'),
};
export const SEALED_EVENT_TOPIC = '0x' + keccak256('Sealed(bytes32,uint64,uint64)');

// ---------- 十六进制工具 ----------
const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
export const isHex32 = (s) => typeof s === 'string' && HEX32.test(s);
export const isHex64 = (s) => typeof s === 'string' && HEX64.test(s);

/** bytes32 参数：32 字节小端无关，直接左对齐（值本身 32 字节，无需填充） */
const wordOf = (hex64) => hex64;
/** bytes16 参数：定长字节右补零到 32 字节 */
const wordOfBytes16 = (hex32) => hex32.padEnd(64, '0');
/** 整数参数：大端、左补零到 32 字节 */
const wordOfUint = (n) => BigInt(n).toString(16).padStart(64, '0');

/**
 * 链编号（bytes16）的确定性派生：应用的 chainId 是 base64url 随机串（非十六进制），
 * 上链取 SHA-256(chainId 字符串) 的前 16 字节。第三方拿着导出文件里的 chainId 用同一规则即可复算。
 */
export function chainIdBytes16Hex(chainIdStr) {
  if (typeof chainIdStr !== 'string' || !chainIdStr) throw new Error('chainId 不能为空');
  return sha256(chainIdStr).slice(0, 32);
}

// ---------- calldata 组装（供自动提交与「手动提交指引」共用） ----------
export function buildSealCalldata(commitmentHex) {
  if (!isHex64(commitmentHex)) throw new Error('commitment 必须是 64 位十六进制');
  return '0x' + SELECTORS.seal + wordOf(commitmentHex);
}

export function buildSealBatchCalldata(commitmentHexes) {
  if (!commitmentHexes.length) throw new Error('空批次');
  if (commitmentHexes.length > 256) throw new Error('单批最多 256 条（合约 MAX_BATCH）');
  const head = SELECTORS.sealBatch;
  const offset = (32).toString(16).padStart(64, '0'); // 首个（唯一）动态参数的偏移恒为 0x20
  const len = commitmentHexes.length.toString(16).padStart(64, '0');
  return '0x' + head + offset + len + commitmentHexes.map(wordOf).join('');
}

export function buildSealOfCalldata(commitmentHex) {
  return '0x' + SELECTORS.sealOf + wordOf(commitmentHex);
}

export function buildAnchorHeadCalldata(chainIdStr, headHashHex64, localHeight) {
  if (!isHex64(headHashHex64)) throw new Error('headHash 必须是 64 位十六进制');
  return '0x' + SELECTORS.anchorHead + wordOfBytes16(chainIdBytes16Hex(chainIdStr)) + wordOf(headHashHex64) + wordOfUint(localHeight);
}

export function buildHeadOfCalldata(chainIdStr) {
  return '0x' + SELECTORS.headOf + wordOfBytes16(chainIdBytes16Hex(chainIdStr));
}

// ---------- 返回值解码 ----------
function wordsOf(resultHex) {
  const h = resultHex.replace(/^0x/, '');
  const words = [];
  for (let i = 0; i + 64 <= h.length; i += 64) words.push(h.slice(i, i + 64));
  return words;
}

/** sealOf(bytes32) returns (bool found, uint64 index, uint64 sealedAt) */
export function parseSealOfResult(resultHex) {
  const w = wordsOf(resultHex || '0x');
  if (w.length < 3) return { found: false, index: null, sealedAt: null };
  const found = BigInt('0x' + w[0]) !== 0n;
  return {
    found,
    index: found ? Number(BigInt('0x' + w[1])) : null,
    sealedAt: found ? Number(BigInt('0x' + w[2])) : null,
  };
}

/** headOf(bytes16) returns (bool found, bytes32 headHash, uint64 localHeight, uint64 anchoredAt) */
export function parseHeadOfResult(resultHex) {
  const w = wordsOf(resultHex || '0x');
  if (w.length < 4) return { found: false, headHash: null, localHeight: null, anchoredAt: null };
  const found = BigInt('0x' + w[0]) !== 0n;
  return {
    found,
    headHash: found ? w[1] : null,
    localHeight: found ? Number(BigInt('0x' + w[2])) : null,
    anchoredAt: found ? Number(BigInt('0x' + w[3])) : null,
  };
}

// ---------- 模式与配置 ----------
export function onchainMode() {
  const c = config.onchain;
  if (!c.contract || !c.rpcUrl || !c.chainId) return 'off';
  return c.relayerKey ? 'auto' : 'manual';
}

export function assertConfigured() {
  if (onchainMode() === 'off') {
    throw Object.assign(new Error('公共链锚定未配置：请在 .env 设置 ONCHAIN_RPC_URL / ONCHAIN_CHAIN_ID / ONCHAIN_CONTRACT'), { statusCode: 409, code: 'ONCHAIN_NOT_CONFIGURED' });
  }
}

export function explorerTxUrl(txHash) {
  return config.onchain.explorer && txHash ? `${config.onchain.explorer.replace(/\/$/, '')}/tx/${txHash}` : null;
}

/** 浏览器根地址（页面用它拼 /address/合约、/tx/交易 链接） */
export function explorerBase() {
  return config.onchain.explorer ? config.onchain.explorer.replace(/\/$/, '') : null;
}

// ---------- JSON-RPC（零 npm 依赖；Node 22+ 自带 fetch） ----------
let rpcSeq = 1;

/**
 * 少数网络环境下，本机 Node 的 TLS 连接会被某些 RPC 节点选择性丢弃（fetch 报 Connect Timeout），
 * 同机 curl 却可以连通（TLS 指纹差异）。因此 fetch 失败时自动降级为 curl 转发同一请求；
 * 两条路径请求体完全一致，不引入任何解析差异。curl 在 Windows 10+/macOS/Linux 均内置。
 */
async function rpcViaCurl(bodyJson) {
  const { stdout } = await execFileAsync(
    'curl',
    ['-sS', '-m', '30', '-X', 'POST', config.onchain.rpcUrl, '-H', 'content-type: application/json', '-d', bodyJson],
    { windowsHide: true }
  );
  return JSON.parse(stdout);
}

export async function rpc(method, params) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: rpcSeq++, method, params });
  const interpret = (json) => {
    if (!json || json.error) {
      throw Object.assign(
        new Error(`RPC ${method} 失败: ${json && json.error ? json.error.message || JSON.stringify(json.error) : '空响应'}`),
        { statusCode: 502 }
      );
    }
    return json.result;
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(config.onchain.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: controller.signal,
    });
    return interpret(await res.json().catch(() => null));
  } catch (err) {
    if (err && err.statusCode) throw err; // RPC 层明确错误：不再降级重试
    try {
      return interpret(await rpcViaCurl(body));
    } catch (curlErr) {
      if (curlErr && curlErr.statusCode) throw curlErr;
      throw Object.assign(new Error(`RPC ${method} 不可达（fetch: ${err.message}; curl: ${curlErr.message}）`), { statusCode: 502 });
    }
  } finally {
    clearTimeout(timer);
  }
}

async function ethCall(data) {
  return rpc('eth_call', [{ to: config.onchain.contract, data }, 'latest']);
}

/** 实时核验：问公共链「这条承诺登记过吗」。任何人都可以用同样的 eth_call 独立完成，不依赖本应用。 */
export async function verifyCommitmentOnChain(commitmentHex) {
  const raw = await ethCall(buildSealOfCalldata(commitmentHex));
  const r = parseSealOfResult(raw);
  return { ...r, sealedAtIso: r.sealedAt ? new Date(r.sealedAt * 1000).toISOString() : null };
}

export async function verifyHeadOnChain(chainIdStr) {
  const raw = await ethCall(buildHeadOfCalldata(chainIdStr));
  const r = parseHeadOfResult(raw);
  return { ...r, anchoredAtIso: r.anchoredAt ? new Date(r.anchoredAt * 1000).toISOString() : null };
}

export async function chainSealCount() {
  const raw = await ethCall('0x' + SELECTORS.sealCount);
  return raw === '0x' ? 0 : Number(BigInt(raw));
}

// ---------- 公开核验门户（免登录）：任何人可查这条链上的慢记存证 ----------
/** 公开门户首页信息：只有本来就公开的链上事实，无任何应用内部数据 */
export async function publicChainInfo() {
  const mode = onchainMode();
  if (mode === 'off') return { configured: false };
  return {
    configured: true,
    contractName: CONTRACT_NAME,
    chainId: config.onchain.chainId,
    contract: config.onchain.contract,
    explorer: explorerBase(),
    walletDirect: await walletDirectSupported(),
    sealCount: await cachedChainSealCount(),
  };
}

/**
 * 公开查询一个 64 位十六进制值：先按交易哈希查回执（命中则解析 Sealed 事件里登记的承诺），
 * 查不到再按承诺哈希做 sealOf。两条路都是只读 eth_call/回执查询，任何人可独立复现。
 */
export async function publicLookup(hashHex64) {
  const receipt = await rpc('eth_getTransactionReceipt', ['0x' + hashHex64]).catch(() => null);
  const explorerUrl = explorerTxUrl(hashHex64);
  if (receipt) {
    const seals = [];
    for (const log of receipt.logs || []) {
      if ((log.address || '').toLowerCase() !== config.onchain.contract) continue;
      if (!log.topics || log.topics[0] !== SEALED_EVENT_TOPIC) continue;
      // Sealed(bytes32 indexed commitment, uint64 index, uint64 sealedAt)
      const words = (log.data || '0x').replace(/^0x/, '').match(/.{64}/g) || [];
      const index = words[0] ? Number(BigInt('0x' + words[0])) : null;
      const sealedAt = words[1] ? Number(BigInt('0x' + words[1])) : null;
      seals.push({
        commitment: log.topics[1].replace(/^0x/, '').toLowerCase(),
        index,
        sealedAtIso: sealedAt ? new Date(sealedAt * 1000).toISOString() : null,
      });
    }
    return {
      kind: 'tx',
      tx: {
        hash: hashHex64,
        explorerUrl,
        to: (receipt.to || '').toLowerCase(),
        isOurContract: (receipt.to || '').toLowerCase() === config.onchain.contract,
        status: receipt.status === '0x1',
        blockNumber: receipt.blockNumber ? Number(BigInt(receipt.blockNumber)) : null,
        from: (receipt.from || '').toLowerCase(),
        seals,
      },
    };
  }
  const onchain = await verifyCommitmentOnChain(hashHex64);
  return {
    kind: 'commitment',
    commitment: {
      hash: hashHex64,
      found: onchain.found,
      index: onchain.index,
      sealedAtIso: onchain.sealedAtIso,
    },
  };
}

// ---------- 合约版本探测（v2 起 seal/sealBatch 对任何钱包开放，页面可引导用户钱包直发） ----------
let cachedVersion = undefined; // undefined=尚未成功；成功后缓存，链上 VERSION 是常量不再变化

/** ABI string 返回值解码：word0=偏移(0x20) word1=字节长度 其后为 utf-8 数据 */
function parseStringResult(resultHex) {
  const w = wordsOf(resultHex || '0x');
  if (w.length < 3) return null;
  const len = Number(BigInt('0x' + w[1]));
  if (!len || len > 64) return null;
  const hex = w.slice(2).join('').slice(0, len * 2);
  try {
    return Buffer.from(hex, 'hex').toString('utf8');
  } catch {
    return null;
  }
}

/** 问链上 VERSION()（带 3 秒预算：状态接口不该被慢 RPC 拖住）；失败返回 null，下次再试 */
export async function contractVersion() {
  if (cachedVersion !== undefined) return cachedVersion;
  try {
    const raw = await Promise.race([
      ethCall('0x' + SELECTORS.version),
      new Promise((_, reject) => setTimeout(() => reject(new Error('VERSION() 查询超时')), 3000)),
    ]);
    const v = parseStringResult(raw);
    if (v) cachedVersion = v;
    return v || null;
  } catch {
    return null;
  }
}

/** 页面钱包直发是否可用：v2+ 合约开放 seal 写权限；旧合约（v1 只有 owner/relayer 可写）返回 false；探测失败返回 null（未知） */
export async function walletDirectSupported() {
  const v = await contractVersion();
  if (v === null) return null;
  return Number(v) >= 2;
}

// ---------- 承诺提交队列 ----------
export function sealRowOf(anchorId) {
  return db.prepare('SELECT * FROM public_seals WHERE id = ?').get(anchorId);
}

/** 某条本地锚定的主网登记状态（挂在约定/日记载荷上，供列表卡片显示主网徽章） */
export function mainnetSealOfAnchor(anchorId) {
  const row = db.prepare('SELECT status, seal_index FROM public_seals WHERE id = ?').get(anchorId);
  return row ? { status: row.status, sealIndex: row.seal_index } : null;
}

// 主网登记总数（面板展示用）：60 秒缓存；查询带 3 秒预算（首次慢 RPC 不拖住状态接口），失败沿用上次成功值
let sealCountCache = { value: null, at: 0 };
export async function cachedChainSealCount() {
  if (sealCountCache.value !== null && Date.now() - sealCountCache.at < 60_000) return sealCountCache.value;
  try {
    const n = await Promise.race([
      chainSealCount(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('sealCount 查询超时')), 3000)),
    ]);
    sealCountCache = { value: n, at: Date.now() };
    return n;
  } catch {
    return sealCountCache.value;
  }
}

export function sealsOfHome(homeId) {
  return db.prepare('SELECT * FROM public_seals WHERE home_id = ? ORDER BY created_at ASC').all(homeId);
}

/** 把一条本地锚定加入公共链待办。幂等：已确认的不重复入队；上次失败的重新排队（可重试）。 */
export function enqueueSeal(anchor) {
  const existing = sealRowOf(anchor.id);
  if (existing) {
    if (existing.status === 'failed') {
      db.prepare("UPDATE public_seals SET status = 'pending', error = NULL, updated_at = ? WHERE id = ?").run(nowIso(), anchor.id);
    }
    return { row: sealRowOf(anchor.id), queued: existing.status === 'failed' };
  }
  db.prepare(
    `INSERT INTO public_seals (id, home_id, record_type, record_id, revision, commitment, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
  ).run(anchor.id, anchor.home_id, anchor.record_type, anchor.record_id, anchor.revision, anchor.commitment, nowIso(), nowIso());
  return { row: sealRowOf(anchor.id), queued: true };
}

/** 手动模式：运营者已用 Remix/MetaMask 发送交易，回填交易哈希，等待出块后自动确认 */
export function bindTx(anchorId, txHash) {
  if (!isHex64(txHash)) throw Object.assign(new Error('交易哈希必须是 64 位十六进制'), { statusCode: 400, code: 'BAD_TX_HASH' });
  const row = sealRowOf(anchorId);
  if (!row) throw Object.assign(new Error('没有这条待办'), { statusCode: 404 });
  if (row.status === 'confirmed') return sealRowOf(anchorId);
  db.prepare('UPDATE public_seals SET status = ?, tx_hash = ?, error = NULL, updated_at = ? WHERE id = ?').run('submitted', txHash, nowIso(), anchorId);
  return sealRowOf(anchorId);
}

function markConfirmed(anchorId, index, sealedAt, txHash) {
  db.prepare(
    'UPDATE public_seals SET status = ?, seal_index = ?, sealed_at = ?, tx_hash = COALESCE(?, tx_hash), error = NULL, updated_at = ? WHERE id = ?'
  ).run('confirmed', index, new Date(sealedAt * 1000).toISOString(), txHash || null, nowIso(), anchorId);
}

function markFailed(anchorId, message) {
  // 已确认的行绝不降级：重复交易被回滚不代表链上登记有误
  db.prepare("UPDATE public_seals SET status = 'failed', error = ?, updated_at = ? WHERE id = ? AND status != 'confirmed'")
    .run(String(message).slice(0, 300), nowIso(), anchorId);
}

/**
 * 复核一行待办，返回 { row, checked, found }：
 *   checked=true 表示本次成功问过链上 sealOf（found 为其结论）——只有 checked 且未登记的行才允许提交，
 *   网络/查询失败时 checked=false，本轮绝不盲发（避免把已在链上的承诺再发一遍、被合约整体回滚）。
 * 1) 链上已登记（此前交易其实成功）→ 直接确认（自愈）；
 * 2) 未登记且已有交易哈希 → 查回执：成功→保持 submitted 等下一轮自愈；失败(reverted)→标记 failed；
 * 3) 其余保持等待。
 */
export async function refreshSealRow(row) {
  try {
    const onchain = await verifyCommitmentOnChain(row.commitment);
    if (onchain.found) {
      markConfirmed(row.id, onchain.index, onchain.sealedAt, row.tx_hash);
      return { row: sealRowOf(row.id), checked: true, found: true };
    }
  } catch (err) {
    return { row: { ...row, lastError: err.message }, checked: false, found: false };
  }
  if (row.tx_hash) {
    const receipt = await rpc('eth_getTransactionReceipt', [row.tx_hash]).catch(() => null);
    if (receipt) {
      if (receipt.status === '0x1') {
        return { row: sealRowOf(row.id), checked: true, found: false }; // 成功但 sealOf 尚未可见：下轮自愈
      }
      markFailed(row.id, `交易 ${row.tx_hash} 在链上执行失败（reverted）`);
      return { row: sealRowOf(row.id), checked: true, found: false };
    }
  }
  return { row: sealRowOf(row.id), checked: true, found: false };
}

// ---------- 本地链头部锚定 ----------
export function headRowOf(homeId) {
  return db.prepare('SELECT * FROM public_head_anchors WHERE home_id = ?').get(homeId);
}

/** 为当前家安排头部锚定：幂等——同一高度的头部正在处理/已确认时，不再重复入队 */
export function enqueueHeadAnchor(homeId) {
  const chainId = chainIdExisting(homeId);
  const head = latestBlock(homeId);
  if (!chainId || !head) throw Object.assign(new Error('这条本地链还没有链编号或区块'), { statusCode: 409 });
  const row = headRowOf(homeId);
  if (row && row.local_height >= head.height) {
    // 已覆盖当前高度（pending/submitted 处理中，或 confirmed）：无需任何动作
    return { row: headRowOf(homeId), queued: false };
  }
  db.prepare(
    `INSERT INTO public_head_anchors (home_id, chain_id, head_hash, local_height, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?)
     ON CONFLICT(home_id) DO UPDATE SET chain_id = excluded.chain_id, head_hash = excluded.head_hash,
       local_height = excluded.local_height, status = 'pending', tx_hash = NULL, error = NULL, updated_at = excluded.updated_at`
  ).run(homeId, chainId, head.hash, head.height, nowIso(), nowIso());
  return { row: headRowOf(homeId), queued: true };
}

/** 复核头部待办，返回 { row, checked }：checked=true 表示成功问过链上 headOf（幂等确认与提交判断的依据） */
async function refreshHeadRow(row) {
  try {
    const onchain = await verifyHeadOnChain(row.chain_id);
    if (onchain.found && onchain.localHeight >= row.local_height) {
      db.prepare("UPDATE public_head_anchors SET status = 'confirmed', tx_hash = COALESCE(?, tx_hash), error = NULL, updated_at = ? WHERE home_id = ?")
        .run(row.tx_hash || null, nowIso(), row.home_id);
      return { row: headRowOf(row.home_id), checked: true };
    }
  } catch {
    return { row, checked: false };
  }
  if (row.tx_hash) {
    const receipt = await rpc('eth_getTransactionReceipt', [row.tx_hash]).catch(() => null);
    if (receipt && receipt.status !== '0x1') {
      db.prepare("UPDATE public_head_anchors SET status = 'failed', error = '交易执行失败（reverted）', updated_at = ? WHERE home_id = ?").run(nowIso(), row.home_id);
      return { row: headRowOf(row.home_id), checked: true };
    }
  }
  return { row: headRowOf(row.home_id), checked: true };
}

// ---------- 自动代提交（auto 模式；签名需要可选依赖 ethers） ----------
let ethersModule = undefined; // undefined=未尝试；null=不可用
async function loadEthers() {
  if (ethersModule === undefined) {
    try {
      ethersModule = await import('ethers');
    } catch {
      ethersModule = null;
      console.warn('[manji] 已配置 ONCHAIN_RELAYER_KEY 但未安装 ethers（npm i ethers），公共链提交降级为手动模式');
    }
  }
  return ethersModule;
}

// 已缓存的签名钱包（不连接 provider：签名完全本地完成，广播走上面带 curl 兜底的 rpc()）
let cachedWallet = null;
async function relayerWallet() {
  const ethers = await loadEthers();
  if (!ethers) throw new Error('自动提交需要安装 ethers：npm i ethers');
  if (!cachedWallet) cachedWallet = new ethers.Wallet(config.onchain.relayerKey);
  return cachedWallet;
}

/**
 * 组装并发送一笔合约交易：本地签名 → JSON-RPC 广播。
 * 每个后台周期最多发送一笔（承诺走 sealBatch 批量），nonce 每次实时取 pending 值，天然串行不撞车。
 * 使用传统（type 0）交易与节点返回的 eth_gasPrice：已在本机对 BOT 主网实测通过。
 */
async function sendTx(calldata, gasLimit = 300_000) {
  const wallet = await relayerWallet();
  const [nonceHex, gasPriceHex, estimate] = await Promise.all([
    rpc('eth_getTransactionCount', [wallet.address, 'pending']),
    rpc('eth_gasPrice', []),
    rpc('eth_estimateGas', [{ from: wallet.address, to: config.onchain.contract, data: calldata }]).catch(() => null),
  ]);
  const limit = estimate ? Math.ceil((Number(BigInt(estimate)) * 1.3) / 1000) * 1000 : gasLimit;
  const raw = await wallet.signTransaction({
    chainId: config.onchain.chainId,
    nonce: Number(BigInt(nonceHex)),
    gasLimit: limit,
    gasPrice: BigInt(gasPriceHex),
    to: config.onchain.contract,
    data: calldata,
    type: 0,
  });
  return await rpc('eth_sendRawTransaction', [raw]);
}

// ---------- 后台循环：复核待办 + 自动提交（auto 模式） ----------
let started = false;
let ticking = false; // 互斥：一轮未结束绝不开始下一轮（tick 内多次 RPC 较慢，重入会把同一批待办重复发上链）

export function startOnchainSubmitter() {
  if (started) return;
  started = true;
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      const mode = onchainMode();
      if (mode === 'off') return;

      // 1) 复核待办承诺：只有「成功问过链上且未登记」(checked && !found) 的 pending 行才允许提交
      const waiting = db.prepare("SELECT * FROM public_seals WHERE status IN ('pending','submitted') ORDER BY created_at ASC LIMIT 128").all();
      const submittable = [];
      for (const row of waiting) {
        const r = await refreshSealRow(row);
        if (r.checked && !r.found && r.row && r.row.status === 'pending') submittable.push(r.row);
      }

      // 2) 本地链头部复核
      const headWaiting = db.prepare("SELECT * FROM public_head_anchors WHERE status IN ('pending','submitted') LIMIT 8").all();
      let headReady = null;
      for (const row of headWaiting) {
        const r = await refreshHeadRow(row);
        if (r.checked && r.row && r.row.status === 'pending') headReady = r.row;
      }

      // 3) auto 模式：批量提交承诺 + 头部
      if (mode === 'auto') {
        const commitments = [...new Set(submittable.map((r) => r.commitment))];
        if (commitments.length) {
          const txHash = await sendTx(commitments.length === 1 ? buildSealCalldata(commitments[0]) : buildSealBatchCalldata(commitments));
          const mark = db.prepare("UPDATE public_seals SET status = 'submitted', tx_hash = ?, updated_at = ? WHERE commitment = ? AND status = 'pending'");
          for (const c of commitments) mark.run(txHash, nowIso(), c);
          console.log(`[manji] 公共链：${commitments.length} 条承诺已提交，交易 ${txHash}`);
        }
        if (headReady) {
          try {
            const txHash = await sendTx(buildAnchorHeadCalldata(headReady.chain_id, headReady.head_hash, headReady.local_height));
            db.prepare("UPDATE public_head_anchors SET status = 'submitted', tx_hash = ?, updated_at = ? WHERE home_id = ?").run(txHash, nowIso(), headReady.home_id);
            console.log(`[manji] 公共链：本地链头部（高度 ${headReady.local_height}）已提交，交易 ${txHash}`);
          } catch (err) {
            console.warn('[manji] 公共链：头部锚定提交失败：', err.message);
            db.prepare("UPDATE public_head_anchors SET status = 'failed', error = ?, updated_at = ? WHERE home_id = ?").run(String(err.message).slice(0, 300), nowIso(), headReady.home_id);
          }
        }
      }
    } catch (err) {
      console.warn('[manji] 公共链提交循环异常：', err.message);
    } finally {
      ticking = false;
    }
  };
  setInterval(tick, 15_000).unref();
}

export function queueSummary() {
  const counts = { pending: 0, submitted: 0, confirmed: 0, failed: 0 };
  for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM public_seals GROUP BY status').all()) {
    counts[r.status] = r.n;
  }
  return counts;
}
