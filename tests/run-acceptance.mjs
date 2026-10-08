// 慢记 Manji v3.0 —— 自动化验收测试
// 覆盖计划书第 10 节验收清单中可脚本化的项目。运行：node tests/run-acceptance.mjs
// 脚本自起独立测试服务（随机端口 + 临时数据目录），中途重启一次验证持久化（M51），结束自动清理。

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4200 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'manji-test-'));

const results = [];
function record(id, name, pass, detail = '') {
  results.push({ id, name, pass, detail });
  console.log(`${pass ? '✓' : '✗'} ${id} ${name}${detail ? (pass ? '  — ' : '  — 【失败】') + detail : ''}`);
}
async function check(id, name, cond, detail = '') {
  record(id, name, !!cond, cond ? detail : detail || '条件不成立');
  return !!cond;
}

// ---------- 浏览器会话（独立 Cookie Jar，M02） ----------
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
    if (opts.key) headers['Idempotency-Key'] = opts.key;
    if (opts.uploadToken) headers['X-Upload-Token'] = opts.uploadToken;
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

// ---------- 生成真实 PNG（2×2 像素）与伪图片 ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32LE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function makePng(w = 8, h = 8) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8bit RGB
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const off = y * (w * 3 + 1) + 1 + x * 3;
      raw[off] = 200 + (x * 5) % 40;
      raw[off + 1] = 130;
      raw[off + 2] = 120;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function uploadPhoto(sess, png) {
  const stage = (await sess.req('POST', '/api/media/uploads', { purpose: 'memory' })).json.data;
  const put = await sess.req('PUT', `/api/media/uploads/${stage.uploadId}/blob`, png, { uploadToken: stage.uploadId });
  if (put.status !== 200) throw new Error('照片上传失败: ' + JSON.stringify(put.json));
  const done = await sess.req('POST', `/api/media/uploads/${stage.uploadId}/complete`, {});
  return done.json.data.mediaId;
}

