// 慢记 Manji v3.1 —— 账户、我的、家、邀请、解除关联、小狗、通知
import { db, tx } from '../db.js';
import { config } from '../config.js';
import {
  nowIso, newId, sha256, randomToken, bizToday, errors, hashPassword, verifyPassword,
  createSession, revokeSession, userForRequest, setSessionCookie, clearSessionCookie, audit,
  trimTo, assert, parseCookies,
} from '../core.js';
import {
  getUser, getHome, activeMembers, membershipOf, partnerOf, currentHome, myHomes,
  getPet, notify, listVisibleContainers,
} from '../domain/permissions.js';
import { readMediaFile } from './media.js';

const PET_APPEARANCES = ['cream', 'caramel', 'cocoa'];

/** 中文输入法常见全角字符规范化：全角横线/破折号 → 半角"-"，全角空格 → 半角空格 */
function normalizeIme(v) {
  return String(v ?? '')
    .replace(/[－—–﹣−ー]/g, '-')
    .replace(/[\u3000\u00A0]/g, ' ');
}

function sanitizeName(v) {
  const t = trimTo(normalizeIme(v), 24);
  assert(t, 'displayName', '昵称需要 1–24 个字符');
  return t;
}

function createHomeFor(userId, displayName) {
  const homeId = newId('home');
  const now = nowIso();
  db.prepare('INSERT INTO homes (id, status, timezone, created_at) VALUES (?, ?, ?, ?)').run(
    homeId, 'solo', config.bizTimezone, now
  );
  db.prepare('INSERT INTO memberships (home_id, user_id, status, joined_at) VALUES (?, ?, ?, ?)').run(
    homeId, userId, 'active', now
  );
  db.prepare(
    `INSERT INTO pet_profiles (id, owner_type, owner_id, name, appearance_key, created_at)
     VALUES (?, 'home', ?, ?, 'cream', ?)`
  ).run(newId('pet'), homeId, `${displayName}的小狗`, now);
  db.prepare('UPDATE users SET current_home_id = ? WHERE id = ?').run(homeId, userId);
  return homeId;
}

function userPayload(user) {
  const prefs = JSON.parse(user.preferences || '{}');
  const home = getHome(user.current_home_id);
  const pet = getPet(user.current_home_id);
  return {
    id: user.id,
    displayName: user.display_name,
    isAdmin: !!user.is_admin,
    preferences: {
      pauseNotifications: !!prefs.pauseNotifications,
      pauseRecall: !!prefs.pauseRecall,
      reduceMotion: !!prefs.reduceMotion,
      recallEnabled: prefs.recallEnabled !== false,
    },
    home: home
      ? {
          id: home.id,
          status: home.status,
          timezone: home.timezone,
          isShared: home.status === 'shared',
          name: home.name || null, // v3.5（U01）：服务端共同家名，两位成员一致
          revision: home.revision,
          members: activeMembers(home.id),
          createdAt: home.created_at, // v3.2.1：首页「第 N 天」用（附加字段，不改变既有契约）
        }
      : null,
    pet: pet ? { id: pet.id, name: pet.name, appearanceKey: pet.appearance_key } : null,
  };
}

