// Local launcher: verifies the port, starts this app with its own data, then opens login.
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = 'http://127.0.0.1:4332';
const noBrowser = process.argv.includes('--no-browser');
async function existing() {
  let response;
  try { response = await fetch(base + '/app.js', { signal: AbortSignal.timeout(1500) }); }
  catch { return false; }
  const text = await response.text();
  if (!response.ok || !text.includes("from './room/room.js'")) throw new Error('Port 4332 belongs to another app. Keep it running and choose another port manually.');
  return true;
}
if (!(await existing())) {
  const data = path.join(root, 'data'); mkdirSync(data, { recursive: true });
  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: root, detached: true, windowsHide: true,
    env: { ...process.env, PORT: '4332', DB_PATH: path.join(data, 'manji.db'), MEDIA_ROOT: path.join(data, 'media') },
    stdio: ['ignore', openSync(path.join(data, 'server.log'), 'a'), openSync(path.join(data, 'server-error.log'), 'a')],
  });
  server.unref(); writeFileSync(path.join(data, 'server.pid'), String(server.pid));
  let started = false;
  for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 250)); if (await existing()) { started = true; break; } }
  if (!started) throw new Error('Server did not start. See data/server-error.log.');
  const seed = spawn(process.execPath, ['scripts/seed-demo.mjs'], { cwd: root, windowsHide: true, env: { ...process.env, BASE_URL: base }, stdio: 'inherit' });
  await new Promise((resolve, reject) => { seed.on('error', reject); seed.on('exit', code => code === 0 ? resolve() : reject(new Error('Demo setup failed.'))); });
}
console.log('Interactive home: ' + base + '/#/login');
console.log('Demo: 体验官A / manji-2026-10');
if (!noBrowser) {
  const browser = spawn('cmd.exe', ['/c', 'start', '', base + '/#/login'], { windowsHide: true, stdio: 'ignore' });
  browser.on('error', () => console.log('Open the URL above in your browser.'));
  browser.unref();
}
