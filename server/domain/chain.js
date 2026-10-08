// 慢记 Manji v3.5 —— 永恒之链（每个小家一条独立的本地存证链）
// 设计原则（《心动铃铛-关系上链隐私与退出机制研究》）：
//   1. 链上只保存内容指纹（哈希承诺），永不保存正文、照片或身份；
//   2. 上链完全自愿，共同约定须两人都点过「我也愿意」才可镌刻；
//   3. 链只追加、不修改、不删除；任何改动都会被全链校验发现；
//   4. 承诺带随机盐，外部无法用已知文本枚举比对出正文。
// v3.5（B01）：区块哈希算法分版本记录——旧链（哈希含 home_id）按旧规则继续验证与延伸，
// 新链使用随机 chain_id 规则；绝不重写已发出的旧区块哈希。
import { db } from '../db.js';
import { nowIso, newId, sha256, randomToken, errors } from '../core.js';
import { config } from '../config.js';
import { blockHashRaw, detectBlockAlgo, BLOCK_ALGO_V1, BLOCK_ALGO_V2 } from './chain-algo.js';

const GENESIS_MESSAGE =
  '慢记 · 永恒之链 · 创世块：愿每一段被认真写下的话，都值得被永远记住。此后每一块，都是两个人亲手封存的瞬间。';

// ---------- 规范化编码（键排序、稳定字符串化，保证双方可独立复算同一承诺） ----------
function canonicalValue(v) {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalValue).join(',')}]`;
  if (typeof v === 'object') {
    const keys = Object.keys(v).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalValue(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export const ANCHOR_DOMAIN = 'manji-anchor-v1';

/** 承诺 = SHA-256(域分隔 ‖ 规范编码的内容 ‖ 随机盐)。盐只保存在链下数据库，供两位成员核验。 */
export function commitmentOf(canonical, salt) {
  return sha256(`${ANCHOR_DOMAIN}\n${canonicalValue(canonical)}\n${salt}`);
}

// ---------- 待锚定内容的规范快照（字段清单同时用于凭证导出，B05） ----------
export const CANONICAL_FIELDS = {
  promise: ['dueDate', 'id', 'note', 'revision', 'scope', 'text', 'type'],
  contribution: ['contentHash', 'id', 'memoryId', 'photos', 'text', 'type', 'version'],
};

export function canonicalForPromise(p) {
  return {
    type: 'promise',
    id: p.id,
    revision: p.revision,
    text: p.text,
    note: p.note || '',
    dueDate: p.due_date || '',
    scope: p.scope,
  };
}

export function canonicalForContribution(contrib, versionRow, photoIds) {
  return {
    type: 'contribution',
    id: contrib.id,
    memoryId: contrib.memory_id,
    version: versionRow.version,
    text: versionRow.text,
    contentHash: versionRow.content_hash,
    photos: [...photoIds].sort(),
  };
}

// ---------- 链编号与算法版本 ----------
/**
 * 每条链有一个随机 chainId（与内部家编号无关）：参与新规则哈希、随导出公布，让第三方能独立复算验证。
 * v3.5 起只给"还没有任何区块的新链"建档；已有区块却没有 chain_meta 的旧链（v1 规则）返回 null，
 * 不生成一个与旧块哈希无关的随机编号去误导验证与导出。
 */
export function chainIdOf(homeId) {
  let row = db.prepare('SELECT chain_id FROM chain_meta WHERE home_id = ?').get(homeId);
  if (!row) {
    const hasBlocks = db.prepare('SELECT 1 FROM chain_blocks WHERE home_id = ? LIMIT 1').get(homeId);
    if (hasBlocks) return null; // 旧链：哈希规则里没有 chain_id
    const chainId = randomToken(16);
    db.prepare('INSERT OR IGNORE INTO chain_meta (home_id, chain_id, created_at) VALUES (?, ?, ?)').run(homeId, chainId, nowIso());
    row = db.prepare('SELECT chain_id FROM chain_meta WHERE home_id = ?').get(homeId);
  }
  return row.chain_id;
}

/** 已存在（不创建）的 chainId，供导出/凭证如实展示；旧链为 null */
export function chainIdExisting(homeId) {
  return db.prepare('SELECT chain_id FROM chain_meta WHERE home_id = ?').get(homeId)?.chain_id || null;
}

/** 这条链下一个新区块应使用的哈希算法：跟随已有区块的规则（旧链继续旧规则，不偷偷换算法） */
function algoForNewBlock(homeId) {
  const last = db
    .prepare('SELECT hash_algo FROM chain_blocks WHERE home_id = ? ORDER BY height DESC LIMIT 1')
    .get(homeId);
  if (!last) return BLOCK_ALGO_V2; // 全新链 → 新规则
  return last.hash_algo || BLOCK_ALGO_V1; // 回填都定不了的块：按旧规则延续，校验自会指出问题
}

/** 某算法版本下参与哈希的编号键：v1=家编号，v2=随机链编号 */
function algoKey(homeId, algo) {
  return algo === BLOCK_ALGO_V2 ? chainIdOf(homeId) : homeId;
}

function blockHashOf(homeId, algo, block) {
  return blockHashRaw(algoKey(homeId, algo), block);
}

/** 工作量证明：哈希前缀需出现 N 个十六进制 0。默认 4 位（约 6.5 万次尝试，瞬时完成但真实可验）。 */
function mineBlock(homeId, algo, height, timestamp, prevHash, payloadObj) {
  const payload = JSON.stringify(payloadObj);
  const prefix = '0'.repeat(config.chainDifficulty);
  for (let nonce = 0; nonce < 100_000_000; nonce++) {
    const hash = blockHashOf(homeId, algo, { height, timestamp, prev_hash: prevHash, payload, nonce });
    if (hash.startsWith(prefix)) {
      return { height, timestamp, prev_hash: prevHash, payload, nonce, hash, algo };
    }
  }
  throw errors.unavailable('镌刻超时，请稍后再试');
}

function insertBlock(homeId, block) {
  db.prepare(
    `INSERT INTO chain_blocks (home_id, height, timestamp, prev_hash, payload, nonce, hash, hash_algo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(homeId, block.height, block.timestamp, block.prev_hash, block.payload, block.nonce, block.hash, block.algo);
}

