// 慢记 Manji v3.6 —— 永恒之链 API：约定与日记上链、全链校验、凭证导出、已定格旧链的只读入口
// v3.6 新增：本地镌刻之后，可在 routes/onchain.js 里自愿把同一承诺提交 BOT Chain 公共链。
import crypto from 'node:crypto';
import { db, tx } from '../db.js';
import { config } from '../config.js';
import { errors, audit } from '../core.js';
import {
  getHome, getContainer, getContribution, membershipOf, partnerOf, currentHome, canReadContribution, notify,
} from '../domain/permissions.js';
import {
  canonicalForPromise, canonicalForContribution, commitmentOf, appendAnchorBlock,
  anchorOf, anchorsForRecord, anchorsOfHome, blocksOfHome, verifyChain, anchorStatus, newAnchorId,
  chainIdExisting, CANONICAL_FIELDS,
} from '../domain/chain.js';
import { BLOCK_ALGO_V1, BLOCK_ALGO_V2, algoNote } from '../domain/chain-algo.js';

/** 本地存证的诚实表述（U03；v3.6 更新：本地链之外，可自愿把同一承诺提交 BOT Chain 公共链） */
const HONESTY_TEXT =
  '链上只保存内容指纹（哈希承诺与随机盐的运算结果），不保存正文、照片或任何身份信息。这条链由本应用在你自己的慢记服务里忠实维护（本地数据库存储、应用计算工作量并校验哈希）；v3.6 起你还可以自愿把同一承诺提交到 BOT Chain 公共链，让存证不依赖本应用是否在线——是否提交完全由你决定，提交的同样只有指纹。请用「导出整条链」与「存证凭证」做好备份。';

