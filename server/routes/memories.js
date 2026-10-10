// 慢记 Manji v3.1 —— 回忆、贡献、版本、纪念物、摆放、收纳、查找、回顾
import { rmSync } from 'node:fs';
import { db, tx, getTemplate, ROOM_SLOTS, TOPICS } from '../db.js';
import { config } from '../config.js';
import {
  nowIso, newId, sha256, bizToday, isValidDate, errors, audit, trimTo, assert,
} from '../core.js';
import {
  getContainer, getContribution, containerAccess, visibleContributions, canReadContribution,
  refreshContainerVisibility, invalidateGrantsForContribution, maybeGrantFirstCoMemoryAppearance,
  currentHome, membershipOf, partnerOf, getPet, notify, memberPreference, getUser, getHome,
} from '../domain/permissions.js';
import { anchorsForRecord } from '../domain/chain.js';
import { mainnetSealOfAnchor } from '../domain/public-chain.js';

const SLOT_KEYS = ROOM_SLOTS.map((s) => s.key);

// ---------- 辅助 ----------
function photosOf(contributionId, viewer, access, container) {
  const rows = db
    .prepare(
      `SELECT * FROM media_assets WHERE contribution_id = ? AND purpose = 'memory' AND status = 'bound'
       ORDER BY created_at ASC`
    )
    .all(contributionId);
  return rows.map((m) => ({ id: m.id, mime: m.mime, width: m.width, height: m.height, size: m.size }));
}

function firstThumbId(contributionId) {
  const m = db
    .prepare(
      `SELECT id FROM media_assets WHERE contribution_id = ? AND purpose = 'memory' AND status = 'bound' ORDER BY created_at ASC LIMIT 1`
    )
    .get(contributionId);
  return m ? m.id : null;
}

function myObjectOf(memoryId, userId) {
  return db
    .prepare('SELECT * FROM memory_objects WHERE memory_id = ? AND owner_id = ?')
    .get(memoryId, userId);
}

function placementOf(objectId, homeId) {
  return db
    .prepare('SELECT * FROM placements WHERE object_id = ? AND home_id = ?')
    .get(objectId, homeId);
}

function slotOccupied(homeId, layer, slotKey, exceptPlacementId) {
  const row = db
    .prepare(
      `SELECT p.id FROM placements p JOIN memory_objects o ON o.id = p.object_id
       WHERE p.home_id = ? AND p.layer = ? AND p.slot_key = ? AND p.status = 'displayed'
         AND EXISTS (SELECT 1 FROM memory_containers mc WHERE mc.id = o.memory_id AND mc.status = 'active')`
    )
    .get(homeId, layer, slotKey);
  return row && row.id !== exceptPlacementId ? row.id : null;
}

function freeSlots(homeId, layer) {
  const occupied = new Set(
    db
      .prepare(
        `SELECT p.slot_key FROM placements p JOIN memory_objects o ON o.id = p.object_id
         WHERE p.home_id = ? AND p.layer = ? AND p.status = 'displayed'
           AND EXISTS (SELECT 1 FROM memory_containers mc WHERE mc.id = o.memory_id AND mc.status = 'active')`
      )
      .all(homeId, layer)
      .map((r) => r.slot_key)
  );
  return ROOM_SLOTS.filter((s) => !occupied.has(s.key));
}

/** 物件在层间移动（共享→共同层；撤回→本人层），占位冲突时收入收纳盒 */
function moveObjectToLayer(object, homeId, layer, preferredSlot) {
  const placement = placementOf(object.id, homeId);
  const now = nowIso();
  if (!placement) return;
  if (placement.layer === layer) return;
  let slot = null;
  let status = 'stored';
  if (preferredSlot && !slotOccupied(homeId, layer, preferredSlot, placement.id)) {
    slot = preferredSlot;
    status = 'displayed';
  } else {
    const free = freeSlots(homeId, layer);
    if (free.length > 0) {
      slot = free[0].key;
      status = 'displayed';
    }
  }
  db.prepare(
    `UPDATE placements SET layer = ?, slot_key = ?, status = ?, revision = revision + 1, updated_at = ? WHERE id = ?`
  ).run(layer, slot, status, now, placement.id);
}

function cardFor(user, container, access) {
  const contribs = visibleContributions(user, container, access);
  const myContrib = contribs.find((c) => c.author_id === user.id);
  const prefs = memberPreference(user.id, container.id);
  const obj = myObjectOf(container.id, user.id);
  let placement = null;
  let partnerObjVisible = false;
  if (access === 'full' && container.home_id === user.current_home_id) {
    if (obj) placement = placementOf(obj.id, container.home_id);
    if (!placement || placement.status === 'stored') {
      const homeObj = db
        .prepare(
          `SELECT o.*, p.status AS p_status FROM memory_objects o
           LEFT JOIN placements p ON p.object_id = o.id AND p.home_id = ?
           WHERE o.memory_id = ? AND o.visibility = 'home'`
        )
        .get(container.home_id, container.id);
      if (homeObj && homeObj.p_status === 'displayed') partnerObjVisible = true;
    }
  }
  return {
    id: container.id,
    eventDate: container.event_date,
    topic: container.topic,
    title:
      access === 'full' || container.creator_id === user.id
        ? container.title || container.safe_title
        : access === 'archive'
          ? '已归档的回忆'
          : '我的私密视角',
    visibility: container.visibility,
    access,
    homeStatus: getHome(container.home_id).status,
    hidden: !!prefs.hidden,
    excludeFromRecall: !!prefs.exclude_from_recall,
    perspectives: contribs.map((c) => ({
      authorName: c.author_name,
      mine: c.author_id === user.id,
      shared: c.visibility === 'home',
      hasPhotos: firstThumbId(c.id) != null,
    })),
    photoThumbId: contribs.length > 0 ? firstThumbId(contribs[0].id) : null,
    objectTemplate: obj ? obj.template_key : null,
    objectSlot: placement ? placement.slot_key : null,
    objectStored: placement ? placement.status === 'stored' : partnerObjVisible ? false : null,
    hasDisplayedObject:
      (placement && placement.status === 'displayed') || partnerObjVisible,
    removalRequestedBy: container.removal_requested_by || null,
    revision: container.revision,
  };
}

