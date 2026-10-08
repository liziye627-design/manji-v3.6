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
};