export const routes = {
  /**
   * 镌刻上链。body: { type: 'promise' | 'contribution', id }
   * - 共同约定：两位成员都已在当前版本点过「我也愿意」才允许上链（自愿与共同同意原则）；
   * - 日记（我的视角）：只由作者本人上链，锚定的是当前版本；
   * - 同一版本只镌刻一次；改动后的新版本可以再镌刻新块，旧块永远保留。
   */
  'POST /api/chain/anchor': async (ctx) => {
    const home = currentHome(ctx.user);
    if (home.status === 'frozen') throw errors.conflict('HOME_FROZEN', '这个家已解除关联，链条已定格');
    const body = ctx.json();
    const type = body.type === 'promise' || body.type === 'contribution' ? body.type : null;
    if (!type || typeof body.id !== 'string') {
      throw errors.invalid({ type: 'type 必须是 promise 或 contribution' }, '要上链的内容类型无效');
    }

    let canonical;
    let revision;
    let label;
    let partnerNotice = null;

    if (type === 'promise') {
      const p = db.prepare('SELECT * FROM promises WHERE id = ?').get(body.id);
      if (!p || p.home_id !== home.id) throw errors.notFound();
      requirePromiseAccess(ctx.user, p);
      if (p.scope === 'shared') {
        // 共同约定的"双方同意"：作者提出即愿意，对方须在当前版本点过「我也愿意」（active 且无需重新确认）
        if (p.status === 'proposed' || p.needs_reconfirm) {
          throw errors.conflict('PROMISE_NOT_CONFIRMED', '这条约定还没有得到两个人的一致同意，等对方点过"我也愿意"再上链');
        }
        partnerNotice = partnerOf(p.home_id, ctx.user.id);
      }
      canonical = canonicalForPromise(p);
      revision = p.revision;
      label = '约定';
    } else {
      const c = getContribution(body.id);
      if (!c || c.deleted_at) throw errors.notFound();
      const container = getContainer(c.memory_id);
      if (!container || container.home_id !== home.id) throw errors.notFound();
      if (c.author_id !== ctx.user.id) throw errors.forbidden('日记只能由写下的本人上链');
      const versionRow = db
        .prepare('SELECT * FROM contribution_versions WHERE contribution_id = ? AND version = ?')
        .get(c.id, c.current_version);
      if (!versionRow) throw errors.notFound('这一版内容已不可用');
      const photoIds = db
        .prepare(
          `SELECT id FROM media_assets WHERE contribution_id = ? AND contribution_version <= ? AND purpose = 'memory' AND status = 'bound' ORDER BY id ASC`
        )
        .all(c.id, c.current_version)
        .map((m) => m.id);
      canonical = canonicalForContribution(c, versionRow, photoIds);
      revision = c.current_version;
      label = '日记';
    }

    const existing = anchorOf(home.id, type, body.id, revision);
    if (existing) {
      throw errors.conflict('ALREADY_ON_CHAIN', `这一版${label}已经在第 ${existing.block_height} 块上了`, {
        blockHeight: existing.block_height,
        anchorId: existing.id,
      });
    }

    const salt = crypto.randomBytes(32).toString('hex');
    const commitment = commitmentOf(canonical, salt);
    const anchorId = newAnchorId();

    const block = tx(() =>
      appendAnchorBlock({
        homeId: home.id,
        anchorId,
        recordType: type,
        recordId: body.id,
        revision,
        salt,
        commitment,
        requestedBy: ctx.user.id,
      })
    )();

    if (partnerNotice) {
      notify(partnerNotice.id, {
        type: 'chain-anchor',
        title: '一条约定被镌刻进了永恒之链',
        body: `「${ctx.user.display_name}」把你们都同意的一条约定刻上了链。链上只保存指纹，正文只属于你们。`,
        sourceId: anchorId,
        dedupeKey: `chain-anchor:${anchorId}`,
      });
    }
    audit(ctx.user.id, 'chain-anchor', type, body.id, 'ok', revision);
    return {
      status: 201,
      data: {
        data: {
          anchorId,
          blockHeight: block.height,
          blockHash: block.hash,
          commitment,
          anchoredAt: block.timestamp,
          label,
        },
      },
    };
  },

  /** 永恒之链总览：当前家的整条链 + 每块内容的可见摘要（按查看者权限给出标题，看不到正文的只显示"私密内容"）。 */
  'GET /api/chain': async (ctx) => {
    const home = currentHome(ctx.user);
    return { status: 200, data: { data: chainOverviewPayload(home.id, ctx.user) } };
  },

  /** 已定格旧链的只读入口（B08）：解除关联后，双方仍可查看自己参与过的那条链（内容按当前权限裁剪）。 */
  'GET /api/chain/archive/:homeId': async (ctx) => {
    const home = requireArchivedHome(ctx.user, ctx.params.homeId);
    const payload = chainOverviewPayload(home.id, ctx.user);
    return { status: 200, data: { data: { ...payload, archived: true, frozenAt: home.frozen_at } } };
  },

  /** 全链校验：逐块重算哈希并检查链接，同时逐条报告锚定内容相对镌刻时刻的状态。 */
  'GET /api/chain/verify': async (ctx) => {
    const home = currentHome(ctx.user);
    const verification = verifyChain(home.id);
    const anchors = anchorsOfHome(home.id).map((a) => {
      const s = anchorSummaryFor(a, ctx.user);
      return {
        anchorId: s.anchorId,
        blockHeight: s.blockHeight,
        type: s.type,
        status: s.status,
        label: s.label,
      };
    });
    audit(ctx.user.id, 'chain-verify', 'chain', home.id, verification.ok ? 'ok' : `broken@${verification.brokenAt}`);
    return {
      status: 200,
      data: {
        data: {
          ok: verification.ok,
          brokenAt: verification.brokenAt,
          checkedBlocks: verification.blocks.length,
          anchors,
        },
      },
    };
  },

  /** 一条记录（约定或日记）的全部镌刻记录，供详情页展示徽标。 */
  'GET /api/chain/anchors/:type/:id': async (ctx) => {
    const { type, id } = ctx.params;
    if (type !== 'promise' && type !== 'contribution') throw errors.notFound();
    const rows = anchorsForRecord(type, id).filter((a) => canViewAnchoredRecord(a, ctx.user));
    return {
      status: 200,
      data: {
        data: {
          items: rows.map((a) => anchorSummaryFor(a, ctx.user)),
        },
      },
    };
  },

  /**
   * 单条锚定的存证凭证（JSON 下载）。v3.5（B05）：
   * - canonicalFields 来自真正的规范快照（此前误导出 rebuildCanonical 包装对象的键）；
   * - 给出精确的承诺算法、规范编码规则、逐字段清单与逐步离线复算说明；
   * - 附区块算法版本与参与哈希的编号，使区块哈希也能离线复算。
   * 凭证不包含正文与照片——离线复算需要用户另行保存镌刻当时的原文。
   */
  'GET /api/chain/proof/:anchorId': async (ctx) => {
    const a = db.prepare('SELECT * FROM chain_anchors WHERE id = ?').get(ctx.params.anchorId);
    if (!a) throw errors.notFound();
    if (!canViewAnchoredRecord(a, ctx.user)) throw errors.notFound();
    const verification = verifyChain(a.home_id);
    const block = db.prepare('SELECT * FROM chain_blocks WHERE home_id = ? AND height = ?').get(a.home_id, a.block_height);
    const rebuild = rebuildCanonical(a);
    const canonicalObj = rebuild && rebuild.canonical ? rebuild.canonical : null;
    const chainId = chainIdExisting(a.home_id);
    const algo = block ? block.hash_algo || null : null;
    const isLegacy = algo === BLOCK_ALGO_V1;
    const buf = Buffer.from(
      JSON.stringify(
        {
          app: 'manji',
          version: config.version,
          kind: 'chain-proof',
          proofFormat: 2,
          anchorId: a.id,
          recordType: a.record_type,
          recordId: a.record_id,
          revision: a.revision,
          commitment: a.commitment,
          salt: a.salt,
          domain: 'manji-anchor-v1',
          canonicalFields: canonicalObj ? Object.keys(canonicalObj).sort() : null,
          canonicalFieldMeanings: {
            promise: {
              type: '固定 "promise"',
              id: '约定编号',
              revision: '镌刻时的约定修订号',
              text: '约定正文（镌刻当时）',
              note: '补充说明，没有则为空字符串',
              dueDate: '约定日期 YYYY-MM-DD，没有则为空字符串',
              scope: '"personal" 或 "shared"',
            },
            contribution: {
              type: '固定 "contribution"',
              id: '视角（贡献）编号',
              memoryId: '所属回忆编号',
              version: '镌刻时的内容版本号',
              text: '这一版正文（镌刻当时）',
              contentHash: '应用为这一版正文保存的 SHA-256（十六进制）',
              photos: '按字母排序的照片编号数组',
            },
          }[a.record_type],
          commitmentAlgorithm: {
            formula: 'SHA-256( "manji-anchor-v1" + "\\n" + canonicalJSON(内容) + "\\n" + salt )，输入按 UTF-8 编码，输出取十六进制小写',
            canonicalJSON:
              '递归稳定编码：对象 → 按键名升序（UTF-16 码元序）写成 {"键":值,…}（键用 JSON.stringify，值递归），逗号分隔、无空格；数组 → [值,值,…]；字符串 → JSON.stringify；null/undefined → 字符串 "null"；其他标量 → JSON.stringify',
            fields: CANONICAL_FIELDS[a.record_type],
          },
          block: block
            ? {
                height: block.height,
                timestamp: block.timestamp,
                prevHash: block.prev_hash,
                hash: block.hash,
                nonce: block.nonce,
                hashAlgo: algo,
                hashAlgoNote: algo ? algoNote(algo) : '算法版本未知（数据可能被外部改动）',
                ...(isLegacy ? { legacyHomeKey: a.home_id } : { chainId }),
              }
            : null,
          chain: { ok: verification.ok, checkedBlocks: verification.blocks.length, ...(isLegacy ? {} : { chainId }) },
          howToVerify: [
            '1. 准备镌刻当时的原文（本凭证不含正文，需要你另行保存）：按 canonicalFields 与 canonicalFieldMeanings 组装内容对象。',
            '2. 按 commitmentAlgorithm.canonicalJSON 规则把内容对象稳定编码成字符串。',
            '3. 计算 SHA-256("manji-anchor-v1" + "\\n" + 编码串 + "\\n" + salt)，结果应等于 commitment——改动任何一个字都不会相等。',
            '4. （可选）核对区块：按 block.hashAlgoNote 的公式，用 block 中的 height/timestamp/prevHash/payload 相关材料与 nonce 重算 SHA-256，应等于 block.hash；本应用内「再验证一次」会逐块完成这件事。',
            '隐私：正文、照片与身份永远不会写入链或区块；盐与承诺只用于核验。改一字即不匹配，无需依赖应用内查询。',
          ].join('\n'),
          privacyNote: '本凭证不含正文、照片或身份信息；离线复算需要你另外保存镌刻当时的原文。',
        },
        null,
        2
      ),
      'utf8'
    );
    audit(ctx.user.id, 'chain-proof', 'anchor', a.id, 'ok');
    return { status: 200, rawFile: { buf, mime: 'application/json', filename: `manji-chain-proof-${a.id}.json` } };
  },

  /**
   * 整条链导出（JSON 下载）：只含区块与承诺，不含任何正文、照片、身份。可供第三方独立校验。
   * v3.5：逐块标注 hashAlgo；旧链（v1 规则）公布参与哈希的家编号（随机内部键，非身份），
   * 使升级前的旧链同样可以仅凭导出文件离线复算（B01/B05）。
   * ?home=<homeId>：导出已解除关联的旧链（成员本人，只读）。
   */
  'GET /api/chain/export': async (ctx) => {
    const homeParam = ctx.query.get('home');
    const home = homeParam ? requireArchivedHome(ctx.user, homeParam) : currentHome(ctx.user);
    const blocks = blocksOfHome(home.id);
    const verification = verifyChain(home.id);
    const algos = [...new Set(blocks.map((b) => b.hash_algo).filter(Boolean))];
    // 只有真有 v2 区块时才公布 chainId；v1 旧链公布参与哈希的家编号（随机内部键，非身份）
    const chainId = algos.includes(BLOCK_ALGO_V2) ? chainIdExisting(home.id) : null;
    const buf = Buffer.from(
      JSON.stringify(
        {
          app: 'manji',
          version: config.version,
          kind: 'chain-export',
          chainId,
          ...(algos.includes(BLOCK_ALGO_V1)
            ? { legacyHomeKey: home.id, legacyHomeKeyNote: '旧规则（v1-home-key）区块参与哈希的内部编号：随机字符串，不是用户身份。仅为离线复算公布，新链不包含。' }
            : {}),
          hashAlgos: algos,
          homeCreatedAt: home.created_at,
          difficulty: config.chainDifficulty,
          integrity: { ok: verification.ok, checkedBlocks: blocks.length },
          blocks: blocks.map((b) => ({
            height: b.height,
            timestamp: b.timestamp,
            prevHash: b.prev_hash,
            payload: JSON.parse(b.payload),
            nonce: b.nonce,
            hash: b.hash,
            hashAlgo: b.hash_algo || null,
          })),
          note:
            '本文件不含正文与身份，仅含内容指纹。区块按各自 hashAlgo 计算：' +
            `${BLOCK_ALGO_V2} → SHA-256("manji-block-v1"|chainId|height|timestamp|prevHash|payload|nonce)；` +
            `${BLOCK_ALGO_V1} → SHA-256("manji-block-v1"|legacyHomeKey|height|timestamp|prevHash|payload|nonce)；以 "|" 连接。` +
            'payload 为 JSON.stringify 后的锚定载荷原文。chainId/legacyHomeKey 是随机编号（非用户身份），公布它是为了让任何人都能独立复算验证。',
        },
        null,
        2
      ),
      'utf8'
    );
    audit(ctx.user.id, 'chain-export', 'chain', home.id, 'ok');
    return { status: 200, rawFile: { buf, mime: 'application/json', filename: `manji-chain-${home.id}.json` } };
  },
};

