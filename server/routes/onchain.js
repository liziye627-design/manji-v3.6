// 慢记 Manji v3.6 —— 公共链锚定 API：把已镌刻的日记/约定承诺自愿提交到 BOT Chain
// 设计原则：
//   1. 公共链提交是一次独立的、明确的自愿动作——本地镌刻（双方同意在那里强制）成功后才有资格提交；
//   2. 提交的只有承诺哈希；手动模式返回的 calldata 也是纯哈希调用数据，可在发送前肉眼检查；
//   3. 任何时刻都可以用「核验」向公共链直接提问（eth_call sealOf），不依赖本应用存活；
//   4. 未配置时所有接口如实返回不可用，绝不影响本地永恒之链。
import { db } from '../db.js';
import { errors, audit } from '../core.js';
import { currentHome } from '../domain/permissions.js';
import { canViewAnchoredRecord } from './chain.js';
import {
  onchainMode, queueSummary, sealsOfHome, sealRowOf, enqueueSeal, bindTx, refreshSealRow,
  enqueueHeadAnchor, headRowOf, verifyCommitmentOnChain, buildSealCalldata, explorerTxUrl, CONTRACT_NAME,
} from '../domain/public-chain.js';

const PRIVACY_NOTE =
  '提交到公共链的只有承诺哈希（SHA-256(域名‖内容‖随机盐)）：没有正文、照片、成员身份或关系状态。交易由统一代提交账户发送，你们的地址不会出现在交易里。承诺一旦上链永远无法撤回——这是它可信的原因，也请只在你想清楚后提交。';

function requireConfigured() {
  if (onchainMode() === 'off') {
    throw errors.conflict(
      'ONCHAIN_NOT_CONFIGURED',
      '公共链锚定未配置：请在 .env 设置 ONCHAIN_RPC_URL / ONCHAIN_CHAIN_ID / ONCHAIN_CONTRACT（见 contracts/DEPLOY-BOTCHAIN.md）'
    );
  }
}

/** 载入锚定记录并校验查看权限（与本地链详情同一套权限） */
function requireAnchor(ctx) {
  const a = db.prepare('SELECT * FROM chain_anchors WHERE id = ?').get(ctx.params.anchorId);
  if (!a || !canViewAnchoredRecord(a, ctx.user)) throw errors.notFound();
  return a;
}

/** 公共链模块抛出的 RPC/状态错误 → 统一转为 ApiError（保留原始信息，便于排查） */
async function withRpcErrors(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err && err.statusCode) throw errors.unavailable(err.message);
    throw err;
  }
}

const STATUS_TEXT = {
  pending: '等待提交',
  submitted: '已发送，等待链上确认',
  confirmed: '已在公共链登记',
  failed: '上次提交失败（可重新发起）',
};

function sealPayload(row) {
  return {
    anchorId: row.id,
    type: row.record_type,
    revision: row.revision,
    label: row.record_type === 'promise' ? '约定' : '日记',
    commitment: row.commitment,
    status: row.status,
    statusText: STATUS_TEXT[row.status] || row.status,
    txHash: row.tx_hash,
    explorerUrl: explorerTxUrl(row.tx_hash),
    sealIndex: row.seal_index,
    sealedAt: row.sealed_at,
    error: row.error || null,
    createdAt: row.created_at,
  };
}

