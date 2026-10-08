// 慢记 Manji v3.1 —— 轻承诺、纪念日、版本授权、纪念作品、导出、外观
import { rmSync } from 'node:fs';
import path from 'node:path';
import { db } from '../db.js';
import { config } from '../config.js';
import {
  nowIso, newId, sha256, bizToday, isValidDate, errors, audit, trimTo, assert, daysBetween, nextOccurrence,
} from '../core.js';
import {
  getUser, getHome, getContainer, getContribution, membershipOf, partnerOf, currentHome,
  canReadContribution, notify, grantVersionsStillValid, grantCoversVersions, cancelJobsForGrant,
} from '../domain/permissions.js';
import { buildZip } from '../domain/zip.js';
import { anchorsForRecord } from '../domain/chain.js';
import { readMediaFile } from './media.js';

const WORK_TEMPLATES = ['polaroid', 'stamp', 'gallery'];

function homeState(homeId) {
  return getHome(homeId);
}

// ============ 承诺（S06） ============
export const routes = {
  'GET /api/promises': async (ctx) => {
    const home = currentHome(ctx.user);
    const rows = db
      .prepare(`SELECT * FROM promises WHERE home_id = ? ORDER BY created_at DESC`)
      .all(home.id);
    const items = rows
      .filter((p) => (p.scope === 'shared' ? true : p.author_id === ctx.user.id))
      .map((p) => promisePayload(p, ctx.user));
    return { status: 200, data: { data: { items } } };
  },

  'POST /api/promises': async (ctx) => {
    const home = currentHome(ctx.user);
    const body = ctx.json();
    const text = trimTo(body.text, 60);
    assert(text, 'text', '写下一句小小的约定（1–60 字）');
    const note = body.note ? trimTo(body.note, 120) : null;
    const dueDate = body.dueDate || null;
    if (dueDate) assert(isValidDate(dueDate), 'dueDate', '日期格式无效');
    const scope = body.scope === 'shared' ? 'shared' : 'personal';
    if (scope === 'shared' && home.status !== 'shared') {
      throw errors.invalid({ scope: '共同承诺需要先邀请另一个人回家' }, '共同承诺需要两位成员');
    }
    // v3.5（B06）：慢网双击/重放防重——同一人在同一家 10 秒内提交完全相同的新约定，直接返回已建的那条。
    // node:sqlite 同步执行，两次请求在进程内天然串行，此判断没有并发窗口。
    const dupWindowStart = new Date(Date.now() - 10_000).toISOString();
    const dup = db
      .prepare(
        `SELECT id FROM promises WHERE home_id = ? AND author_id = ? AND text = ? AND scope = ? AND created_at >= ?
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(home.id, ctx.user.id, text, scope, dupWindowStart);
    if (dup) {
      audit(ctx.user.id, 'promise-create-dedupe', 'promise', dup.id, 'ok');
      return { status: 201, data: { data: { promiseId: dup.id, deduplicated: true } } };
    }
    const id = newId('prm');
    const now = nowIso();
    db.prepare(
      `INSERT INTO promises (id, home_id, author_id, text, note, due_date, scope, status, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    ).run(id, home.id, ctx.user.id, text, note, dueDate, scope, scope === 'personal' ? 'active' : 'proposed', now, now);
    if (scope === 'personal') {
      db.prepare(`INSERT OR REPLACE INTO promise_confirmations (promise_id, user_id, confirmed_revision, created_at) VALUES (?, ?, 1, ?)`)
        .run(id, ctx.user.id, now);
    }
    audit(ctx.user.id, 'promise-create', 'promise', id, 'ok');
    return { status: 201, data: { data: { promiseId: id } } };
  },

  'PATCH /api/promises/:id': async (ctx) => {
    const p = db.prepare('SELECT * FROM promises WHERE id = ?').get(ctx.params.id);
    if (!p) throw errors.notFound();
    requirePromiseAccess(ctx.user, p);
    if (p.author_id !== ctx.user.id) throw errors.forbidden('只有提出的人可以修改文字');
    const body = ctx.json();
    const expected = Number(body.expectedRevision);
    assert(Number.isInteger(expected), 'expectedRevision', '缺少版本号');
    if (expected !== p.revision) {
      throw errors.conflict('REVISION_CONFLICT', '这个承诺刚被更新过，请重新查看', { currentRevision: p.revision });
    }
    const text = body.text !== undefined ? trimTo(body.text, 60) : p.text;
    assert(text, 'text', '写下一句小小的约定');
    const note = body.note !== undefined ? (body.note ? trimTo(body.note, 120) : null) : p.note;
    const dueDate = body.dueDate !== undefined ? body.dueDate : p.due_date;
    if (dueDate) assert(isValidDate(dueDate), 'dueDate', '日期格式无效');
    const importantChanged = text !== p.text || dueDate !== p.due_date;
    const now = nowIso();
    db.prepare(
      `UPDATE promises SET text = ?, note = ?, due_date = ?, revision = revision + 1,
       needs_reconfirm = CASE WHEN ? THEN 1 ELSE needs_reconfirm END, updated_at = ? WHERE id = ?`
    ).run(text, note, dueDate, p.scope === 'shared' && importantChanged ? 1 : 0, now, p.id);
    if (p.scope === 'shared' && importantChanged) {
      // 重要修改：需要对方重新确认（计划书 4.6 / M25）
      db.prepare(`DELETE FROM promise_confirmations WHERE promise_id = ?`).run(p.id);
      const partner = partnerOf(p.home_id, ctx.user.id);
      if (partner) {
        notify(partner.id, {
          type: 'promise-reconfirm',
          title: '一个说好的承诺改了内容',
          body: '改过之后的约定，需要你重新点一次"我也愿意"。',
          sourceId: p.id,
          dedupeKey: `promise-reconfirm:${p.id}:${p.revision + 1}`,
        });
      }
    }
    audit(ctx.user.id, 'promise-update', 'promise', p.id, 'ok');
    return { status: 200, data: { data: { revision: p.revision + 1, needsReconfirm: p.scope === 'shared' && importantChanged } } };
  },

  'POST /api/promises/:id/accept': async (ctx) => {
    const p = db.prepare('SELECT * FROM promises WHERE id = ?').get(ctx.params.id);
    if (!p) throw errors.notFound();
    requirePromiseAccess(ctx.user, p);
    if (p.scope !== 'shared') throw errors.conflict('NOT_SHARED', '个人承诺不需要对方确认');
    if (p.author_id === ctx.user.id) throw errors.forbidden('自己提出的约定由对方确认');
    if (p.status !== 'proposed' && !(p.status === 'active' && p.needs_reconfirm)) {
      throw errors.conflict('PROMISE_STATE', '这条约定现在不在待确认状态');
    }
    const now = nowIso();
    db.prepare(`UPDATE promises SET status = 'active', needs_reconfirm = 0, revision = revision + 1, updated_at = ? WHERE id = ?`).run(now, p.id);
    db.prepare(`INSERT OR REPLACE INTO promise_confirmations (promise_id, user_id, confirmed_revision, created_at) VALUES (?, ?, ?, ?)`)
      .run(p.id, ctx.user.id, p.revision + 1, now);
    notify(p.author_id, {
      type: 'promise-accepted',
      title: `${ctx.user.display_name} 也愿意`,
      body: '你们有了一个新的小约定。',
      sourceId: p.id,
      dedupeKey: `promise-accepted:${p.id}:${p.revision + 1}`,
    });
    audit(ctx.user.id, 'promise-accept', 'promise', p.id, 'ok');
    return { status: 200, data: { data: { status: 'active' } } };
  },

  'POST /api/promises/:id/complete': async (ctx) => {
    const p = db.prepare('SELECT * FROM promises WHERE id = ?').get(ctx.params.id);
    if (!p) throw errors.notFound();
    requirePromiseAccess(ctx.user, p);
    if (p.status === 'proposed') throw errors.conflict('PROMISE_STATE', '对方还没有确认这条约定');
    if (p.status === 'completed') throw errors.conflict('PROMISE_STATE', '已经记下完成了');
    const now = nowIso();
    db.prepare(
      `UPDATE promises SET status = 'completed', completed_by = ?, completed_at = ?, undo_note = NULL, revision = revision + 1, updated_at = ? WHERE id = ?`
    ).run(ctx.user.id, now, now, p.id);
    const partner = p.scope === 'shared' ? partnerOf(p.home_id, ctx.user.id) : null;
    if (partner) {
      notify(partner.id, {
        type: 'promise-completed',
        title: `${ctx.user.display_name} 完成了一个承诺`,
        body: '只是记下这件事完成了，没有任何评分。',
        sourceId: p.id,
        dedupeKey: `promise-completed:${p.id}:${p.revision + 1}`,
      });
    }
    audit(ctx.user.id, 'promise-complete', 'promise', p.id, 'ok');
    return { status: 200, data: { data: { status: 'completed', completedBy: ctx.user.display_name } } };
  },

  'POST /api/promises/:id/reopen': async (ctx) => {
    const p = db.prepare('SELECT * FROM promises WHERE id = ?').get(ctx.params.id);
    if (!p) throw errors.notFound();
    requirePromiseAccess(ctx.user, p);
    if (p.status !== 'completed') throw errors.conflict('PROMISE_STATE', '这条约定还没有被记为完成');
    const note = ctx.json().note ? trimTo(ctx.json().note, 120) : null;
    db.prepare(
      `UPDATE promises SET status = 'active', completed_by = NULL, completed_at = NULL, undo_note = ?, revision = revision + 1, updated_at = ? WHERE id = ?`
    ).run(note, nowIso(), p.id);
    audit(ctx.user.id, 'promise-reopen', 'promise', p.id, 'ok');
    return { status: 200, data: { data: { status: 'active' } } };
  },

  'POST /api/promises/:id/pause': async (ctx) => {
    const p = db.prepare('SELECT * FROM promises WHERE id = ?').get(ctx.params.id);
    if (!p) throw errors.notFound();
    requirePromiseAccess(ctx.user, p);
    if (p.status !== 'active' && p.status !== 'proposed') throw errors.conflict('PROMISE_STATE', '当前状态不能推迟');
    db.prepare(`UPDATE promises SET status = 'paused', revision = revision + 1, updated_at = ? WHERE id = ?`).run(nowIso(), p.id);
    audit(ctx.user.id, 'promise-pause', 'promise', p.id, 'ok');
    return { status: 200, data: { data: { status: 'paused' } } };
  },

  'POST /api/promises/:id/resume': async (ctx) => {
    const p = db.prepare('SELECT * FROM promises WHERE id = ?').get(ctx.params.id);
    if (!p) throw errors.notFound();
    requirePromiseAccess(ctx.user, p);
    if (p.status !== 'paused') throw errors.conflict('PROMISE_STATE', '这条约定没有在推迟中');
    const back = p.scope === 'shared' && !hasConfirmed(p, otherMember(p, ctx.user)?.id) ? 'proposed' : 'active';
    db.prepare(`UPDATE promises SET status = ?, revision = revision + 1, updated_at = ? WHERE id = ?`).run(back, nowIso(), p.id);
    return { status: 200, data: { data: { status: back } } };
  },

  'POST /api/promises/:id/archive': async (ctx) => {
    const p = db.prepare('SELECT * FROM promises WHERE id = ?').get(ctx.params.id);
    if (!p) throw errors.notFound();
    requirePromiseAccess(ctx.user, p);
    if (p.author_id !== ctx.user.id) throw errors.forbidden('由提出的人收起');
    db.prepare(`UPDATE promises SET status = 'archived', revision = revision + 1, updated_at = ? WHERE id = ?`).run(nowIso(), p.id);
    return { status: 200, data: { data: { status: 'archived' } } };
  },

  'DELETE /api/promises/:id': async (ctx) => {
    const p = db.prepare('SELECT * FROM promises WHERE id = ?').get(ctx.params.id);
    if (!p) throw errors.notFound();
    requirePromiseAccess(ctx.user, p);
    if (p.author_id !== ctx.user.id) throw errors.forbidden('只有提出的人可以删除');
    db.prepare('DELETE FROM promise_confirmations WHERE promise_id = ?').run(p.id);
    db.prepare('DELETE FROM promises WHERE id = ?').run(p.id);
    audit(ctx.user.id, 'promise-delete', 'promise', p.id, 'ok');
    return { status: 200, data: { data: { ok: true } } };
  },

  // ============ 纪念日（S07） ============
  'GET /api/anniversaries': async (ctx) => {
    const today = bizToday();
    const home = currentHome(ctx.user);
    // v3.5（B03）：范围选"两个人都看到"的纪念日，另一位成员也要能看到——
    // 读取 = 本人全部记录 + 当前有效共同家里由对方创建的 shared 记录（解除/离开后自然不再出现）。
    const rows = db
      .prepare(
        `SELECT * FROM anniversaries WHERE owner_id = ? OR (home_id = ? AND scope = 'shared') ORDER BY date ASC`
      )
      .all(ctx.user.id, home.id);
    const items = rows
      .filter((a) => {
        if (!a.home_id || a.scope !== 'shared') return true;
        const h = getHome(a.home_id);
        if (!h || h.status === 'frozen') return a.owner_id === ctx.user.id; // 解除后仅保留在创建者本人的档案里
        const ms = membershipOf(h.id, ctx.user.id);
        return !!(ms && ms.status === 'active');
      })
      .map((a) => anniversaryPayload(a, today, ctx.user))
      .sort((x, y) => (x.nextDate || '9999').localeCompare(y.nextDate || '9999'));
    return { status: 200, data: { data: { items, today } } };
  },

  'POST /api/anniversaries': async (ctx) => {
    const body = ctx.json();
    const title = trimTo(body.title, 24);
    assert(title, 'title', '给纪念日起个名字（1–24 字）');
    assert(isValidDate(body.date), 'date', '日期格式无效');
    const repeat = body.repeat === 'yearly' ? 'yearly' : 'once';
    const reminderDays = [0, 1, 3, 7].includes(Number(body.reminderDays)) ? Number(body.reminderDays) : 0;
    const scope = body.scope === 'shared' ? 'shared' : 'personal';
    const home = currentHome(ctx.user);
    if (scope === 'shared' && home.status !== 'shared') {
      throw errors.invalid({ scope: '共同纪念日需要两位成员' }, '共同纪念日需要两位成员');
    }
    const note = body.note ? trimTo(body.note, 120) : null;
    const id = newId('ann');
    const now = nowIso();
    db.prepare(
      `INSERT INTO anniversaries (id, owner_id, home_id, title, date, repeat, reminder_days, scope, note, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    ).run(id, ctx.user.id, scope === 'shared' ? home.id : null, title, body.date, repeat, reminderDays, scope, note, now, now);
    audit(ctx.user.id, 'anniversary-create', 'anniversary', id, 'ok');
    return { status: 201, data: { data: { anniversaryId: id } } };
  },

  'PATCH /api/anniversaries/:id': async (ctx) => {
    const a = db.prepare('SELECT * FROM anniversaries WHERE id = ?').get(ctx.params.id);
    if (!a || a.owner_id !== ctx.user.id) throw errors.notFound();
    const body = ctx.json();
    const expected = Number(body.expectedRevision);
    assert(Number.isInteger(expected), 'expectedRevision', '缺少版本号');
    if (expected !== a.revision) {
      throw errors.conflict('REVISION_CONFLICT', '这条纪念日刚被更新过，请重新查看', { currentRevision: a.revision });
    }
    const title = body.title !== undefined ? trimTo(body.title, 24) : a.title;
    assert(title, 'title', '给纪念日起个名字');
    const date = body.date !== undefined ? body.date : a.date;
    assert(isValidDate(date), 'date', '日期格式无效');
    const repeat = body.repeat !== undefined ? (body.repeat === 'yearly' ? 'yearly' : 'once') : a.repeat;
    const reminderDays =
      body.reminderDays !== undefined
        ? [0, 1, 3, 7].includes(Number(body.reminderDays)) ? Number(body.reminderDays) : 0
        : a.reminder_days;
    const note = body.note !== undefined ? (body.note ? trimTo(body.note, 120) : null) : a.note;
    db.prepare(
      `UPDATE anniversaries SET title = ?, date = ?, repeat = ?, reminder_days = ?, note = ?, revision = revision + 1, updated_at = ? WHERE id = ?`
    ).run(title, date, repeat, reminderDays, note, nowIso(), a.id);
    // 修改后取消旧待发提醒（计划书 4.7 / M29）
    cancelAnniversaryReminders(a.id);
    audit(ctx.user.id, 'anniversary-update', 'anniversary', a.id, 'ok');
    return { status: 200, data: { data: { revision: a.revision + 1 } } };
  },

  'DELETE /api/anniversaries/:id': async (ctx) => {
    const a = db.prepare('SELECT * FROM anniversaries WHERE id = ?').get(ctx.params.id);
    if (!a || a.owner_id !== ctx.user.id) throw errors.notFound();
    cancelAnniversaryReminders(a.id);
    db.prepare('DELETE FROM anniversaries WHERE id = ?').run(a.id);
    audit(ctx.user.id, 'anniversary-delete', 'anniversary', a.id, 'ok');
    return { status: 200, data: { data: { ok: true } } };
  },

  // ============ 版本授权（计划书 5.2 / 6.2） ============
  'GET /api/consents': async (ctx) => {
    const rows = db
      .prepare(
        `SELECT * FROM consent_grants WHERE requester_id = ? OR approver_id = ? ORDER BY created_at DESC LIMIT 50`
      )
      .all(ctx.user.id, ctx.user.id);
    const items = rows.map((g) => ({
      id: g.id,
      purpose: g.purpose,
      audience: g.audience,
      status: g.status,
      revision: g.revision,
      requesterName: getUser(g.requester_id)?.display_name,
      approverName: getUser(g.approver_id)?.display_name,
      iAmRequester: g.requester_id === ctx.user.id,
      iAmApprover: g.approver_id === ctx.user.id,
      resourceVersions: JSON.parse(g.resource_versions),
      createdAt: g.created_at,
    }));
    return { status: 200, data: { data: { items } } };
  },

  'POST /api/consents': async (ctx) => {
    const home = currentHome(ctx.user);
    const partner = partnerOf(home.id, ctx.user.id);
    if (!partner) throw errors.invalid(undefined, '需要先有另一位成员，才能请求对方内容的授权');
    const body = ctx.json();
    const purpose = body.purpose === 'export' ? 'export' : 'work';
    const versions = body.resourceVersions;
    assert(Array.isArray(versions) && versions.length > 0, 'resourceVersions', '选择至少一个具体版本');
    for (const rv of versions) {
      const c = getContribution(rv.contributionId);
      if (!c || c.deleted_at) throw errors.invalid({ resourceVersions: '内容已不可用' }, '内容已不可用');
      if (c.author_id !== partner.id) {
        throw errors.invalid({ resourceVersions: '只能请求另一位成员的内容授权' }, '只能请求另一位成员的内容授权');
      }
      if (c.current_version !== Number(rv.version)) {
        throw errors.invalid({ resourceVersions: '内容已更新，请重新选择版本' }, '内容已更新，请重新选择版本');
      }
      if (c.visibility !== 'home') {
        throw errors.invalid({ resourceVersions: '对方尚未共享这段内容' }, '对方尚未共享这段内容');
      }
    }
    const id = newId('cgt');
    db.prepare(
      `INSERT INTO consent_grants (id, requester_id, approver_id, resource_versions, purpose, audience, status, revision, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 1, ?)`
    ).run(id, ctx.user.id, partner.id, JSON.stringify(versions), purpose, body.audience || 'partner-download', nowIso());
    notify(partner.id, {
      type: 'consent-request',
      title: `一份${purpose === 'work' ? '作品' : '导出'}授权请求`,
      body: `${ctx.user.display_name} 想在${purpose === 'work' ? '一份电子作品' : '一次打包导出'}里使用你选定的内容版本。`,
      sourceId: id,
      dedupeKey: `consent-request:${id}`,
    });
    audit(ctx.user.id, 'consent-create', 'consent', id, 'ok');
    return { status: 201, data: { data: { consentId: id } } };
  },

  'POST /api/consents/:id/respond': async (ctx) => {
    const g = db.prepare('SELECT * FROM consent_grants WHERE id = ?').get(ctx.params.id);
    if (!g) throw errors.notFound();
    if (g.approver_id !== ctx.user.id) throw errors.forbidden('这份请求需要由内容作者本人回应');
    const body = ctx.json();
    const expected = Number(body.expectedRevision);
    assert(Number.isInteger(expected), 'expectedRevision', '缺少版本号');
    if (expected !== g.revision) {
      throw errors.conflict('REVISION_CONFLICT', '这份请求刚被处理过，请刷新', { currentRevision: g.revision });
    }
    if (g.status !== 'pending') throw errors.conflict('CONSENT_STATE', '这份请求已经处理过了');
    if (body.decision === 'approve') {
      if (!grantVersionsStillValid(g)) {
        db.prepare(`UPDATE consent_grants SET status = 'invalidated', revision = revision + 1 WHERE id = ?`).run(g.id);
        throw errors.conflict('CONSENT_INVALID', '涉及的内容刚刚发生了变化，这份授权不能再批准');
      }
      db.prepare(`UPDATE consent_grants SET status = 'approved', responded_at = ?, revision = revision + 1 WHERE id = ?`).run(nowIso(), g.id);
      notify(g.requester_id, {
        type: 'consent-approved',
        title: '对方同意了你的授权请求',
        body: '可以继续制作那份作品了。这份授权只覆盖你选定的版本和用途。',
        sourceId: g.id,
        dedupeKey: `consent-approved:${g.id}`,
      });
    } else if (body.decision === 'reject') {
      db.prepare(`UPDATE consent_grants SET status = 'rejected', responded_at = ?, revision = revision + 1 WHERE id = ?`).run(nowIso(), g.id);
      notify(g.requester_id, {
        type: 'consent-rejected',
        title: '对方暂时没有同意授权',
        body: '你仍然可以只用本人的内容继续制作。',
        sourceId: g.id,
        dedupeKey: `consent-rejected:${g.id}`,
      });
    } else {
      throw errors.invalid({ decision: '决定无效' }, '决定无效');
    }
    audit(ctx.user.id, `consent-${body.decision}`, 'consent', g.id, 'ok');
    return { status: 200, data: { data: { status: body.decision === 'approve' ? 'approved' : 'rejected' } } };
  },

  'POST /api/consents/:id/revoke': async (ctx) => {
    const g = db.prepare('SELECT * FROM consent_grants WHERE id = ?').get(ctx.params.id);
    if (!g) throw errors.notFound();
    if (g.approver_id !== ctx.user.id) throw errors.forbidden('只有授权人可以撤回');
    if (g.status !== 'approved') throw errors.conflict('CONSENT_STATE', '只有已同意的授权可以撤回');
    db.prepare(`UPDATE consent_grants SET status = 'revoked', revision = revision + 1 WHERE id = ?`).run(g.id);
    cancelJobsForGrant(g.id, '授权已被撤回', nowIso());
    audit(ctx.user.id, 'consent-revoke', 'consent', g.id, 'ok');
    return { status: 200, data: { data: { ok: true } } };
  },

  // 授权内容预览：批准前可逐项核对申请时锁定的具体版本（B10，计划书 5.2）
  'GET /api/consents/:id/preview': async (ctx) => {
    const g = db.prepare('SELECT * FROM consent_grants WHERE id = ?').get(ctx.params.id);
    if (!g) throw errors.notFound();
    if (g.approver_id !== ctx.user.id && g.requester_id !== ctx.user.id) {
      throw errors.forbidden('只有授权双方可以查看这份授权的内容预览');
    }
    const versions = JSON.parse(g.resource_versions);
    const items = versions.map((rv) => {
      const c = getContribution(rv.contributionId);
      if (!c || c.deleted_at) {
        return { contributionId: rv.contributionId, version: rv.version, unavailable: true, text: '', photoIds: [], isCurrent: false };
      }
      const ver = db
        .prepare('SELECT text FROM contribution_versions WHERE contribution_id = ? AND version = ?')
        .get(c.id, rv.version);
      const photos = db
        .prepare(
          `SELECT id FROM media_assets WHERE contribution_id = ? AND contribution_version <= ? AND purpose = 'memory' AND status = 'bound' ORDER BY created_at ASC`
        )
        .all(c.id, rv.version)
        .map((m) => m.id);
      const container = getContainer(c.memory_id);
      return {
        contributionId: c.id,
        version: rv.version,
        isCurrent: c.current_version === Number(rv.version) && c.visibility === 'home',
        text: ver ? ver.text : '',
        photoIds: photos,
        eventDate: container ? container.event_date : null,
      };
    });
    return {
      status: 200,
      data: {
        data: {
          id: g.id,
          purpose: g.purpose,
          status: g.status,
          requesterName: getUser(g.requester_id)?.display_name,
          items,
        },
      },
    };
  },

  // ============ 纪念作品（S08） ============
  'GET /api/works': async (ctx) => {
    const rows = db.prepare(`SELECT * FROM work_jobs WHERE owner_id = ? ORDER BY created_at DESC LIMIT 30`).all(ctx.user.id);
    return {
      status: 200,
      data: {
        data: {
          items: rows.map((w) => ({
            id: w.id,
            templateKey: w.template_key,
            caption: w.caption,
            status: w.status,
            failReason: w.fail_reason,
            includesPartner: !!w.includes_partner,
            versionSet: JSON.parse(w.version_set),
            artifactMediaId: w.artifact_media_id || null,
            createdAt: w.created_at,
          })),
          templates: WORK_TEMPLATES,
          subsidyAvailable: false, // 补贴未接入：诚实展示（M45）
        },
      },
    };
  },

  'POST /api/works': async (ctx) => {
    const body = ctx.json();
    assert(WORK_TEMPLATES.includes(body.templateKey), 'templateKey', '作品模板无效');
    const items = body.items;
    assert(Array.isArray(items) && items.length > 0, 'items', '选择至少一段内容');
    const home = currentHome(ctx.user);
    let includesPartner = false;
    const versionSet = [];
    for (const it of items) {
      const c = getContribution(it.contributionId);
      if (!c || c.deleted_at || !canReadContribution(ctx.user, c)) {
        throw errors.invalid({ items: '有内容现在不可用' }, '有内容现在不可用');
      }
      if (Number(it.version) !== c.current_version) {
        throw errors.invalid({ items: '内容已更新，请重新选择' }, '内容已更新，请重新选择');
      }
      if (c.author_id !== ctx.user.id) includesPartner = true;
      versionSet.push({ contributionId: c.id, version: c.current_version });
    }
    let grantId = null;
    const partnerVersionSet = [];
    if (includesPartner) {
      const g = body.grantId ? db.prepare('SELECT * FROM consent_grants WHERE id = ?').get(body.grantId) : null;
      // 授权只需覆盖"对方的内容"；本人内容不需要授权
      for (const it of items) {
        const c = getContribution(it.contributionId);
        if (c && c.author_id !== ctx.user.id) partnerVersionSet.push({ contributionId: c.id, version: c.current_version });
      }
      if (!g || g.requester_id !== ctx.user.id || g.status !== 'approved' || !grantCoversVersions(g, partnerVersionSet)) {
        throw errors.invalid(undefined, '包含对方内容的作品需要先获得对方的版本授权（M32）');
      }
      if (!grantVersionsStillValid(g)) {
        db.prepare(`UPDATE consent_grants SET status = 'invalidated', revision = revision + 1 WHERE id = ?`).run(g.id);
        throw errors.conflict('CONSENT_INVALID', '对方内容已更新，原授权失效，请重新请求');
      }
      grantId = g.id;
    }
    const id = newId('wrk');
    const now = nowIso();
    db.prepare(
      `INSERT INTO work_jobs (id, owner_id, home_id, template_key, version_set, includes_partner, grant_id, caption, status, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 1, ?, ?)`
    ).run(id, ctx.user.id, home.id, body.templateKey, JSON.stringify(versionSet), includesPartner ? 1 : 0, grantId,
      body.caption ? trimTo(body.caption, 60) : null, now, now);
    audit(ctx.user.id, 'work-create', 'work', id, 'ok');
    return { status: 201, data: { data: { workId: id, status: 'queued' } } };
  },

  'POST /api/works/:id/start': async (ctx) => {
    const w = requireWork(ctx.user, ctx.params.id);
    if (w.status === 'queued') {
      db.prepare(`UPDATE work_jobs SET status = 'running', updated_at = ? WHERE id = ?`).run(nowIso(), w.id);
    }
    return { status: 200, data: { data: { status: 'running' } } };
  },

  'POST /api/works/:id/complete': async (ctx) => {
    const w = requireWork(ctx.user, ctx.params.id);
    if (w.status !== 'running' && w.status !== 'queued') {
      throw errors.conflict('WORK_STATE', '这个任务不在进行中');
    }
    const media = db.prepare('SELECT * FROM media_assets WHERE id = ?').get(ctx.json().artifactUploadId);
    if (!media || media.owner_id !== ctx.user.id || media.purpose !== 'work-artifact' || media.status !== 'bound') {
      throw errors.invalid({ artifactUploadId: '作品文件无效' }, '作品文件无效');
    }
    // 完成时第二次验权（M35）
    if (w.includes_partner) {
      const g = db.prepare('SELECT * FROM consent_grants WHERE id = ?').get(w.grant_id);
      if (!g || g.status !== 'approved' || !grantVersionsStillValid(g)) {
        db.prepare(`UPDATE work_jobs SET status = 'cancelled', fail_reason = '授权已失效', updated_at = ? WHERE id = ?`).run(nowIso(), w.id);
        throw errors.forbidden('相关授权已失效，这份作品不能完成');
      }
    }
    db.prepare(
      `UPDATE work_jobs SET status = 'ready', artifact_media_id = ?, updated_at = ?, revision = revision + 1 WHERE id = ?`
    ).run(media.id, nowIso(), w.id);
    db.prepare(`UPDATE media_assets SET work_id = ? WHERE id = ?`).run(w.id, media.id);
    audit(ctx.user.id, 'work-complete', 'work', w.id, 'ok');
    return { status: 200, data: { data: { status: 'ready' } } };
  },

  'POST /api/works/:id/fail': async (ctx) => {
    const w = requireWork(ctx.user, ctx.params.id);
    if (w.status !== 'running' && w.status !== 'queued') throw errors.conflict('WORK_STATE', '任务状态不允许标记失败');
    db.prepare(`UPDATE work_jobs SET status = 'failed', fail_reason = ?, updated_at = ? WHERE id = ?`).run(
      trimTo(ctx.json().reason, 80) || '生成失败', nowIso(), w.id
    );
    return { status: 200, data: { data: { status: 'failed' } } };
  },

  'POST /api/works/:id/cancel': async (ctx) => {
    const w = requireWork(ctx.user, ctx.params.id);
    const now = nowIso();
    if (w.status === 'ready') {
      // 删除已完成作品：撤下任务与文件，下载/媒体读取随状态一并关闭（B09）
      const media = w.artifact_media_id
        ? db.prepare('SELECT * FROM media_assets WHERE id = ?').get(w.artifact_media_id)
        : null;
      db.prepare(
        `UPDATE work_jobs SET status = 'cancelled', artifact_media_id = NULL, fail_reason = '作品已删除', updated_at = ?, revision = revision + 1 WHERE id = ?`
      ).run(now, w.id);
      if (media) {
        db.prepare(`UPDATE media_assets SET status = 'deleted' WHERE id = ?`).run(media.id);
        try {
          rmSync(path.join(config.mediaRoot, media.storage_key), { force: true });
        } catch {
          // 文件清理失败不影响状态标记
        }
      }
      audit(ctx.user.id, 'work-delete', 'work', w.id, 'ok');
      return { status: 200, data: { data: { ok: true, status: 'deleted' } } };
    }
    if (w.status === 'queued' || w.status === 'running' || w.status === 'failed') {
      db.prepare(`UPDATE work_jobs SET status = 'cancelled', updated_at = ? WHERE id = ?`).run(now, w.id);
    }
    return { status: 200, data: { data: { ok: true, status: 'cancelled' } } };
  },

  'GET /api/works/:id/download': async (ctx) => {
    const w = requireWork(ctx.user, ctx.params.id);
    // 下载时第三次验权（计划书 5.2 / M35 / M37）
    if (w.status !== 'ready' || !w.artifact_media_id) throw errors.notFound('作品还没有生成完成');
    if (w.includes_partner) {
      const g = db.prepare('SELECT * FROM consent_grants WHERE id = ?').get(w.grant_id);
      if (!g || g.status !== 'approved' || !grantVersionsStillValid(g)) {
        throw errors.forbidden('这份作品包含的对方内容授权已失效，不能再下载；已经下载到本地的文件系统无法收回');
      }
      const home = getHome(w.home_id);
      if (!home || home.status === 'frozen') {
        throw errors.forbidden('空间已解除关联，包含对方内容的作品已停止下载');
      }
    }
    const media = db.prepare('SELECT * FROM media_assets WHERE id = ?').get(w.artifact_media_id);
    if (!media) throw errors.notFound();
    const buf = readMediaFile(media.storage_key);
    if (!buf) throw errors.notFound('这份作品文件已不可用');
    audit(ctx.user.id, 'work-download', 'work', w.id, 'ok');
    return { status: 200, rawFile: { buf, mime: 'image/png', filename: `manji-postcard-${w.id}.png` } };
  },

  // ============ 外观权益（计划书 5.1） ============
  'GET /api/me/appearances': async (ctx) => {
    const rows = db.prepare(`SELECT * FROM appearance_grants WHERE user_id = ? ORDER BY created_at DESC`).all(ctx.user.id);
    return {
      status: 200,
      data: {
        data: {
          items: rows.map((r) => ({
            id: r.id,
            appearanceKey: r.appearance_key,
            reason: r.reason,
            createdAt: r.created_at,
          })),
        },
      },
    };
  },

  // ============ 导出（计划书 6.2） ============
  'POST /api/exports': async (ctx) => {
    const scope = ctx.json().scope === 'granted' ? 'granted' : 'self';
    const home = currentHome(ctx.user);
    let grantId = null;
    let versionSet = [];
    if (scope === 'granted') {
      const g = ctx.json().grantId ? db.prepare('SELECT * FROM consent_grants WHERE id = ?').get(ctx.json().grantId) : null;
      if (!g || g.requester_id !== ctx.user.id || g.status !== 'approved' || g.purpose !== 'export') {
        throw errors.invalid(undefined, '导出对方内容需要有效的导出授权');
      }
      if (!grantVersionsStillValid(g)) {
        db.prepare(`UPDATE consent_grants SET status = 'invalidated', revision = revision + 1 WHERE id = ?`).run(g.id);
        throw errors.conflict('CONSENT_INVALID', '对方内容已更新，原授权失效');
      }
      grantId = g.id;
      versionSet = JSON.parse(g.resource_versions);
    }
    const entries = [];
    const manifest = [];
    const md = [];
    const homes = db
      .prepare(`SELECT h.* FROM memberships m JOIN homes h ON h.id = m.home_id WHERE m.user_id = ?`)
      .all(ctx.user.id);
    for (const h of homes) {
      // 共同移除的容器也纳入本人导出：个人原始贡献不受共同入口移除影响（B07）
      const containers = db.prepare(`SELECT * FROM memory_containers WHERE home_id = ?`).all(h.id);
      for (const c of containers) {
        if (c.status === 'removed' && scope !== 'self') continue; // granted 范围的授权在移除时已失效
        const myContribution = db
          .prepare(`SELECT * FROM contributions WHERE memory_id = ? AND author_id = ? AND deleted_at IS NULL`)
          .get(c.id, ctx.user.id);
        let partnerContribution = null;
        if (scope === 'granted') {
          const wanted = versionSet.map((v) => v.contributionId);
          for (const vid of wanted) {
            const pc = getContribution(vid);
            if (pc && pc.memory_id === c.id && versionSet.some((v) => v.contributionId === pc.id && v.version === pc.current_version)) {
              partnerContribution = pc;
            }
          }
        }
        if (!myContribution && !partnerContribution) continue;
        const block = [`## ${c.title || c.safe_title}`, `- 日期：${c.event_date}`, `- 主题：${c.topic || '未设置'}`];
        if (myContribution) {
          const text = contributionText(myContribution.id, myContribution.current_version);
          block.push(`\n### 我的视角（版本 ${myContribution.current_version}）\n\n${text || '（只有照片）'}\n`);
          for (const m of mediaOf(myContribution.id)) {
            entries.push({ name: `photos/${m.id}.${extOf(m.mime)}`, data: readMediaFile(m.storage_key) });
            manifest.push({ mediaId: m.id, mine: true, memoryId: c.id });
          }
        }
        if (partnerContribution) {
          const partner = getUser(partnerContribution.author_id);
          const text = contributionText(partnerContribution.id, partnerContribution.current_version);
          block.push(`\n### ${partner ? partner.display_name : '对方'}的视角（版本 ${partnerContribution.current_version}，经授权导出）\n\n${text || '（只有照片）'}\n`);
          for (const m of mediaOf(partnerContribution.id)) {
            entries.push({ name: `photos/${m.id}.${extOf(m.mime)}`, data: readMediaFile(m.storage_key) });
            manifest.push({ mediaId: m.id, mine: false, memoryId: c.id });
          }
        }
        md.push(block.join('\n'));
      }
    }
    entries.unshift({
      name: 'memories.md',
      data: Buffer.from(`# 慢记 · 我的回忆导出\n\n导出时间：${nowIso()}\n范围：${scope === 'self' ? '本人内容' : '本人内容 + 经授权的对方版本'}\n\n${md.join('\n\n---\n\n')}\n`, 'utf8'),
    });
    entries.unshift({
      name: 'manifest.json',
      data: Buffer.from(JSON.stringify({ app: 'manji', version: '3.1.0', scope, exportedAt: nowIso(), items: manifest }, null, 2), 'utf8'),
    });
    const zip = buildZip(entries.filter((e) => e.data));
    const key = `exports/${newId('exp')}.zip`;
    const { writeExportFile } = await import('../domain/storage.js');
    writeExportFile(key, zip);
    const id = newId('exp');
    db.prepare(
      `INSERT INTO export_jobs (id, owner_id, home_id, scope, grant_id, status, file_key, file_size, created_at)
       VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, ?)`
    ).run(id, ctx.user.id, home.id, scope, grantId, key, zip.length, nowIso());
    audit(ctx.user.id, 'export-create', 'export', id, 'ok');
    return { status: 201, data: { data: { exportId: id, size: zip.length, entryCount: entries.length } } };
  },

  'GET /api/exports/:id/download': async (ctx) => {
    const job = db.prepare('SELECT * FROM export_jobs WHERE id = ?').get(ctx.params.id);
    if (!job || job.owner_id !== ctx.user.id) throw errors.notFound();
    if (job.status !== 'ready') throw errors.notFound('这次导出已不可用');
    if (job.scope === 'granted') {
      const g = db.prepare('SELECT * FROM consent_grants WHERE id = ?').get(job.grant_id);
      if (!g || g.status !== 'approved' || !grantVersionsStillValid(g)) {
        db.prepare(`UPDATE export_jobs SET status = 'cancelled', fail_reason = '授权已失效' WHERE id = ?`).run(job.id);
        throw errors.forbidden('相关授权已失效，这份导出不能再下载');
      }
    }
    const { readExportFile } = await import('../domain/storage.js');
    const buf = readExportFile(job.file_key);
    if (!buf) throw errors.notFound('导出文件已不可用');
    audit(ctx.user.id, 'export-download', 'export', job.id, 'ok');
    return { status: 200, rawFile: { buf, mime: 'application/zip', filename: `manji-export-${job.id}.zip` } };
  },

  'GET /api/exports': async (ctx) => {
    const rows = db.prepare(`SELECT * FROM export_jobs WHERE owner_id = ? ORDER BY created_at DESC LIMIT 20`).all(ctx.user.id);
    return {
      status: 200,
      data: {
        data: {
          items: rows.map((r) => ({
            id: r.id,
            scope: r.scope,
            status: r.status,
            failReason: r.fail_reason,
            size: r.file_size,
            createdAt: r.created_at,
          })),
        },
      },
    };
  },
};