// ---------- 辅助 ----------
function chainOverviewPayload(homeId, viewer) {
  const verification = verifyChain(homeId);
  const anchors = anchorsOfHome(homeId);
  return {
    homeId,
    height: verification.blocks.length - 1,
    latestHash: verification.blocks[verification.blocks.length - 1]?.hash || null,
    genesisHash: verification.blocks[0]?.hash || null,
    integrity: { ok: verification.ok, brokenAt: verification.brokenAt, checkedBlocks: verification.blocks.length },
    anchors: anchors.map((a) => anchorSummaryFor(a, viewer)),
    difficulty: config.chainDifficulty,
    honesty: HONESTY_TEXT,
  };
}

/** 已解除关联的家：只有参与过的成员可读旧链，且永远只读 */
function requireArchivedHome(user, homeId) {
  const home = getHome(homeId);
  if (!home) throw errors.notFound();
  const ms = membershipOf(homeId, user.id);
  if (!ms) throw errors.notFound();
  if (home.status !== 'frozen') {
    // 非冻结的家走正常入口，避免绕过当前家的写路径
    throw errors.notFound('这条链还没有定格，请从「永恒之链」页查看');
  }
  return home;
}

function requirePromiseAccess(user, p) {
  const ms = membershipOf(p.home_id, user.id);
  if (!ms) throw errors.notFound();
  const home = getHome(p.home_id);
  if (home.status === 'frozen') {
    if (p.author_id !== user.id) throw errors.notFound();
    return;
  }
  if (ms.status !== 'active') throw errors.notFound();
  if (p.scope === 'personal' && p.author_id !== user.id) throw errors.notFound();
}

