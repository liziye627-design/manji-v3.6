// 慢记 Manji v3.6.3 —— 链上小狗身份 API（自托管 ManjiPuppyIdentity 合约 + BOT Chain 主网）
// 设计原则（对齐 onchain.js）：
//   1. PUPPY_IDENTITY_CONTRACT 未配置 → 写接口如实 409 AGENTOS_NOT_CONFIGURED（status 如实报告
//      mode:off，页面据此显示等待文案），主流程零影响；
//   2. 全部路由要求登录（不进 PUBLIC_ROUTES）；audit 只写状态短码；
//   3. 铸造与打赏都由成员自己的钱包直接签名上链，服务端只准备 calldata 与对账回执——无私钥、无 API key；
//   4. 路由返回载荷绝不含 BigInt：wei 金额唯一出口是 tip 的 amountWei 十进制字符串。
import { errors, audit } from '../core.js';
import { config } from '../config.js';
import { currentHome } from '../domain/permissions.js';
import {
  agentosMode, puppyContract, EXPLORER,
  puppyRowOf, puppyCard, preparePuppyMint, bindPuppyMint, verifyPuppyOwnerOnChain, tipPuppy, bindTip,
  cachedPuppyTotal,
} from '../domain/agentos.js';

function requireConfigured() {
  if (agentosMode() === 'off') {
    throw errors.conflict(
      'AGENTOS_NOT_CONFIGURED',
      '链上小狗身份未配置：请在 .env.local 设置 PUPPY_IDENTITY_CONTRACT（见 contracts/DEPLOYED-mainnet.json）'
    );
  }
}

/** 公共链模块抛出的 RPC/传输错误 → 统一 503（照 onchain.js 的 withRpcErrors） */
async function withRpcErrors(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err && err.statusCode) throw errors.unavailable(err.message);
    throw err;
  }
}

export const routes = {
  /** 配置总览（登录可看）：模式、链、合约与小狗卡片 + 链上已铸总数（best-effort） */
  'GET /api/agentos/status': async (ctx) => {
    const mode = agentosMode();
    audit(ctx.user.id, 'agentos-status', 'chain', 'global', mode);
    const home = mode === 'off' ? null : currentHome(ctx.user);
    const row = home ? puppyRowOf(home.id) : null;
    return {
      status: 200,
      data: {
        data: {
          mode,
          chainId: mode === 'off' ? null : Number(config.onchain.chainId) || null,
          contract: mode === 'off' ? null : puppyContract(),
          explorer: mode === 'off' ? null : EXPLORER(),
          totalPuppies: mode === 'off' ? null : await cachedPuppyTotal(),
          puppy: row ? puppyCard(row) : null,
        },
      },
    };
  },

  /** 当前家的小狗身份卡片（还没铸造过 → 404，页面据此显示「给我们的小狗上链上身份」） */
  'GET /api/agentos/puppy': async (ctx) => {
    requireConfigured();
    const home = currentHome(ctx.user);
    const row = puppyRowOf(home.id);
    if (!row) throw errors.notFound('这只小狗还没有链上身份');
    return { status: 200, data: { data: puppyCard(row) } };
  },

  /**
   * 发起铸造（服务端只准备数据）：校验名字与存钱罐地址、写 PENDING 行，返回钱包直发所需的
   * 合约地址与 mint calldata——之后由前端连接的钱包签名发送（C 端主网写入的核心一步）。
   */
  'POST /api/agentos/puppy/register': async (ctx) => {
    requireConfigured();
    const home = currentHome(ctx.user); // 冻结的家在此处即被拒绝
    const body = ctx.json();
    const prep = preparePuppyMint(home, { name: body && body.name, agentWallet: body && body.agentWallet });
    audit(ctx.user.id, 'agentos-mint-prepare', 'puppy', home.id, 'PENDING');
    return { status: 200, data: { data: prep } };
  },

  /** 钱包已发出铸造交易：回填哈希置 SUBMITTED，出块后后台轮询解析 PuppyRegistered 事件确认 */
  'POST /api/agentos/puppy/bind': async (ctx) => {
    requireConfigured();
    const home = currentHome(ctx.user);
    const body = ctx.json();
    const txHash = String((body && body.txHash) || '').toLowerCase().replace(/^0x/, '');
    if (!/^[0-9a-f]{64}$/.test(txHash)) {
      throw errors.invalid({ txHash: '交易哈希必须是 64 位十六进制' }, '交易哈希格式无效');
    }
    const row = bindPuppyMint(home, txHash);
    audit(ctx.user.id, 'agentos-mint-bind', 'puppy', home.id, row.identity_status);
    return { status: 200, data: { data: puppyCard(row) } };
  },

  /** 实时核验：直接问链上合约「这个身份的 owner 是谁」（eth_call ownerOf，任何人可复现） */
  'GET /api/agentos/puppy/verify': async (ctx) => {
    requireConfigured();
    const home = currentHome(ctx.user);
    const row = puppyRowOf(home.id);
    if (!row) throw errors.notFound('这只小狗还没有链上身份');
    if (!row.agent_token_id) throw errors.conflict('PUPPY_NOT_REGISTERED', '小狗的链上身份还没铸造完成，暂时无法核验');
    if (!config.onchain.rpcUrl) {
      throw errors.conflict('AGENTOS_VERIFY_RPC_UNCONFIGURED', '未配置 ONCHAIN_RPC_URL，无法做链上核验');
    }
    const result = await withRpcErrors(() => verifyPuppyOwnerOnChain(row.agent_token_id));
    audit(ctx.user.id, 'agentos-verify', 'puppy', home.id, result.found ? 'found' : 'not-found');
    return {
      status: 200,
      data: {
        data: {
          agentTokenId: row.agent_token_id,
          registry: puppyContract(),
          found: result.found,
          reason: result.reason || null,
          owner: result.owner || null,
          verifyHint: result.found
            ? '任何人都可以对小狗身份合约调用 ownerOf(tokenId) 得到同样的结果——这一步不依赖本应用。'
            : '链上查不到这个身份：铸造交易还没出块，或 tokenId 不存在。',
        },
      },
    };
  },

  /**
   * 登记一笔打赏：守卫全部通过才 INSERT pending 行；实际转账由成员已连接的钱包直发原生 BOT 交易；
   * amountWei 是十进制字符串（BigInt 在此 .toString() 过 JSON，前端 BigInt(字符串) 无损还原）。
   */
  'POST /api/agentos/puppy/tip': async (ctx) => {
    requireConfigured();
    const home = currentHome(ctx.user);
    const tip = tipPuppy(home, ctx.user.id, ctx.json().amountBot);
    audit(ctx.user.id, 'agentos-tip', 'tip', tip.tipId, 'pending');
    return { status: 200, data: { data: tip } };
  },

  /** 成员钱包已发出打赏交易：回填哈希置 submitted，链上对账交后台 poller（剥 0x，onchain.js 同款） */
  'POST /api/agentos/puppy/tip/:tipId/bind': async (ctx) => {
    requireConfigured();
    const home = currentHome(ctx.user);
    const body = ctx.json();
    const txHash = String((body && body.txHash) || '').toLowerCase().replace(/^0x/, '');
    if (!/^[0-9a-f]{64}$/.test(txHash)) {
      throw errors.invalid({ txHash: '交易哈希必须是 64 位十六进制' }, '交易哈希格式无效');
    }
    const row = bindTip(home, ctx.params.tipId, txHash);
    audit(ctx.user.id, 'agentos-tip-bind', 'tip', row.id, row.status);
    return { status: 200, data: { data: { tipId: row.id, status: row.status, txHash: row.tx_hash } } };
  },
};