/** 取得容器并校验访问；removed 容器仅贡献者可入（共同移除后回私密档案）
 *  allowOwn：容器整体回到私密时，仍允许有本人贡献的作者进入（B06，配合路由层的作者校验） */
function requireContainer(user, id, { needFull = false, allowOwn = false } = {}) {
  const container = getContainer(id);
  if (!container) throw errors.notFound();
  let access = containerAccess(user, container);
  if (container.status === 'removed') {
    const mine = db
      .prepare(`SELECT COUNT(*) AS n FROM contributions WHERE memory_id = ? AND author_id = ? AND deleted_at IS NULL`)
      .get(id, user.id).n;
    access = mine > 0 ? 'archive' : null;
  }
  if (!access) throw errors.notFound();
  if (needFull && access !== 'full' && !(allowOwn && access === 'own')) {
    throw errors.forbidden('这份回忆已不在共同范围，只能查看和管理你自己的部分');
  }
  return { container, access };
}

function validateUploadIds(userId, ids, existingCount) {
  assert(Array.isArray(ids) && ids.every((x) => typeof x === 'string'), 'photoUploadIds', '照片参数无效');
  assert(existingCount + ids.length <= config.maxPhotosPerMemory, 'photoUploadIds',
    `每人在一件回忆里最多放 ${config.maxPhotosPerMemory} 张照片`);
  const staged = [];
  for (const uploadId of ids) {
    const m = db.prepare('SELECT * FROM media_assets WHERE id = ?').get(uploadId);
    if (!m || m.owner_id !== userId || m.purpose !== 'memory' || m.status !== 'bound' || m.contribution_id) {
      throw errors.invalid({ photoUploadIds: '有照片尚未完成上传或不可用' }, '有照片尚未完成上传或不可用');
    }
    staged.push(m);
  }
  return staged;
}

function bindMedia(mediaRows, contributionId, version) {
  for (const m of mediaRows) {
    db.prepare('UPDATE media_assets SET contribution_id = ?, contribution_version = ? WHERE id = ?').run(
      contributionId, version, m.id
    );
  }
}

function checkText(text) {
  if (text === undefined || text === null) return '';
  assert(typeof text === 'string' && text.length <= config.maxTextChars, 'text',
    `正文最多 ${config.maxTextChars} 字`);
  return text.trim();
}

function safeTitleFrom(title, text) {
  if (title) return title.slice(0, 16);
  if (text) {
    const t = text.trim().replace(/\s+/g, ' ');
    return t.slice(0, 12);
  }
  return '一段回忆';
}