// ---------- 辅助 ----------
function requireWork(user, id) {
  const w = db.prepare('SELECT * FROM work_jobs WHERE id = ?').get(id);
  if (!w || w.owner_id !== user.id) throw errors.notFound();
  return w;
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

function hasConfirmed(p, userId) {
  if (!userId) return true;
  return !!db.prepare('SELECT 1 FROM promise_confirmations WHERE promise_id = ? AND user_id = ?').get(p.id, userId);
}

function otherMember(p, user) {
  return partnerOf(p.home_id, user.id);
}

function promisePayload(p, user) {
  const partner = partnerOf(p.home_id, user.id);
  const iConfirmed = hasConfirmed(p, user.id);
  const partnerConfirmed = partner ? hasConfirmed(p, partner.id) : true;
  const anchors = anchorsForRecord('promise', p.id);
  const latest = anchors[anchors.length - 1] || null;
  return {
    id: p.id,
    text: p.text,
    note: p.note,
    dueDate: p.due_date,
    scope: p.scope,
    status: p.status,
    needsReconfirm: !!p.needs_reconfirm,
    authorName: getUser(p.author_id)?.display_name,
    mine: p.author_id === user.id,
    completedBy: p.completed_by ? getUser(p.completed_by)?.display_name : null,
    undoNote: p.undo_note,
    revision: p.revision,
    waitingMyConfirm: p.scope === 'shared' && p.author_id !== user.id && (p.status === 'proposed' || (p.status === 'active' && p.needs_reconfirm)) && !iConfirmed,
    bothConfirmed: iConfirmed && partnerConfirmed,
    onChain: latest
      ? {
          blockHeight: latest.block_height,
          revision: latest.revision,
          isCurrentRevision: latest.revision === p.revision,
          anchoredAt: latest.created_at,
          anchorCount: anchors.length,
        }
      : null,
  };
}

function anniversaryPayload(a, today, viewer = null) {
  const next = nextOccurrence(a.date, a.repeat, today);
  return {
    id: a.id,
    title: a.title,
    date: a.date,
    repeat: a.repeat,
    reminderDays: a.reminder_days,
    scope: a.scope,
    note: a.note,
    revision: a.revision,
    mine: viewer ? a.owner_id === viewer.id : true, // 只有创建者能改/删（B03：另一半只读对方的 shared 纪念日）
    ownerName: viewer && a.owner_id !== viewer.id ? getUser(a.owner_id)?.display_name || '' : '',
    nextDate: next,
    daysLeft: next ? daysBetween(today, next) : null,
    isToday: next === today,
    passed: a.repeat === 'once' && a.date < today,
  };
}

function cancelAnniversaryReminders(anniversaryId) {
  db.prepare(`UPDATE notifications SET status = 'cancelled' WHERE source_id = ? AND type = 'anniversary' AND read_at IS NULL`).run(anniversaryId);
}

function contributionText(contributionId, version) {
  return db.prepare('SELECT text FROM contribution_versions WHERE contribution_id = ? AND version = ?').get(contributionId, version)?.text || '';
}

function mediaOf(contributionId) {
  return db.prepare(`SELECT * FROM media_assets WHERE contribution_id = ? AND purpose = 'memory' AND status = 'bound' ORDER BY created_at ASC`).all(contributionId);
}

function extOf(mime) {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  return 'png';
}