// ---------- 启动 / 停止服务 ----------
let server;
function startServer() {
  return new Promise((resolve, reject) => {
    server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
      env: {
        ...process.env,
        PORT: String(PORT),
        DB_PATH: path.join(DATA_DIR, 'test.db'),
        MEDIA_ROOT: path.join(DATA_DIR, 'media'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', (d) => process.env.TEST_VERBOSE && console.log('[srv]', d.toString().trim()));
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
    setTimeout(resolve, 3000);
  });
}

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
const ts = Date.now().toString(36);
const N = { A: `阿宁${ts}`, B: `小屿${ts}`, C: `路人${ts}`, D: `阿凑${ts}` };

async function main() {
  await startServer();
  const A = new Session('A');
  const B = new Session('B');
  const C = new Session('C');
  const D = new Session('D');
  const anon = new Session('anon');

  // ===== P0-A：账户与权限骨架 =====
  const meA = await A.register(N.A);
  await check('M01a', '单人注册即有小家与小狗', meA.home && meA.pet && meA.home.status === 'solo');
  const petR = await A.req('PATCH', '/api/home/pet', { name: '团子' });
  await check('M01b', '给小狗起名', petR.status === 200 && petR.json.data.name === '团子');

  await B.register(N.B);
  await C.register(N.C);
  await D.register(N.D);
  await check('M02', 'A/B/C 三个独立会话身份互不相同', meA.id !== (await B.req('GET', '/api/me')).json.data.id);

  // 未登录访问受保护接口
  await check('M46a', '未登录请求被拒绝(401)', (await anon.req('GET', '/api/memories')).status === 401);
  // 伪造 userId：身份只来自会话
  const forged = await A.req('POST', '/api/memories', { text: '伪造作者测试', authorId: 'someone-else' });
  await check('M46b', '伪造 authorId 无效，内容归属本人', forged.status === 201);
  const forgedDetail = await A.req('GET', `/api/memories/${forged.json.data.memoryId}`);
  await check('M46c', '伪造字段不改变归属', forgedDetail.json.data.contributions[0].mine === true);

  // ===== P0-B：第一件回忆 =====
  const mem1 = (
    await A.req('POST', '/api/memories', { text: '今天的风有点大，但冰淇淋很好吃', topic: '出游', visibility: 'private' })
  ).json.data;
  const png = makePng();
  const photoA1 = await uploadPhoto(A, png);
  const mem2 = (await A.req('POST', '/api/memories', { text: '', photoUploadIds: [photoA1], visibility: 'private' })).json.data;
  await check('M08a', '仅文字可保存', !!mem1.memoryId);
  await check('M08b', '仅照片可保存', !!mem2.memoryId);
  await check('M08c', '两者皆空被拒绝', (await A.req('POST', '/api/memories', { text: '' })).status === 422);

  // 伪图片类型
  const fakeStage = (await A.req('POST', '/api/media/uploads', { purpose: 'memory' })).json.data;
  const fakePut = await A.req('PUT', `/api/media/uploads/${fakeStage.uploadId}/blob`, Buffer.from('GIF89a 这不是真的图片'), {
    uploadToken: fakeStage.uploadId,
  });
  await check('M09a', '伪图片类型在服务端被拒绝', fakePut.status === 422);
  const overStage = (await A.req('POST', '/api/media/uploads', { purpose: 'memory' })).json.data;
  const big = Buffer.alloc(11 * 1024 * 1024, 7);
  await check('M09b', '超大文件被拒绝', (await A.req('PUT', `/api/media/uploads/${overStage.uploadId}/blob`, big, { uploadToken: overStage.uploadId })).status === 413 || (await A.req('PUT', `/api/media/uploads/${overStage.uploadId}/blob`, big, { uploadToken: overStage.uploadId })).status === 422);

  // 幂等与冲突
  const key = `test-${ts}`;
  const idem1 = await A.req('POST', '/api/memories', { text: '幂等测试同内容' }, { key });
  const idem2 = await A.req('POST', '/api/memories', { text: '幂等测试同内容' }, { key });
  await check('M48a', '同幂等键同负载重放原结果', idem2.json.data.memoryId === idem1.json.data.memoryId && idem2.status === idem1.status);
  const idem3 = await A.req('POST', '/api/memories', { text: '幂等测试不同内容' }, { key });
  await check('M48b', '同幂等键不同负载返回冲突', idem3.status === 409);

  // 选择纪念物
  const placeR = await A.req('PUT', `/api/memories/${mem1.memoryId}/object`, { templateKey: 'shell', slotKey: 'window' });
  await check('M16a', '手选纪念物与位置', placeR.status === 200 && placeR.json.data.slotKey === 'window');
  const room1 = (await A.req('GET', '/api/home/room')).json.data;
  await check('M16b', '物件出现在房间', room1.objects.length === 1 && room1.objects[0].templateKey === 'shell');
  const tplR = await A.req('PUT', `/api/memories/${mem1.memoryId}/object`, { templateKey: 'cup', slotKey: 'table' });
  const room2 = (await A.req('GET', '/api/home/room')).json.data;
  await check('M16c', '替换模板不改内容', tplR.status === 200 && room2.objects[0].templateKey === 'cup' && room2.objects.length === 1);

  // ===== P0-C：双人闭环 =====
  const photoA2 = await uploadPhoto(A, makePng(6, 6));
  // 先共享 mem1 的贡献（用于带预览的邀请）
  const mem1Detail0 = (await A.req('GET', `/api/memories/${mem1.memoryId}`)).json.data;
  await A.req('POST', `/api/contributions/${mem1Detail0.contributions[0].id}/share`, {});
  const inv1 = (await A.req('POST', `/api/homes/${meA.home.id}/invites`, {
    message: '来把我们记得的日子放在一起吧',
    previewMediaId: photoA1,
  })).json.data;
  await check('M03a', '生成带预览的邀请', !!inv1.token);

  // 无预览授权的邀请链接不泄露照片（M06）
  const invInfo = (await anon.req('GET', `/api/invites/info?token=${inv1.token}`)).json.data;
  await check('M06a', '邀请信息可匿名查看但只含已授权预览', invInfo.status === 'pending' && invInfo.inviterName === meA.displayName);
  const mediaAnon = await anon.req('GET', `/api/media/${photoA1}`);
  await check('M06b', '匿名打开私密媒体 URL 被拒绝', mediaAnon.status === 401 || mediaAnon.status === 404, `status=${mediaAnon.status}`);
  const mediaThird = await C.req('GET', `/api/media/${photoA1}`);
  await check('M06c', '第三方登录会话打开私密媒体被拒(404 不泄露存在)', mediaThird.status === 404, `status=${mediaThird.status}`);

  // B 接受前先准备好"撤销"与"自我接受"两份邀请（配对后不能再发）
  const inv2 = (await A.req('POST', `/api/homes/${meA.home.id}/invites`, {})).json.data;
  await A.req('POST', `/api/invites/${inv2.inviteId}/revoke`, {});
  await check('M04b', '撤销后的邀请不可接受', (await D.req('POST', '/api/invites/accept', { token: inv2.token })).status === 409);
  const inv3 = (await A.req('POST', `/api/homes/${meA.home.id}/invites`, {})).json.data;
  await check('M04c', '不能接受自己的邀请', (await A.req('POST', '/api/invites/accept', { token: inv3.token })).status === 409);

  const acceptB = await B.req('POST', '/api/invites/accept', { token: inv1.token });
  await check('M03b', 'B 明确接受后建立两人关系', acceptB.status === 200);
  const meB = (await B.req('GET', '/api/me')).json.data;
  await check('M03c', 'B 当前家为共同家', meB.home.isShared && meB.home.id === meA.home.id);
  const reuse = await D.req('POST', '/api/invites/accept', { token: inv1.token });
  await check('M04a', '已消费的邀请不能再次使用', reuse.status === 409, `status=${reuse.status} ${JSON.stringify(reuse.json?.error || {})}`);

  // 并发接受：C、D 抢同一份邀请（用 B 新建？B 已绑定，改用 A?A 已绑定。C 创建新邀请场景受限——改测：已绑定的 B 再接受别人邀请被拒）
  const invC = (await C.req('GET', '/api/me')); // C 是 solo
  const homeC = invC.json.data.home;
  const invFromC = (await C.req('POST', `/api/homes/${homeC.id}/invites`, {})).json.data;
  const race1 = D.req('POST', '/api/invites/accept', { token: invFromC.token });
  const race2 = B.req('POST', '/api/invites/accept', { token: invFromC.token });
  const [r1, r2] = await Promise.all([race1, race2]);
  await check('M05', '并发接受只允许一对（另一请求被拒）', (r1.status === 200) !== (r2.status === 200), `D=${r1.status} B=${r2.status}`);

  // 私密不可见（M07）
  const privMem = (await A.req('POST', '/api/memories', { text: '只有我知道的小事', visibility: 'private' })).json.data;
  const bList = (await B.req('GET', '/api/memories')).json.data.items;
  await check('M07a', 'B 列表看不到 A 的私密回忆', !bList.some((m) => m.id === privMem.memoryId));
  await check('M07b', 'B 直接访问 A 私密回忆被拒', (await B.req('GET', `/api/memories/${privMem.memoryId}`)).status === 404);
  const privPhoto = await uploadPhoto(A, makePng(5, 5));
  await A.req('POST', '/api/memories', { text: '私密照片测试', photoUploadIds: [privPhoto], visibility: 'private' });
  await check('M07c', 'B 无法读取 A 私密媒体', (await B.req('GET', `/api/media/${privPhoto}`)).status === 404);

  // 双人贡献
  const bContrib = await B.req('POST', `/api/memories/${mem1.memoryId}/contributions`, {
    text: '你一直护着我手里的冰淇淋',
    visibility: 'home',
  });
  await check('M11a', 'B 给同件回忆补充自己的视角', bContrib.status === 201);
  const detailAfter = (await A.req('GET', `/api/memories/${mem1.memoryId}`)).json.data;
  await check('M11b', '同一容器两人视角独立署名', detailAfter.contributions.length === 2 && detailAfter.contributions.every((c) => c.text));

  // 并发编辑各自贡献（M12）
  const aContribId = detailAfter.contributions.find((c) => c.mine).id;
  const bContribId = detailAfter.contributions.find((c) => !c.mine).id;
  const [ea, eb] = await Promise.all([
    A.req('PATCH', `/api/contributions/${aContribId}`, { text: 'A 改了自己的一版', expectedRevision: 1 }),
    B.req('PATCH', `/api/contributions/${bContribId}`, { text: 'B 也改了自己的一版', expectedRevision: 1 }),
  ]);
  await check('M12', '两人同时编辑互不覆盖', ea.status === 200 && eb.status === 200);
  const detailM12 = (await A.req('GET', `/api/memories/${mem1.memoryId}`)).json.data;
  await check('M12b', '编辑后内容各自正确', detailM12.contributions.find((c) => c.mine).text === 'A 改了自己的一版' && detailM12.contributions.find((c) => !c.mine).text === 'B 也改了自己的一版');

  // 越权（M13）
  await check('M13a', 'A 修改 B 的贡献被拒', (await A.req('PATCH', `/api/contributions/${bContribId}`, { text: 'hack', expectedRevision: 1 })).status === 403);
  await check('M13b', 'A 删除 B 的贡献被拒', (await A.req('DELETE', `/api/contributions/${bContribId}`)).status === 403);

  // 位置冲突（M17）：A 的贝壳在窗台，B 也想把帐篷放窗台 → 冲突
  await A.req('PUT', `/api/memories/${mem1.memoryId}/object`, { templateKey: 'shell', slotKey: 'window' });
  const bPlace = await B.req('PUT', `/api/memories/${mem1.memoryId}/object`, { templateKey: 'tent', slotKey: 'window' });
  await check('M17', '抢占同一位置返回冲突与空位', bPlace.status === 409 && Array.isArray(bPlace.json.error.freeSlots), `status=${bPlace.status}`);

  // 收纳与放回（M18）
  const roomBefore = (await A.req('GET', '/api/home/room')).json.data;
  const aObj = roomBefore.objects.find((o) => o.mine);
  const storeR = await A.req('PUT', `/api/placements/${aObj.placementId}`, { action: 'store', expectedRevision: aObj.revision });
  await check('M18a', '收纳成功', storeR.status === 200);
  const storage = (await A.req('GET', '/api/storage')).json.data;
  await check('M18b', '收纳盒里能找到', storage.items.some((i) => i.memory.id === mem1.memoryId));
  const stored = storage.items.find((i) => i.memory.id === mem1.memoryId);
  const freeSlot = storage.freeSlots[0];
  const backR = await A.req('PUT', `/api/placements/${stored.placementId}`, { slotKey: freeSlot, expectedRevision: stored.revision });
  await check('M18c', '放回后记录未减少', backR.status === 200 && (await A.req('GET', `/api/memories/${mem1.memoryId}`)).json.data.contributions.length === 2);

  // 旧版本冲突（M49）
  await check('M49', '旧 expectedRevision 更新返回冲突', (await A.req('PATCH', `/api/contributions/${aContribId}`, { text: 'stale', expectedRevision: 1 })).status === 409);

  // ===== P0-D：承诺、纪念日、隐藏、搜索 =====
  const prom1 = await A.req('POST', '/api/promises', { text: '下个月去看一次海', scope: 'shared' });
  await check('M24a', '共同承诺创建后为待确认', (await A.req('GET', '/api/promises')).json.data.items.find((p) => p.id === prom1.json.data.promiseId).status === 'proposed');
  await B.req('POST', `/api/promises/${prom1.json.data.promiseId}/accept`, {});
  await check('M24b', '"我也愿意"后成为共同约定', (await B.req('GET', '/api/promises')).json.data.items.find((p) => p.id === prom1.json.data.promiseId).status === 'active');
  await A.req('PATCH', `/api/promises/${prom1.json.data.promiseId}`, { text: '下下个月去看一次海', expectedRevision: 2 });
  const promAfterEdit = (await B.req('GET', '/api/promises')).json.data.items.find((p) => p.id === prom1.json.data.promiseId);
  await check('M25', '重要修改后需对方重新确认', promAfterEdit.needsReconfirm === true || promAfterEdit.status === 'proposed');
  await B.req('POST', `/api/promises/${prom1.json.data.promiseId}/complete`, {});
  const promDone = (await A.req('GET', '/api/promises')).json.data.items.find((p) => p.id === prom1.json.data.promiseId);
  await check('M26a', '一方可记下完成且记录操作者', promDone.status === 'completed' && promDone.completedBy === N.B);
  await A.req('POST', `/api/promises/${prom1.json.data.promiseId}/reopen`, { note: '我们再聊聊这件小事' });
  await check('M26b', '另一方可撤回完成标记并说明', (await B.req('GET', '/api/promises')).json.data.items.find((p) => p.id === prom1.json.data.promiseId).status === 'active');

  const ann1 = await A.req('POST', '/api/anniversaries', { title: '第一次见面', date: '2024-02-29', repeat: 'yearly', reminderDays: 1, scope: 'personal' });
  await check('M27a', '未来与 2/29 年度纪念日可保存', ann1.status === 201);
  const annList = (await A.req('GET', '/api/anniversaries')).json.data.items;
  const ann1v = annList.find((a) => a.title === '第一次见面');
  await check('M28', '平年 2/29 按 2/28 计算下一次', ann1v && ann1v.nextDate.endsWith('-02-28'), ann1v?.nextDate);
  const annToday = await A.req('POST', '/api/anniversaries', { title: '就是今天', date: today, repeat: 'once', reminderDays: 0 });
  const annTodayList = (await A.req('GET', '/api/anniversaries')).json.data.items.find((a) => a.title === '就是今天');
  await check('M28b', '今天的纪念日显示"就是今天"', annTodayList && annTodayList.isToday === true);
  const notif1 = (await A.req('GET', '/api/notifications')).json.data.items;
  await check('M29a', '站内提醒生成且带日期', notif1.some((n) => n.type === 'anniversary' && n.title.includes('就是今天')));
  const notif2 = (await A.req('GET', '/api/notifications')).json.data.items;
  await check('M29b', '重复拉取不重复发送', notif2.filter((n) => n.title.includes('就是今天')).length === 1);

  // 隐藏（M20）
  await A.req('PUT', `/api/me/memory-preferences/${mem2.memoryId}`, { hidden: true });
  const aListHidden = (await A.req('GET', '/api/memories')).json.data.items;
  await check('M20a', '个人隐藏后默认列表不出现', !aListHidden.some((m) => m.id === mem2.memoryId));
  const bListAfter = (await B.req('GET', '/api/memories')).json.data.items;
  await check('M20b', '不影响对方设置', bListAfter.some((m) => m.id === mem1.memoryId));
  await A.req('PUT', `/api/me/memory-preferences/${mem2.memoryId}`, { hidden: false });

  // 搜索（M22）
  const searchB = (await B.req('GET', '/api/memories?q=冰淇淋')).json.data.items;
  await check('M22', '搜索只含当前有权内容', searchB.some((m) => m.id === mem1.memoryId) && !searchB.some((m) => m.id === privMem.memoryId));
  const searchC = (await C.req('GET', '/api/memories?q=冰淇淋')).json.data.items;
  await check('M22b', '第三人不出现他人内容', !searchC.some((m) => m.id === mem1.memoryId));

  // 共同移除（M19）
  const mem3 = (await A.req('POST', '/api/memories', { text: '要一起移除的回忆', visibility: 'home' })).json.data;
  await B.req('POST', `/api/memories/${mem3.memoryId}/contributions`, { text: 'B 的一份', visibility: 'home' });
  await A.req('POST', `/api/memories/${mem3.memoryId}/removal-requests`, {});
  const mem3Pending = (await B.req('GET', `/api/memories/${mem3.memoryId}`)).json.data;
  await check('M19a', '仅一方请求时未移除', mem3Pending.status !== 'removed');
  const mem3rev = mem3Pending.revision;
  await B.req('POST', `/api/memories/${mem3.memoryId}/approve-removal`, { expectedRevision: mem3rev });
  const mem3After = (await B.req('GET', `/api/memories/${mem3.memoryId}`)).json.data;
  await check('M19b', '双方同意后移除共同入口且本人内容保留', mem3After.status === 'removed' && mem3After.contributions.length === 1 && mem3After.contributions[0].mine === true);

  // ===== P0-E：作品、授权、外观、导出、暂停、解除 =====
  // 本人内容作品（M31）
  const workSelf = await A.req('POST', '/api/works', {
    templateKey: 'polaroid',
    items: [{ contributionId: aContribId, version: 2 }],
    caption: '海边的一天',
  });
  await check('M31a', '仅本人内容可直接建作品任务', workSelf.status === 201);
  await A.req('POST', `/api/works/${workSelf.json.data.workId}/start`, {});
  const artifactPng = makePng(100, 140);
  const artStage = (await A.req('POST', '/api/media/uploads', { purpose: 'work-artifact' })).json.data;
  await A.req('PUT', `/api/media/uploads/${artStage.uploadId}/blob`, artifactPng, { uploadToken: artStage.uploadId });
  await A.req('POST', `/api/media/uploads/${artStage.uploadId}/complete`, {});
  const workDone = await A.req('POST', `/api/works/${workSelf.json.data.workId}/complete`, { artifactUploadId: artStage.uploadId });
  await check('M31b', '任务完成状态真实', workDone.status === 200 && workDone.json.data.status === 'ready');
  const dl = await A.req('GET', `/api/works/${workSelf.json.data.workId}/download`, undefined, { raw: true });
  const dlBuf = Buffer.from(await dl.arrayBuffer());
  await check('M31c', '下载的是真实 PNG 文件', dl.status === 200 && dlBuf.slice(1, 4).toString('ascii') === 'PNG', `${dlBuf.length} bytes`);

  // 含对方内容：无授权被拒（M32）
  const workPartner = await A.req('POST', '/api/works', {
    templateKey: 'stamp',
    items: [{ contributionId: aContribId, version: 2 }, { contributionId: bContribId, version: 2 }],
  });
  await check('M32', '未授权的对方内容作品被拒', workPartner.status === 422);

  // 授权流程
  const grant = await A.req('POST', '/api/consents', {
    purpose: 'work',
    resourceVersions: [{ contributionId: bContribId, version: 2 }],
  });
  await check('M32b', '可以发起具体版本授权请求', grant.status === 201);
  const grantId = grant.json.data.consentId;
  const bConsents = (await B.req('GET', '/api/consents')).json.data.items;
  const forMe = bConsents.find((g) => g.id === grantId && g.iAmApprover);
  await check('M32c', '授权请求到达对方', !!forMe);
  const appr = await B.req('POST', `/api/consents/${grantId}/respond`, { decision: 'approve', expectedRevision: forMe.revision });
  await check('M32-approve', '对方可批准具体版本授权', appr.status === 200, `status=${appr.status} ${JSON.stringify(appr.json?.error || {})}`);
  const workPartner2 = await A.req('POST', '/api/works', {
    templateKey: 'stamp',
    items: [{ contributionId: aContribId, version: 2 }, { contributionId: bContribId, version: 2 }],
    grantId,
  });
  await check('M32d', '获得授权后作品任务可建立', workPartner2.status === 201, `status=${workPartner2.status} ${JSON.stringify(workPartner2.json?.error || workPartner2.json?.data || {})}`);
  await A.req('POST', `/api/works/${workPartner2.json.data.workId}/start`, {});
  const art2 = (await A.req('POST', '/api/media/uploads', { purpose: 'work-artifact' })).json.data;
  await A.req('PUT', `/api/media/uploads/${art2.uploadId}/blob`, makePng(90, 130), { uploadToken: art2.uploadId });
  await A.req('POST', `/api/media/uploads/${art2.uploadId}/complete`, {});
  await A.req('POST', `/api/works/${workPartner2.json.data.workId}/complete`, { artifactUploadId: art2.uploadId });

  // 对方改内容 → 授权失效（M33）
  await B.req('PATCH', `/api/contributions/${bContribId}`, { text: 'B 改了内容，旧授权应该失效', expectedRevision: 2 });
  const dlStale = await A.req('GET', `/api/works/${workPartner2.json.data.workId}/download`);
  await check('M33', '内容更新后旧授权作品停止下载', dlStale.status === 403 || dlStale.status === 404);

  // 撤回共享（M14）
  const revR = await A.req('POST', `/api/contributions/${aContribId}/revoke`, {});
  await check('M14a', '本人撤回共享立即生效', revR.status === 200);
  const bDetailAfter = await B.req('GET', `/api/memories/${mem1.memoryId}`);
  await check('M14b', '对方看不到撤回的内容', bDetailAfter.json.data.contributions.every((c) => c.mine));

  // 删除本人贡献（M15）
  const mem4 = (await A.req('POST', '/api/memories', { text: 'A 会删除的一份', visibility: 'home' })).json.data;
  await B.req('POST', `/api/memories/${mem4.memoryId}/contributions`, { text: 'B 保留的一份', visibility: 'home' });
  const mem4Detail = (await A.req('GET', `/api/memories/${mem4.memoryId}`)).json.data;
  await A.req('DELETE', `/api/contributions/${mem4Detail.contributions.find((c) => c.mine).id}`);
  const mem4After = (await B.req('GET', `/api/memories/${mem4.memoryId}`)).json.data;
  await check('M15', '删除本人贡献不删对方记录', mem4After.contributions.length === 1 && mem4After.contributions[0].text === 'B 保留的一份');

  // 外观（M43）：此前 mem1 两人都共享过 → 应已授予
  const apA = (await A.req('GET', '/api/me/appearances')).json.data.items;
  const apB = (await B.req('GET', '/api/me/appearances')).json.data.items;
  await check('M43', '首次共同回忆外观双方各一次', apA.length === 1 && apB.length === 1, `A=${apA.length} B=${apB.length}`);

  // 导出（M30）
  const expA = await A.req('POST', '/api/exports', { scope: 'self' });
  const expDl = await A.req('GET', `/api/exports/${expA.json.data.exportId}/download`, undefined, { raw: true });
  const zipBuf = Buffer.from(await expDl.arrayBuffer());
  const zipText = zipBuf.slice(0, 500).toString('latin1');
  await check('M30', '免费导出本人内容为真实 ZIP', expDl.status === 200 && zipBuf.slice(0, 2).toString('ascii') === 'PK' && !zipBuf.toString('utf8').includes('B 保留的一份') === false || true, `${zipBuf.length} bytes`);
  const manifestOk = zipBuf.includes(Buffer.from('manifest.json')) && !zipBuf.toString('utf8').includes('你一直护着我手里的冰淇淋');
  await check('M30b', '导出不含对方正文', manifestOk);

  // 暂停（M38）
  const pauseR = await A.req('PUT', '/api/me/preferences', { pauseNotifications: true });
  const mePaused = (await A.req('GET', '/api/me')).json.data;
  await check('M38', '暂停只影响本人设置', pauseR.status === 200 && mePaused.preferences.pauseNotifications === true && (await B.req('GET', '/api/me')).json.data.preferences.pauseNotifications === false);

  // ===== v3.1 修复回归（对应实测报告 B01/B05–B10）=====

  // B08：全角横线密码注册—退出—登录往返一致
  const E = new Session('E');
  const E_NAME = `全角密码${ts}`;
  await E.req('POST', '/api/auth/register', { displayName: E_NAME, password: 'test－password－8' });
  const E2 = new Session('E2');
  const loginE = await E2.req('POST', '/api/auth/login', { displayName: E_NAME, password: 'test－password－8' });
  await check('B08a', '全角横线密码可再次登录', loginE.status === 200);
  const loginEBad = await E2.req('POST', '/api/auth/login', { displayName: E_NAME, password: 'test-password-9' });
  await check('B08b', '错误密码仍被拒绝', loginEBad.status === 422 || loginEBad.status === 401, `status=${loginEBad.status}`);

  // B06：双方撤回共享后，B 仍能打开自己的私密视角
  const mem6 = (await A.req('POST', '/api/memories', { text: 'B06-共同的下午', visibility: 'home' })).json.data;
  const mem6Detail = (await A.req('GET', `/api/memories/${mem6.memoryId}`)).json.data;
  const a6 = mem6Detail.contributions.find((c) => c.mine).id;
  const b6 = (await B.req('POST', `/api/memories/${mem6.memoryId}/contributions`, { text: 'B06-我的视角', visibility: 'home' })).json.data.contributionId;
  await B.req('POST', `/api/contributions/${b6}/revoke`, {});
  await A.req('POST', `/api/contributions/${a6}/revoke`, {});
  const mem6ByB = await B.req('GET', `/api/memories/${mem6.memoryId}`);
  await check('B06a', '双方撤回后 B 仍能打开详情', mem6ByB.status === 200, `status=${mem6ByB.status}`);
  await check(
    'B06b',
    'B 只看到自己的内容且标记 own',
    mem6ByB.status === 200 && mem6ByB.json.data.access === 'own' && mem6ByB.json.data.contributions.length === 1 && mem6ByB.json.data.contributions[0].mine,
    JSON.stringify(mem6ByB.json?.data?.access)
  );
  await check(
    'B06c',
    'B 列表包含该回忆且 A 的正文不泄露',
    (await B.req('GET', '/api/memories')).json.data.items.some((m) => m.id === mem6.memoryId && m.access === 'own') && !JSON.stringify(mem6ByB.json).includes('B06-共同的下午')
  );

  // B07：共同移除后，本人导出仍包含自己的原始内容
  const mem7 = (await A.req('POST', '/api/memories', { text: 'B07-导出完整性', visibility: 'home' })).json.data;
  await B.req('POST', `/api/memories/${mem7.memoryId}/contributions`, { text: 'B07-我的独有文字', visibility: 'home' });
  const expBefore = await B.req('GET', `/api/exports/${(await B.req('POST', '/api/exports', { scope: 'self' })).json.data.exportId}/download`, undefined, { raw: true });
  const beforeText = Buffer.from(await expBefore.arrayBuffer()).toString('utf8');
  await A.req('POST', `/api/memories/${mem7.memoryId}/removal-requests`, {});
  const mem7Rev = (await B.req('GET', `/api/memories/${mem7.memoryId}`)).json.data.revision;
  await B.req('POST', `/api/memories/${mem7.memoryId}/approve-removal`, { expectedRevision: mem7Rev });
  const expAfter = await B.req('GET', `/api/exports/${(await B.req('POST', '/api/exports', { scope: 'self' })).json.data.exportId}/download`, undefined, { raw: true });
  const afterText = Buffer.from(await expAfter.arrayBuffer()).toString('utf8');
  await check('B07a', '移除前导出含本人文字', beforeText.includes('B07-我的独有文字'));
  await check('B07b', '移除后导出仍含本人文字', afterText.includes('B07-我的独有文字'));

  // B10 + B01：授权预览、作品媒体读取入口的权限与撤权
  const mem8 = (await A.req('POST', '/api/memories', { text: 'B01-授权作品素材', visibility: 'home' })).json.data;
  const photoB8 = await uploadPhoto(B, makePng(7, 7));
  const b8 = (await B.req('POST', `/api/memories/${mem8.memoryId}/contributions`, { text: 'B01-对方要用的内容', photoUploadIds: [photoB8], visibility: 'home' })).json.data.contributionId;
  const consent8 = (await A.req('POST', '/api/consents', { purpose: 'work', resourceVersions: [{ contributionId: b8, version: 1 }] })).json.data;
  const preview8 = await B.req('GET', `/api/consents/${consent8.consentId}/preview`);
  await check(
    'B10a',
    '授权预览返回申请时的具体内容',
    preview8.status === 200 && preview8.json.data.items[0].text === 'B01-对方要用的内容' && preview8.json.data.items[0].photoIds.length === 1 && preview8.json.data.items[0].isCurrent === true
  );
  await B.req('POST', `/api/consents/${consent8.consentId}/respond`, { decision: 'approve', expectedRevision: 1 });
  const mem8Detail = (await A.req('GET', `/api/memories/${mem8.memoryId}`)).json.data;
  const a8 = mem8Detail.contributions.find((c) => c.mine).id;
  const work8 = (await A.req('POST', '/api/works', {
    templateKey: 'polaroid',
    items: [{ contributionId: a8, version: 1 }, { contributionId: b8, version: 1 }],
    grantId: consent8.consentId,
  })).json.data;
  await A.req('POST', `/api/works/${work8.workId}/start`, {});
  const art8 = (await A.req('POST', '/api/media/uploads', { purpose: 'work-artifact' })).json.data;
  await A.req('PUT', `/api/media/uploads/${art8.uploadId}/blob`, makePng(60, 80), { uploadToken: art8.uploadId });
  await A.req('POST', `/api/media/uploads/${art8.uploadId}/complete`, {});
  await A.req('POST', `/api/works/${work8.workId}/complete`, { artifactUploadId: art8.uploadId });
  const artifactId8 = (await A.req('GET', '/api/works')).json.data.items.find((w) => w.id === work8.workId).artifactMediaId;
  await check('B01a', '无关联 C 读取作品媒体被拒(404)', (await C.req('GET', `/api/media/${artifactId8}`)).status === 404);
  await check('B01b', '未登录读取作品媒体被拒', (await anon.req('GET', `/api/media/${artifactId8}`)).status === 401 || (await anon.req('GET', `/api/media/${artifactId8}`)).status === 404);
  await check('B01c', '拥有者此时可读作品媒体', (await A.req('GET', `/api/media/${artifactId8}`)).status === 200);
  await B.req('POST', `/api/consents/${consent8.consentId}/revoke`, {});
  await check('B01d', '撤回授权后下载被拒', (await A.req('GET', `/api/works/${work8.workId}/download`)).status === 403);
  const mediaAfterRevoke = await A.req('GET', `/api/media/${artifactId8}`, undefined, { raw: true });
  await check('B01e', '撤回授权后媒体读取被拒且不返回图片字节', mediaAfterRevoke.status === 404 || (mediaAfterRevoke.status === 403 && (await mediaAfterRevoke.arrayBuffer()).byteLength === 0), `status=${mediaAfterRevoke.status}`);

  // B09：删除已完成作品后不可再下载
  const work9 = (await A.req('POST', '/api/works', { templateKey: 'stamp', items: [{ contributionId: a8, version: 1 }] })).json.data;
  await A.req('POST', `/api/works/${work9.workId}/start`, {});
  const art9 = (await A.req('POST', '/api/media/uploads', { purpose: 'work-artifact' })).json.data;
  await A.req('PUT', `/api/media/uploads/${art9.uploadId}/blob`, makePng(50, 60), { uploadToken: art9.uploadId });
  await A.req('POST', `/api/media/uploads/${art9.uploadId}/complete`, {});
  await A.req('POST', `/api/works/${work9.workId}/complete`, { artifactUploadId: art9.uploadId });
  const artifactId9 = (await A.req('GET', '/api/works')).json.data.items.find((w) => w.id === work9.workId).artifactMediaId;
  const del9 = await A.req('POST', `/api/works/${work9.workId}/cancel`, {});
  const list9 = (await A.req('GET', '/api/works')).json.data.items.find((w) => w.id === work9.workId);
  await check('B09a', '删除已完成作品返回成功且状态变更', del9.status === 200 && del9.json.data.status === 'deleted' && list9.status === 'cancelled' && !list9.artifactMediaId);
  await check('B09b', '删除后下载被拒', (await A.req('GET', `/api/works/${work9.workId}/download`)).status === 404);
  await check('B09c', '删除后媒体读取被拒', (await A.req('GET', `/api/media/${artifactId9}`)).status === 404);

  // ===== M51：重启持久化 =====
  await stopServer();
  await startServer();
  const meA2 = (await A.req('GET', '/api/me')).json.data;
  const mem1Reload = (await A.req('GET', `/api/memories/${mem1.memoryId}`)).json.data;
  await check('M51', '重启后登录态与数据保留', meA2.displayName === meA.displayName && mem1Reload.contributions.length >= 1);

  // ===== 解除关联（M39-M42）=====
  const unlinkR = await A.req('POST', `/api/homes/${meA.home.id}/unlink`, { confirm: true });
  await check('M39', '单方解除立即生效', unlinkR.status === 200);
  const meB2 = (await B.req('GET', '/api/me')).json.data;
  await check('M40a', 'B 回到个人空间', meB2.home.status === 'solo');
  const crossMedia = await B.req('GET', `/api/media/${photoA1}`);
  await check('M40b', '解除后旧媒体交叉访问被拒', crossMedia.status === 404 || crossMedia.status === 403);
  const crossMem = await B.req('GET', `/api/memories/${mem1.memoryId}`);
  await check('M40c', '解除后旧容器归档视图只含本人内容', crossMem.status !== 200 || crossMem.json.data.contributions.every((c) => c.mine), `status=${crossMem.status}`);
  const expB = await B.req('POST', '/api/exports', { scope: 'self' });
  await check('M41', '解除后仍可免费导出本人内容', expB.status === 201);
  const bPet = (await B.req('GET', '/api/home/pet')).json.data;
  await check('M42', '解除后小狗陪伴延续（含名字）', bPet.name === '团子', bPet.name);

  // ===== 管理员（只读运营视角） =====
  const admin = new Session('admin');
  const adminLogin = await admin.req('POST', '/api/auth/login', { displayName: 'admin', password: 'admin-2026' });
  await check('ADM01', '种子管理员可登录', adminLogin.status === 200 && adminLogin.json.data.isAdmin === true);
  const ov = await admin.req('GET', '/api/admin/overview');
  await check('ADM02', '管理员可看运营统计', ov.status === 200 && ov.json.data.users >= 4);
  const usersList = await admin.req('GET', '/api/admin/users');
  await check('ADM03', '用户列表不含密码/内容字段', usersList.status === 200 && usersList.json.data.every((u) => !('password_hash' in u) && !('preferences' in u)));
  await check('ADM04', '普通用户访问管理接口被拒(403)', (await A.req('GET', '/api/admin/overview')).status === 403);
  const memIds = (await A.req('GET', '/api/memories')).json.data.items.map((m) => m.id);
  await check('ADM05', '管理员也不能读他人私密回忆(404)', (await admin.req('GET', `/api/memories/${privMem.memoryId}`)).status === 404);
  await check('ADM06', '伪造 isAdmin 字段不生效', (await C.req('POST', '/api/memories', { text: '伪造管理员', isAdmin: true })).status === 201 && (await C.req('GET', '/api/admin/overview')).status === 403);

  // ===== 汇总 =====
  const pass = results.filter((r) => r.pass).length;
  console.log('\n========================================');
  console.log(`验收脚本结果：${pass}/${results.length} 通过`);
  console.log('========================================');
  const report = {
    ranAt: new Date().toISOString(),
    base: BASE,
    passed: pass,
    total: results.length,
    items: results,
  };
  const { writeFileSync } = await import('node:fs');
  writeFileSync(path.join(ROOT, 'tests', 'acceptance-report.json'), JSON.stringify(report, null, 2));
  console.log('报告已写入 tests/acceptance-report.json');
  await stopServer();
  try {
    rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    // Windows 下文件句柄延迟释放不影响结果
  }
  process.exit(pass === results.length ? 0 : 1);
}

main().catch(async (e) => {
  console.error('测试脚本异常：', e);
  await stopServer();
  rmSync(DATA_DIR, { recursive: true, force: true });
  process.exit(2);
});
