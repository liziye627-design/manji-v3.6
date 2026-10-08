// 慢记 Manji v3.4 —— 永恒之链专项验收测试
// 覆盖：约定与日记上链、双方同意门槛、同一版本幂等、版本演进、隐私（正文/身份不上链）、
//       全链校验与篡改检测、存证凭证、整链导出、跨家隔离。运行：node tests/chain-acceptance.mjs
// 脚本自起独立测试服务（随机端口 + 临时数据目录），结束后自动清理。

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4600 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'manji-chain-test-'));
const DB_PATH = path.join(DATA_DIR, 'test.db');

const results = [];
function record(id, name, pass, detail = '') {
  results.push({ id, name, pass, detail });
  console.log(`${pass ? '✓' : '✗'} ${id} ${name}${detail ? (pass ? '  — ' : '  — 【失败】') + detail : ''}`);
}
async function check(id, name, cond, detail = '') {
  record(id, name, !!cond, cond ? detail : detail || '条件不成立');
  return !!cond;
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

class Session {
  constructor(name) {
    this.name = name;
    this.cookie = '';
  }
  jar(res) {
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
  }
  async req(method, apiPath, body, opts = {}) {
    const headers = { 'X-Manji-Client': '1' };
    if (this.cookie) headers.Cookie = this.cookie;
    let payload;
    if (body instanceof Uint8Array) {
      headers['Content-Type'] = 'application/octet-stream';
      payload = body;
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    if (opts.headers) Object.assign(headers, opts.headers);
    const res = await fetch(BASE + apiPath, { method, headers, body: payload, redirect: 'manual' });
    this.jar(res);
    if (opts.raw) return res;
    let json = null;
    try {
      json = await res.json();
    } catch {}
    return { status: res.status, json };
  }
  async register(displayName) {
    const r = await this.req('POST', '/api/auth/register', { displayName, password: 'test-password-8' });
    if (r.status !== 201) throw new Error(`注册失败: ${JSON.stringify(r.json)}`);
    return r.json.data;
  }
}

let server;
function startServer() {
  return new Promise((resolve, reject) => {
    server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
      env: { ...process.env, PORT: String(PORT), DB_PATH, MEDIA_ROOT: path.join(DATA_DIR, 'media') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stderr.on('data', (d) => console.error('[srv-err]', d.toString().trim()));
    const wait = setInterval(() => {
      fetch(`${BASE}/api/me`).then((r) => {
        if (r.status === 401) {
          clearInterval(wait);
          resolve();
        }
      }).catch(() => {});
    }, 250);
    setTimeout(() => {
      clearInterval(wait);
      reject(new Error('服务启动超时'));
    }, 15000);
  });
}
function stopServer() {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.on('exit', () => resolve());
    server.kill();
    setTimeout(() => resolve(), 3000);
  });
}

async function main() {
  await startServer();
  const A = new Session('A');
  const B = new Session('B');
  const C = new Session('C'); // 另一个家的旁观者
  const meA = await A.register('链A');
  const meB = await B.register('链B');
  const meC = await C.register('链C');

  // A 邀请 B 成家
  const inv = (await A.req('POST', `/api/homes/${meA.home.id}/invites`, {})).json.data;
  await B.req('POST', '/api/invites/accept', { token: inv.token });

  // ---------- 约定上链 ----------
  // CH01 共同约定：对方未确认前不能上链（自愿与共同同意）
  const pr1 = (await A.req('POST', '/api/promises', { text: '每年秋天去看一次海', scope: 'shared' })).json.data.promiseId;
  const early = await A.req('POST', '/api/chain/anchor', { type: 'promise', id: pr1 });
  await check('CH01', '对方未点"我也愿意"前不能上链', early.status === 409 && early.json.error.code === 'PROMISE_NOT_CONFIRMED',
    `status=${early.status}`);

  // CH02 B 确认后，任一成员可上链，出块并带 PoW 前导零
  await B.req('POST', `/api/promises/${pr1}/accept`, {});
  const anc1 = await A.req('POST', '/api/chain/anchor', { type: 'promise', id: pr1 });
  await check('CH02', '双方同意后可镌刻上链（第 1 块）', anc1.status === 201 && anc1.json.data?.blockHeight === 1,
    JSON.stringify(anc1.json.data || anc1.json));
  await check('CH03', '区块哈希带工作量证明前导 0000', /^0000/.test(anc1.json.data?.blockHash || ''), (anc1.json.data?.blockHash || '').slice(0, 12));

  // CH04 同一版本重复上链被拒
  const dup = await B.req('POST', '/api/chain/anchor', { type: 'promise', id: pr1 });
  await check('CH04', '同一版本只镌刻一次', dup.status === 409 && dup.json.error.code === 'ALREADY_ON_CHAIN', `status=${dup.status}`);

  // CH05 修改后新版本可再上链，旧块保留（superseded）
  const cur = (await A.req('GET', '/api/promises')).json.data.items.find((p) => p.id === pr1);
  await A.req('PATCH', `/api/promises/${pr1}`, { text: '每年秋天去看一次海，捡一枚贝壳', expectedRevision: cur.revision });
  await B.req('POST', `/api/promises/${pr1}/accept`, {}); // 重要修改后重新确认
  const anc2 = await B.req('POST', '/api/chain/anchor', { type: 'promise', id: pr1 });
  const verifyAfterEdit = (await A.req('GET', '/api/chain/verify')).json.data || { anchors: [] };
  const statuses = verifyAfterEdit.anchors.map((a) => a.status);
  await check('CH05', '修改后新版本上链、旧块永存', anc2.status === 201 && verifyAfterEdit.ok && statuses.includes('superseded') && statuses.includes('intact'),
    `block=${anc2.json.data?.blockHeight} statuses=${statuses.join(',')}`);

  // ---------- 日记上链 ----------
  const mem = (await A.req('POST', '/api/memories', { eventDate: '2026-10-08', text: '小狗第一次握手，爪子软软的。', visibility: 'home', topic: '日常' })).json.data;
  const anc3 = await A.req('POST', '/api/chain/anchor', { type: 'contribution', id: mem.contributionId });
  await check('CH06', '日记（我的视角）可由本人上链', anc3.status === 201 && anc3.json.data.blockHeight === 3, `status=${anc3.status}`);

  // CH07 不能替对方上链
  const bContrib = (await B.req('POST', `/api/memories/${mem.memoryId}/contributions`, { text: '它对我们摇了很久尾巴。', visibility: 'home' })).json.data;
  const steal = await A.req('POST', '/api/chain/anchor', { type: 'contribution', id: bContrib.contributionId });
  await check('CH07', '不能替对方把日记上链', steal.status === 403 || steal.status === 404, `status=${steal.status}`);
  const bAnchor = await B.req('POST', '/api/chain/anchor', { type: 'contribution', id: bContrib.contributionId });
  await check('CH07b', '对方本人可上链自己的日记', bAnchor.status === 201, `status=${bAnchor.status}`);

  // ---------- 隐私：链上没有正文与身份 ----------
  const exRes = await A.req('GET', '/api/chain/export', undefined, { raw: true });
  const exportText = await exRes.text();
  const leak =
    exportText.includes('贝壳') || exportText.includes('握手') || exportText.includes('尾巴') ||
    exportText.includes(meA.displayName) || exportText.includes(meB.displayName) || exportText.includes(meA.id) || exportText.includes(meB.id);
  await check('CH08', '整链导出不含正文与身份（只含指纹）', exRes.status === 200 && !leak, `bytes=${exportText.length}`);

  // CH09 导出的链可被第三方独立复算验证
  const exported = JSON.parse(exportText);
  let independentOk = exported.blocks.length >= 5 && !!exported.chainId;
  let prev = '0'.repeat(64);
  for (let i = 0; i < exported.blocks.length; i++) {
    const b = exported.blocks[i];
    const hash = sha256(['manji-block-v1', exported.chainId, String(b.height), b.timestamp, b.prevHash, JSON.stringify(b.payload), String(b.nonce)].join('|'));
    if (b.height !== i || b.prevHash !== prev || !hash.startsWith('0000') || hash !== b.hash) { independentOk = false; break; }
    prev = b.hash;
  }
  await check('CH09', '第三方用 chainId 独立复算全部区块哈希与链接', independentOk, `blocks=${exported.blocks.length}`);

  // ---------- 存证凭证 ----------
  const proofRes = await A.req('GET', `/api/chain/proof/${anc3.json.data.anchorId}`, undefined, { raw: true });
  const proof = JSON.parse(await proofRes.text());
  // 独立复算承诺：与 service 端相同语义（键排序 JSON + 盐），文本用测试已知的原文
  const canon = (v) =>
    v === null || v === undefined ? 'null'
    : Array.isArray(v) ? `[${v.map(canon).join(',')}]`
    : typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`
    : JSON.stringify(v);
  const diaryText = '小狗第一次握手，爪子软软的。';
  const myCanonical = {
    type: 'contribution', id: mem.contributionId, memoryId: mem.memoryId, version: 1,
    text: diaryText, contentHash: sha256(diaryText), photos: [],
  };
  const myCommitment = sha256(`manji-anchor-v1
${canon(myCanonical)}
${proof.salt}`);
  await check('CH10', '存证凭证可离线复算出同一承诺', proofRes.status === 200 && proof.commitment === myCommitment && proof.salt.length === 64 && !!proof.howToVerify,
    proof.commitment === myCommitment ? '复算一致' : '复算不一致');

  // CH10b 非本家成员拿不到凭证
  const cProof = await C.req('GET', `/api/chain/proof/${anc3.json.data.anchorId}`);
  await check('CH10b', '其他家成员拿不到存证凭证', cProof.status === 404 || cProof.status === 403, `status=${cProof.status}`);

  // ---------- 跨家隔离 ----------
  const chainA = (await A.req('GET', '/api/chain')).json.data;
  const chainC = (await C.req('GET', '/api/chain')).json.data;
  await check('CH11', '每家一条独立链（C 家只有创世块）', chainA.height >= 4 && chainC.height === 0 && chainC.anchors.length === 0,
    `A高度=${chainA.height} C高度=${chainC.height}`);

  // ---------- 徽标入详情 ----------
  const plist = (await B.req('GET', '/api/promises')).json.data.items.find((p) => p.id === pr1);
  const detail = (await B.req('GET', `/api/memories/${mem.memoryId}`)).json.data;
  const bContribPayload = detail.contributions.find((c) => c.mine); // B 自己的那份（B 会话）
  await check('CH12', '约定/日记详情带链上徽标', plist.onChain?.blockHeight === anc2.json.data.blockHeight && bContribPayload.onChain?.blockHeight === bAnchor.json.data.blockHeight,
    `promise#${plist.onChain?.blockHeight} diary#${bContribPayload.onChain?.blockHeight}`);

  // ---------- 删除与不可改变 ----------
  const del = await B.req('DELETE', `/api/contributions/${bContrib.contributionId}`);
  const vDel = (await A.req('GET', '/api/chain/verify')).json.data;
  const goneAnchor = vDel.anchors.find((a) => a.anchorId === bAnchor.json.data.anchorId);
  await check('CH13', '删除内容后链不回退：指纹仍在（gone）', del.status === 200 && vDel.ok && goneAnchor.status === 'gone',
    `status=${goneAnchor?.status}`);

  // ---------- 篡改检测 ----------
  const db = new DatabaseSync(DB_PATH);
  const orig = db.prepare('SELECT payload FROM chain_blocks WHERE height = 2').get().payload;
  db.prepare('UPDATE chain_blocks SET payload = ? WHERE height = 2').run(orig.replace(/"commitment":"[0-9a-f]{4}/, '"commitment":"dead'));
  const vTamper = (await A.req('GET', '/api/chain/verify')).json.data;
  await check('CH14', '篡改区块内容被全链校验发现并定位', vTamper.ok === false && vTamper.brokenAt === 2, `ok=${vTamper.ok} brokenAt=${vTamper.brokenAt}`);
  db.prepare('UPDATE chain_blocks SET payload = ? WHERE height = 2').run(orig);
  db.close();
  const vRestored = (await A.req('GET', '/api/chain/verify')).json.data;
  await check('CH15', '恢复后链条重新验证通过', vRestored.ok === true, `ok=${vRestored.ok}`);

  // ---------- 解除后链不再增长 ----------
  await A.req('POST', `/api/homes/${meA.home.id}/unlink`, { confirm: true });
  const afterFreeze = await B.req('POST', '/api/chain/anchor', { type: 'promise', id: pr1 });
  await check('CH16', '家解除关联后链条定格（拒绝新锚定）', afterFreeze.status === 409 || afterFreeze.status === 404 || afterFreeze.status === 503,
    `status=${afterFreeze.status}`);

  // 汇总
  const passed = results.filter((r) => r.pass).length;
  console.log('========================================');
  console.log(`永恒之链验收结果：${passed}/${results.length} 通过`);
  console.log('========================================');
  process.exitCode = passed === results.length ? 0 : 1;
}

main()
  .catch((err) => {
    console.error('测试执行失败：', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await stopServer();
    try {
      rmSync(DATA_DIR, { recursive: true, force: true });
    } catch {}
  });
