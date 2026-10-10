// 慢记 Manji v3.1 —— 环境配置
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return; // 没有 .env 时使用默认值，不报错
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
loadDotEnv();

// v3.6：.env.local 在 .env 之后加载并覆盖同名项——机密（如 ONCHAIN_RELAYER_KEY）只放这里，
// 它被 .gitignore 与交付打包排除，绝不进入代码仓库或交付压缩包。
function loadDotEnvLocal() {
  let text = '';
  try {
    text = readFileSync(path.join(ROOT, '.env.local'), 'utf8');
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
loadDotEnvLocal();

const int = (v, dflt) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : dflt);

export const config = {
  root: ROOT,
  port: int(process.env.PORT, 4173),
  dbPath: path.resolve(ROOT, process.env.DB_PATH || 'data/manji.db'),
  mediaRoot: path.resolve(ROOT, process.env.MEDIA_ROOT || 'data/media'),
  sessionTtlHours: int(process.env.SESSION_TTL_HOURS, 720),
  bizTimezone: process.env.BIZ_TIMEZONE || 'Asia/Shanghai',
  maxUploadBytes: int(process.env.MAX_UPLOAD_MIB, 10) * 1024 * 1024,
  maxPhotosPerMemory: int(process.env.MAX_PHOTOS_PER_MEMORY, 6),
  maxTextChars: int(process.env.MAX_TEXT_CHARS, 500),
  inviteTtlDays: 7,
  chainDifficulty: int(process.env.CHAIN_DIFFICULTY, 4),
  version: '3.6.0',
  adminDisplayName: process.env.ADMIN_DISPLAY_NAME || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || 'admin-2026',
  // v3.6 公共链锚定（BOT Chain / 任意 EVM 兼容链）。三项都配置后功能开启；
  // 再配置 ONCHAIN_RELAYER_KEY（需 npm i ethers）则由后台自动代提交，否则手动模式。
  onchain: {
    rpcUrl: process.env.ONCHAIN_RPC_URL || '',
    chainId: int(process.env.ONCHAIN_CHAIN_ID, 0),
    contract: (process.env.ONCHAIN_CONTRACT || '').toLowerCase(),
    relayerKey: process.env.ONCHAIN_RELAYER_KEY || '',
    explorer: process.env.ONCHAIN_EXPLORER || (Number(process.env.ONCHAIN_CHAIN_ID) === 677 ? 'https://scan.botchain.ai' : 'https://scan.bohr.life'),
  },
  // v3.6 Agent OS（BOT Chain 官方托管 API）：小狗的链上身份（ERC-8004 NFT）+ 托管钱包。
  // AGENTOS_API_KEY（ak_ 前缀，只显示一次）只放 .env.local；未配置（空）时功能整体 off，
  // 所有 agentos 接口如实返回未配置，主流程零影响。key 绝不写日志、绝不进入任何 API 响应。
  agentos: {
    apiKey: process.env.AGENTOS_API_KEY || '',
    walletApi: process.env.AGENTOS_WALLET_API || 'https://wallet-api.botchain.ai',
    identityApi: process.env.AGENTOS_IDENTITY_API || 'https://identity-api.botchain.ai',
    chainId: int(process.env.AGENTOS_CHAIN_ID, 677),
  },
  // v3.6.3 链上小狗身份（自托管 ManjiPuppyIdentity 合约）：官方 Agent OS 托管 API 未获批 key 的
  // 自部署替代——ERC-8004 风格（ownerOf/getAgentWallet/tokenURI），铸造由成员钱包直接签名。
  // 只需合约地址，RPC/链/浏览器复用 onchain 配置；未配置时功能 off，主流程零影响。
  puppyIdentity: {
    contract: (process.env.PUPPY_IDENTITY_CONTRACT || '').toLowerCase(),
  },
};