// ---------- 列表与详情 ----------
export const routes = {
  'GET /api/memories': async (ctx) => {
    const q = ctx.query.get('q') || '';
    const from = ctx.query.get('from');
    const to = ctx.query.get('to');
    const topic = ctx.query.get('topic');
    const includeHidden = ctx.query.get('includeHidden') === '1';
    const scope = ctx.query.get('scope') || 'all';
    const user = ctx.user;
    const out = [];
    const homes = db
      .prepare(
        `SELECT h.* FROM memberships m JOIN homes h ON h.id = m.home_id WHERE m.user_id = ? ORDER BY m.joined_at DESC`
      )
      .all(user.id);
    for (const h of homes) {
      if (scope === 'current' && h.id !== user.current_home_id) continue;
      if (scope === 'archive' && h.id === user.current_home_id) continue;
      const containers = db
        .prepare(
          `SELECT * FROM memory_containers WHERE home_id = ? AND status != 'removed' ORDER BY event_date DESC, created_at DESC`
        )
        .all(h.id);
      for (const c of containers) {
        let access = containerAccess(user, c);
        if (!access) continue;
        const prefs = memberPreference(user.id, c.id);
        if (prefs.hidden && !includeHidden) continue;
        if (h.id !== user.current_home_id) {
          const mine = db
            .prepare(`SELECT COUNT(*) AS n FROM contributions WHERE memory_id = ? AND author_id = ? AND deleted_at IS NULL`)
            .get(c.id, user.id).n;
          if (mine === 0) continue;
        }
        out.push({ container: c, access });
      }
      // 已共同移除的容器：仅贡献者本人、归档视图
      const removed = db
        .prepare(`SELECT * FROM memory_containers WHERE home_id = ? AND status = 'removed'`)
        .all(h.id);
      for (const c of removed) {
        const mine = db
          .prepare(`SELECT COUNT(*) AS n FROM contributions WHERE memory_id = ? AND author_id = ? AND deleted_at IS NULL`)
          .get(c.id, user.id).n;
        if (mine > 0 && scope !== 'current') out.push({ container: c, access: 'archive' });
      }
    }
    let cards = out.map(({ container, access }) => cardFor(user, container, access));
    if (q) {
      const needle = q.trim().toLowerCase();
      cards = cards.filter((card) => {
        const c = getContainer(card.id);
        if (card.title && card.title.toLowerCase().includes(needle)) return true;
        for (const contrib of visibleContributions(user, c)) {
          const v = db
            .prepare('SELECT text FROM contribution_versions WHERE contribution_id = ? AND version = ?')
            .get(contrib.id, contrib.current_version);
          if (v && v.text && v.text.toLowerCase().includes(needle)) return true;
        }
        return false;
      });
    }
    if (from) cards = cards.filter((c) => c.eventDate >= from);
    if (to) cards = cards.filter((c) => c.eventDate <= to);
    if (topic) cards = cards.filter((c) => c.topic === topic);
    return { status: 200, data: { data: { items: cards, topics: TOPICS } } };
  },

  'POST /api/memories': async (ctx) => {
    const body = ctx.json();
    const home = currentHome(ctx.user);
    const text = checkText(body.text);
    const photoIds = body.photoUploadIds || [];
    assert(text.length > 0 || photoIds.length > 0, 'text', '照片或文字至少留一项');
    const eventDate = body.eventDate || bizToday();
    assert(isValidDate(eventDate), 'eventDate', '日期格式无效');
    assert(eventDate <= bizToday(), 'eventDate', '发生日期不能在未来；未来的约定放在承诺或纪念日里');
    const topic = body.topic ? trimTo(body.topic, 12) : null;
    if (topic) assert(TOPICS.includes(topic), 'topic', '主题不在可选范围');
    const title = body.title ? trimTo(body.title, 16) : null;
    const visibility = body.visibility || 'private';
    assert(visibility === 'private' || visibility === 'home', 'visibility', '范围无效');
    const staged = validateUploadIds(ctx.user.id, photoIds, 0);

    const now = nowIso();
    const memoryId = newId('mem');
    const contributionId = newId('con');
    tx(() => {
      db.prepare(
        `INSERT INTO memory_containers (id, home_id, creator_id, title, safe_title, event_date, topic, visibility, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'private', 1, ?, ?)`
      ).run(memoryId, home.id, ctx.user.id, title, safeTitleFrom(title, text), eventDate, topic, now, now);
      db.prepare(
        `INSERT INTO contributions (id, memory_id, author_id, visibility, current_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`
      ).run(contributionId, memoryId, ctx.user.id, 'private', now, now);
      db.prepare(
        `INSERT INTO contribution_versions (contribution_id, version, text, content_hash, created_at) VALUES (?, 1, ?, ?, ?)`
      ).run(contributionId, text, sha256(text), now);
      bindMedia(staged, contributionId, 1);
      if (visibility === 'home') {
        db.prepare(`UPDATE contributions SET visibility = 'home' WHERE id = ?`).run(contributionId);
      }
      refreshContainerVisibility(memoryId);
    })();
    if (visibility === 'home') maybeGrantFirstCoMemoryAppearance(memoryId);
    audit(ctx.user.id, 'memory-create', 'memory', memoryId, 'ok');
    return { status: 201, data: { data: { memoryId, contributionId, visibility } } };
  },

  'GET /api/memories/:id': async (ctx) => {
    const { container, access } = requireContainer(ctx.user, ctx.params.id);
    const contribs = visibleContributions(ctx.user, container, access);
    const myObject = myObjectOf(container.id, ctx.user.id);
    let placement = null;
    if (myObject) placement = placementOf(myObject.id, container.home_id);
    const partner = access === 'full' && container.home_id === ctx.user.current_home_id
      ? partnerOf(container.home_id, ctx.user.id)
      : null;
    return {
      status: 200,
      data: {
        data: {
          id: container.id,
          homeId: container.home_id, // v3.5（B08）：归档视图的存证徽标直达已定格旧链 ?home=<homeId>
          eventDate: container.event_date,
          topic: container.topic,
          title:
            access === 'full' || container.creator_id === ctx.user.id
              ? container.title || container.safe_title
              : access === 'archive'
                ? '已归档的回忆'
                : '我的私密视角',
          visibility: container.visibility,
          status: container.status,
          access,
          isCreator: container.creator_id === ctx.user.id,
          revision: container.revision,
          removalRequestedBy: container.removal_requested_by || null,
          contributions: contribs.map((c) => {
            const anchors = anchorsForRecord('contribution', c.id);
            const latest = anchors[anchors.length - 1] || null;
            return {
              id: c.id,
              authorName: c.author_name,
              mine: c.author_id === ctx.user.id,
              visibility: c.visibility,
              version: c.current_version,
              text: db
                .prepare('SELECT text FROM contribution_versions WHERE contribution_id = ? AND version = ?')
                .get(c.id, c.current_version).text,
              photos: photosOf(c.id),
              updatedAt: c.updated_at,
              onChain: latest
                ? {
                    blockHeight: latest.block_height,
                    revision: latest.revision,
                    isCurrentRevision: latest.revision === c.current_version,
                    anchoredAt: latest.created_at,
                    anchorCount: anchors.length,
                    mainnet: mainnetSealOfAnchor(latest.id),
                  }
                : null,
            };
          }),
          object: myObject
            ? {
                id: myObject.id,
                templateKey: myObject.template_key,
                visibility: myObject.visibility,
                placement: placement
                  ? { id: placement.id, layer: placement.layer, slotKey: placement.slot_key, status: placement.status, revision: placement.revision }
                  : null,
              }
            : null,
          hasPartner: !!partner,
          templates: db.prepare('SELECT key, label, allowed_slots FROM object_templates').all(),
          slots: ROOM_SLOTS,
        },
      },
    };
  },

  'PATCH /api/memories/:id': async (ctx) => {
    const { container } = requireContainer(ctx.user, ctx.params.id, { needFull: true });
    if (container.creator_id !== ctx.user.id) throw errors.forbidden('只有创建者可以修改这件回忆的基本信息');
    const body = ctx.json();
    const expected = Number(body.expectedRevision);
    assert(Number.isInteger(expected), 'expectedRevision', '缺少版本号');
    if (expected !== container.revision) {
      throw errors.conflict('REVISION_CONFLICT', '内容已更新，请重新查看', { currentRevision: container.revision });
    }
    const title = body.title !== undefined ? trimTo(body.title, 16) : container.title;
    const topic = body.topic !== undefined ? trimTo(body.topic, 12) : container.topic;
    if (topic) assert(TOPICS.includes(topic), 'topic', '主题不在可选范围');
    const eventDate = body.eventDate !== undefined ? body.eventDate : container.event_date;
    assert(isValidDate(eventDate) && eventDate <= bizToday(), 'eventDate', '日期无效或在未来');
    db.prepare(
      `UPDATE memory_containers SET title = ?, topic = ?, event_date = ?, revision = revision + 1, updated_at = ? WHERE id = ?`
    ).run(title, topic, eventDate, nowIso(), container.id);
    // 版本变化后，未完成的共同移除请求重置
    db.prepare(`UPDATE memory_containers SET removal_requested_by = NULL WHERE id = ? AND removal_requested_by IS NOT NULL`).run(container.id);
    audit(ctx.user.id, 'memory-update', 'memory', container.id, 'ok', container.revision + 1);
    return { status: 200, data: { data: { revision: container.revision + 1 } } };
  },

  // ---------- 贡献与版本 ----------
  'POST /api/memories/:id/contributions': async (ctx) => {
    const { container, access } = requireContainer(ctx.user, ctx.params.id, { needFull: true });
    const existing = db
      .prepare('SELECT id FROM contributions WHERE memory_id = ? AND author_id = ? AND deleted_at IS NULL')
      .get(container.id, ctx.user.id);
    if (existing) throw errors.conflict('CONTRIBUTION_EXISTS', '你已经留过视角了，可以直接编辑自己的那份');
    const body = ctx.json();
    const text = checkText(body.text);
    const photoIds = body.photoUploadIds || [];
    assert(text.length > 0 || photoIds.length > 0, 'text', '照片或文字至少留一项');
    const staged = validateUploadIds(ctx.user.id, photoIds, 0);
    const visibility = body.visibility === 'home' ? 'home' : 'private';
    const now = nowIso();
    const contributionId = newId('con');
    tx(() => {
      db.prepare(
        `INSERT INTO contributions (id, memory_id, author_id, visibility, current_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`
      ).run(contributionId, container.id, ctx.user.id, 'private', now, now);
      db.prepare(
        `INSERT INTO contribution_versions (contribution_id, version, text, content_hash, created_at) VALUES (?, 1, ?, ?, ?)`
      ).run(contributionId, text, sha256(text), now);
      bindMedia(staged, contributionId, 1);
      if (visibility === 'home') {
        db.prepare(`UPDATE contributions SET visibility = 'home' WHERE id = ?`).run(contributionId);
      }
      refreshContainerVisibility(container.id);
    })();
    if (visibility === 'home') maybeGrantFirstCoMemoryAppearance(container.id);
    const partner = partnerOf(container.home_id, ctx.user.id);
    if (partner && visibility === 'home') {
      notify(partner.id, {
        type: 'memory-shared',
        title: `${ctx.user.display_name} 补上了自己的视角`,
        body: '可以去看看同一天在 TA 眼里的样子。',
        sourceId: container.id,
        dedupeKey: `memory-shared:${contributionId}`,
      });
    }
    audit(ctx.user.id, 'contribution-create', 'contribution', contributionId, 'ok');
    return { status: 201, data: { data: { contributionId } } };
  },

  'PATCH /api/contributions/:id': async (ctx) => {
    const contribution = getContribution(ctx.params.id);
    if (!contribution || contribution.deleted_at) throw errors.notFound();
    if (contribution.author_id !== ctx.user.id) throw errors.forbidden('只能编辑自己的视角');
    const { container } = requireContainer(ctx.user, contribution.memory_id, { needFull: true, allowOwn: true });
    const body = ctx.json();
    const expected = Number(body.expectedRevision);
    assert(Number.isInteger(expected), 'expectedRevision', '缺少版本号');
    if (expected !== contribution.current_version) {
      throw errors.conflict('REVISION_CONFLICT', '内容已更新，请重新查看', { currentRevision: contribution.current_version });
    }
    const text = checkText(body.text);
    const addIds = body.addPhotoIds || [];
    const removeIds = body.removePhotoIds || [];
    const current = db
      .prepare(`SELECT COUNT(*) AS n FROM media_assets WHERE contribution_id = ? AND purpose = 'memory' AND status = 'bound'`)
      .get(contribution.id).n;
    const staged = validateUploadIds(ctx.user.id, addIds, current - removeIds.length);
    const newText = body.text !== undefined ? text : getCurrentText(contribution.id, contribution.current_version);
    assert(newText.length > 0 || current - removeIds.length + addIds.length > 0, 'text', '照片或文字至少留一项');

    const now = nowIso();
    const newVersion = contribution.current_version + 1;
    tx(() => {
      db.prepare(
        `INSERT INTO contribution_versions (contribution_id, version, text, content_hash, created_at) VALUES (?, ?, ?, ?, ?)`
      ).run(contribution.id, newVersion, newText, sha256(newText), now);
      db.prepare(`UPDATE contributions SET current_version = ?, updated_at = ? WHERE id = ?`).run(newVersion, now, contribution.id);
      bindMedia(staged, contribution.id, newVersion);
      for (const photoId of removeIds) {
        const m = db.prepare(`SELECT * FROM media_assets WHERE id = ? AND contribution_id = ?`).get(photoId, contribution.id);
        if (m) {
          db.prepare(`UPDATE media_assets SET status = 'deleted' WHERE id = ?`).run(m.id);
          if (m.thumb_key) db.prepare(`UPDATE media_assets SET status = 'deleted' WHERE id = ?`).run(m.thumb_key);
          rmSyncMedia(m);
        }
      }
    })();
    // 内容变化：相关授权立即失效（M33）
    invalidateGrantsForContribution(contribution.id);
    refreshContainerVisibility(container.id);
    audit(ctx.user.id, 'contribution-update', 'contribution', contribution.id, 'ok', newVersion);
    return { status: 200, data: { data: { version: newVersion } } };
  },

  'POST /api/contributions/:id/share': async (ctx) => {
    const contribution = getContribution(ctx.params.id);
    if (!contribution || contribution.deleted_at) throw errors.notFound();
    if (contribution.author_id !== ctx.user.id) throw errors.forbidden('只能分享自己的内容');
    const { container } = requireContainer(ctx.user, contribution.memory_id, { needFull: true, allowOwn: true });
    if (contribution.visibility === 'home') return { status: 200, data: { data: { visibility: 'home' } } };
    db.prepare(`UPDATE contributions SET visibility = 'home' WHERE id = ?`).run(contribution.id);
    refreshContainerVisibility(container.id);
    // 我的物件进入共同层（M14 的反向面：共享后对方可见）
    const obj = myObjectOf(container.id, ctx.user.id);
    if (obj) {
      db.prepare(`UPDATE memory_objects SET visibility = 'home', revision = revision + 1 WHERE id = ?`).run(obj.id);
      const placement = placementOf(obj.id, container.home_id);
      if (placement && placement.layer === 'private') {
        moveObjectToLayer(obj, container.home_id, 'home', placement.slot_key);
      }
    }
    maybeGrantFirstCoMemoryAppearance(container.id);
    const partner = partnerOf(container.home_id, ctx.user.id);
    if (partner) {
      notify(partner.id, {
        type: 'memory-shared',
        title: `${ctx.user.display_name} 分享了一段回忆`,
        body: '现在你也可以看到这一天在 TA 眼里的样子。',
        sourceId: container.id,
        dedupeKey: `memory-shared:${contribution.id}`,
      });
    }
    audit(ctx.user.id, 'contribution-share', 'contribution', contribution.id, 'ok');
    return { status: 200, data: { data: { visibility: 'home' } } };
  },

  'POST /api/contributions/:id/revoke': async (ctx) => {
    const contribution = getContribution(ctx.params.id);
    if (!contribution || contribution.deleted_at) throw errors.notFound();
    if (contribution.author_id !== ctx.user.id) throw errors.forbidden('只能撤回自己的内容');
    const { container } = requireContainer(ctx.user, contribution.memory_id, { needFull: true, allowOwn: true });
    db.prepare(`UPDATE contributions SET visibility = 'private' WHERE id = ?`).run(contribution.id);
    invalidateGrantsForContribution(contribution.id); // 撤权立即断开作品与导出（M14/M32/M35）
    refreshContainerVisibility(container.id);
    const obj = myObjectOf(container.id, ctx.user.id);
    if (obj) {
      db.prepare(`UPDATE memory_objects SET visibility = 'private', revision = revision + 1 WHERE id = ?`).run(obj.id);
      const placement = placementOf(obj.id, container.home_id);
      if (placement && placement.layer === 'home') {
        moveObjectToLayer(obj, container.home_id, 'private', placement.slot_key);
      }
    }
    audit(ctx.user.id, 'contribution-revoke', 'contribution', contribution.id, 'ok');
    return { status: 200, data: { data: { visibility: 'private' } } };
  },

  'DELETE /api/contributions/:id': async (ctx) => {
    const contribution = getContribution(ctx.params.id);
    if (!contribution || contribution.deleted_at) throw errors.notFound();
    if (contribution.author_id !== ctx.user.id) throw errors.forbidden('只能删除自己的内容（M13）');
    const { container, access } = requireContainer(ctx.user, contribution.memory_id, { needFull: true, allowOwn: true });
    const now = nowIso();
    tx(() => {
      db.prepare(`UPDATE contributions SET deleted_at = ?, updated_at = ? WHERE id = ?`).run(now, now, contribution.id);
      const photos = db
        .prepare(`SELECT * FROM media_assets WHERE contribution_id = ? AND purpose = 'memory'`)
        .all(contribution.id);
      for (const m of photos) {
        db.prepare(`UPDATE media_assets SET status = 'deleted' WHERE id = ?`).run(m.id);
        if (m.thumb_key) db.prepare(`UPDATE media_assets SET status = 'deleted' WHERE storage_key = ?`).run(m.thumb_key);
      }
      // 我的物件与摆放一并移除（不连带对方记录，M15）
      const obj = myObjectOf(container.id, ctx.user.id);
      if (obj) {
        db.prepare(`DELETE FROM placements WHERE object_id = ?`).run(obj.id);
        db.prepare(`DELETE FROM memory_objects WHERE id = ?`).run(obj.id);
      }
      invalidateGrantsForContribution(contribution.id);
      refreshContainerVisibility(container.id);
      const left = db
        .prepare(`SELECT COUNT(*) AS n FROM contributions WHERE memory_id = ? AND deleted_at IS NULL`)
        .get(container.id).n;
      if (left === 0) {
        db.prepare(`UPDATE memory_containers SET status = 'removed', updated_at = ? WHERE id = ?`).run(now, container.id);
      }
    })();
    for (const m of db
      .prepare(`SELECT * FROM media_assets WHERE contribution_id = ? AND purpose = 'memory'`)
      .all(contribution.id)) {
      rmSyncMedia(m);
    }
    audit(ctx.user.id, 'contribution-delete', 'contribution', contribution.id, 'ok');
    return { status: 200, data: { data: { ok: true } } };
  },

  // ---------- 纪念物与摆放（计划书 4.3 / S04） ----------
  'PUT /api/memories/:id/object': async (ctx) => {
    const { container } = requireContainer(ctx.user, ctx.params.id, { needFull: true });
    const body = ctx.json();
    const template = getTemplate(body.templateKey);
    if (!template) throw errors.invalid({ templateKey: '纪念物模板无效' }, '纪念物模板无效');
    const slotKey = body.slotKey;
    const wantStore = slotKey === 'store' || slotKey == null;
    if (!wantStore) assert(SLOT_KEYS.includes(slotKey), 'slotKey', '摆放位置无效');
    const allowed = JSON.parse(template.allowed_slots);
    if (!wantStore) {
      assert(allowed.includes(slotKey), 'slotKey', `这个物件建议放在：${allowed.map(slotLabel).join('、')}`);
    }
    const home = getHome(container.home_id);
    if (home.status === 'frozen') throw errors.forbidden('这个空间已冻结');
    const contribution = db
      .prepare(`SELECT * FROM contributions WHERE memory_id = ? AND author_id = ? AND deleted_at IS NULL`)
      .get(container.id, ctx.user.id);
    const layer = contribution && contribution.visibility === 'home' ? 'home' : 'private';
    const now = nowIso();

    let obj = myObjectOf(container.id, ctx.user.id);
    const txn = tx(() => {
      if (!wantStore) {
        const occupant = slotOccupied(container.home_id, layer, slotKey, null);
        if (occupant) {
          throw errors.conflict('SLOT_OCCUPIED', '这个位置已经有别的东西了', {
            slot: slotKey,
            freeSlots: freeSlots(container.home_id, layer),
          });
        }
      }
      if (!obj) {
        const objId = newId('obj');
        db.prepare(
          `INSERT INTO memory_objects (id, memory_id, template_key, owner_id, visibility, revision, created_at)
           VALUES (?, ?, ?, ?, ?, 1, ?)`
        ).run(objId, container.id, template.key, ctx.user.id, layer, now);
        const placementId = newId('plc');
        db.prepare(
          `INSERT INTO placements (id, home_id, object_id, layer, owner_id, slot_key, status, revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
        ).run(
          placementId, container.home_id, objId, layer,
          layer === 'private' ? ctx.user.id : null,
          wantStore ? null : slotKey, wantStore ? 'stored' : 'displayed', now, now
        );
        obj = { id: objId };
      } else {
        db.prepare(`UPDATE memory_objects SET template_key = ?, visibility = ?, revision = revision + 1 WHERE id = ?`).run(
          template.key, layer, obj.id
        );
        let placement = placementOf(obj.id, container.home_id);
        if (!placement) {
          const placementId = newId('plc');
          db.prepare(
            `INSERT INTO placements (id, home_id, object_id, layer, owner_id, slot_key, status, revision, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
          ).run(placementId, container.home_id, obj.id, layer, layer === 'private' ? ctx.user.id : null,
            wantStore ? null : slotKey, wantStore ? 'stored' : 'displayed', now, now);
        } else {
          if (!wantStore && slotKey !== placement.slot_key) {
            const occupant = slotOccupied(container.home_id, layer, slotKey, placement.id);
            if (occupant) {
              throw errors.conflict('SLOT_OCCUPIED', '这个位置已经有别的东西了', {
                slot: slotKey,
                freeSlots: freeSlots(container.home_id, layer),
              });
            }
          }
          if (placement.layer !== layer) {
            // 共享状态变化引起换层
            if (!wantStore) {
              const occupant = slotOccupied(container.home_id, layer, slotKey, placement.id);
              if (occupant) {
                throw errors.conflict('SLOT_OCCUPIED', '这个位置已经有别的东西了', {
                  slot: slotKey,
                  freeSlots: freeSlots(container.home_id, layer),
                });
              }
            }
            db.prepare(
              `UPDATE placements SET layer = ?, owner_id = ?, slot_key = ?, status = ?, revision = revision + 1, updated_at = ? WHERE id = ?`
            ).run(layer, layer === 'private' ? ctx.user.id : null, wantStore ? null : slotKey,
              wantStore ? 'stored' : 'displayed', now, placement.id);
          } else {
            db.prepare(
              `UPDATE placements SET slot_key = ?, status = ?, revision = revision + 1, updated_at = ? WHERE id = ?`
            ).run(wantStore ? null : slotKey, wantStore ? 'stored' : 'displayed', now, placement.id);
          }
        }
      }
    });
    try {
      txn();
    } catch (e) {
      if (e instanceof Error && e.status) throw e;
      throw e;
    }
    audit(ctx.user.id, 'object-select', 'memory', container.id, 'ok');
    return { status: 200, data: { data: { templateKey: template.key, slotKey: wantStore ? null : slotKey, layer } } };
  },

  'PUT /api/placements/:id': async (ctx) => {
    const placement = db.prepare('SELECT * FROM placements WHERE id = ?').get(ctx.params.id);
    if (!placement) throw errors.notFound();
    const obj = db.prepare('SELECT * FROM memory_objects WHERE id = ?').get(placement.object_id);
    const container = getContainer(obj.memory_id);
    const home = getHome(placement.home_id);
    if (!home || home.status === 'frozen') throw errors.forbidden('这个空间已冻结');
    const ms = membershipOf(placement.home_id, ctx.user.id);
    if (!ms || ms.status !== 'active') throw errors.notFound();
    if (placement.layer === 'private' && placement.owner_id !== ctx.user.id) {
      throw errors.notFound(); // 不泄露对方私有物件的存在
    }
    if (placement.layer === 'home' && containerAccess(ctx.user, container) !== 'full') {
      throw errors.notFound();
    }
    const body = ctx.json();
    const expected = Number(body.expectedRevision);
    assert(Number.isInteger(expected), 'expectedRevision', '缺少版本号');
    if (expected !== placement.revision) {
      throw errors.conflict('REVISION_CONFLICT', '位置刚刚被更新过，请重新查看', {
        currentRevision: placement.revision,
        freeSlots: freeSlots(placement.home_id, placement.layer),
      });
    }
    const action = body.action;
    let slotKey = placement.slot_key;
    let status = placement.status;
    if (action === 'store') {
      status = 'stored';
      slotKey = null;
    } else if (action === 'display') {
      status = 'displayed';
      slotKey = body.slotKey;
      assert(SLOT_KEYS.includes(slotKey), 'slotKey', '摆放位置无效');
    } else if (body.slotKey) {
      slotKey = body.slotKey;
      status = 'displayed';
      assert(SLOT_KEYS.includes(slotKey), 'slotKey', '摆放位置无效');
    }
    const txn = tx(() => {
      const cur = db.prepare('SELECT * FROM placements WHERE id = ?').get(placement.id);
      if (cur.revision !== expected) {
        throw errors.conflict('REVISION_CONFLICT', '位置刚刚被更新过，请重新查看', {
          currentRevision: cur.revision,
          freeSlots: freeSlots(placement.home_id, placement.layer),
        });
      }
      if (status === 'displayed') {
        const occupant = slotOccupied(placement.home_id, placement.layer, slotKey, placement.id);
        if (occupant) {
          throw errors.conflict('SLOT_OCCUPIED', '这个位置刚刚被占了，可以换一个', {
            slot: slotKey,
            freeSlots: freeSlots(placement.home_id, placement.layer),
          });
        }
      }
      db.prepare(
        `UPDATE placements SET slot_key = ?, status = ?, revision = revision + 1, updated_at = ? WHERE id = ?`
      ).run(slotKey, status, nowIso(), placement.id);
    });
    txn();
    audit(ctx.user.id, 'placement-update', 'placement', placement.id, 'ok');
    return { status: 200, data: { data: { slotKey, status } } };
  },

  // ---------- 房间（S01） ----------
  'GET /api/home/room': async (ctx) => {
    const home = currentHome(ctx.user);
    const pet = getPet(home.id);
    const placements = db
      .prepare(
        `SELECT p.* FROM placements p JOIN memory_objects o ON o.id = p.object_id
         WHERE p.home_id = ? AND p.status = 'displayed'
           AND (p.layer = 'home' OR (p.layer = 'private' AND p.owner_id = ?))
           AND EXISTS (SELECT 1 FROM memory_containers mc WHERE mc.id = o.memory_id AND mc.status = 'active')`
      )
      .all(home.id, ctx.user.id);
    const objects = placements.map((p) => {
      const obj = db.prepare('SELECT * FROM memory_objects WHERE id = ?').get(p.object_id);
      const container = getContainer(obj.memory_id);
      const card = cardFor(ctx.user, container, 'full');
      return {
        placementId: p.id,
        layer: p.layer,
        slotKey: p.slot_key,
        revision: p.revision,
        templateKey: obj.template_key,
        mine: obj.owner_id === ctx.user.id,
        memory: {
          id: container.id,
          title: card.title,
          eventDate: container.event_date,
          topic: container.topic,
          photoThumbId: card.photoThumbId,
          perspectives: card.perspectives,
          visibility: container.visibility,
        },
      };
    });
    const storedCount = db
      .prepare(
        `SELECT COUNT(*) AS n FROM placements p JOIN memory_objects o ON o.id = p.object_id
         WHERE p.home_id = ? AND p.status = 'stored'
           AND (p.layer = 'home' OR (p.layer = 'private' AND p.owner_id = ?))
           AND EXISTS (SELECT 1 FROM memory_containers mc WHERE mc.id = o.memory_id AND mc.status = 'active')`
      )
      .get(home.id, ctx.user.id).n;
    const slots = freeSlots(home.id, 'home').map((s) => s.key);
    return {
      status: 200,
      data: {
        data: {
          home: { id: home.id, status: home.status, isShared: home.status === 'shared' },
          pet: pet ? { id: pet.id, name: pet.name, appearanceKey: pet.appearance_key } : null,
          objects,
          storedCount,
          freeHomeSlots: slots,
          slotLabels: Object.fromEntries(ROOM_SLOTS.map((s) => [s.key, s.label])),
        },
      },
    };
  },

  // ---------- 收纳与查找（S11） ----------
  'GET /api/storage': async (ctx) => {
    const home = currentHome(ctx.user);
    const placements = db
      .prepare(
        `SELECT p.* FROM placements p JOIN memory_objects o ON o.id = p.object_id
         WHERE p.home_id = ? AND p.status = 'stored'
           AND (p.layer = 'home' OR (p.layer = 'private' AND p.owner_id = ?))
           AND EXISTS (SELECT 1 FROM memory_containers mc WHERE mc.id = o.memory_id AND mc.status = 'active')`
      )
      .all(home.id, ctx.user.id);
    const items = placements.map((p) => {
      const obj = db.prepare('SELECT * FROM memory_objects WHERE id = ?').get(p.object_id);
      const container = getContainer(obj.memory_id);
      const card = cardFor(ctx.user, container, 'full');
      return {
        placementId: p.id,
        revision: p.revision,
        layer: p.layer,
        templateKey: obj.template_key,
        mine: obj.owner_id === ctx.user.id,
        memory: { id: container.id, title: card.title, eventDate: container.event_date, topic: container.topic, photoThumbId: card.photoThumbId },
      };
    });
    return {
      status: 200,
      data: { data: { items, freeSlots: freeSlots(home.id, 'home').map((s) => s.key), slotLabels: Object.fromEntries(ROOM_SLOTS.map((s) => [s.key, s.label])) } },
    };
  },

  // ---------- 个人隐藏 / 回顾排除（计划书 4.5） ----------
  'PUT /api/me/memory-preferences/:id': async (ctx) => {
    const container = getContainer(ctx.params.id);
    if (!container) throw errors.notFound();
    const access = containerAccess(ctx.user, container);
    if (!access) throw errors.notFound();
    const body = ctx.json();
    db.prepare(
      `INSERT INTO member_memory_preferences (user_id, memory_id, hidden, exclude_from_recall) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, memory_id) DO UPDATE SET hidden = excluded.hidden, exclude_from_recall = excluded.exclude_from_recall`
    ).run(
      ctx.user.id,
      container.id,
      body.hidden === undefined ? 0 : body.hidden ? 1 : 0,
      body.excludeFromRecall === undefined ? 0 : body.excludeFromRecall ? 1 : 0
    );
    audit(ctx.user.id, 'memory-preference', 'memory', container.id, 'ok');
    return { status: 200, data: { data: { ok: true } } };
  },

  'GET /api/me/hidden-memories': async (ctx) => {
    const rows = db
      .prepare(
        `SELECT mc.* FROM member_memory_preferences mmp JOIN memory_containers mc ON mc.id = mmp.memory_id
         WHERE mmp.user_id = ? AND (mmp.hidden = 1 OR mmp.exclude_from_recall = 1)`
      )
      .all(ctx.user.id);
    const items = rows
      .filter((c) => containerAccess(ctx.user, c))
      .map((c) => ({
        ...cardFor(ctx.user, c, containerAccess(ctx.user, c)),
      }));
    return { status: 200, data: { data: { items } } };
  },

  // ---------- 回顾（旧物卡，计划书 4.4） ----------
  'GET /api/recall': async (ctx) => {
    const prefs = JSON.parse(ctx.user.preferences || '{}');
    if (prefs.recallEnabled === false || prefs.pauseRecall) {
      return { status: 200, data: { data: { disabled: true } } };
    }
    const home = currentHome(ctx.user);
    const candidates = [];
    const containers = db
      .prepare(`SELECT * FROM memory_containers WHERE home_id = ? AND status = 'active'`)
      .all(home.id);
    for (const c of containers) {
      if (containerAccess(ctx.user, c) !== 'full') continue;
      const p = memberPreference(ctx.user.id, c.id);
      if (p.hidden || p.exclude_from_recall) continue;
      const hasContent = db
        .prepare(`SELECT COUNT(*) AS n FROM contributions WHERE memory_id = ? AND deleted_at IS NULL`)
        .get(c.id).n;
      if (hasContent === 0) continue;
      const obj = db
        .prepare(
          `SELECT o.* FROM memory_objects o JOIN placements p ON p.object_id = o.id
           WHERE o.memory_id = ? AND p.status = 'displayed' AND p.home_id = ?
             AND (o.visibility = 'home' OR o.owner_id = ?)`
        )
        .get(c.id, home.id, ctx.user.id);
      if (obj) candidates.push(c);
    }
    if (candidates.length === 0) return { status: 200, data: { data: { item: null } } };
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    const card = cardFor(ctx.user, pick, 'full');
    return { status: 200, data: { data: { item: { ...card, daysAgo: Math.round((Date.parse(bizToday()) - Date.parse(pick.event_date)) / 86400000) } } } };
  },

  // ---------- 共同移除（计划书 4.5） ----------
  'POST /api/memories/:id/removal-requests': async (ctx) => {
    const { container, access } = requireContainer(ctx.user, ctx.params.id, { needFull: true });
    const home = getHome(container.home_id);
    if (home.status !== 'shared') {
      throw errors.conflict('NOT_SHARED', '单人的回忆可以直接删除自己的内容');
    }
    db.prepare(
      `UPDATE memory_containers SET removal_requested_by = ?, revision = revision + 1, updated_at = ? WHERE id = ?`
    ).run(ctx.user.id, nowIso(), container.id);
    const partner = partnerOf(container.home_id, ctx.user.id);
    if (partner) {
      notify(partner.id, {
        type: 'removal-request',
        title: '一个移除共同回忆的请求',
        body: '需要两个人都同意才会移除共同入口；各自的原始内容仍由本人管理。',
        sourceId: container.id,
        dedupeKey: `removal-request:${container.id}:${container.revision + 1}`,
      });
    }
    audit(ctx.user.id, 'removal-request', 'memory', container.id, 'ok');
    return { status: 200, data: { data: { ok: true } } };
  },

  'POST /api/memories/:id/approve-removal': async (ctx) => {
    const { container, access } = requireContainer(ctx.user, ctx.params.id, { needFull: true });
    if (!container.removal_requested_by) {
      throw errors.conflict('NO_PENDING_REQUEST', '目前没有待确认的移除请求');
    }
    if (container.removal_requested_by === ctx.user.id) {
      throw errors.forbidden('需要由另一个人来确认这个请求');
    }
    const expected = Number(ctx.json().expectedRevision);
    assert(Number.isInteger(expected), 'expectedRevision', '缺少版本号');
    if (expected !== container.revision) {
      throw errors.conflict('REVISION_CONFLICT', '内容已更新，请重新查看', { currentRevision: container.revision });
    }
    const now = nowIso();
    tx(() => {
      const cur = getContainer(container.id);
      if (cur.revision !== expected || !cur.removal_requested_by) {
        throw errors.conflict('REVISION_CONFLICT', '内容已更新，请重新查看');
      }
      db.prepare(`UPDATE memory_containers SET status = 'removed', updated_at = ? WHERE id = ?`).run(now, container.id);
      // 物件与摆放移除；个人贡献转私密档案
      const objs = db.prepare(`SELECT * FROM memory_objects WHERE memory_id = ?`).all(container.id);
      for (const o of objs) {
        db.prepare(`DELETE FROM placements WHERE object_id = ?`).run(o.id);
        db.prepare(`DELETE FROM memory_objects WHERE id = ?`).run(o.id);
      }
      db.prepare(`UPDATE contributions SET visibility = 'private' WHERE memory_id = ?`).run(container.id);
      invalidateGrantsByContainer(container.id);
    })();
    audit(ctx.user.id, 'removal-approve', 'memory', container.id, 'ok');
    return { status: 200, data: { data: { ok: true } } };
  },
};

