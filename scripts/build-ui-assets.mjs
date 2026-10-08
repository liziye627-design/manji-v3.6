// 慢记 v3.2 —— Consensus Bell UI 素材构建脚本（零依赖）
// 输入：Blender V2 渲染图（物体=纯黑底，场景=完整背景）
// 处理：黑底边缘泛洪抠图 → alpha 羽化 → 双线性降采样 → 重编码 PNG
// 输出：public/assets/img/ 下的 web 尺寸素材 + 一张对照表（供人工核对映射）
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SRC = path.join(ROOT, '..', 'ConsensusBell-Blender-V2鲜活与16动作', 'renders');
const OUT = path.join(ROOT, 'public', 'assets', 'img');
const QA = path.join(ROOT, '..', '_qa');

// ---------- PNG 解码（8bit，灰度/RGB/RGBA） ----------
function decodePNG(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not png');
  let w, h, colorType, bitDepth;
  const idat = [];
  let o = 8;
  while (o < buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString('ascii', o + 4, o + 8);
    if (type === 'IHDR') {
      w = buf.readUInt32BE(o + 8);
      h = buf.readUInt32BE(o + 12);
      bitDepth = buf[o + 16];
      colorType = buf[o + 17];
    } else if (type === 'IDAT') idat.push(buf.subarray(o + 8, o + 8 + len));
    else if (type === 'IEND') break;
    o += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
  const ch = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
  if (!ch) throw new Error(`unsupported color type ${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(w * h * ch);
  let prev = Buffer.alloc(stride);
  let pos = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[pos++];
    const cur = Buffer.from(raw.subarray(pos, pos + stride));
    pos += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev[x];
      const c = x >= ch ? prev[x - ch] : 0; // 左上
      let v = cur[x];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 255;
    }
    cur.copy(out, y * stride);
    prev = cur;
  }
  return { w, h, ch, data: out };
}

// ---------- PNG 编码（RGBA，逐行启发式滤波） ----------
function encodePNG(w, h, rgba) {
  const raws = Buffer.alloc((w * 4 + 1) * h);
  const filters = [0, 1, 2, 3, 4];
  for (let y = 0; y < h; y++) {
    const rowStart = y * w * 4;
    let bestF = 0, bestCost = Infinity, bestBytes = null;
    for (const f of filters) {
      const line = Buffer.alloc(w * 4);
      let cost = 0;
      for (let x = 0; x < w * 4; x++) {
        const left = x >= 4 ? rgba[rowStart + x - 4] : 0;
        const up = y > 0 ? rgba[rowStart - w * 4 + x] : 0;
        const v = rgba[rowStart + x];
        let d;
        if (f === 0) d = v;
        else if (f === 1) d = v - left;
        else if (f === 2) d = v - up;
        else if (f === 3) d = v - ((left + up) >> 1);
        else {
          const upLeft = y > 0 && x >= 4 ? rgba[rowStart - w * 4 + x - 4] : 0;
          const p = left + up - upLeft;
          const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
          d = v - (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
        }
        line[x] = d & 255;
        cost += Math.min(d & 255, 256 - (d & 255));
      }
      if (cost < bestCost) { bestCost = cost; bestF = f; bestBytes = line; }
    }
    raws[y * (w * 4 + 1)] = bestF;
    bestBytes.copy(raws, y * (w * 4 + 1) + 1);
  }
  const chunks = [];
  const push = (type, data) => {
    const c = Buffer.alloc(8 + data.length + 4);
    c.writeUInt32BE(data.length, 0);
    c.write(type, 4, 'ascii');
    data.copy(c, 8);
    c.writeUInt32BE(crc32(c.subarray(4, 8 + data.length)), 8 + data.length);
    chunks.push(c);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  push('IHDR', ihdr);
  push('IDAT', zlib.deflateSync(raws, { level: 9 }));
  push('IEND', Buffer.alloc(0));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunks]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------- 黑底抠图：从边缘泛洪删除近黑像素，再对 alpha 做一次 3×3 平滑 ----------
function keyBlack(img, tol = 44) {
  const { w, h, ch, data } = img;
  const px = (i) => (ch === 1 ? [data[i], data[i], data[i], 255] : ch === 2 ? [data[i], data[i], data[i], data[i + 1]] : ch === 3 ? [data[i], data[i + 1], data[i + 2], 255] : [data[i], data[i + 1], data[i + 2], data[i + 3]]);
  const removed = new Uint8Array(w * h);
  const stack = [];
  const nearBlack = (i) => {
    const [r, g, b] = px(i * ch);
    return r < tol && g < tol && b < tol;
  };
  for (let x = 0; x < w; x++) {
    stack.push(x, (h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    stack.push(y * w, y * w + w - 1);
  }
  while (stack.length) {
    const i = stack.pop();
    if (i < 0 || i >= w * h || removed[i]) continue;
    if (!nearBlack(i)) continue;
    removed[i] = 1;
    const x = i % w, y = (i / w) | 0;
    if (x > 0) stack.push(i - 1);
    if (x < w - 1) stack.push(i + 1);
    if (y > 0) stack.push(i - w);
    if (y < h - 1) stack.push(i + w);
  }
  // alpha 通道 + 边缘羽化
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const [r, g, b] = px(i * ch);
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = removed[i] ? 0 : 255;
  }
  const alpha = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) alpha[i] = rgba[i * 4 + 3];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (alpha[i] === 255) {
        const n = alpha[i - 1] + alpha[i + 1] + alpha[i - w] + alpha[i + w];
        if (n < 4 * 255) rgba[i * 4 + 3] = 200; // 边缘半透明，弱化锯齿
      } else if (alpha[i] === 0) {
        const n = alpha[i - 1] + alpha[i + 1] + alpha[i - w] + alpha[i + w];
        if (n > 0) rgba[i * 4 + 3] = 90; // 轻微回收半影
      }
    }
  }
  return { w, h, data: rgba };
}

// ---------- 双线性降采样（RGBA） ----------
function resize(img, tw) {
  const { w, h, data } = img;
  const th = Math.round((h * tw) / w);
  const out = Buffer.alloc(tw * th * 4);
  for (let y = 0; y < th; y++) {
    const sy = (y + 0.5) * (h / th) - 0.5;
    const y0 = Math.max(0, Math.floor(sy)), y1 = Math.min(h - 1, y0 + 1), fy = sy - y0;
    for (let x = 0; x < tw; x++) {
      const sx = (x + 0.5) * (w / tw) - 0.5;
      const x0 = Math.max(0, Math.floor(sx)), x1 = Math.min(w - 1, x0 + 1), fx = sx - x0;
      const i00 = (y0 * w + x0) * 4, i10 = (y0 * w + x1) * 4, i01 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
      const o = (y * tw + x) * 4;
      for (let c = 0; c < 4; c++) {
        const top = data[i00 + c] * (1 - fx) + data[i10 + c] * fx;
        const bot = data[i01 + c] * (1 - fx) + data[i11 + c] * fx;
        out[o + c] = Math.round(top * (1 - fy) + bot * fy);
      }
    }
  }
  return { w: tw, h: th, data: out };
}

// ---------- 裁掉全透明边缘 ----------
function trimAlpha(img) {
  const { w, h, data } = img;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return img;
  const tw = maxX - minX + 1, th = maxY - minY + 1;
  const out = Buffer.alloc(tw * th * 4);
  for (let y = 0; y < th; y++) {
    data.copy(out, y * tw * 4, ((minY + y) * w + minX) * 4, ((minY + y) * w + maxX + 1) * 4);
  }
  return { w: tw, h: th, data: out };
}

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(QA, { recursive: true });

// ---------- 物体素材（黑底抠图） ----------
const OBJECTS = [
  ['dog_stand.png', 'dog-cream.png'],
  ['dog_variant_02.png', 'dog-caramel.png'],
  ['dog_variant_03.png', 'dog-cocoa.png'],
  ['dog_variant_04.png', 'dog-wheat.png'],
  ['dog_sit.png', 'dog-sit.png'],
  ['dog_sleep.png', 'dog-sleep.png'],
  ['dog_carry.png', 'dog-carry.png'],
  ['treasure_shell.png', 'obj-shell.png'],
  ['treasure_envelope.png', 'obj-ticket.png'],
  ['treasure_stump_box.png', 'obj-pot.png'],
  ['treasure_umbrella.png', 'obj-umbrella.png'],
  ['treasure_tent.png', 'obj-tent.png'],
  ['treasure_dome.png', 'obj-cup.png'],
  ['treasure_camera.png', 'obj-camera.png'],
  ['treasure_boat.png', 'obj-boat.png'],
  ['treasure_suitcase.png', 'obj-suitcase.png'],
  ['treasure_plant.png', 'obj-plant.png'],
  ['treasure_big_tent.png', 'obj-big-tent.png'],
  ['treasure_plant_alt.png', 'obj-plant-alt.png'],
];

// ---------- 场景素材（保留背景，仅降采样） ----------
const SCENES = [
  ['gateway.png', 'scene-gateway.png'],
  ['home_room.png', 'scene-home.png'],
  ['delivery.png', 'scene-delivery.png'],
  ['placement.png', 'scene-placement.png'],
];

const keyed = [];
for (const [srcName, outName] of OBJECTS) {
  const img = keyBlack(decodePNG(path.join(SRC, srcName)));
  const small = resize(trimAlpha(img), 448);
  fs.writeFileSync(path.join(OUT, outName), encodePNG(small.w, small.h, small.data));
  keyed.push({ name: outName, img: small });
  console.log('✔', outName, small.w + 'x' + small.h);
}
for (const [srcName, outName] of SCENES) {
  const img = decodePNG(path.join(SRC, srcName));
  const rgba = Buffer.alloc(img.w * img.h * 4);
  const { ch, data } = img;
  for (let i = 0; i < img.w * img.h; i++) {
    if (ch === 3) {
      rgba[i * 4] = data[i * 3]; rgba[i * 4 + 1] = data[i * 3 + 1]; rgba[i * 4 + 2] = data[i * 3 + 2]; rgba[i * 4 + 3] = 255;
    } else if (ch === 1) {
      rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = data[i]; rgba[i * 4 + 3] = 255;
    } else {
      rgba[i * 4] = data[i * 4]; rgba[i * 4 + 1] = data[i * 4 + 1]; rgba[i * 4 + 2] = data[i * 4 + 2]; rgba[i * 4 + 3] = data[i * 4 + 3];
    }
  }
  const small = resize({ w: img.w, h: img.h, data: rgba }, 900);
  fs.writeFileSync(path.join(OUT, outName), encodePNG(small.w, small.h, small.data));
  console.log('✔', outName, small.w + 'x' + small.h);
}

// ---------- 对照表（5 列网格，仅供人工核对） ----------
{
  const cell = 240, pad = 10, cols = 5;
  const rows = Math.ceil(keyed.length / cols);
  const W = cols * cell, H = rows * cell;
  const sheet = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const x = i % W, y = (i / W) | 0;
    const on = ((x / 24 | 0) + (y / 24 | 0)) % 2 === 0;
    const v = on ? 235 : 220;
    sheet[i * 4] = v; sheet[i * 4 + 1] = v - 4; sheet[i * 4 + 2] = v - 12; sheet[i * 4 + 3] = 255;
  }
  const blend = (di, s, a) => {
    const da = sheet[di + 3] / 255, sa = a / 255;
    const oa = sa + da * (1 - sa);
    if (oa === 0) return;
    for (let c = 0; c < 3; c++) sheet[di + c] = Math.round((s[c] * sa + sheet[di + c] * da * (1 - sa)) / oa);
    sheet[di + 3] = Math.round(oa * 255);
  };
  keyed.forEach((k, idx) => {
    const cx = (idx % cols) * cell + pad, cy = ((idx / cols) | 0) * cell + pad;
    const { w, h, data } = k.img;
    const scale = Math.min((cell - pad * 2) / w, (cell - pad * 2 - 18) / h);
    const dw = Math.round(w * scale), dh = Math.round(h * scale);
    const ox = cx + Math.round((cell - pad * 2 - dw) / 2), oy = cy + 18 + Math.round((cell - pad * 2 - 18 - dh) / 2);
    for (let y = 0; y < dh; y++) {
      for (let x = 0; x < dw; x++) {
        const si = (((y / scale) | 0) * w + ((x / scale) | 0)) * 4;
        const di = ((oy + y) * W + ox + x) * 4;
        if (di < 0 || di + 3 >= sheet.length) continue;
        blend(di, [data[si], data[si + 1], data[si + 2]], data[si + 3]);
      }
    }
    // 底部文字条（简易位数字）
    const label = String(idx + 1).padStart(2, '0') + ' ' + k.name.replace('.png', '');
    for (let x = 0; x < label.length * 6 && cx + x < W; x++) {
      for (let y = 0; y < 12; y++) {
        const di = ((cy + 3 + y) * W + cx + x) * 4;
        sheet[di] = 60; sheet[di + 1] = 46; sheet[di + 2] = 36; sheet[di + 3] = 255;
      }
    }
  });
  fs.writeFileSync(path.join(QA, 'ui-assets-contact-sheet.png'), encodePNG(W, H, sheet));
  console.log('✔ contact sheet → _qa/ui-assets-contact-sheet.png');
}
console.log('done');
