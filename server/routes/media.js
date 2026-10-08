// 慢记 Manji v3.1 —— 私密媒体：三步上传 + 鉴权代理读取
import { createWriteStream, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { db } from '../db.js';
import { config } from '../config.js';
import { nowIso, newId, errors, audit } from '../core.js';
import { sniffImage } from '../domain/media-sniff.js';
import { canReadMedia } from '../domain/permissions.js';

const UPLOAD_PURPOSES = ['memory', 'thumb', 'work-artifact', 'invite-preview'];

function mediaPath(key) {
  return path.join(config.mediaRoot, key);
}

function writeMediaFile(key, buf) {
  const p = mediaPath(key);
  mkdirSync(path.dirname(p), { recursive: true });
  rmSync(p, { force: true });
  const out = createWriteStream(p);
  out.write(buf);
  out.end();
  return p;
}

export function readMediaFile(key) {
  const p = mediaPath(key);
  if (!existsSync(p)) return null;
  return readFileSync(p);
}

export const routes = {
  // 第一步：登记暂存
  'POST /api/media/uploads': async (ctx) => {
    const purpose = ctx.json().purpose;
    if (!UPLOAD_PURPOSES.includes(purpose)) {
      throw errors.invalid({ purpose: '不支持的上传用途' }, '不支持的上传用途');
    }
    const id = newId('med');
    const key = `${purpose}/${id}.bin`;
    db.prepare(
      `INSERT INTO media_assets (id, owner_id, purpose, storage_key, mime, size, status, created_at)
       VALUES (?, ?, ?, ?, '', 0, 'staged', ?)`
    ).run(id, ctx.user.id, purpose, key, nowIso());
    return {
      status: 201,
      data: { data: { uploadId: id, purpose, maxBytes: config.maxUploadBytes, uploadToken: id } },
    };
  },

  // 第二步：上传原始字节（X-Upload-Token 绑定登记记录）
  'PUT /api/media/uploads/:id/blob': async (ctx) => {
    const media = db.prepare('SELECT * FROM media_assets WHERE id = ?').get(ctx.params.id);
    if (!media || media.owner_id !== ctx.user.id) throw errors.notFound();
    if (media.status !== 'staged') throw errors.conflict('UPLOAD_STATE', '这个上传已处理过');
    const token = String(ctx.req.headers['x-upload-token'] || '');
    if (token !== media.id) throw errors.forbidden('上传令牌不匹配');
    const buf = ctx.body;
    if (!buf || buf.length === 0) throw errors.invalid({ file: '文件为空' }, '文件为空');
    if (buf.length > config.maxUploadBytes) {
      throw errors.invalid({ file: `文件超过 ${Math.round(config.maxUploadBytes / 1048576)} MiB 上限` }, '文件超过大小限制');
    }
    const info = sniffImage(buf);
    if (!info) {
      // 伪图片类型 / 无法解码结构：直接拒绝，不留可访问文件（M09）
      throw errors.invalid({ file: '不是有效的 JPEG / PNG / WebP 图片' }, '不是有效的 JPEG / PNG / WebP 图片');
    }
    writeMediaFile(media.storage_key, buf);
    db.prepare('UPDATE media_assets SET mime = ?, size = ?, width = ?, height = ? WHERE id = ?').run(
      info.mime, buf.length, info.width, info.height, media.id
    );
    return { status: 200, data: { data: { uploadId: media.id, mime: info.mime, width: info.width, height: info.height } } };
  },

  // 第三步：完成（校验 + 可选挂缩略图）
  'POST /api/media/uploads/:id/complete': async (ctx) => {
    const media = db.prepare('SELECT * FROM media_assets WHERE id = ?').get(ctx.params.id);
    if (!media || media.owner_id !== ctx.user.id) throw errors.notFound();
    if (media.status !== 'staged') throw errors.conflict('UPLOAD_STATE', '这个上传已处理过');
    if (!existsSync(mediaPath(media.storage_key)) || media.size === 0) {
      db.prepare(`UPDATE media_assets SET status = 'orphan' WHERE id = ?`).run(media.id);
      throw errors.invalid({ file: '上传内容缺失，请重新上传' }, '上传内容缺失，请重新上传');
    }
    let thumbKey = null;
    const thumbId = ctx.json().thumbUploadId;
    if (thumbId) {
      const thumb = db.prepare('SELECT * FROM media_assets WHERE id = ?').get(thumbId);
      if (!thumb || thumb.owner_id !== ctx.user.id || thumb.purpose !== 'thumb' || thumb.status !== 'staged') {
        throw errors.invalid({ thumbUploadId: '缩略图无效' }, '缩略图无效');
      }
      db.prepare(`UPDATE media_assets SET status = 'bound', parent_media_id = ? WHERE id = ?`).run(media.id, thumb.id);
      thumbKey = thumb.storage_key;
    }
    // purpose=thumb 不能单独 complete，必须由主图挂接
    if (media.purpose !== 'thumb') {
      db.prepare(`UPDATE media_assets SET status = 'bound', thumb_key = ? WHERE id = ?`).run(thumbKey, media.id);
    }
    audit(ctx.user.id, 'media-complete', 'media', media.id, 'ok');
    return {
      status: 200,
      data: { data: { mediaId: media.id, mime: media.mime, width: media.width, height: media.height, bound: true } },
    };
  },

  // 鉴权代理读取（原图 / 缩略图），每次请求验证当前权限（M47）
  'GET /api/media/:id': async (ctx) => {
    const media = db.prepare('SELECT * FROM media_assets WHERE id = ?').get(ctx.params.id);
    if (!media) throw errors.notFound();
    if (!canReadMedia(ctx.user, media)) throw errors.notFound();
    const variant = ctx.query.get('variant') || 'full';
    let key = media.storage_key;
    if (variant === 'thumb' && media.thumb_key) key = media.thumb_key;
    const buf = readMediaFile(key);
    if (!buf) throw errors.notFound('这部分内容已不再共享');
    return {
      status: 200,
      rawFile: { buf, mime: variant === 'thumb' && media.thumb_key ? 'image/jpeg' : media.mime },
    };
  },
};

/** 清理超过 24 小时的孤立暂存（启动与每日触发） */
export function cleanupStaleUploads() {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const rows = db.prepare(`SELECT * FROM media_assets WHERE status = 'staged'`).all();
  for (const m of rows) {
    if (Date.parse(m.created_at) < cutoff) {
      rmSync(mediaPath(m.storage_key), { force: true });
      db.prepare(`UPDATE media_assets SET status = 'orphan' WHERE id = ?`).run(m.id);
    }
  }
}