function ensureGenesis(homeId) {
  const existing = db.prepare('SELECT * FROM chain_blocks WHERE home_id = ? AND height = 0').get(homeId);
  if (existing) return existing;
  const home = db.prepare('SELECT * FROM homes WHERE id = ?').get(homeId);
  const algo = algoForNewBlock(homeId);
  const genesis = mineBlock(homeId, algo, 0, home ? home.created_at : nowIso(), '0'.repeat(64), {
    v: 1,
    message: GENESIS_MESSAGE,
    anchors: [],
  });
  insertBlock(homeId, genesis);
  return genesis;
}

export function latestBlock(homeId) {
  ensureGenesis(homeId);
  return db.prepare('SELECT * FROM chain_blocks WHERE home_id = ? ORDER BY height DESC LIMIT 1').get(homeId);
}

/**
 * 把一条锚定记录镌刻成新区块（每个值得纪念的瞬间独占一块，高度即第 N 个瞬间）。
 * 必须在事务内调用；矿工计算放在事务外由调用方完成（见 routes/chain.js）。
 */
export function appendAnchorBlock({ homeId, anchorId, recordType, recordId, revision, salt, commitment, requestedBy }) {
  const prev = latestBlock(homeId);
  const height = prev.height + 1;
  const timestamp = nowIso();
  const block = mineBlock(homeId, algoForNewBlock(homeId), height, timestamp, prev.hash, {
    v: 1,
    anchors: [{ id: anchorId, type: recordType, record: recordId, revision, commitment }],
  });
  insertBlock(homeId, block);
  db.prepare(
    `INSERT INTO chain_anchors (id, home_id, record_type, record_id, revision, salt, commitment, requested_by, block_height, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(anchorId, homeId, recordType, recordId, revision, salt, commitment, requestedBy, height, timestamp);
  return block;
}

// ---------- 查询与校验 ----------
export function anchorOf(homeId, recordType, recordId, revision) {
  return db
    .prepare('SELECT * FROM chain_anchors WHERE home_id = ? AND record_type = ? AND record_id = ? AND revision = ?')
    .get(homeId, recordType, recordId, revision);
}

export function anchorsForRecord(recordType, recordId) {
  return db
    .prepare('SELECT * FROM chain_anchors WHERE record_type = ? AND record_id = ? ORDER BY block_height ASC')
    .all(recordType, recordId);
}

export function anchorsOfHome(homeId) {
  return db
    .prepare('SELECT * FROM chain_anchors WHERE home_id = ? ORDER BY block_height ASC')
    .all(homeId);
}

export function blocksOfHome(homeId) {
  ensureGenesis(homeId);
  return db.prepare('SELECT * FROM chain_blocks WHERE home_id = ? ORDER BY height ASC').all(homeId);
}

/**
 * 全链校验：逐块按其记录的算法版本重算哈希、检查难度与前向链接、高度连续。
 * 旧链的块按旧规则（home_id）重算，新链按新规则（chain_id）——两者在同一轮校验里都成立（B01）。
 * 返回 { ok, blocks, brokenAt }；brokenAt 为第一个被改动/断裂的区块高度。
 */
export function verifyChain(homeId) {
  const blocks = blocksOfHome(homeId);
  const chainId = chainIdExisting(homeId);
  const prefix = '0'.repeat(config.chainDifficulty);
  let prevHash = '0'.repeat(64);
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const algo = b.hash_algo || detectBlockAlgo(homeId, chainId, b); // 兜底：迁移未覆盖时现场判定
    const hash = algo ? blockHashRaw(algo === BLOCK_ALGO_V1 ? homeId : chainId, b) : null;
    if (
      b.height !== i ||
      b.prev_hash !== prevHash ||
      !b.hash.startsWith(prefix) ||
      hash === null ||
      hash !== b.hash
    ) {
      return { ok: false, blocks, brokenAt: i };
    }
    prevHash = b.hash;
  }
  return { ok: true, blocks, brokenAt: null };
}

/** 锚定状态的诚实展示：链上承诺永不消失；这里的 status 只描述"当前内容相对镌刻时刻"的关系。 */
export function anchorStatus(anchor, rebuild) {
  if (!rebuild.found) return 'gone'; // 记录已被删除：链上指纹仍在，正文已不在应用里
  if (!rebuild.canonical) {
    // 约定没有历史版本表：旧版本承诺无法从当前数据复算（链上指纹仍受区块哈希保护）
    return 'superseded';
  }
  const recomputed = commitmentOf(rebuild.canonical, anchor.salt);
  if (recomputed !== anchor.commitment) return 'mismatch'; // 理论上不可达：内容被就地改写（库被外部篡改）
  return rebuild.isCurrent ? 'intact' : 'superseded'; // intact=仍是当前版本；superseded=已有更新版本，镌刻的那一刻仍留链上
}

export function newAnchorId() {
  return newId('anc');
}

export { BLOCK_ALGO_V1, BLOCK_ALGO_V2 };
