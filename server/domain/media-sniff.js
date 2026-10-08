// 慢记 Manji v3.1 —— 媒体真实类型校验（魔数 + 结构遍历，计划书 4.2 / M09）
// 不依赖第三方库：JPEG 走段遍历确认 SOFn 与 EOI；PNG 确认签名/IHDR/IEND；WebP 确认 RIFF/VP8 族块。

export const ALLOWED_MIMES = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * 返回 { mime, width, height } 或 null（伪类型 / 无法解码结构）。
 */
export function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  // PNG
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return validatePng(buf);
  }
  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return validateJpeg(buf);
  }
  // WebP (RIFF....WEBP)
  if (
    buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return validateWebp(buf);
  }
  return null;
}

function validatePng(buf) {
  let off = 8;
  let width = null;
  let height = null;
  let sawIend = false;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (type === 'IHDR' && len >= 13) {
      width = buf.readUInt32BE(off + 8);
      height = buf.readUInt32BE(off + 12);
    }
    if (type === 'IEND') sawIend = true;
    off += 12 + len; // 长度 + 类型 + CRC
    if (len > 0x7fffffff) return null;
  }
  if (width == null || !sawIend) return null;
  if (width <= 0 || height <= 0 || width > 12000 || height > 12000) return null;
  return { mime: 'image/png', width, height };
}

function validateJpeg(buf) {
  let off = 2;
  let width = null;
  let height = null;
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xff) return null;
    const marker = buf[off + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      off += 2;
      continue;
    }
    if (marker === 0xda) {
      // 扫描数据后应能找到 EOI；粗验证扫描区不越界
      return width && height ? { mime: 'image/jpeg', width, height } : null;
    }
    const len = buf.readUInt16BE(off + 2);
    if (len < 2) return null;
    if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      height = buf.readUInt16BE(off + 5);
      width = buf.readUInt16BE(off + 7);
    }
    off += 2 + len;
  }
  return null;
}

function validateWebp(buf) {
  const tag = buf.toString('ascii', 12, 16);
  let width = null;
  let height = null;
  if (tag === 'VP8 ') {
    if (buf.length < 30) return null;
    // lossy: 帧头后 14 字节处起 3×14bit 宽高
    const b = buf.readUInt32LE(26);
    width = b & 0x3fff;
    height = (b >> 14) & 0x3fff;
  } else if (tag === 'VP8L') {
    if (buf.length < 25) return null;
    const b = buf.readUInt32LE(21);
    width = (b & 0x3fff) + 1;
    height = ((b >> 14) & 0x3fff) + 1;
  } else if (tag === 'VP8X') {
    if (buf.length < 30) return null;
    width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
    height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
  } else {
    return null;
  }
  if (!width || !height || width > 16383 || height > 16383) return null;
  return { mime: 'image/webp', width, height };
}
