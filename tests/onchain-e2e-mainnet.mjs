// 慢记 Manji v3.6 —— 公共链锚定端到端实测（BOT Chain 主网，真实交易、真实 Gas）
// 全流程走应用 API：注册成家 → 共同约定双方同意 → 本地镌刻 → 提交公共链 → 主网确认 → sealOf 核验 → 头部锚定。
// 运行前置：.env 已配置主网 ONCHAIN_*，.env.local 已配置 ONCHAIN_RELAYER_KEY，已 npm i（可选依赖 ethers）。
// 运行：node tests/onchain-e2e-mainnet.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4900 + Math.floor(Math.random() * 80);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'manji-onchain-e2e-'));

class Session {
  constructor() { this.cookie = ''; }
  jar(res) { const set = res.headers.get('set-cookie'); if (set) this.cookie = set.split(';')[0]; }
  async req(method, apiPath, body) {
    const headers = { 'X-Manji-Client': '1' };
    if (this.cookie) headers.Cookie = this.cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(BASE + apiPath, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    this.jar(res);
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, json };
  }
  async register(displayName) {
    const r = await this.req('POST', '/api/auth/register', { displayName, password: 'test-password-8' });
    if (r.status !== 201) throw new Error('注册失败: ' + JSON.stringify(r.json));
    return r.json.data;
  }
}

let server;
function startServer() {
  return new Promise((resolve, reject) => {
    server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
      env: { ...process.env, PORT: String(PORT), DB_PATH: path.join(DATA_DIR, 'test.db'), MEDIA_ROOT: path.join(DATA_DIR, 'media') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', (d) => process.stdout.write('[srv] ' + d.toString()));
    server.stderr.on('data', (d) => process.stderr.write('[srv-err] ' + d.toString()));
    const wait = setInterval(() => {
      fetch(`${BASE}/api/me`).then((r) => { if (r.status === 401) { clearInterval(wait); resolve(); } }).catch(() => {});
    }, 250);
    setTimeout(() => { clearInterval(wait); reject(new Error('服务启动超时')); }, 20000);
  });
}
async function stopServer() {
  if (!server) return;
  const done = new Promise((r) => { server.on('exit', r); setTimeout(r, 3000); });
  server.kill();
  await done;
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
}

const log = (mark, msg) => console.log(`${mark} ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function poll(fn, what, timeoutMs = 150_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await fn();
    if (r) return r;
    await sleep(5000);
    process.stdout.write('.');
  }
  throw new Error(`等待超时：${what}`);
}

async function main() {
  await startServer();
  try {
    const A = new Session();
    const B = new Session();
    const meA = await A.register('小明');
    const meB = await B.register('小红');
    const inv = (await A.req('POST', `/api/homes/${meA.home.id}/invites`, {})).json.data;
    await B.req('POST', '/api/invites/accept', { token: inv.token });
    log('✓', '两人成家完成');

    // 状态接口：应显示 auto 模式 + 主网合约
    const st = (await A.req('GET', '/api/chain/onchain/status')).json.data;
    if (st.mode !== 'auto') throw new Error(`期望 auto 模式，实际 ${st.mode}（检查 .env/.env.local）`);
    log('✓', `公共链状态：${st.modeText} · 合约 ${st.contract}`);

    // 1) 共同约定：双方同意 → 本地镌刻 → 提交公共链
    const pr1 = (await A.req('POST', '/api/promises', { text: '把今天的日记刻进 BOT 主网', scope: 'shared' })).json.data.promiseId;
    await B.req('POST', `/api/promises/${pr1}/accept`, {});
    const anchor = (await A.req('POST', '/api/chain/anchor', { type: 'promise', id: pr1 })).json.data;
    log('✓', `本地镌刻：第 ${anchor.blockHeight} 块，承诺 ${anchor.commitment.slice(0, 16)}…`);
    const sealReq = await A.req('POST', `/api/chain/onchain/${anchor.anchorId}`);
    if (sealReq.status !== 201) throw new Error('提交公共链请求失败: ' + JSON.stringify(sealReq.json));
    log('✓', '已加入公共链提交队列（后台 15 秒内自动发送）');

    // 2) 日记：本人镌刻 → 提交公共链
    const mem = (await A.req('POST', '/api/memories', { eventDate: '2026-10-08', text: '小狗今天第一次把日记送上了主网。', visibility: 'home', topic: '日常' })).json.data;
    const anchor2 = (await A.req('POST', '/api/chain/anchor', { type: 'contribution', id: mem.contributionId })).json.data;
    const sealReq2 = await A.req('POST', `/api/chain/onchain/${anchor2.anchorId}`);
    if (sealReq2.status !== 201) throw new Error('日记提交失败: ' + JSON.stringify(sealReq2.json));
    log('✓', `日记已入队（本地第 ${anchor2.blockHeight} 块）`);

    // 3) 等两条都在主网确认（sealBatch 批量一笔交易）
    const confirmed = await poll(async () => {
      const list = (await A.req('GET', '/api/chain/onchain')).json.data.items;
      return list.length === 2 && list.every((i) => i.status === 'confirmed') ? list : null;
    }, '公共链确认');
    console.log();
    for (const c of confirmed) {
      log('✓', `${c.label}已上主网：index=${c.sealIndex} tx=${c.txHash}`);
      log('  ', `浏览器：${c.explorerUrl}`);
    }

    // 4) sealOf 实时核验（这一步任何人都能独立完成，不依赖本应用）
    const v = (await A.req('GET', `/api/chain/onchain/verify/${anchor.anchorId}`)).json.data;
    if (!v.onChain.found) throw new Error('sealOf 核验失败');
    log('✓', `sealOf 核验：found=${v.onChain.found} index=${v.onChain.sealIndex} sealedAt=${v.onChain.sealedAt}`);

    // 5) 本地链头部锚定
    const head = (await A.req('POST', '/api/chain/onchain/head')).json.data;
    log('✓', `头部锚定入队：本地高度 ${head.localHeight}，头哈希 ${head.headHash.slice(0, 16)}…`);
    const headDone = await poll(async () => {
      // 再次发起是幂等的（同高度不会重复入队），借返回值观察当前状态
      const again = (await A.req('POST', '/api/chain/onchain/head')).json.data;
      return again.status === 'confirmed' ? again : null;
    }, '头部锚定确认');
    console.log();
    log('✓', `头部锚定已上主网：tx=${headDone.txHash}`);

    console.log('\n========================================');
    console.log('端到端实测通过：约定与日记的承诺已在 BOT 主链登记，并可独立核验');
    console.log('========================================');
  } finally {
    await stopServer();
  }
}

main().catch((e) => { console.error('\n【失败】', e.message); process.exitCode = 1; return stopServer().then(() => process.exit(process.exitCode || 1)); });
