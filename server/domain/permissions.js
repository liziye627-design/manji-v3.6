// 慢记 Manji v3.1 —— 权限与可见性（所有读取路径的唯一裁决处）
import { db } from '../db.js';
import { nowIso, newId, errors } from '../core.js';

export function getUser(userId) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
}

export function getHome(homeId) {
  return db.prepare('SELECT * FROM homes WHERE id = ?').get(homeId);
}

export function activeMembers(homeId) {
  return db
    .prepare(
      `SELECT u.id, u.display_name FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.home_id = ? AND m.status = 'active'`
    )
    .all(homeId);
}

export function membershipOf(homeId, userId) {
  return db.prepare('SELECT * FROM memberships WHERE home_id = ? AND user_id = ?').get(homeId, userId);
}

export function partnerOf(homeId, userId) {
  const rows = activeMembers(homeId).filter((m) => m.id !== userId);
  return rows.length === 1 ? rows[0] : null;
}

export function currentHome(user) {
  const home = getHome(user.current_home_id);
  if (!home || home.status === 'frozen') throw errors.unavailable('当前空间不可用');
  return home;
}

/** 我参与过（含已离开/冻结）的家，按加入时间倒序 */
export function myHomes(userId) {
  return db
    .prepare(
      `SELECT h.*, m.status AS my_status, m.joined_at FROM memberships m JOIN homes h ON h.id = m.home_id
       WHERE m.user_id = ? ORDER BY m.joined_at DESC`
    )
    .all(userId);
}

export function getContainer(containerId) {
  return db.prepare('SELECT * FROM memory_containers WHERE id = ?').get(containerId);
}

export function getContribution(contributionId) {
  return db.prepare('SELECT * FROM contributions WHERE id = ?').get(contributionId);
}

/**
 * 容器对用户的可见模式：
 * - 'full'   当前有效家的容器（本人私有或共同）
 * - 'own'    容器已回到私密，但我在里面有未删除的贡献（B06：保留本人视角入口，只见自己的部分）
 * - 'archive' 已冻结家中我参与过的容器（归档视图，仅本人内容）
 * - null     无权（对外按 404 处理，不泄露存在性）
 */
export function containerAccess(user, container) {
  if (!container || container.status === 'removed') return null;
  const ms = membershipOf(container.home_id, user.id);
  if (!ms) return null;
  const home = getHome(container.home_id);
  if (home.status === 'frozen') return 'archive';
  if (ms.status !== 'active') return null;
  if (container.visibility === 'private' && container.creator_id !== user.id) {
    // 容器回到私密后，另一位作者仍保留自己的视角（B06），只是看不到对方内容
    const own = db
      .prepare(`SELECT COUNT(*) AS n FROM contributions WHERE memory_id = ? AND author_id = ? AND deleted_at IS NULL`)
      .get(container.id, user.id).n;
    return own > 0 ? 'own' : null;
  }
  return 'full';
}

/** 容器内用户当前可读的贡献（本人贡献在归档/仅本人视图也可读） */
export function visibleContributions(user, container, access) {
  const rows = db
    .prepare(
      `SELECT c.*, u.display_name AS author_name FROM contributions c JOIN users u ON u.id = c.author_id
       WHERE c.memory_id = ? AND c.deleted_at IS NULL ORDER BY c.created_at ASC`
    )
    .all(container.id);
  const mode = access || containerAccess(user, container);
  if (!mode) return [];
  if (mode === 'archive' || mode === 'own') return rows.filter((r) => r.author_id === user.id);
  return rows.filter((r) => r.author_id === user.id || r.visibility === 'home');
}

/** 单条贡献是否可读 */
export function canReadContribution(user, contribution) {
  if (!contribution || contribution.deleted_at) return false;
  if (contribution.author_id === user.id) return true;
  if (contribution.visibility !== 'home') return false;
  const container = getContainer(contribution.memory_id);
  const access = containerAccess(user, container);
  if (!access || access === 'archive') return false;
  return true;
}