function invalidateGrantsByContainer(containerId) {
  const grants = db.prepare(`SELECT * FROM consent_grants WHERE status = 'approved'`).all();
  for (const g of grants) {
    const versions = JSON.parse(g.resource_versions);
    const ids = new Set(versions.map((v) => v.contributionId));
    if (ids.size === 0) continue;
    const hit = db
      .prepare(`SELECT COUNT(*) AS n FROM contributions WHERE memory_id = ? AND id IN (${[...ids].map(() => '?').join(',')})`)
      .get(containerId, ...ids).n;
    if (hit > 0) {
      db.prepare(`UPDATE consent_grants SET status = 'invalidated', revision = revision + 1 WHERE id = ?`).run(g.id);
      db.prepare(
        `UPDATE work_jobs SET status = 'cancelled', fail_reason = '回忆已共同移除' WHERE grant_id = ? AND status IN ('queued','running','ready')`
      ).run(g.id);
    }
  }
}

function getCurrentText(contributionId, version) {
  return db
    .prepare('SELECT text FROM contribution_versions WHERE contribution_id = ? AND version = ?')
    .get(contributionId, version).text;
}

function rmSyncMedia(m) {
  try {
    rmSync(`${config.mediaRoot}/${m.storage_key}`, { force: true });
  } catch {
    // 文件清理失败不影响状态标记
  }
}

function slotLabel(key) {
  const s = ROOM_SLOTS.find((x) => x.key === key);
  return s ? s.label : key;
}