export const routes = {
  /** 公共链配置与队列总览（登录即可看；不涉及任何内容） */
  'GET /api/chain/onchain/status': async (ctx) => {
    const mode = onchainMode();
    audit(ctx.user.id, 'onchain-status', 'chain', 'global', mode);
    return {
      status: 200,
      data: {
        data: {
          mode,
          modeText: { off: '未配置', manual: '手动提交模式', auto: '自动代提交模式' }[mode],
          contractName: CONTRACT_NAME,
          chainId: mode === 'off' ? null : Number(process.env.ONCHAIN_CHAIN_ID) || null,
          contract: mode === 'off' ? null : process.env.ONCHAIN_CONTRACT || null,
          queue: queueSummary(),
          privacyNote: PRIVACY_NOTE,
        },
      },
    };
  },

  /** 当前家全部公共链提交记录 */
  'GET /api/chain/onchain': async (ctx) => {
    const home = currentHome(ctx.user);
    const rows = sealsOfHome(home.id);
    return { status: 200, data: { data: { items: rows.map(sealPayload), privacyNote: PRIVACY_NOTE } } };
  },

  /**
   * 把一条已镌刻的本地锚定提交到公共链。这是用户自己的第二次自愿确认：
   * 本地镌刻（含共同约定的双方同意）成功是前置条件；公共链登记永久不可撤回。
   */
  'POST /api/chain/onchain/:anchorId': async (ctx) => {
    requireConfigured();
    const home = currentHome(ctx.user); // 冻结的家在此处即被拒绝（本地链已定格，不再提交公共链）
    const a = requireAnchor(ctx);
    if (a.home_id !== home.id) throw errors.notFound();
    const { row, queued } = enqueueSeal(a);
    audit(ctx.user.id, 'onchain-seal', a.record_type, a.record_id, queued ? 'queued' : row.status, a.revision);

    const result = { anchorId: row.id, status: row.status, statusText: STATUS_TEXT[row.status], queued, privacyNote: PRIVACY_NOTE };
    if (onchainMode() === 'manual') {
      // 手动模式：给出可直接粘贴到 Remix/MetaMask 的调用数据（内容只有一个 32 字节承诺哈希，可肉眼审阅）
      result.manual = {
        contract: process.env.ONCHAIN_CONTRACT,
        chainId: Number(process.env.ONCHAIN_CHAIN_ID),
        calldata: buildSealCalldata(a.commitment),
        note: '用任意 EVM 钱包向上述合约地址发送这笔 calldata（合约的 seal 函数），拿到交易哈希后回来「回填交易」。',
      };
    }
    return { status: queued ? 201 : 200, data: { data: result } };
  },

  /** 手动模式：回填运营者已发送的交易哈希，之后自动轮询回执并确认 */
  'POST /api/chain/onchain/:anchorId/bind': async (ctx) => {
    requireConfigured();
    const home = currentHome(ctx.user);
    const a = requireAnchor(ctx);
    if (a.home_id !== home.id) throw errors.notFound();
    const body = ctx.json();
    if (typeof body.txHash !== 'string' || !/^[0-9a-fA-F]{64}$/.test(body.txHash)) {
      throw errors.invalid({ txHash: '交易哈希必须是 64 位十六进制' }, '交易哈希格式无效');
    }
    const row = bindTx(a.id, body.txHash.toLowerCase());
    audit(ctx.user.id, 'onchain-bind', a.record_type, a.record_id, row.status, a.revision);
    return { status: 200, data: { data: sealPayload(row) } };
  },

  /** 实时核验：直接问公共链「这条承诺登记过吗」（eth_call sealOf），并在成功时自愈本地台账 */
  'GET /api/chain/onchain/verify/:anchorId': async (ctx) => {
    requireConfigured();
    const a = requireAnchor(ctx);
    const refreshed = await withRpcErrors(() => refreshSealRow(sealRowOf(a.id) || a));
    const onchain = await withRpcErrors(() => verifyCommitmentOnChain(a.commitment));
    audit(ctx.user.id, 'onchain-verify', a.record_type, a.record_id, onchain.found ? 'found' : 'not-found', a.revision);
    return {
      status: 200,
      data: {
        data: {
          anchorId: a.id,
          commitment: a.commitment,
          onChain: {
            found: onchain.found,
            sealIndex: onchain.index,
            sealedAt: onchain.sealedAtIso,
          },
          localRow: refreshed.row && refreshed.row.commitment ? sealPayload(refreshed.row) : null,
          verifyHint: onchain.found
            ? '任何人都可以对公共链合约调用 sealOf(承诺) 得到同样的结果——这一步不依赖本应用。'
            : '公共链上还没有这条承诺：它尚未被提交，或交易尚未被确认。',
        },
      },
    };
  },

  /** 锚定本地链头部：一笔交易声明「截至此刻这条本地链的完整状态」，保护整条链的历史 */
  'POST /api/chain/onchain/head': async (ctx) => {
    requireConfigured();
    const home = currentHome(ctx.user); // 冻结的家在此处即被拒绝
    const { row, queued } = enqueueHeadAnchor(home.id);
    audit(ctx.user.id, 'onchain-head', 'chain', home.id, queued ? 'queued' : row.status, row.local_height);
    return {
      status: queued ? 201 : 200,
      data: {
        data: {
          chainId: row.chain_id,
          headHash: row.head_hash,
          localHeight: row.local_height,
          status: row.status,
          txHash: row.tx_hash,
          explorerUrl: explorerTxUrl(row.tx_hash),
          note: '头部哈希覆盖这条本地链的全部历史区块；锚定头部后，任何人都能用导出文件独立复算整条链并与该哈希比对。',
        },
      },
    };
  },
};
