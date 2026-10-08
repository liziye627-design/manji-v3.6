// 慢记 Manji v3.1 —— 导出文件存储
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

function abs(key) {
  return path.join(config.mediaRoot, key);
}

export function writeExportFile(key, buf) {
  const p = abs(key);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, buf);
}

export function readExportFile(key) {
  const p = abs(key);
  return existsSync(p) ? readFileSync(p) : null;
}
