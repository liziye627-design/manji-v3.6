// 慢记 Manji v3.0 —— 演示数据种子
// 用途：重建演示账户与场景（体验官A/B、小狗麻薯、贝壳与帐篷）。已存在则跳过。
// 运行：node scripts/seed-demo.mjs  （需要服务已在运行；脚本通过 API 创建，遵守全部权限规则）

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173';

class S {
  cookie = '';
  async req(method, path, body) {
    const headers = { 'X-Manji-Client': '1' };
    if (this.cookie) headers.Cookie = this.cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(BASE + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${json?.error?.message || ''}`);
    return json?.data ?? json;
  }
}

async function main() {
  const A = new S();
  const exists = await A.req('POST', '/api/auth/login', { displayName: '体验官A', password: 'manji-2026-10' }).then(
    () => true,
    () => false
  );
  if (exists) {
    console.log('演示数据已存在（体验官A 可登录），跳过。');
    return;
  }

  await A.req('POST', '/api/auth/register', { displayName: '体验官A', password: 'manji-2026-10' });
  await A.req('PATCH', '/api/home/pet', { name: '麻薯' });
  const mem = await A.req('POST', '/api/memories', {
    text: '今天去了海边的老码头，风很大，但是落日把海面染成了蜂蜜色。',
    topic: '出游',
    visibility: 'private',
  });
  await A.req('PUT', `/api/memories/${mem.memoryId}/object`, { templateKey: 'shell', slotKey: 'window' });
  const inv = await A.req('POST', `/api/homes/${(await A.req('GET', '/api/me')).home.id}/invites`, {
    message: '来看看我们的小家吧',
  });

  const B = new S();
  await B.req('POST', '/api/auth/register', { displayName: '体验官B', password: 'manji-2026-10' });
  await B.req('POST', '/api/invites/accept', { token: inv.token });
  const memB = await B.req('POST', '/api/memories', {
    text: '那天你一直护着我手里的冰淇淋，风再大也没化掉。',
    topic: '出游',
    visibility: 'private',
  });
  await B.req('PUT', `/api/memories/${memB.memoryId}/object`, { templateKey: 'tent', slotKey: 'corner' });
  const detailB = await B.req('GET', `/api/memories/${memB.memoryId}`);
  await B.req('POST', `/api/contributions/${detailB.contributions[0].id}/share`, {});

  // 一条共同的小说明和纪念日（可选体验项）
  const prom = await A.req('POST', '/api/promises', { text: '下个月去看一次海', scope: 'shared' });
  await B.req('POST', `/api/promises/${prom.promiseId}/accept`, {});
  await A.req('POST', '/api/anniversaries', {
    title: '第一次见面',
    date: '2026-10-01',
    repeat: 'yearly',
    reminderDays: 3,
    scope: 'shared',
  });

  console.log('演示数据已重建：');
  console.log('  体验官A / manji-2026-10 —— 小狗「麻薯」的主人，窗台有一枚私密的贝壳');
  console.log('  体验官B / manji-2026-10 —— 已接受邀请回家，角落放了共享的小帐篷');
  console.log('  admin / admin-2026 —— 种子管理员（首次启动自动创建）');
}

main().catch((e) => {
  console.error('种子失败：', e.message);
  process.exit(1);
});