export const routes = {
  // ---------- 账户 ----------
  'POST /api/auth/register': async (ctx) => {
    const displayName = sanitizeName(ctx.json().displayName);
    // 注册与登录使用同一套密码规范化，保证注册—退出—登录往返一致（B08）
    const password = normalizeIme(String(ctx.json().password || ''));
    assert(password.length >= 8 && password.length <= 128, 'password', '密码至少 8 位');
    const existing = db.prepare('SELECT id FROM users WHERE display_name = ?').get(displayName);
    if (existing) throw errors.conflict('NAME_TAKEN', '这个昵称已经有人用了');
    const userId = newId('user');
    db.prepare('INSERT INTO users (id, display_name, password_hash, preferences, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(userId, displayName, hashPassword(password), '{}', nowIso());
    createHomeFor(userId, displayName);
    const token = createSession(userId);
    setSessionCookie(ctx.res, token);
    audit(userId, 'register', 'user', userId, 'ok');
    return { status: 201, data: { data: userPayload(getUser(userId)) } };
  },

  'POST /api/auth/login': async (ctx) => {
    const displayName = sanitizeName(ctx.json().displayName);
    const rawPassword = String(ctx.json().password || '');
    const password = normalizeIme(rawPassword);
    const user = db.prepare('SELECT * FROM users WHERE display_name = ?').get(displayName);
    if (!user) throw errors.invalid({ password: '昵称或密码不正确' }, '昵称或密码不正确');
    if (!verifyPassword(password, user.password_hash)) {
      // 兼容 v3.0 旧账户：注册时未经规范化的原始密码（B08），验证通过后迁移为规范化哈希
      if (!verifyPassword(rawPassword, user.password_hash)) {
        throw errors.invalid({ password: '昵称或密码不正确' }, '昵称或密码不正确');
      }
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), user.id);
    }
    const token = createSession(user.id);
    setSessionCookie(ctx.res, token);
    if (!getHome(user.current_home_id)) createHomeFor(user.id, user.display_name);
    audit(user.id, 'login', 'user', user.id, 'ok');
    return { status: 200, data: { data: userPayload(user) } };
  },

  'POST /api/auth/logout': async (ctx) => {
    const token = parseCookies(ctx.req).manji_session;
    if (token) revokeSession(token);
    clearSessionCookie(ctx.res);
    return { status: 200, data: { data: { ok: true } } };
  },

  'GET /api/me': async (ctx) => {
    return { status: 200, data: { data: userPayload(ctx.user) } };
  },

  'PATCH /api/me': async (ctx) => {
    const displayName = sanitizeName(ctx.json().displayName);
    const existing = db.prepare('SELECT id FROM users WHERE display_name = ? AND id != ?').get(displayName, ctx.user.id);
    if (existing) throw errors.conflict('NAME_TAKEN', '这个昵称已经有人用了');
    db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(displayName, ctx.user.id);
    audit(ctx.user.id, 'rename', 'user', ctx.user.id, 'ok');
    return { status: 200, data: { data: userPayload(getUser(ctx.user.id)) } };
  },

  'PUT /api/me/preferences': async (ctx) => {
    const body = ctx.json();
    const prefs = JSON.parse(ctx.user.preferences || '{}');
    for (const key of ['pauseNotifications', 'pauseRecall', 'reduceMotion', 'recallEnabled']) {
      if (typeof body[key] === 'boolean') prefs[key] = body[key];
    }
    db.prepare('UPDATE users SET preferences = ? WHERE id = ?').run(JSON.stringify(prefs), ctx.user.id);
    audit(ctx.user.id, 'update-preferences', 'user', ctx.user.id, 'ok');
    return { status: 200, data: { data: { preferences: prefs } } };
  },

  // ---------- 家 ----------
  'GET /api/home': async (ctx) => {
    const home = currentHome(ctx.user);
    const pet = getPet(home.id);
    return {
      status: 200,
      data: {
        data: {
          id: home.id,
          status: home.status,
          isShared: home.status === 'shared',
          name: home.name || null,
          members: activeMembers(home.id),
          pet: pet ? { id: pet.id, name: pet.name, appearanceKey: pet.appearance_key } : null,
          revision: home.revision,
        },
      },
    };
  },

  /**
   * 家名（U01，v3.5）：从"各自设备的 localStorage"改为服务端共同属性，两位成员共享同一个名字。
   * 带版本号做乐观并发：对方刚改过时提示刷新，不静默覆盖；修改会通知另一位成员。
   */
  'PATCH /api/home/name': async (ctx) => {
    const home = currentHome(ctx.user);
    const body = ctx.json();
    const expected = Number(body.expectedRevision);
    assert(Number.isInteger(expected), 'expectedRevision', '缺少版本号');
    if (expected !== home.revision) {
      throw errors.conflict('REVISION_CONFLICT', '家名刚被另一位成员改过，请刷新后再试', { currentRevision: home.revision });
    }
    const name = body.name === null || body.name === '' ? null : trimTo(body.name, 16);
    if (body.name !== null && body.name !== '' && !name) {
      throw errors.invalid({ name: '家名需要 1–16 个字符' }, '家名需要 1–16 个字符');
    }
    db.prepare('UPDATE homes SET name = ?, revision = revision + 1 WHERE id = ?').run(name, home.id);
    const partner = partnerOf(home.id, ctx.user.id);
    if (partner) {
      notify(partner.id, {
        type: 'home-name',
        title: '家里的名字换了一下',
        body: name
          ? `${ctx.user.display_name} 把小屋名字改成了「${name}」；两个人看到的是同一个名字。`
          : `${ctx.user.display_name} 清空了小屋名字。`,
        sourceId: home.id,
        dedupeKey: `home-name:${home.id}:${home.revision + 1}`,
      });
    }
    audit(ctx.user.id, 'home-rename', 'home', home.id, 'ok');
    return { status: 200, data: { data: { name, revision: home.revision + 1 } } };
  },

  'POST /api/homes': async (ctx) => {
    // 幂等：已有当前家时返回现状，不重复创建
    const home = getHome(ctx.user.current_home_id);
    if (home && home.status !== 'frozen') {
      return { status: 200, data: { data: { homeId: home.id, existed: true } } };
    }
    const homeId = createHomeFor(ctx.user.id, ctx.user.display_name);
    audit(ctx.user.id, 'create-home', 'home', homeId, 'ok');
    return { status: 201, data: { data: { homeId: homeId, existed: false } } };
  },

  // ---------- 小狗 ----------
  'GET /api/home/pet': async (ctx) => {
    const home = currentHome(ctx.user);
    const pet = getPet(home.id);
    if (!pet) throw errors.notFound();
    return { status: 200, data: { data: { id: pet.id, name: pet.name, appearanceKey: pet.appearance_key, settings: JSON.parse(pet.settings || '{}') } } };
  },

  'PATCH /api/home/pet': async (ctx) => {
    const home = currentHome(ctx.user);
    const pet = getPet(home.id);
    if (!pet) throw errors.notFound();
    const body = ctx.json();
    let name = pet.name;
    if (body.name !== undefined) {
      name = trimTo(body.name, 24);
      assert(name, 'name', '小狗名字需要 1–24 个字符');
    }
    let appearance = pet.appearance_key;
    if (body.appearanceKey !== undefined) {
      assert(PET_APPEARANCES.includes(body.appearanceKey), 'appearanceKey', '外观不在可选范围');
      appearance = body.appearanceKey;
    }
    db.prepare('UPDATE pet_profiles SET name = ?, appearance_key = ? WHERE id = ?').run(name, appearance, pet.id);
    audit(ctx.user.id, 'pet-update', 'pet', pet.id, 'ok');
    return { status: 200, data: { data: { id: pet.id, name, appearanceKey: appearance } } };
  },

  'POST /api/home/pet/interact': async (ctx) => {
    const home = currentHome(ctx.user);
    const pet = getPet(home.id);
    if (!pet) throw errors.notFound();
    const action = ctx.json().action;
    assert(['pat', 'ball', 'rest'].includes(action), 'action', '未知的小狗互动');
    // 轻关联基于真实已有主题（计划书 4.4），不推断感情
    const topics = db
      .prepare(
        `SELECT DISTINCT mc.topic FROM memory_containers mc
         JOIN contributions c ON c.memory_id = mc.id
         WHERE mc.home_id = ? AND mc.status = 'active' AND c.deleted_at IS NULL AND c.author_id = ?`
      )
      .all(home.id, ctx.user.id)
      .map((r) => r.topic)
      .filter(Boolean);
    const settings = JSON.parse(pet.settings || '{}');
    settings.interactions = (settings.interactions || 0) + 1;
    settings.lastAction = action;
    settings.lastActionAt = nowIso();
    db.prepare('UPDATE pet_profiles SET settings = ? WHERE id = ?').run(JSON.stringify(settings), pet.id);

    let reaction;
    if (action === 'pat') {
      reaction = topics.includes('美食')
        ? `${pet.name} 闻了闻你的手，好像想起了一起做饭的那天。`
        : `${pet.name} 凑过来蹭了蹭你。`;
    } else if (action === 'ball') {
      reaction = topics.includes('户外')
        ? `${pet.name} 追着球跑了一圈，有点像那次露营的劲头。`
        : `${pet.name} 把球推回你脚边，尾巴摇个不停。`;
    } else {
      reaction = `${pet.name} 在垫子上换了个更舒服的姿势。`;
    }
    return { status: 200, data: { data: { reaction, interactions: settings.interactions } } };
  },

  // ---------- 邀请（计划书 S09） ----------
  'POST /api/homes/:id/invites': async (ctx) => {
    const home = getHome(ctx.params.id);
    if (!home) throw errors.notFound();
    const ms = membershipOf(home.id, ctx.user.id);
    if (!ms || ms.status !== 'active') throw errors.forbidden();
    if (home.status !== 'solo') throw errors.conflict('HOME_NOT_SOLO', '这个家已经有两位成员了');
    const body = ctx.json();
    const message = body.message ? trimTo(body.message, 120) : null;

    let previewMediaId = null;
    if (body.previewMediaId) {
      const media = db.prepare('SELECT * FROM media_assets WHERE id = ?').get(body.previewMediaId);
      // 预览只能是本人主动授权的具体内容（M06）：本人拥有且绑定在本人贡献上
      if (!media || media.owner_id !== ctx.user.id || media.purpose !== 'memory' || !media.contribution_id) {
        throw errors.invalid({ previewMediaId: '预览内容无效，只能选择你自己的照片' }, '预览内容无效');
      }
      const contribution = db.prepare('SELECT * FROM contributions WHERE id = ?').get(media.contribution_id);
      if (!contribution || contribution.author_id !== ctx.user.id || contribution.deleted_at) {
        throw errors.invalid({ previewMediaId: '预览内容无效' }, '预览内容无效');
      }
      previewMediaId = media.id;
    }

    const token = randomToken(24);
    const id = newId('inv');
    const expires = new Date(Date.now() + config.inviteTtlDays * 86400000).toISOString();
    db.prepare(
      `INSERT INTO invites (id, home_id, creator_id, token_hash, message, preview_media_id, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
    ).run(id, home.id, ctx.user.id, sha256(token), message, previewMediaId, nowIso(), expires);
    audit(ctx.user.id, 'invite-create', 'invite', id, 'ok');
    return {
      status: 201,
      data: { data: { inviteId: id, token, expiresAt: expires, url: `#/invite/accept?t=${token}` } },
    };
  },

  'GET /api/invites/info': async (ctx) => {
    const token = String(ctx.query.get('token') || '');
    assert(token.length >= 16, 'token', '邀请链接无效');
    const invite = db.prepare('SELECT * FROM invites WHERE token_hash = ?').get(sha256(token));
    if (!invite) throw errors.notFound('邀请不存在或已失效');
    let status = invite.status;
    if (status === 'pending' && invite.expires_at < nowIso()) status = 'expired';
    const inviter = getUser(invite.creator_id);
    const body = {
      status,
      inviterName: inviter ? inviter.display_name : '一位朋友',
      message: invite.message,
      hasPreview: false,
      previewDataUrl: null,
    };
    // 无有效预览授权则只显示普通邀请说明（M06）
    if (status === 'pending' && invite.preview_media_id) {
      const media = db.prepare('SELECT * FROM media_assets WHERE id = ?').get(invite.preview_media_id);
      if (media && media.status === 'bound') {
        const contribution = db.prepare('SELECT * FROM contributions WHERE id = ?').get(media.contribution_id);
        if (contribution && !contribution.deleted_at && contribution.visibility === 'home') {
          body.hasPreview = true;
          body.previewDataUrl = null; // 预览图通过单独的令牌接口取，不内联
          body.previewMediaToken = token;
        }
      }
    }
    return { status: 200, data: { data: body } };
  },

  'GET /api/invites/preview': async (ctx) => {
    const token = String(ctx.query.get('token') || '');
    const invite = db.prepare('SELECT * FROM invites WHERE token_hash = ?').get(sha256(token));
    if (!invite || invite.status !== 'pending' || !invite.preview_media_id) throw errors.notFound();
    const media = db.prepare('SELECT * FROM media_assets WHERE id = ?').get(invite.preview_media_id);
    if (!media || media.status !== 'bound') throw errors.notFound('这部分内容已不再共享');
    const contribution = db.prepare('SELECT * FROM contributions WHERE id = ?').get(media.contribution_id);
    if (!contribution || contribution.deleted_at || contribution.visibility !== 'home') {
      throw errors.notFound('这部分内容已不再共享');
    }
    const buf = readMediaFile(media.storage_key);
    if (!buf) throw errors.notFound('这部分内容已不再共享');
    return { status: 200, rawFile: { buf, mime: media.mime } };
  },

  'POST /api/invites/:id/revoke': async (ctx) => {
    const invite = db.prepare('SELECT * FROM invites WHERE id = ?').get(ctx.params.id);
    if (!invite) throw errors.notFound();
    if (invite.creator_id !== ctx.user.id) throw errors.forbidden();
    if (invite.status !== 'pending') throw errors.conflict('INVITE_NOT_PENDING', '邀请已不在待接受状态');
    db.prepare(`UPDATE invites SET status = 'revoked' WHERE id = ?`).run(invite.id);
    audit(ctx.user.id, 'invite-revoke', 'invite', invite.id, 'ok');
    return { status: 200, data: { data: { ok: true } } };
  },

  'POST /api/invites/accept': async (ctx) => {
    const token = String(ctx.json().token || '');
    assert(token.length >= 16, 'token', '邀请链接无效');
    const invite = db.prepare('SELECT * FROM invites WHERE token_hash = ?').get(sha256(token));
    if (!invite) throw errors.notFound('邀请不存在或已失效');
    if (invite.status === 'used') throw errors.conflict('INVITE_USED', '这份邀请已经被使用过了');
    if (invite.status === 'revoked') throw errors.conflict('INVITE_REVOKED', '这份邀请已被撤销');
    if (invite.status === 'expired' || invite.expires_at < nowIso()) {
      throw errors.conflict('INVITE_EXPIRED', '这份邀请已过期');
    }
    if (invite.creator_id === ctx.user.id) {
      throw errors.conflict('INVITE_SELF', '不能接受自己的邀请');
    }
    const home = getHome(invite.home_id);
    if (!home || home.status !== 'solo') {
      throw errors.conflict('HOME_UNAVAILABLE', '这个家已经不能加入了');
    }
    const members = activeMembers(home.id);
    if (members.length >= 2) throw errors.conflict('HOME_FULL', '这个家已经有两位成员了');
    // 双方都不能已有有效共同绑定
    for (const u of [ctx.user.id, invite.creator_id]) {
      const bound = db
        .prepare(
          `SELECT COUNT(*) AS n FROM memberships m JOIN homes h ON h.id = m.home_id
           WHERE m.user_id = ? AND m.status = 'active' AND h.status = 'shared'`
        )
        .get(u).n;
      if (bound > 0) throw errors.conflict('ALREADY_BOUND', '你或对方已经在一个共同小家里了');
    }
    const now = nowIso();
    const apply = tx(() => {
      const cur = db.prepare('SELECT * FROM invites WHERE id = ?').get(invite.id);
      if (cur.status !== 'pending') throw errors.conflict('INVITE_RACE', '这份邀请刚刚被处理，请刷新');
      const curHome = getHome(invite.home_id);
      if (curHome.status !== 'solo') throw errors.conflict('HOME_RACE', '这个家刚刚发生了变化');
      db.prepare(`UPDATE invites SET status = 'used' WHERE id = ?`).run(invite.id);
      db.prepare(`UPDATE homes SET status = 'shared', revision = revision + 1 WHERE id = ?`).run(home.id);
      db.prepare('INSERT INTO memberships (home_id, user_id, status, joined_at) VALUES (?, ?, ?, ?)').run(
        home.id, ctx.user.id, 'active', now
      );
      db.prepare('UPDATE users SET current_home_id = ? WHERE id = ?').run(home.id, ctx.user.id);
    });
    try {
      apply();
    } catch (e) {
      if (e instanceof Error && e.code) throw e;
      throw e;
    }
    notify(invite.creator_id, {
      type: 'invite-accepted',
      title: `${ctx.user.display_name} 回到了家`,
      body: '你们现在共用一间小家，可以各自补上自己的视角。',
      sourceId: home.id,
      dedupeKey: `invite-accepted:${invite.id}`,
    });
    audit(ctx.user.id, 'invite-accept', 'home', home.id, 'ok');
    return { status: 200, data: { data: { homeId: home.id } } };
  },

  // ---------- 解除关联（计划书 6.4） ----------
  'POST /api/homes/:id/unlink': async (ctx) => {
    const home = getHome(ctx.params.id);
    if (!home) throw errors.notFound();
    const ms = membershipOf(home.id, ctx.user.id);
    if (!ms || ms.status !== 'active') throw errors.forbidden();
    assert(ctx.json().confirm === true, 'confirm', '请在确认后再次提交');
    const now = nowIso();
    const members = activeMembers(home.id);
    const pet = getPet(home.id);

    const apply = tx(() => {
      const cur = getHome(home.id);
      if (cur.status === 'frozen') throw errors.conflict('HOME_FROZEN', '这个家已经解除过关联');
      db.prepare(`UPDATE homes SET status = 'frozen', frozen_at = ?, revision = revision + 1 WHERE id = ?`).run(now, home.id);
      db.prepare(`UPDATE memberships SET status = 'left', left_at = ? WHERE home_id = ? AND status = 'active'`).run(now, home.id);
      // 待处理邀请全部失效
      db.prepare(`UPDATE invites SET status = 'revoked' WHERE home_id = ? AND status = 'pending'`).run(home.id);
      // 双方之间未完成的授权请求失效
      const memberIds = members.map((m) => m.id);
      const placeholders = memberIds.map(() => '?').join(',');
      db.prepare(
        `UPDATE consent_grants SET status = 'invalidated', revision = revision + 1
         WHERE status IN ('pending','approved') AND requester_id IN (${placeholders}) AND approver_id IN (${placeholders})`
      ).run(...memberIds, ...memberIds);
      // 含对方内容的作品/导出任务取消
      db.prepare(
        `UPDATE work_jobs SET status = 'cancelled', fail_reason = '空间已解除关联', updated_at = ?
         WHERE home_id = ? AND includes_partner = 1 AND status IN ('queued','running','ready')`
      ).run(now, home.id);
      db.prepare(
        `UPDATE export_jobs SET status = 'cancelled', fail_reason = '空间已解除关联'
         WHERE home_id = ? AND scope = 'granted' AND status = 'ready'`
      ).run(home.id);
      // 待发的共同纪念日提醒取消，避免重放泄露
      db.prepare(
        `UPDATE notifications SET status = 'cancelled'
         WHERE status = 'sent' AND read_at IS NULL AND type = 'anniversary' AND source_id IN
           (SELECT id FROM anniversaries WHERE home_id = ? AND scope = 'shared')`
      ).run(home.id);
      // 每个人回到一间可用的个人家；小狗延续（保留共同选定的名字与外观）
      for (const m of members) {
        let solo = db
          .prepare(
            `SELECT h.id FROM memberships ms JOIN homes h ON h.id = ms.home_id
             WHERE ms.user_id = ? AND ms.status = 'active' AND h.status = 'solo' AND h.id != ?`
          )
          .get(m.id, home.id);
        if (!solo) {
          const homeId = newId('home');
          db.prepare('INSERT INTO homes (id, status, timezone, created_at) VALUES (?, ?, ?, ?)').run(
            homeId, 'solo', config.bizTimezone, now
          );
          db.prepare('INSERT INTO memberships (home_id, user_id, status, joined_at) VALUES (?, ?, ?, ?)').run(
            homeId, m.id, 'active', now
          );
          const user = getUser(m.id);
          db.prepare(
            `INSERT INTO pet_profiles (id, owner_type, owner_id, name, appearance_key, created_at)
             VALUES (?, 'home', ?, ?, ?, ?)`
          ).run(newId('pet'), homeId, pet ? pet.name : `${user.display_name}的小狗`, pet ? pet.appearance_key : 'cream', now);
          solo = { id: homeId };
        } else if (pet) {
          const soloPet = db.prepare(`SELECT * FROM pet_profiles WHERE owner_type = 'home' AND owner_id = ?`).get(solo.id);
          if (soloPet && /^.*的小狗$/.test(soloPet.name)) {
            db.prepare('UPDATE pet_profiles SET name = ?, appearance_key = ? WHERE id = ?').run(
              pet.name, pet.appearance_key, soloPet.id
            );
          }
        }
        db.prepare('UPDATE users SET current_home_id = ? WHERE id = ?').run(solo.id, m.id);
      }
    });
    apply();
    audit(ctx.user.id, 'unlink', 'home', home.id, 'ok');
    return { status: 200, data: { data: { ok: true, frozenHomeId: home.id } } };
  },

  // ---------- 通知 ----------
  'GET /api/notifications': async (ctx) => {
    generateAnniversaryReminders(ctx.user);
    const rows = db
      .prepare(
        `SELECT * FROM notifications WHERE user_id = ? AND status = 'sent' ORDER BY created_at DESC LIMIT 50`
      )
      .all(ctx.user.id);
    return { status: 200, data: { data: { items: rows } } };
  },

  'POST /api/notifications/read': async (ctx) => {
    const ids = Array.isArray(ctx.json().ids) ? ctx.json().ids : null;
    if (ids) {
      const mark = db.prepare(`UPDATE notifications SET read_at = ? WHERE user_id = ? AND id = ? AND read_at IS NULL`);
      for (const id of ids) mark.run(nowIso(), ctx.user.id, String(id));
    } else {
      db.prepare(`UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL`).run(nowIso(), ctx.user.id);
    }
    return { status: 200, data: { data: { ok: true } } };
  },

  // ---------- 我的空间总览（我的 Tab 用） ----------
  'GET /api/me/spaces': async (ctx) => {
    const homes = myHomes(ctx.user.id);
    return {
      status: 200,
      data: {
        data: homes.map((h) => ({
          id: h.id,
          status: h.status,
          myStatus: h.my_status,
          isCurrent: h.id === ctx.user.current_home_id,
          members: activeMembers(h.id),
          pet: getPet(h.id) ? getPet(h.id).name : null,
        })),
      },
    };
  },

  // ---------- 管理员（只读运营视角，不能查看任何用户私密内容，M07/M46 不变） ----------
  'GET /api/admin/overview': async (ctx) => {
    requireAdmin(ctx);
    const count = (sql) => db.prepare(sql).get().n;
    const recentAudit = db
      .prepare(`SELECT a.action, a.object_type, a.result, a.at, u.display_name AS actor
                FROM audit_events a LEFT JOIN users u ON u.id = a.actor_id
                ORDER BY a.at DESC LIMIT 12`)
      .all();
    return {
      status: 200,
      data: {
        data: {
          users: count('SELECT COUNT(*) AS n FROM users'),
          homesSolo: count(`SELECT COUNT(*) AS n FROM homes WHERE status = 'solo'`),
          homesShared: count(`SELECT COUNT(*) AS n FROM homes WHERE status = 'shared'`),
          homesFrozen: count(`SELECT COUNT(*) AS n FROM homes WHERE status = 'frozen'`),
          memories: count(`SELECT COUNT(*) AS n FROM memory_containers WHERE status = 'active'`),
          contributions: count('SELECT COUNT(*) AS n FROM contributions WHERE deleted_at IS NULL'),
          photos: count(`SELECT COUNT(*) AS n FROM media_assets WHERE purpose = 'memory' AND status = 'bound'`),
          works: count(`SELECT COUNT(*) AS n FROM work_jobs WHERE status = 'ready'`),
          exports: count(`SELECT COUNT(*) AS n FROM export_jobs`),
          pendingConsents: count(`SELECT COUNT(*) AS n FROM consent_grants WHERE status = 'pending'`),
          recentAudit,
        },
      },
    };
  },

  'GET /api/admin/users': async (ctx) => {
    requireAdmin(ctx);
    const rows = db
      .prepare(
        `SELECT u.id, u.display_name, u.is_admin, u.created_at,
                (SELECT h.status FROM homes h WHERE h.id = u.current_home_id) AS home_status,
                (SELECT COUNT(*) FROM contributions c WHERE c.author_id = u.id AND c.deleted_at IS NULL) AS own_contributions
         FROM users u ORDER BY u.created_at DESC LIMIT 200`
      )
      .all();
    return {
      status: 200,
      data: {
        data: rows.map((r) => ({
          id: r.id,
          displayName: r.display_name,
          isAdmin: !!r.is_admin,
          createdAt: r.created_at,
          homeStatus: r.home_status,
          ownContributions: r.own_contributions,
        })),
      },
    };
  },
};