/** 媒体读取权：沿贡献版本链验证（B01：作品产物必须走完整作品鉴权，不再对拥有者提前放行） */
export function canReadMedia(user, media) {
  if (!media || media.status === 'deleted' || media.status === 'orphan') return false;
  if (media.purpose === 'memory') {
    if (!media.contribution_id) return false;
    const contribution = getContribution(media.contribution_id);
    if (!contribution) return false;
    if (media.contribution_version > contribution.current_version) return false;
    return canReadContribution(user, contribution);
  }
  if (media.purpose === 'work-artifact') {
    const job = db.prepare('SELECT * FROM work_jobs WHERE artifact_media_id = ?').get(media.id);
    return canDownloadWork(user, job).ok === true;
  }
  // 导出 / 邀请预览等其余用途：仅限拥有者本人（导出与预览各有自己的鉴权入口）
  return media.owner_id === user.id;
}

/** 作品下载权：任务仍在、空间有效、授权（如含对方内容）仍有效。返回 {ok, reason}，调用方必须检查 .ok */
export function canDownloadWork(user, job) {
  if (!user || !job || job.owner_id !== user.id) return { ok: false };
  if (job.status !== 'ready' || !job.artifact_media_id) return { ok: false };
  if (!validateJobGrants(job)) return { ok: false, reason: 'consent-invalid' };
  if (job.includes_partner) {
    const home = getHome(job.home_id);
    if (!home || home.status === 'frozen') return { ok: false, reason: 'home-frozen' };
  }
  return { ok: true };
}

/** 校验任务引用的所有授权仍然有效（版本未变、共享未撤回）
 *  授权只需覆盖"对方的内容"版本；本人内容不需要授权（与作品创建时的校验一致） */
export function validateJobGrants(job) {
  if (!job.includes_partner || !job.grant_id) return true;
  const grant = db.prepare('SELECT * FROM consent_grants WHERE id = ?').get(job.grant_id);
  if (!grant || grant.status !== 'approved') return false;
  if (!grantVersionsStillValid(grant)) return false;
  const versionSet = JSON.parse(job.version_set);
  const partnerVersions = versionSet.filter((v) => {
    const c = getContribution(v.contributionId);
    return c && c.author_id !== job.owner_id;
  });
  return grantCoversVersions(grant, partnerVersions);
}

export function grantCoversVersions(grant, versionSet) {
  const approved = new Set(JSON.parse(grant.resource_versions).map((r) => `${r.contributionId}@${r.version}`));
  return versionSet.every((v) => approved.has(`${v.contributionId}@${v.version}`));
}

/** 授权涉及的贡献当前是否仍是批准时的版本且保持共享 */
export function grantVersionsStillValid(grant) {
  const versions = JSON.parse(grant.resource_versions);
  for (const rv of versions) {
    const c = getContribution(rv.contributionId);
    if (!c || c.deleted_at || c.current_version !== rv.version || c.visibility !== 'home') return false;
  }
  return true;
}

/** 让涉及某贡献全部授权失效（编辑新版本 / 撤回共享 / 删除时） */
export function invalidateGrantsForContribution(contributionId) {
  const grants = db.prepare(`SELECT * FROM consent_grants WHERE status = 'approved'`).all();
  const now = nowIso();
  for (const g of grants) {
    const versions = JSON.parse(g.resource_versions);
    if (versions.some((v) => v.contributionId === contributionId)) {
      db.prepare(`UPDATE consent_grants SET status = 'invalidated', revision = revision + 1 WHERE id = ?`).run(g.id);
      cancelJobsForGrant(g.id, `授权已失效`, now);
    }
  }
}

export function cancelJobsForGrant(grantId, reason, now) {
  db.prepare(
    `UPDATE work_jobs SET status = 'cancelled', fail_reason = ?, updated_at = ? WHERE grant_id = ? AND status IN ('queued','running')`
  ).run(reason, now, grantId);
  db.prepare(
    `UPDATE export_jobs SET status = 'cancelled', fail_reason = ? WHERE grant_id = ? AND status = 'ready'`
  ).run(reason, grantId);
  // 已生成但由系统托管的作品：停止下载（canDownloadWork 会因授权失效拒绝）
}