/** 谁可以查看一条锚定记录（公共链提交沿用同一套权限判定） */
export function canViewAnchoredRecord(anchor, user) {
  if (anchor.record_type === 'promise') {
    const p = db.prepare('SELECT * FROM promises WHERE id = ?').get(anchor.record_id);
    if (!p) return false;
    try {
      requirePromiseAccess(user, p);
      return true;
    } catch {
      return false;
    }
  }
  const c = getContribution(anchor.record_id);
  if (!c) return false;
  return c.author_id === user.id || canReadContribution(user, c);
}

/** 依据当前数据重建规范快照；供校验承诺是否仍与内容一致。 */
function rebuildCanonical(anchor) {
  if (anchor.record_type === 'promise') {
    const p = db.prepare('SELECT * FROM promises WHERE id = ?').get(anchor.record_id);
    if (!p) return null; // 已删除 → gone
    if (p.revision !== anchor.revision) return { canonical: null, isCurrent: false, found: true }; // 旧版本 → superseded
    return { canonical: canonicalForPromise(p), isCurrent: true, found: true };
  }
  const c = getContribution(anchor.record_id);
  if (!c || c.deleted_at) return null;
  const ver = db
    .prepare('SELECT * FROM contribution_versions WHERE contribution_id = ? AND version = ?')
    .get(c.id, anchor.revision);
  if (!ver) return null;
  const photoIds = db
    .prepare(
      `SELECT id FROM media_assets WHERE contribution_id = ? AND contribution_version <= ? AND purpose = 'memory' AND status = 'bound' ORDER BY id ASC`
    )
    .all(c.id, anchor.revision)
    .map((m) => m.id);
  return { canonical: canonicalForContribution(c, ver, photoIds), isCurrent: c.current_version === anchor.revision, found: true };
}

