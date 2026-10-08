// 慢记 Manji v3.1 —— 数据库（node:sqlite，事务 + WAL）
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { detectBlockAlgo, BLOCK_ALGO_V1, BLOCK_ALGO_V2 } from './domain/chain-algo.js';

mkdirSync(path.dirname(config.dbPath), { recursive: true });
mkdirSync(config.mediaRoot, { recursive: true });

export const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  current_home_id TEXT,
  preferences TEXT NOT NULL DEFAULT '{}',
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS homes (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('solo','shared','frozen')),
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  revision INTEGER NOT NULL DEFAULT 1,
  name TEXT,
  created_at TEXT NOT NULL,
  frozen_at TEXT
);
CREATE TABLE IF NOT EXISTS memberships (
  home_id TEXT NOT NULL REFERENCES homes(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('active','left')),
  role TEXT NOT NULL DEFAULT 'member',
  joined_at TEXT NOT NULL,
  left_at TEXT,
  PRIMARY KEY (home_id, user_id)
);
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL REFERENCES homes(id),
  creator_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  message TEXT,
  preview_media_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','revoked','used','expired')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pet_profiles (
  id TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('home','user')),
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  appearance_key TEXT NOT NULL DEFAULT 'cream',
  settings TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE (owner_type, owner_id)
);
CREATE TABLE IF NOT EXISTS memory_containers (
  id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL REFERENCES homes(id),
  creator_id TEXT NOT NULL REFERENCES users(id),
  title TEXT,
  safe_title TEXT NOT NULL,
  event_date TEXT NOT NULL,
  topic TEXT,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','home')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
  removal_requested_by TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS contributions (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memory_containers(id),
  author_id TEXT NOT NULL REFERENCES users(id),
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','home')),
  current_version INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS contribution_versions (
  contribution_id TEXT NOT NULL REFERENCES contributions(id),
  version INTEGER NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (contribution_id, version)
);
CREATE TABLE IF NOT EXISTS media_assets (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  purpose TEXT NOT NULL CHECK (purpose IN ('memory','thumb','work-artifact','export','invite-preview')),
  parent_media_id TEXT,
  contribution_id TEXT,
  contribution_version INTEGER,
  work_id TEXT,
  storage_key TEXT NOT NULL,
  thumb_key TEXT,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  status TEXT NOT NULL CHECK (status IN ('staged','bound','deleted','orphan')),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS object_templates (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  asset_ref TEXT NOT NULL,
  allowed_slots TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_objects (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memory_containers(id),
  template_key TEXT NOT NULL REFERENCES object_templates(key),
  owner_id TEXT NOT NULL REFERENCES users(id),
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','home')),
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS placements (
  id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL REFERENCES homes(id),
  object_id TEXT NOT NULL REFERENCES memory_objects(id),
  layer TEXT NOT NULL CHECK (layer IN ('private','home')),
  owner_id TEXT,
  slot_key TEXT,
  status TEXT NOT NULL DEFAULT 'displayed' CHECK (status IN ('displayed','stored')),
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS member_memory_preferences (
  user_id TEXT NOT NULL REFERENCES users(id),
  memory_id TEXT NOT NULL REFERENCES memory_containers(id),
  hidden INTEGER NOT NULL DEFAULT 0,
  exclude_from_recall INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, memory_id)
);
CREATE TABLE IF NOT EXISTS promises (
  id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL REFERENCES homes(id),
  author_id TEXT NOT NULL REFERENCES users(id),
  text TEXT NOT NULL,
  note TEXT,
  due_date TEXT,
  scope TEXT NOT NULL CHECK (scope IN ('personal','shared')),
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','active','completed','paused','archived')),
  needs_reconfirm INTEGER NOT NULL DEFAULT 0,
  completed_by TEXT,
  completed_at TEXT,
  undo_note TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS promise_confirmations (
  promise_id TEXT NOT NULL REFERENCES promises(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  confirmed_revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (promise_id, user_id)
);
CREATE TABLE IF NOT EXISTS anniversaries (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  home_id TEXT,
  title TEXT NOT NULL,
  date TEXT NOT NULL,
  repeat TEXT NOT NULL DEFAULT 'once' CHECK (repeat IN ('once','yearly')),
  reminder_days INTEGER NOT NULL DEFAULT 0,
  scope TEXT NOT NULL DEFAULT 'personal' CHECK (scope IN ('personal','shared')),
  note TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS consent_grants (
  id TEXT PRIMARY KEY,
  requester_id TEXT NOT NULL REFERENCES users(id),
  approver_id TEXT NOT NULL REFERENCES users(id),
  resource_versions TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('work','export')),
  audience TEXT NOT NULL DEFAULT 'partner-download',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','invalidated','revoked')),
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  responded_at TEXT
);
CREATE TABLE IF NOT EXISTS work_jobs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  home_id TEXT,
  template_key TEXT NOT NULL,
  version_set TEXT NOT NULL,
  includes_partner INTEGER NOT NULL DEFAULT 0,
  grant_id TEXT,
  caption TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','ready','failed','cancelled')),
  artifact_media_id TEXT,
  fail_reason TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS export_jobs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  home_id TEXT,
  scope TEXT NOT NULL CHECK (scope IN ('self','granted')),
  grant_id TEXT,
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','failed','cancelled')),
  file_key TEXT,
  file_size INTEGER,
  fail_reason TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS appearance_grants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  home_id TEXT NOT NULL,
  appearance_key TEXT NOT NULL,
  reason TEXT NOT NULL,
  business_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, business_key)
);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  source_id TEXT,
  occurrence_date TEXT,
  dedupe_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','cancelled')),
  created_at TEXT NOT NULL,
  read_at TEXT,
  UNIQUE (user_id, dedupe_key)
);
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  actor_id TEXT,
  action TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT,
  revision INTEGER,
  result TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id TEXT NOT NULL,
  route TEXT NOT NULL,
  idem_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  response_body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, route, idem_key)
);
CREATE TABLE IF NOT EXISTS chain_blocks (
  home_id TEXT NOT NULL,
  height INTEGER NOT NULL,
  timestamp TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  payload TEXT NOT NULL,
  nonce INTEGER NOT NULL,
  hash TEXT NOT NULL,
  hash_algo TEXT,
  PRIMARY KEY (home_id, height)
);
CREATE TABLE IF NOT EXISTS chain_meta (
  home_id TEXT PRIMARY KEY,
  chain_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chain_anchors (
  id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  record_type TEXT NOT NULL CHECK (record_type IN ('promise','contribution')),
  record_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  salt TEXT NOT NULL,
  commitment TEXT NOT NULL,
  requested_by TEXT,
  block_height INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (record_type, record_id, revision)
);
-- v3.6 公共链锚定：本地锚定 → BOT Chain 合约 ManjiEternalChain 的提交台账（与 chain_anchors 一一对应）
CREATE TABLE IF NOT EXISTS public_seals (
  id TEXT PRIMARY KEY,               -- = chain_anchors.id
  home_id TEXT NOT NULL,
  record_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  commitment TEXT NOT NULL UNIQUE,   -- 全局唯一：同一条内容+盐只会有一条公共链记录
  status TEXT NOT NULL CHECK (status IN ('pending','submitted','confirmed','failed')),
  tx_hash TEXT,
  seal_index INTEGER,                -- 合约内登记序号（sealOf 返回）
  sealed_at TEXT,                    -- 链上登记时间（区块时间戳）
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- v3.6 本地链头部锚定：一次交易声明「截至 T，这条本地链的完整状态」，保护整条链的历史
CREATE TABLE IF NOT EXISTS public_head_anchors (
  home_id TEXT PRIMARY KEY,
  chain_id TEXT NOT NULL,
  head_hash TEXT NOT NULL,
  local_height INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','submitted','confirmed','failed')),
  tx_hash TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chain_blocks_home ON chain_blocks(home_id, height);
CREATE INDEX IF NOT EXISTS idx_chain_anchors_record ON chain_anchors(record_type, record_id);
CREATE INDEX IF NOT EXISTS idx_contrib_memory ON contributions(memory_id);
CREATE INDEX IF NOT EXISTS idx_contrib_author ON contributions(author_id);
CREATE INDEX IF NOT EXISTS idx_containers_home ON memory_containers(home_id);
CREATE INDEX IF NOT EXISTS idx_placements_home ON placements(home_id, layer, status);
CREATE INDEX IF NOT EXISTS idx_media_owner ON media_assets(owner_id, status);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at);
`);

// 旧库迁移：补管理员标记列（新库已含）
try {
  db.prepare('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0').run();
} catch {
  // 列已存在
}

// 旧库迁移：v3.5 家名改为服务端共同属性（U01：原先只存各自设备的 localStorage）
try {
  db.prepare('ALTER TABLE homes ADD COLUMN name TEXT').run();
} catch {
  // 列已存在
}

// 旧库迁移：v3.5 为每个区块记录哈希算法版本（B01）。
// 旧链（v3.4 早期）区块哈希包含 home_id；新链用随机 chain_id。回填方式是逐块按两种规则重算：
// 能与哪种规则对上就记哪种——只补充元数据，不重写任何区块原值；都对不上的保持 NULL，
// 由全链校验如实报告断裂（那是真实的被改动，不是升级兼容问题）。
try {
  db.prepare('ALTER TABLE chain_blocks ADD COLUMN hash_algo TEXT').run();
} catch {
  // 列已存在
}
if (db.prepare('SELECT COUNT(*) AS n FROM chain_blocks WHERE hash_algo IS NULL').get().n > 0) {
  const markAlgo = db.prepare('UPDATE chain_blocks SET hash_algo = ? WHERE home_id = ? AND height = ?');
  for (const { home_id } of db.prepare('SELECT DISTINCT home_id FROM chain_blocks').all()) {
    const meta = db.prepare('SELECT chain_id FROM chain_meta WHERE home_id = ?').get(home_id);
    const blocks = db.prepare('SELECT * FROM chain_blocks WHERE home_id = ?').all(home_id);
    for (const b of blocks) {
      if (b.hash_algo) continue;
      const algo = detectBlockAlgo(home_id, meta ? meta.chain_id : null, b);
      if (algo === BLOCK_ALGO_V1 || algo === BLOCK_ALGO_V2) markAlgo.run(algo, home_id, b.height);
    }
  }
  // 清理 v3.4 在旧链（v1 规则）上误建的随机 chain_meta：没有任何区块按它计算过哈希，留着会误导导出与凭证。
  // 有 v2 区块的家不动；没有区块的家也不动（新链建档）。
  for (const { home_id } of db.prepare('SELECT DISTINCT home_id FROM chain_blocks').all()) {
    const algos = db
      .prepare('SELECT DISTINCT hash_algo AS a FROM chain_blocks WHERE home_id = ?')
      .all(home_id)
      .map((r) => r.a);
    if (algos.includes(BLOCK_ALGO_V2) || !algos.includes(BLOCK_ALGO_V1)) continue;
    if (db.prepare('SELECT 1 FROM chain_meta WHERE home_id = ?').get(home_id)) {
      db.prepare('DELETE FROM chain_meta WHERE home_id = ?').run(home_id);
    }
  }
}

// —— 种子数据：6 个纪念物模板（计划书 4.3）与房间固定摆放点 ——
const seedTemplates = db.prepare('SELECT COUNT(*) AS n FROM object_templates').get();
if (seedTemplates.n === 0) {
  const ins = db.prepare(
    'INSERT INTO object_templates (key, label, asset_ref, allowed_slots) VALUES (?, ?, ?, ?)'
  );
  const rows = [
    ['shell', '贝壳', 'svg:shell', '["window","table","corner"]'],
    ['ticket', '电影票', 'svg:ticket', '["sofa_side","table"]'],
    ['pot', '小锅', 'svg:pot', '["kitchen","table"]'],
    ['umbrella', '雨伞', 'svg:umbrella', '["door","corner"]'],
    ['tent', '小帐篷', 'svg:tent', '["corner","window"]'],
    ['cup', '咖啡杯', 'svg:cup', '["table","window","sofa_side"]'],
  ];
  for (const r of rows) ins.run(...r);
}

export const ROOM_SLOTS = [
  { key: 'window', label: '窗台' },
  { key: 'sofa_side', label: '沙发旁的小桌' },
  { key: 'kitchen', label: '厨房角落' },
  { key: 'door', label: '门口伞架' },
  { key: 'corner', label: '房间角落' },
  { key: 'table', label: '茶几' },
];

/** node:sqlite 没有内建 transaction() 包装，这里提供等价的延迟执行事务（语义同 better-sqlite3） */
export function tx(fn) {
  return (...args) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn(...args);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // 连接已中断时忽略
      }
      throw err;
    }
  };
}

export const TOPICS = ['日常', '出游', '美食', '影音', '雨天', '户外', '节日', '其他'];

export function getTemplate(key) {
  return db.prepare('SELECT * FROM object_templates WHERE key = ?').get(key);
}
