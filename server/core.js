// 慢记 Manji v3.1 —— HTTP 契约、会话、错误、幂等、业务日期
import crypto from 'node:crypto';
import { db } from './db.js';
import { config } from './config.js';

// ---------- 时间 ----------
export function nowIso() {
  return new Date().toISOString();
}

/** 业务"今天"（YYYY-MM-DD），按配置时区计算，避免浏览器 UTC 偏移一天 */
export function bizToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: config.bizTimezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

export function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/** 年度纪念日的下一次公历日期；2/29 在平年按 2/28（计划书 1.4） */
export function nextOccurrence(dateStr, repeat, today) {
  if (repeat === 'once') return dateStr >= today ? dateStr : null;
  const [y, m, d] = dateStr.split('-').map(Number);
  const ty = Number(today.slice(0, 4));
  for (let year = ty; year <= ty + 1; year++) {
    let dd = String(d).padStart(2, '0');
    if (m === 2 && d === 29 && !isLeap(year)) dd = '28';
    const occ = `${year}-${String(m).padStart(2, '0')}-${dd}`;
    if (occ >= today) return occ;
  }
  return null;
}

export function daysBetween(from, to) {
  return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000);
}

// ---------- 标识与哈希 ----------
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export function newId(prefix) {
  const bytes = crypto.randomBytes(12);
  let s = '';
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return `${prefix}_${s}`;
}
export function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}
export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

// ---------- 错误契约（计划书 8.1） ----------
export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
export const errors = {
  unauthorized: () => new ApiError(401, 'UNAUTHENTICATED', '请先登录'),
  forbidden: (msg = '没有权限进行这个操作') => new ApiError(403, 'FORBIDDEN', msg),
  notFound: (msg = '这部分内容已不再共享') => new ApiError(404, 'NOT_FOUND', msg),
  conflict: (code, msg, extra = {}) => new ApiError(409, code, msg, extra),
  invalid: (fieldErrors, msg = '输入有误') =>
    new ApiError(422, 'VALIDATION_FAILED', msg, { fieldErrors: fieldErrors || {} }),
  unavailable: (msg = '暂时不可用，请稍后再试') => new ApiError(503, 'UNAVAILABLE', msg),
};

// ---------- 请求辅助 ----------
export function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', '请求体超过大小限制');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

export function parseJsonBuffer(buf) {
  if (!buf || buf.length === 0) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw errors.invalid(undefined, '请求体不是合法 JSON');
  }
}

export function requestId() {
  return crypto.randomBytes(8).toString('hex');
}

// ---------- 会话 ----------
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 }).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
export function verifyPassword(password, stored) {
  const [alg, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const test = crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 }).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(test), Buffer.from(hash));
}

export function createSession(userId) {
  const token = randomToken(32);
  const id = newId('sess');
  const expires = new Date(Date.now() + config.sessionTtlHours * 3600 * 1000).toISOString();
  db.prepare(
    'INSERT INTO sessions (id, token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, sha256(token), userId, nowIso(), expires);
  return token;
}

export function revokeSession(token) {
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL').run(
    nowIso(),
    sha256(token)
  );
}

export function userForRequest(req) {
  const token = parseCookies(req).manji_session;
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.display_name, u.current_home_id, u.preferences, u.created_at, u.is_admin
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?`
    )
    .get(sha256(token), nowIso());
  return row || null;
}

export function setSessionCookie(res, token) {
  res.setHeader(
    'Set-Cookie',
    `manji_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${config.sessionTtlHours * 3600}`
  );
}
export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'manji_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

// ---------- 审计 ----------
export function audit(actorId, action, objectType, objectId, result, revision = null) {
  try {
    db.prepare(
      'INSERT INTO audit_events (id, actor_id, action, object_type, object_id, revision, result, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(newId('aud'), actorId, action, objectType, objectId, result, revision, nowIso());
  } catch {
    // 审计失败不阻断业务
  }
}

// ---------- 幂等（计划书 8.1：同键同负载重放原结果；同键异负载 409） ----------
export function idempotencyLookup(userId, routeKey, key, payloadHash) {
  const row = db
    .prepare('SELECT * FROM idempotency_keys WHERE user_id = ? AND route = ? AND idem_key = ?')
    .get(userId, routeKey, key);
  if (!row) return null;
  if (row.payload_hash !== payloadHash) {
    throw errors.conflict('IDEMPOTENCY_KEY_REUSED', '同一个幂等键已被用于不同的请求内容');
  }
  return row;
}

export function idempotencyStore(userId, routeKey, key, payloadHash, status, bodyJson) {
  db.prepare(
    `INSERT OR IGNORE INTO idempotency_keys (user_id, route, idem_key, payload_hash, status_code, response_body, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(userId, routeKey, key, payloadHash, status, bodyJson, nowIso());
}

// ---------- 响应 ----------
export function sendJson(res, status, payload) {
  const body = JSON.stringify({ ...payload, requestId: requestId() });
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
  return body;
}

export function sendError(res, err) {
  const status = err instanceof ApiError ? err.status : 500;
  const payload =
    err instanceof ApiError
      ? { error: { code: err.code, message: err.message, ...err.extra } }
      : { error: { code: 'INTERNAL', message: '服务出了点问题，请稍后再试', retryable: true } };
  if (!(err instanceof ApiError)) console.error('[manji] internal error:', err);
  sendJson(res, status, payload);
}

// ---------- 校验 ----------
export function trimTo(v, max) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 && t.length <= max ? t : null;
}

export function assert(cond, field, message) {
  if (!cond) throw errors.invalid({ [field]: message }, message);
}
