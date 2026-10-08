// 慢记 Manji v3.5 —— 旧链升级兼容专项测试（B01 验收）
// 复现实测报告 B01 场景：用旧哈希规则（区块哈希包含 home_id）造一条"升级前"的链，
// 再用 v3.5 打开同一个数据库，验证：
//   1. 旧链不再被误判为损坏（integrity.ok=true）；
//   2. 旧链可以继续延伸（新块沿用旧规则，全链仍可验证）；
//   3. 整链导出包含参与哈希的家编号，第三方仅凭导出文件可离线复算每个区块；
//   4. 存证凭证 canonicalFields 是真实内容字段（B05），可离线复算承诺；
//   5. v3.4 在旧链上误建的随机 chain_meta 会被清理，不误导导出；
//   6. 篡改旧块仍会被全链校验发现；
//   7. 新建链继续使用随机 chainId 规则（不受兼容逻辑影响）。
// 运行：node tests/upgrade-compat.mjs（自起独立服务与临时数据库，结束后清理）

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5000 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'manji-upgrade-test-'));
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
  async req(method, apiPath, body) {
    const headers = { 'X-Manji-Client': '1' };
    if (this.cookie) headers.Cookie = this.cookie;
    let payload;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(BASE + apiPath, { method, headers, body: payload });
    this.jar(res);
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
    }, 20000);
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

/** 把一条 v3.5 造出的链整体"改写回"旧规则：重挖每个区块（哈希含 home_id），并抹掉新版的算法列与 chain_meta */
function downgradeChainToV1(db, homeId) {
  try {
    db.prepare('ALTER TABLE chain_blocks DROP COLUMN hash_algo').run();
  } catch {
    // 列不存在（本来就是旧库）
  }
  db.prepare('DELETE FROM chain_meta').run();
  const blocks = db.prepare('SELECT * FROM chain_blocks WHERE home_id = ? ORDER BY height ASC').all(homeId);
  let prevHash = '0'.repeat(64);
  for (const b of blocks) {
    let nonce = 0;
    let hash = '';
    for (;;) {
      hash = sha256(['manji-block-v1', homeId, b.height, b.timestamp, prevHash, b.payload, nonce].join('|'));
      if (hash.startsWith('0000')) break;
      nonce++;
    }
    db.prepare('UPDATE chain_blocks SET prev_hash = ?, nonce = ?, hash = ? WHERE home_id = ? AND height = ?').run(
      prevHash, nonce, hash, homeId, b.height
    );
    prevHash = hash;
  }
  // 模拟 v3.4 在旧链上调用过校验/导出：误建一条与任何区块都无关的随机 chain_meta
  db.prepare('INSERT INTO chain_meta (home_id, chain_id, created_at) VALUES (?, ?, ?)').run(
    homeId, `bogus-${crypto.randomBytes(8).toString('hex')}`, new Date().toISOString()
  );
}