function requireAdmin(ctx) {
  if (!ctx.user || !ctx.user.is_admin) {
    throw errors.forbidden('这个页面只有管理员可以查看');
  }
}

/** 启动时确保存在种子管理员（密码来自 .env，默认 admin-2026；已存在则只更新密码标记不覆盖） */
export function ensureAdmin() {
  const name = config.adminDisplayName;
  const existing = db.prepare('SELECT * FROM users WHERE display_name = ?').get(name);
  if (existing) {
    if (!existing.is_admin) {
      db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(existing.id);
    }
    return existing.id;
  }
  const id = newId('user');
  db.prepare(
    'INSERT INTO users (id, display_name, password_hash, preferences, is_admin, created_at) VALUES (?, ?, ?, ?, 1, ?)'
  ).run(id, name, hashPassword(config.adminPassword), '{}', nowIso());
  audit(id, 'admin-seed', 'user', id, 'ok');
  return id;
}

// ---------- 纪念日提醒惰性生成（发送前重新验权，计划书 4.7 / M29） ----------
function generateAnniversaryReminders(user) {
  const prefs = JSON.parse(user.preferences || '{}');
  if (prefs.pauseNotifications) return;
  const today = bizToday();
  const rows = db.prepare('SELECT * FROM anniversaries WHERE owner_id = ?').all(user.id);
  for (const a of rows) {
    // 范围校验：共同条目要求其家仍有效；解除后对方创建的条目本就不属于我（owner 查询已保证）
    if (a.home_id && a.scope === 'shared') {
      const home = getHome(a.home_id);
      if (!home || home.status !== 'shared') continue;
      const ms = membershipOf(home.id, user.id);
      if (!ms || ms.status !== 'active') continue;
    }
    const next = nextOccurrenceSafe(a.date, a.repeat, today);
    if (!next) continue;
    const daysLeft = Math.round((Date.parse(next + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000);
    const want = [];
    if (a.reminder_days === 0) want.push(0);
    if ([1, 3, 7].includes(a.reminder_days)) want.push(a.reminder_days);
    for (const d of want) {
      if (daysLeft === d) {
        const label = d === 0 ? '就是今天' : `还有 ${d} 天`;
        notify(user.id, {
          type: 'anniversary',
          title: `纪念日：${a.title}`,
          body: `${label}（${next}）`,
          sourceId: a.id,
          occurrenceDate: next,
          dedupeKey: `ann:${a.id}:${next}:d${d}`,
        });
      }
    }
  }
}

function nextOccurrenceSafe(date, repeat, today) {
  if (repeat === 'once') return date >= today ? date : null;
  const [y, m, d] = date.split('-').map(Number);
  const ty = Number(today.slice(0, 4));
  for (let year = ty; year <= ty + 1; year++) {
    let dd = String(d).padStart(2, '0');
    if (m === 2 && d === 29 && !((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0)) dd = '28';
    const occ = `${year}-${String(m).padStart(2, '0')}-${dd}`;
    if (occ >= today) return occ;
  }
  return null;
}