const STATUS_TEXT = {
  intact: '与当前内容一致',
  superseded: '已有更新的版本，镌刻时刻永留链上',
  gone: '原文已不在应用里，链上指纹仍在',
  mismatch: '与当前内容不一致（数据可能被外部改动）',
};

/** 锚定记录的对外摘要：标题按查看者权限给出；永远不包含正文。 */
function anchorSummaryFor(anchor, viewer) {
  const rebuild = rebuildCanonical(anchor) || { found: false };
  const status = anchorStatus(anchor, rebuild);
  let title = '一段私密的内容';
  let canView = false;
  if (anchor.record_type === 'promise') {
    const p = db.prepare('SELECT * FROM promises WHERE id = ?').get(anchor.record_id);
    if (p) {
      try {
        requirePromiseAccess(viewer, p);
        title = `约定 · ${p.text.slice(0, 14)}${p.text.length > 14 ? '…' : ''}`;
        canView = true;
      } catch {
        /* 保持私密标题 */
      }
    }
  } else {
    const c = getContribution(anchor.record_id);
    if (c && (c.author_id === viewer.id || canReadContribution(viewer, c))) {
      const container = getContainer(c.memory_id);
      const author = db.prepare('SELECT display_name FROM users WHERE id = ?').get(c.author_id);
      title = `日记 · ${container ? container.title || container.safe_title : ''} · ${author ? author.display_name : ''}的视角`;
      canView = true;
    }
  }
  return {
    anchorId: anchor.id,
    blockHeight: anchor.block_height,
    type: anchor.record_type === 'promise' ? 'promise' : 'contribution',
    revision: anchor.revision,
    commitment: anchor.commitment,
    anchoredAt: anchor.created_at,
    status,
    statusText: STATUS_TEXT[status],
    title,
    canView,
  };
}