async function main() {
  // ---------- 阶段一：v3.5 正常造一条链（拿到 home / promise / anchor） ----------
  await startServer();
  const A = new Session('A');
  const meA = await A.register('升级A');
  const homeId = meA.home.id;
  const pr1 = (await A.req('POST', '/api/promises', { text: '旧版本里刻下的话', scope: 'personal' })).json.data.promiseId;
  const anc1 = await A.req('POST', '/api/chain/anchor', { type: 'promise', id: pr1 });
  if (anc1.status !== 201) throw new Error('阶段一锚定失败: ' + JSON.stringify(anc1.json));
  const anchorId = anc1.json.data.anchorId;
  await stopServer();

  // ---------- 阶段二：把数据库降级成"升级前"的旧链 ----------
  {
    const db = new DatabaseSync(DB_PATH);
    downgradeChainToV1(db, homeId);
    db.close();
  }

  // ---------- 阶段三：v3.5 打开旧库（升级路径） ----------
  await startServer();
  try {
    // UP01 旧链不再被误判损坏
    const overview = (await A.req('GET', '/api/chain')).json.data;
    await check('UP01', '升级后旧链完整（不再从第 0 块断裂）', overview.integrity.ok === true && overview.height >= 1,
      `ok=${overview.integrity.ok} brokenAt=${overview.integrity.brokenAt} height=${overview.height}`);

    // UP02 旧链可继续延伸，且全链仍可验证
    const pr2 = (await A.req('POST', '/api/promises', { text: '升级后继续刻的话', scope: 'personal' })).json.data.promiseId;
    const anc2 = await A.req('POST', '/api/chain/anchor', { type: 'promise', id: pr2 });
    const overview2 = (await A.req('GET', '/api/chain')).json.data;
    await check('UP02', '旧链继续延伸且整链可验证', anc2.status === 201 && overview2.integrity.ok === true && overview2.height === overview.height + 1,
      `newBlock=${anc2.json.data?.blockHeight} ok=${overview2.integrity.ok}`);

    // UP03 导出仅凭文件可离线复算全部区块（含旧块与新延伸块）
    const exportRes = await fetch(`${BASE}/api/chain/export`, { headers: { Cookie: A.cookie, 'X-Manji-Client': '1' } });
    const chainFile = await exportRes.json();
    const key = chainFile.legacyHomeKey;
    let allMatch = !!key && !chainFile.chainId; // 旧链：公布家编号，不公布无关的 chainId
    let prev = '0'.repeat(64);
    for (const b of chainFile.blocks) {
      const recomputed = sha256(['manji-block-v1', key, b.height, b.timestamp, b.prevHash, JSON.stringify(b.payload), b.nonce].join('|'));
      if (recomputed !== b.hash || b.prevHash !== prev || !b.hash.startsWith('0000')) {
        allMatch = false;
        break;
      }
      prev = b.hash;
    }
    await check('UP03', '整链导出可离线复算（legacyHomeKey 参与哈希）', allMatch,
      `blocks=${chainFile.blocks.length} legacy=${!!key} chainId=${chainFile.chainId || '无'}`);

    // UP04 存证凭证字段真实、承诺可离线复算（B05）
    const proofRes = await fetch(`${BASE}/api/chain/proof/${anchorId}`, { headers: { Cookie: A.cookie, 'X-Manji-Client': '1' } });
    const proof = await proofRes.json();
    const expectedFields = ['dueDate', 'id', 'note', 'revision', 'scope', 'text', 'type'].sort();
    const fieldsOk = JSON.stringify(proof.canonicalFields) === JSON.stringify(expectedFields);
    // 用承诺算法独立复算：规范编码（键排序）→ SHA-256(域 + "\n" + 编码 + "\n" + 盐)
    const p = (await A.req('GET', '/api/promises')).json.data.items.find((x) => x.id === pr1);
    const canonicalValue = (v) => {
      if (v === null || v === undefined) return 'null';
      if (Array.isArray(v)) return `[${v.map(canonicalValue).join(',')}]`;
      if (typeof v === 'object') {
        return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalValue(v[k])}`).join(',')}}`;
      }
      return JSON.stringify(v);
    };
    const content = {
      type: 'promise', id: pr1, revision: p.revision, text: p.text, note: p.note || '',
      dueDate: p.dueDate || '', scope: p.scope,
    };
    const recomputedCommitment = sha256(`manji-anchor-v1\n${canonicalValue(content)}\n${proof.salt}`);
    const legacyBlock = proof.block && proof.block.hashAlgo === 'v1-home-key' && proof.block.legacyHomeKey === homeId;
    await check('UP04', '凭证 canonicalFields 为真实字段且承诺可离线复算',
      fieldsOk && recomputedCommitment === proof.commitment && !!legacyBlock,
      `fields=${proof.canonicalFields?.join(',')} 承诺${recomputedCommitment === proof.commitment ? '一致' : '不一致'} 块算法=${proof.block?.hashAlgo}`);

    // UP05 误建的随机 chain_meta 已清理（导出不再出现无关 chainId —— 已在 UP03 断言 chainId 为空）
    {
      const db = new DatabaseSync(DB_PATH);
      const meta = db.prepare('SELECT COUNT(*) AS n FROM chain_meta WHERE home_id = ?').get(homeId).n;
      const algos = db.prepare('SELECT DISTINCT hash_algo AS a FROM chain_blocks WHERE home_id = ?').all(homeId).map((r) => r.a);
      db.close();
      await check('UP05', 'v3.4 误建的随机 chain_meta 已清理，旧链统一 v1 规则', meta === 0 && algos.every((a) => a === 'v1-home-key'),
        `meta=${meta} algos=${algos.join(',')}`);
    }

    // UP06 篡改旧块仍会被发现（兼容不是放水）
    await stopServer();
    {
      const db = new DatabaseSync(DB_PATH);
      // 区块 payload 只含指纹不含正文：直接在载荷末尾附加一个字符，哈希必然对不上
      db.prepare("UPDATE chain_blocks SET payload = payload || ' ' WHERE home_id = ? AND height = 1").run(homeId);
      db.close();
    }
    await startServer();
    const tampered = (await A.req('GET', '/api/chain')).json.data;
    await check('UP06', '篡改旧链内容仍被全链校验发现', tampered.integrity.ok === false && tampered.integrity.brokenAt === 1,
      `ok=${tampered.integrity.ok} brokenAt=${tampered.integrity.brokenAt}`);

    // UP07 新链不受影响：新注册用户的链继续使用随机 chainId 规则
    const D = new Session('D');
    await D.register('新链D');
    const prd = (await D.req('POST', '/api/promises', { text: '新链继续新规则', scope: 'personal' })).json.data.promiseId;
    await D.req('POST', '/api/chain/anchor', { type: 'promise', id: prd });
    const dExportRes = await fetch(`${BASE}/api/chain/export`, { headers: { Cookie: D.cookie, 'X-Manji-Client': '1' } });
    const dChain = await dExportRes.json();
    let dMatch = !!dChain.chainId && !dChain.legacyHomeKey;
    let dPrev = '0'.repeat(64);
    for (const b of dChain.blocks) {
      const recomputed = sha256(['manji-block-v1', dChain.chainId, b.height, b.timestamp, b.prevHash, JSON.stringify(b.payload), b.nonce].join('|'));
      if (recomputed !== b.hash || b.prevHash !== dPrev) {
        dMatch = false;
        break;
      }
      dPrev = b.hash;
    }
    await check('UP07', '新链沿用随机 chainId 规则且可独立复算', dMatch,
      `blocks=${dChain.blocks.length} chainId=${dChain.chainId ? '有' : '无'}`);
  } finally {
    await stopServer();
    try {
      rmSync(DATA_DIR, { recursive: true, force: true });
    } catch {}
  }

  const passed = results.filter((r) => r.pass).length;
  console.log('========================================');
  console.log(`旧链升级兼容结果：${passed}/${results.length} 通过`);
  console.log('========================================');
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error('测试执行失败：', err);
  process.exitCode = 1;
  stopServer().finally(() => {
    try {
      rmSync(DATA_DIR, { recursive: true, force: true });
    } catch {}
  });
});