/** 重算容器可见性：有任一共享贡献 → home，否则 private */
export function refreshContainerVisibility(containerId) {
  const c = getContainer(containerId);
  if (!c) return;
  const shared = db
    .prepare(`SELECT COUNT(*) AS n FROM contributions WHERE memory_id = ? AND visibility = 'home' AND deleted_at IS NULL`)
    .get(containerId).n;
  const target = shared > 0 ? 'home' : 'private';
  if (c.visibility !== target) {
    db.prepare(`UPDATE memory_containers SET visibility = ?, updated_at = ? WHERE id = ?`).run(
      target,
      nowIso(),
      containerId
    );
  }
}

/** 容器标题按查看者裁剪（归档/仅本人视图不泄露对方敏感标题，B06） */
export function titleFor(user, container, access) {
  if (access !== 'full' && container.creator_id !== user.id) {
    return access === 'archive' ? '已归档的回忆' : '我的私密视角';
  }
  if (container.title) return container.title;
  return container.safe_title || '一段回忆';
}

/** 用户可见的容器卡片列表（含归档），可按条件过滤 */
export function listVisibleContainers(user, { homeIds = null } = {}) {
  const homes = myHomes(user.id);
  const out = [];
  for (const h of homes) {
    if (homeIds && !homeIds.includes(h.id)) continue;
    const containers = db
      .prepare(`SELECT * FROM memory_containers WHERE home_id = ? AND status = 'active' ORDER BY event_date DESC, created_at DESC`)
      .all(h.id);
    for (const c of containers) {
      const access = containerAccess(user, c);
      if (!access) continue;
      if (h.status !== 'frozen' && h.id !== user.current_home_id) {
        // 我的其他空间：只看我有贡献的容器
        const mine = db
          .prepare(`SELECT COUNT(*) AS n FROM contributions WHERE memory_id = ? AND author_id = ? AND deleted_at IS NULL`)
          .get(c.id, user.id).n;
        if (mine === 0) continue;
      }
      out.push({ container: c, home: h, access });
    }
  }
  return out;
}

export function memberPreference(userId, memoryId) {
  return (
    db
      .prepare('SELECT * FROM member_memory_preferences WHERE user_id = ? AND memory_id = ?')
      .get(userId, memoryId) || { hidden: 0, exclude_from_recall: 0 }
  );
}

/** 站内通知：唯一键去重，插入失败即已存在 */
export function notify(userId, { type, title, body, sourceId = null, occurrenceDate = null, dedupeKey }) {
  try {
    db.prepare(
      `INSERT INTO notifications (id, user_id, type, title, body, source_id, occurrence_date, dedupe_key, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sent', ?)`
    ).run(newId('ntf'), userId, type, title, body, sourceId, occurrenceDate, dedupeKey, nowIso());
  } catch {
    // 唯一键冲突：已发过，不重复
  }
}

export function getPet(homeId) {
  return db.prepare(`SELECT * FROM pet_profiles WHERE owner_type = 'home' AND owner_id = ?`).get(homeId);
}

/** 首次共同回忆：两位有效成员在同一家、同一容器各有 ≥1 份共享有效贡献 → 各授予一次外观 */
export function maybeGrantFirstCoMemoryAppearance(containerId) {
  const c = getContainer(containerId);
  if (!c) return;
  const home = getHome(c.home_id);
  if (!home || home.status !== 'shared') return;
  const members = activeMembers(c.home_id);
  if (members.length !== 2) return;
  for (const m of members) {
    const n = db
      .prepare(
        `SELECT COUNT(*) AS n FROM contributions WHERE memory_id = ? AND author_id = ? AND visibility = 'home' AND deleted_at IS NULL`
      )
      .get(containerId, m.id).n;
    if (n === 0) return;
  }
  const businessKey = `first-co-memory:${c.home_id}`;
  const now = nowIso();
  for (const m of members) {
    try {
      db.prepare(
        `INSERT INTO appearance_grants (id, user_id, home_id, appearance_key, reason, business_key, created_at)
         VALUES (?, ?, ?, 'nameplate-sunset', '第一次共同回忆', ?, ?)`
      ).run(newId('apg'), m.id, c.home_id, businessKey, now);
      notify(m.id, {
        type: 'appearance',
        title: '获得了一份小外观',
        body: '你们第一次把同一段回忆放进了家里，小狗的名字牌换上了新的颜色。',
        sourceId: c.home_id,
        dedupeKey: `appearance:${businessKey}:${m.id}`,
      });
    } catch {
      // 已授予过：幂等，不重复发放
    }
  }
}
