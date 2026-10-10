// 慢记 Manji v3.3 —— 可互动的三犬小屋，沿用原账户与回忆接口。
import { dogSVG, objectIcon, tabIcon, bellIcon, toolIcon, dogPoseImg } from './assets/art.js';
import { mountRoom } from './room/room.js';
import { mountPuppyHero } from './puppy/puppy3d.js';
import * as botwallet from './wallet.js';

// ================= 工具 =================
const $app = document.getElementById('app');
const APP_VERSION = '3.5.0';
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const newIdemKey = () =>
  (crypto.randomUUID ? crypto.randomUUID() : `manji-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const fmtDate = (d) => {
  if (!d) return '';
  const [y, m, day] = d.split('-');
  return `${y}年${Number(m)}月${Number(day)}日`;
};
const todayStr = () => {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
};

let toastTimer = null;
function toast(msg) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// ================= API =================
class ApiErr extends Error {
  constructor(err) {
    super(err.message || '请求失败');
    this.code = err.code;
    this.status = err.status;
    this.extra = err;
  }
}

async function api(method, path, body, opts = {}) {
  const headers = { 'X-Manji-Client': '1' };
  let payload;
  if (body instanceof Blob || body instanceof ArrayBuffer || body instanceof Uint8Array) {
    headers['Content-Type'] = 'application/octet-stream';
    payload = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  if (opts.uploadToken) headers['X-Upload-Token'] = opts.uploadToken;
  const res = await fetch(path, { method, headers, body: payload, credentials: 'same-origin' });
  if (res.headers.get('content-type')?.includes('application/json')) {
    const json = await res.json();
    if (!res.ok) throw new ApiErr(json.error || { message: '请求失败' });
    return json.data !== undefined ? json.data : json;
  }
  if (!res.ok) throw new ApiErr({ message: `请求失败（${res.status}）` });
  return res;
}

async function apiBlob(path) {
  const res = await fetch(path, { headers: { 'X-Manji-Client': '1' }, credentials: 'same-origin' });
  if (!res.ok) {
    let msg = `请求失败（${res.status}）`;
    try {
      const j = await res.json();
      msg = j.error?.message || msg;
    } catch {}
    throw new ApiErr({ message: msg });
  }
  return res.blob();
}

// ================= 状态 =================
const state = {
  me: null,
  notifCount: 0,
};

let activeRoom = null;
let routeGeneration = 0;
function disposeRoom() {
  const currentController = document.getElementById('interactive-room')?.roomController;
  activeRoom?.dispose();
  if (currentController !== activeRoom) currentController?.dispose();
  activeRoom = null;
}
window.addEventListener('pagehide', disposeRoom);
window.addEventListener('pageshow', (event) => { if (event.persisted) route(); });

// ================= 页面级观察器（v3.5：B04 共享撤回感知 / U02 新动态提示） =================
// 每次路由切换清空上一页注册的轮询与焦点监听，避免旧页面残留请求
let pageCleanups = [];
function registerPageCleanup(fn) {
  pageCleanups.push(fn);
}
function runPageCleanups() {
  for (const fn of pageCleanups) {
    try {
      fn();
    } catch {}
  }
  pageCleanups = [];
}

/**
 * B04（v3.5）：对方撤回共享后，已打开的详情页不再装作无事发生。
 * 低频轮询 + 回到前台/窗口获得焦点时校验：一旦对方内容不再可见，清屏重绘并明确提示。
 * 页面本身被清除重绘，已加载的文字与图片不会继续停留在界面上。
 */
function watchSharedMemoryAccess(memoryId) {
  const generation = routeGeneration;
  let checking = false;
  const check = async (force = false) => {
    if (checking || generation !== routeGeneration) return;
    if (!force && document.hidden) return; // 轮询避开后台；焦点触发不受此限（焦点本身就是用户回来的信号）
    checking = true;
    try {
      const fresh = await api('GET', `/api/memories/${memoryId}`);
      if (generation !== routeGeneration) return;
      const partnerVisible = fresh.contributions.some((c) => !c.mine && c.visibility === 'home');
      if (fresh.access !== 'full' || !partnerVisible) {
        toast('对方刚刚撤回了共享，页面已更新');
        route();
      }
    } catch (e) {
      if (generation !== routeGeneration) return;
      if (e.status === 404) {
        toast('这段回忆已经不能再查看了');
        location.hash = '#/memories';
      }
      // 网络波动等失败保持安静，等下一轮再查
    } finally {
      checking = false;
    }
  };
  const timer = setInterval(() => check(), 15000);
  const onFocus = () => {
    setTimeout(() => check(true), 400);
  };
  window.addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', onFocus);
  registerPageCleanup(() => {
    clearInterval(timer);
    window.removeEventListener('focus', onFocus);
    document.removeEventListener('visibilitychange', onFocus);
  });
}

/**
 * U02（v3.5）：停在列表页等另一半时，用低频轮询 + 回前台校验发现新动态。
 * 只提示、不自动重绘——避免在用户正编辑表单时把页面抽走。
 */
function watchListFreshness(label, initialSignature, probe) {
  const generation = routeGeneration;
  let lastSignature = initialSignature;
  let banner = null;
  const dismiss = () => {
    banner?.remove();
    banner = null;
  };
  const check = async (force = false) => {
    if (generation !== routeGeneration) return;
    if (!force && document.hidden) return;
    try {
      const sig = await probe();
      if (generation !== routeGeneration || sig === lastSignature) return;
      lastSignature = sig;
      if (!banner || !banner.isConnected) {
        banner = document.createElement('div');
        banner.className = 'freshness-banner';
        banner.innerHTML = `<span>${esc(label)}有了新动态</span><button class="btn sm primary" type="button">刷新看看</button>`;
        banner.querySelector('button').onclick = () => {
          dismiss();
          route();
        };
        document.body.appendChild(banner);
        requestAnimationFrame(() => banner?.classList.add('show'));
      }
    } catch {}
  };
  const timer = setInterval(() => check(), 20000);
  const onFocus = () => {
    setTimeout(() => check(true), 600);
  };
  window.addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', onFocus);
  registerPageCleanup(() => {
    clearInterval(timer);
    window.removeEventListener('focus', onFocus);
    document.removeEventListener('visibilitychange', onFocus);
    dismiss();
  });
}

async function loadMe() {
  try {
    state.me = await api('GET', '/api/me');
  } catch (e) {
    if (e.code === 'UNAUTHENTICATED') state.me = null;
    else throw e;
  }
  return state.me;
}

async function refreshNotifDot() {
  if (!state.me) return;
  try {
    const { items } = await api('GET', '/api/notifications');
    state.notifCount = items.filter((n) => !n.read_at).length;
    const dot = document.querySelector('.icon-btn .dot');
    if (dot) dot.style.display = state.notifCount > 0 ? 'block' : 'none';
  } catch {}
}

// ================= 媒体上传（三步 + 客户端缩略图） =================
async function shrinkImage(file, maxEdge = 640, quality = 0.8) {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality));
    return blob;
  } catch {
    return null;
  }
}

async function uploadImage(file, purpose = 'memory') {
  if (file.size > 10 * 1024 * 1024) throw new Error(`「${file.name}」超过 10 MiB`);
  const stage = await api('POST', '/api/media/uploads', { purpose });
  const buf = await file.arrayBuffer();
  await api('PUT', `/api/media/uploads/${stage.uploadId}/blob`, buf, { uploadToken: stage.uploadId });
  let thumbId = null;
  if (purpose === 'memory') {
    const thumbBlob = await shrinkImage(file);
    if (thumbBlob) {
      const tstage = await api('POST', '/api/media/uploads', { purpose: 'thumb' });
      await api('PUT', `/api/media/uploads/${tstage.uploadId}/blob`, await thumbBlob.arrayBuffer(), {
        uploadToken: tstage.uploadId,
      });
      thumbId = tstage.uploadId;
    }
  }
  await api('POST', `/api/media/uploads/${stage.uploadId}/complete`, { thumbUploadId: thumbId });
  return stage.uploadId;
}

// ================= 草稿（仅本设备，按用户隔离，M52） =================
function draftKey() {
  return `manji:draft:${state.me?.id || 'anon'}`;
}
function saveDraft(d) {
  localStorage.setItem(draftKey(), JSON.stringify({ ...d, savedAt: Date.now() }));
}
function readDraft() {
  try {
    return JSON.parse(localStorage.getItem(draftKey()) || 'null');
  } catch {
    return null;
  }
}
function clearDraft() {
  localStorage.removeItem(draftKey());
}

// ================= 路由 =================
// Companion-driven Home 导航：小屋 / 回忆 / ＋（中央主行动）/ 纪念 / 我的
// 「说好的承诺」与「纪念日与作品」共用「纪念」位（分段页签切换）
const TABS = [
  { key: 'home', label: '小屋', hash: '#/home' },
  { key: 'memories', label: '回忆', hash: '#/memories' },
  { key: 'memorial', label: '纪念', hash: '#/anniversaries' },
  { key: 'me', label: '我的', hash: '#/me' },
];

function tabbar(active) {
  const link = (t) => `<a class="tab ${t.key === active ? 'on' : ''}" href="${t.hash}" role="tab" aria-selected="${t.key === active}">
    ${tabIcon(t.key)}<span>${t.label}</span></a>`;
  return `<nav class="tabbar" role="tablist">
    ${TABS.slice(0, 2).map(link).join('')}
    <div class="tab-add-wrap"><button class="tab-add" id="tab-add" aria-label="记下点什么">${toolIcon('plus')}</button></div>
    ${TABS.slice(2).map(link).join('')}
  </nav>`;
}

/** 中央 ＋ 快捷创建（三种记录共用一个入口） */
function openQuickCreate() {
  openModal(`<h3>记下点什么</h3>
  <div class="quick-menu">
    <button class="qm" id="qm-memory"><span class="qi">🕯️</span><span class="qx"><span class="qt">留下一小段</span><span class="qd">一张照片或一句话，之后会变成家里的纪念物</span></span></button>
    <button class="qm" id="qm-promise"><span class="qi">🤝</span><span class="qx"><span class="qt">说好的承诺</span><span class="qd">温和的小约定，不打分、不排名</span></span></button>
    <button class="qm" id="qm-ann"><span class="qi">📅</span><span class="qx"><span class="qt">一个纪念日</span><span class="qd">安安静静的日期提醒</span></span></button>
  </div>`);
  document.getElementById('qm-memory').onclick = () => { closeModal(); location.hash = '#/new'; };
  document.getElementById('qm-promise').onclick = () => { closeModal(); location.hash = '#/promises?new=1'; };
  document.getElementById('qm-ann').onclick = () => { closeModal(); location.hash = '#/anniversaries?new=1'; };
}

function topbar({ title = '慢记', en = 'OUR SHARED HOME' } = {}) {
  const members = state.me?.home?.members || [];
  return `<header class="topbar">
    <button class="icon-btn" id="btn-notif" aria-label="通知">${bellIcon()}<span class="dot" style="display:none"></span></button>
    <div class="brand"><div class="name">${esc(title)}</div><div class="en">${esc(en)}</div></div>
    ${topbarChainChipHtml()}
    <div class="avatars">
      ${members
        .slice(0, 2)
        .map((m, i) => `<span class="avatar ${i === 1 ? 'rose' : ''}" title="${esc(m.display_name)}">${esc(m.display_name.slice(0, 1))}</span>`)
        .join('')}
    </div>
  </header>`;
}

// ================= v3.6.4 BOT Chain 全局可见性：顶栏常驻徽章 + 首页链上足迹条 =================
// 数据 60 秒缓存（两个只读接口并行，任一失败静默降级）；徽章先渲染、数字异步补上。
const chainBadgeState = { at: 0, data: null };
async function loadChainBadge() {
  if (chainBadgeState.data && Date.now() - chainBadgeState.at < 60_000) return chainBadgeState.data;
  try {
    const [oc, ag] = await Promise.all([
      api('GET', '/api/chain/onchain/status').catch(() => null),
      api('GET', '/api/agentos/status').catch(() => null),
    ]);
    const data = {
      sealCount: oc && typeof oc.chainSealCount === 'number' ? oc.chainSealCount : null, // 主网合约登记总数
      homeSealed: oc && oc.queue ? oc.queue.confirmed || 0 : 0,                          // 这个家已上主网的承诺数
      puppyTokenId: ag && ag.puppy && ag.puppy.agentTokenId != null ? ag.puppy.agentTokenId : null,
      puppyName: ag && ag.puppy && ag.puppy.name ? ag.puppy.name : null,
    };
    chainBadgeState.data = data;
    chainBadgeState.at = Date.now();
    return data;
  } catch {
    return chainBadgeState.data;
  }
}

/** 顶栏常驻的 BOT Chain 入口（数字异步填充，所有 .tc-count 一并更新） */
function topbarChainChipHtml() {
  return `<a class="topbar-chain" href="#/chain" title="永恒之链 · BOT Chain 主网存证（链 677）">⛓ BOT Chain<b class="tc-count" style="display:none"></b></a>`;
}

function updateChainChip() {
  loadChainBadge()
    .then((d) => {
      if (!d) return;
      for (const el of document.querySelectorAll('.tc-count')) {
        const label = d.sealCount != null ? String(d.sealCount) : '';
        el.style.display = label ? '' : 'none';
        el.textContent = label;
      }
      const strip = document.getElementById('chain-strip');
      if (strip) {
        const counts = [];
        if (d.homeSealed > 0) counts.push(`<b>${d.homeSealed}</b> 条承诺已刻上 BOT 主网`);
        if (d.puppyTokenId != null) counts.push(`${esc(d.puppyName || '小狗')} 有链上身份 <b>#${d.puppyTokenId}</b>`);
        strip.querySelector('.cs-counts').innerHTML =
          counts.length > 0 ? counts.join(' · ') : '把值得永远记住的一刻，刻上 BOT Chain 主网（链 677）';
      }
    })
    .catch(() => {});
}

/** 站内"减少动画"偏好落到根节点，与系统 prefers-reduced-motion 叠加生效（B12） */
function applyMotionPreference() {
  document.documentElement.classList.toggle('reduce-motion', !!state.me?.preferences?.reduceMotion);
}

async function route() {
  const generation = ++routeGeneration;
  disposeRoom();
  runPageCleanups();
  const hash = location.hash || '#/';
  window.scrollTo(0, 0);
  try {
    if (hash.startsWith('#/welcome')) return viewWelcome();
    if (hash.startsWith('#/verify')) return viewVerify(); // BOT Chain 公开核验门户：免登录
    if (hash.startsWith('#/login') || hash.startsWith('#/register')) return viewAuth(hash.startsWith('#/register'));
    // 邀请页对未登录用户开放：先看见邀请内容，注册/登录后回到这里接受（B03）
    if (hash.startsWith('#/invite/accept')) {
      if (!state.me) await loadMe().catch(() => {});
      return await viewInviteAccept(new URLSearchParams(hash.split('?')[1] || ''));
    }
    if (!state.me) {
      await loadMe();
      if (generation !== routeGeneration) return;
      if (!state.me) return viewWelcome();
    }
    applyMotionPreference();
    if (hash === '#/' || hash.startsWith('#/home')) return await viewHome(generation);
    if (hash.startsWith('#/onboarding')) return viewOnboarding();
    if (hash.startsWith('#/memories')) return await viewMemories();
    if (hash.startsWith('#/new/')) return await viewObjectPick(hash.split('/')[2].split('?')[0]);
    if (hash.startsWith('#/new')) return viewNewMemory();
    if (hash.startsWith('#/memory/')) return await viewMemoryDetail(hash.split('/')[2].split('?')[0]);
    if (hash.startsWith('#/promises')) return await viewPromises();
    if (hash.startsWith('#/anniversaries')) return await viewAnniversaries();
    if (hash.startsWith('#/chain')) return await viewChain();
    if (hash.startsWith('#/works')) return await viewWorks();
    if (hash.startsWith('#/invite')) return await viewInviteCreate();
    if (hash.startsWith('#/me/privacy')) return await viewPrivacy();
    if (hash.startsWith('#/admin')) return await viewAdmin();
    if (hash.startsWith('#/me')) return await viewMe();
    if (hash.startsWith('#/storage')) return await viewStorage();
    return await viewHome(generation);
  } catch (e) {
    if (generation !== routeGeneration) return;
    if (e.code === 'UNAUTHENTICATED') {
      state.me = null;
      return viewWelcome();
    }
    $app.innerHTML = `${topbar()}<div class="page"><div class="empty">
      <div class="big">${esc(e.message || '出了点问题')}</div>
      <p class="muted">稍后再试一次，或者回到小家。</p>
      <a class="btn ghost" href="#/home">回到小家</a>
    </div></div>${tabbar('home')}`;
  } finally {
    if (generation === routeGeneration) bindTopbar();
  }
}

function bindTopbar() {
  const btn = document.getElementById('btn-notif');
  if (btn) {
    btn.addEventListener('click', openNotifications);
    refreshNotifDot();
  }
  updateChainChip(); // 顶栏 BOT Chain 徽章与首页链上足迹条的数字填充
  const add = document.getElementById('tab-add');
  if (add) add.addEventListener('click', openQuickCreate);
}

window.addEventListener('hashchange', route);

// ================= 认证页（Gateway 品牌首页） =================
// ================= Welcome 品牌页：两个人的生活手账 =================
function viewWelcome() {
  $app.innerHTML = `
  <main class="welcome-page" aria-labelledby="welcome-heading">
    <header class="welcome-header">
      <div class="welcome-wordmark" aria-label="慢记 Manji">
        <svg class="welcome-mark" viewBox="0 0 32 36" fill="none" aria-hidden="true"><path d="M5 29V15a11 11 0 0 1 22 0v14" stroke="currentColor" stroke-width="1.5"/><path d="M10 29V17a6 6 0 0 1 12 0v12M3 29h26" stroke="currentColor" stroke-width="1.5"/><path d="M12 20c0-3 4-3 4-.8 0-2.2 4-2.2 4 .8 0 2.1-4 4.5-4 4.5S12 22.1 12 20Z" fill="currentColor"/></svg>
        <span>慢记<small>MANJI</small></span>
      </div>
      <a class="welcome-login" href="#/login">已有小家？<span>登录 <span aria-hidden="true">↗</span></span></a>
    </header>

    <section class="welcome-intro">
      <p class="welcome-eyebrow"><span></span> 两个人，一点一滴</p>
      <h1 id="welcome-heading">把日子，<br>慢慢过成<span class="welcome-us">我们<svg viewBox="0 0 100 10" fill="none" aria-hidden="true"><path d="M3 6c25-5 54-5 94-2M11 9c21-3 49-4 75-2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></span>。</h1>
      <p class="welcome-description">收藏平凡的小事，养一只黏人的小狗。<br>让每个「今天」，都有地方安放。</p>
      <p class="welcome-herochain">⛓ 约定与日记可镌刻上 <b>BOT Chain 主网</b>（链 677）· 小狗可铸链上身份 · <a href="#/verify">免登录核验存证 →</a></p>
    </section>

    <figure class="welcome-illustration" aria-label="一只小狗坐在温柔的拱窗前，等待你们回家">
      <div class="welcome-scene" aria-hidden="true">
        <div class="welcome-arch"><span class="welcome-sun"></span><span class="welcome-hill hill-back"></span><span class="welcome-hill hill-front"></span><span class="welcome-window-line"></span></div>
        <div class="welcome-floor"></div>
        <div class="welcome-rug"></div>
        <div class="welcome-memory"><svg viewBox="0 0 54 48" fill="none"><path d="m9 24 18-14 18 14M14 21v18h26V21M23 39V28h8v11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M25 19c-7-5-1-9 2-5 3-4 9 0 2 5l-2 1.5Z" fill="currentColor"/></svg><span>我们的第一天</span></div>
        <img class="welcome-plant" src="/assets/img/obj-plant.png" width="76" height="119" alt="" decoding="async">
        <div class="welcome-puppy-stage" id="welcome-puppy-stage">
          <img class="welcome-puppy" src="/assets/img/dog-sit.png" width="134" height="226" alt="" fetchpriority="high" decoding="async">
        </div>
        <span class="welcome-note">等你们回家<svg viewBox="0 0 50 34" fill="none"><path d="M5 5c16-3 32 2 31 20m-7-5 7 7 6-8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
      </div>
      <figcaption><span></span> 一间小屋 · 两个人 · 许多以后 <span></span></figcaption>
    </figure>

    <section class="welcome-eternal" aria-label="永恒之链与 BOT Chain 主网存证">
      <div class="we-chain" aria-hidden="true"><svg viewBox="0 0 96 24" fill="none"><path d="M10 12c0-3.6 2.9-6.5 6.5-6.5H26c3.6 0 6.5 2.9 6.5 6.5s-2.9 6.5-6.5 6.5h-9.5C12.9 18.5 10 15.6 10 12Z" stroke="currentColor" stroke-width="1.6"/><path d="M35.5 12c0-3.6 2.9-6.5 6.5-6.5h9.5c3.6 0 6.5 2.9 6.5 6.5s-2.9 6.5-6.5 6.5H42c-3.6 0-6.5-2.9-6.5-6.5Z" stroke="currentColor" stroke-width="1.6"/><path d="M61 12c0-3.6 2.9-6.5 6.5-6.5H77c3.6 0 6.5 2.9 6.5 6.5s-2.9 6.5-6.5 6.5h-9.5C63.9 18.5 61 15.6 61 12Z" stroke="currentColor" stroke-width="1.6"/></svg></div>
      <h2 class="we-title">有些话，值得永远作数</h2>
      <p class="we-copy">约定与日记镌刻进「永恒之链」，再由<b>你们自己的钱包</b>亲手把这一刻的指纹刻上 <b>BOT Chain 主网</b>。从此它不属于任何服务器或公司——任何人，包括我们自己，都无法修改或删除。</p>
      <div class="we-badges">
        <span class="we-badge">⛓ BOT Chain 主网 · 链 677</span>
        <span class="we-badge">连接钱包 · 你亲自签名</span>
        <a class="we-badge" href="https://scan.botchain.ai" target="_blank" rel="noopener">浏览器公开可查 ↗</a>
        <a class="we-badge" href="#/verify">免登录核验存证 →</a>
      </div>
    </section>

    <footer class="welcome-actions">
      <a class="welcome-start" href="#/register"><span>开启我们的小家</span><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 12h15m-6-6 6 6-6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></a>
      <button class="welcome-invite" id="welcome-invite" type="button"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="2.5" y="4" width="15" height="12" rx="2" stroke="currentColor" stroke-width="1.2"/><path d="m3 5 7 6 7-6" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg> 收到邀请？加入对方 <span aria-hidden="true">→</span></button>
      <p class="welcome-signoff">不赶时间，慢慢喜欢。</p>
    </footer>
  </main>`;
  // 登录界面的小狗：优先用优化后的 3D 模型渲染，插画作为加载与降级态。
  const puppyStage = document.getElementById('welcome-puppy-stage');
  if (puppyStage) mountPuppyHero(puppyStage, {
    reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
    onReveal: () => puppyStage.classList.add('is-live'),
  });
  document.getElementById('welcome-invite').onclick = () => {
    openModal(`<h3>有邀请链接？</h3>
      <p class="muted tiny" style="text-align:center">把对方分享给你的邀请链接粘贴到这里，打开后就能回家。</p>
      <div class="field" style="margin-top:10px"><input class="input" id="inv-link-input" placeholder="https://…/#/invite/accept?t=…"></div>
      <div id="inv-link-err"></div>
      <button class="btn primary block" id="inv-link-go">打开邀请</button>`);
    document.getElementById('inv-link-go').onclick = () => {
      const raw = document.getElementById('inv-link-input').value.trim();
      const m = raw.match(/t=([A-Za-z0-9_-]+)/);
      if (!m) {
        document.getElementById('inv-link-err').innerHTML = `<div class="form-error">没有在链接里找到邀请码，请检查后重试</div>`;
        return;
      }
      closeModal();
      location.hash = `#/invite/accept?t=${m[1]}`;
    };
  };
}

// ================= 登录/注册表单页 =================
function viewAuth(isRegister) {
  $app.innerHTML = `
  <div class="page fade-up">
    <div class="auth-hero">
      <div class="logo">慢记</div>
      <div class="sub">MANJI · SLOW MEMORY</div>
      <div class="slogan">一间由回忆慢慢布置起来的家</div>
    </div>
    <div class="gateway-scene breathe"><img src="/assets/img/scene-gateway.png" alt="小屋与小狗"></div>
    <div class="card">
      <div class="radio-cards" style="margin-bottom:16px">
        <div class="radio-card ${!isRegister ? 'on' : ''}" id="tab-login"><div class="t">登录</div></div>
        <div class="radio-card ${isRegister ? 'on' : ''}" id="tab-reg"><div class="t">注册</div></div>
      </div>
      <div id="auth-error"></div>
      <form id="auth-form">
        <div class="field">
          <label for="a-name">昵称</label>
          <input class="input" id="a-name" maxlength="24" autocomplete="username" placeholder="你在慢记里的名字" required>
        </div>
        <div class="field">
          <label for="a-pass">密码</label>
          <input class="input" id="a-pass" type="password" minlength="8" autocomplete="${isRegister ? 'new-password' : 'current-password'}" placeholder="至少 8 位" required>
        </div>
        <button class="btn primary block" type="submit">${isRegister ? '开始搭建我的小家' : '回到家'}</button>
      </form>
      <p class="muted tiny" style="margin-top:12px">注册后会有一间单人的小家和一只可以起名的小狗，随时可以邀请另一个人回来。</p>
      <p class="muted tiny">提示：密码里的横线请用英文半角（系统也会自动把全角"－"当作"-"处理）。</p>
    </div>
    <p class="ob-skip" style="text-align:center;margin-top:14px"><a href="#/welcome">← 回到首页</a></p>
  </div>`;
  document.getElementById('tab-login').onclick = () => (location.hash = '#/login');
  document.getElementById('tab-reg').onclick = () => (location.hash = '#/register');
  document.getElementById('auth-form').onsubmit = async (ev) => {
    ev.preventDefault();
    const displayName = document.getElementById('a-name').value.trim();
    const password = document.getElementById('a-pass').value;
    const errBox = document.getElementById('auth-error');
    errBox.innerHTML = '';
    try {
      await api('POST', isRegister ? '/api/auth/register' : '/api/auth/login', { displayName, password });
      state.me = await loadMe();
      applyMotionPreference();
      // 登录：认证成功后立即回到来处（如邀请页），不静默丢掉上下文（B03）。
      // 注册：走「选择小狗 → 创建小屋」向导，但邀请上下文保留到向导完成/跳过那一刻再消费（v3.5 / B02）——
      // 否则新用户注册完停在首页，不知道自己正被邀请，必须重新打开原链接才能接受。
      if (isRegister) {
        location.hash = '#/onboarding';
        return;
      }
      const returnTo = consumeReturnTo();
      location.hash = returnTo || '#/home';
      if (returnTo) route();
    } catch (e) {
      errBox.innerHTML = `<div class="form-error">${esc(e.message)}</div>`;
    }
  };
}

// ================= 来处上下文（B02/B03） =================
const RETURN_TO_RE = /^#\/(invite\/accept|memor|work|storage|me|home|anniversaries|promises)/;
/** 取出并清除"登录/注册后要回到哪"，只认白名单内的应用内路径 */
function consumeReturnTo() {
  try {
    const returnTo = sessionStorage.getItem('manji:returnTo');
    sessionStorage.removeItem('manji:returnTo');
    return returnTo && RETURN_TO_RE.test(returnTo) ? returnTo : null;
  } catch {
    return null;
  }
}

// ================= 家名（v3.5 / U01：服务端共同属性，两位成员一致） =================
function homeNameKey() {
  return `manji:homeName:${state.me?.home?.id || 'anon'}`;
}
/** 服务端家名优先；离线或旧数据回退到本设备旧值（v3.4 前家名只存在各自设备上） */
function getHomeName() {
  return state.me?.home?.name || (() => {
    try {
      return localStorage.getItem(homeNameKey()) || '';
    } catch {
      return '';
    }
  })();
}
/** 保存家名到服务端（乐观并发：对方刚改过会提示刷新）；同时清理本设备的旧副本 */
async function saveHomeName(name, { silent = false } = {}) {
  const expected = state.me?.home?.revision ?? 1;
  try {
    await api('PATCH', '/api/home/name', { name: name || null, expectedRevision: expected });
    state.me = await loadMe();
    try {
      localStorage.removeItem(homeNameKey());
    } catch {}
    if (!silent) toast('家名已保存，两个人看到的是同一个名字');
    return true;
  } catch (e) {
    if (silent) return false;
    if (e.code === 'REVISION_CONFLICT') {
      openModal(`<h3>家名刚被改过</h3><p class="muted">${esc(e.message)}</p>
        <button class="btn ghost block" onclick="closeModal()">知道了</button>`);
    } else if (name) {
      // 离线等场景：先落本设备，回到网络后再保存（不阻塞向导）
      try {
        localStorage.setItem(homeNameKey(), name);
      } catch {}
      toast('暂时存不到服务端，先记在这台设备上');
    }
    return false;
  }
}
/** 旧版本升级迁移：服务端还没有家名、但本设备有旧值时，静默上迁一次（U01） */
async function migrateLegacyHomeName() {
  if (!state.me?.home || state.me.home.name) return;
  let legacy = '';
  try {
    legacy = localStorage.getItem(`manji:homeName:${state.me.home.id}`) || '';
  } catch {
    return;
  }
  if (legacy) await saveHomeName(legacy, { silent: true });
}

// ================= Onboarding 向导（stitch screen 2/3 · 1:1 复刻） =================
function viewOnboarding() {
  const step = location.hash.includes('step=home') ? 'home' : 'dog';
  const pet = state.me?.pet;
  const me0 = state.me?.displayName || '';
  const BREEDS = { cream: '柴犬 Shiba', caramel: '哈士奇 Husky', cocoa: '巴哥 Pug' };
  const keys = ['cream', 'caramel', 'cocoa'];
  let picked = keys.includes(pet?.appearanceKey) ? pet.appearanceKey : 'cream';
  const blobs = `
    <div class="ambient-blob" style="top:-60px;right:-70px;width:280px;height:280px;background:#FDE9D7;opacity:.6"></div>
    <div class="ambient-blob" style="bottom:60px;left:-80px;width:300px;height:260px;background:#FAE0CF;opacity:.5"></div>`;
  const topbar = (en, cn) => `
    <div class="ob-topbar">
      <button class="ob-back" id="ob-back" aria-label="返回">‹</button>
      <div class="ob-title">${cn}<span class="ob-en">${en}</span></div>
      <span class="ob-avatar">${esc((me0 || '我').slice(0, 1))}</span>
    </div>`;
  const backHome = () => (history.length > 1 ? history.back() : (location.hash = '#/welcome'));
  const markOnboarded = () => {
    if (state.me) localStorage.setItem(`manji:onboarded:${state.me.id}`, '1');
  };
  // 向导结束（完成或跳过）统一出口：如果有邀请等着（B02），回到那份邀请让新用户选择接受，而不是默默落在首页
  const finishOnboarding = () => {
    markOnboarded();
    const returnTo = consumeReturnTo();
    location.hash = returnTo || '#/home';
    if (returnTo) route();
  };

  if (step === 'dog') {
    const name0 = pet?.name && !pet.name.endsWith('的小狗') ? pet.name : '';
    $app.innerHTML = `
    <div class="ob-page fade-up">
      ${blobs}
      ${topbar('Companion Selection', '选择同伴')}
      <div class="ob-hero">
        <h1>选择小狗的品种</h1>
        <p class="ob-sub">A little one to witness our everyday moments. · 见证我们日常的小伙伴</p>
      </div>
      <div class="companion-carousel">
        <button class="cc-arrow" id="cc-prev" aria-label="上一只">‹</button>
        <div class="cc-stage">
          <div class="cc-dog" id="cc-dog">${dogSVG(picked, 148)}</div>
          <div class="cc-name">♥ <span id="cc-who">${esc(name0 || 'Lucky')}</span>！</div>
          <div class="cc-tag">PLAYFUL & ATTENTIVE</div>
        </div>
        <button class="cc-arrow" id="cc-next" aria-label="下一只">›</button>
      </div>
      <div class="breed-chips" id="breed-chips">
        ${keys.map((k) => `<button type="button" class="breed-chip ${picked === k ? 'on' : ''}" data-k="${k}">${BREEDS[k]}</button>`).join('')}
      </div>
      <div class="field" style="margin-top:14px">
        <label for="ob-name">名字 · Name</label>
        <input class="input" id="ob-name" maxlength="24" value="${esc(name0)}" placeholder="比如：Lucky、麻薯">
        <p class="muted tiny" style="margin:6px 2px 0">You can change this anytime · 随时可以再改</p>
      </div>
      <div id="ob-error"></div>
      <button class="btn primary block" id="ob-go"><span class="b-label" style="width:100%;justify-content:space-between">Continue 继续<span class="arrow-chip">→</span></span></button>
      <p class="ob-footnote" id="ob-foot">Both of you will be greeted by <b>${esc(name0 || 'Lucky')}</b> upon arrival · 回家时它会迎接你们</p>
      <p class="ob-skip"><a href="#/home" id="ob-skip-link">先跳过，直接进小屋 →</a></p>
    </div>`;

    document.getElementById('ob-skip-link').addEventListener('click', (ev) => {
      ev.preventDefault(); // 跳过也走统一出口：有邀请时回到邀请（B02）
      finishOnboarding();
    });
    document.getElementById('ob-back').onclick = backHome;
    const apply = () => {
      document.getElementById('cc-dog').innerHTML = dogSVG(picked, 148);
      document.querySelectorAll('#breed-chips .breed-chip').forEach((c) => c.classList.toggle('on', c.dataset.k === picked));
    };
    const shift = (d) => {
      picked = keys[(keys.indexOf(picked) + d + keys.length) % keys.length];
      apply();
    };
    document.getElementById('cc-prev').onclick = () => shift(-1);
    document.getElementById('cc-next').onclick = () => shift(1);
    document.querySelectorAll('#breed-chips .breed-chip').forEach((c) => {
      c.onclick = () => {
        picked = c.dataset.k;
        apply();
      };
    });
    const nameInput = document.getElementById('ob-name');
    nameInput.addEventListener('input', () => {
      const n = nameInput.value.trim() || 'Lucky';
      document.getElementById('cc-who').textContent = n;
      document.getElementById('ob-foot').innerHTML = `Both of you will be greeted by <b>${esc(n)}</b> upon arrival · 回家时 ${esc(n)} 会迎接你们`;
    });
    document.getElementById('ob-go').onclick = async () => {
      const name = nameInput.value.trim();
      if (!name) return toast('先给小狗起个名字吧（或者选「先跳过」）');
      try {
        await api('PATCH', '/api/home/pet', { name, appearanceKey: picked });
        state.me = await loadMe();
        location.hash = '#/onboarding?step=home';
      } catch (e) {
        document.getElementById('ob-error').innerHTML = `<div class="form-error">${esc(e.message)}</div>`;
      }
    };
    return;
  }

  // step = home（stitch screen 3 · 1:1）
  const petName = pet?.name || 'Lucky';
  $app.innerHTML = `
  <div class="ob-page fade-up">
    ${blobs}
    ${topbar('Home Creation', '创建小屋')}
    <div class="ob-hero">
      <h1>创建我们的小屋</h1>
      <p class="ob-sub">Give our home a name, and start with one memory. · 给家起个名字，从一段回忆开始</p>
    </div>
    <div class="room-preview">
      <img src="/assets/img/scene-home.png" alt="小屋预览">
      <div class="rp-caption">🐾 ${esc(petName)} is waiting for you</div>
    </div>
    <div class="field" style="margin-top:14px">
      <label for="ob-home-name">小屋名字 · Home Name <span class="tag plain tiny" style="margin-left:6px">SHARED SPACE</span></label>
      <input class="input" id="ob-home-name" maxlength="16" value="${esc(getHomeName())}" placeholder="比如：我们的树洞">
      <p class="muted tiny" style="margin:6px 2px 0">家名会同步给另一半——两个人看到的是同一个名字，任一方修改都会通知对方</p>
    </div>
    <div class="resident-card">
      <span class="r-ava">🙂</span>
      <div style="flex:1"><div class="r-name">${esc(me0 || '我')}</div><div class="r-role">YOU · NEST BUILDER · 筑巢人</div></div>
      <span class="tag ok">Mutual Sanctuary</span>
    </div>
    <div class="invite-hint-card">
      <span class="i-ico">💌</span>
      <div style="flex:1"><div class="r-name">Invite Partner · 邀请另一半</div><div class="r-role">建好小屋后可以生成邀请链接 Share code</div></div>
    </div>
    <p class="ob-footnote">We'll create your first treasure together. · 你们会一起做出第一件纪念物</p>
    <button class="btn primary block" id="ob-create" style="margin-top:4px"><span class="b-label" style="width:100%;justify-content:space-between">Create Home 创建小屋<span class="arrow-chip">→</span></span></button>
    <p class="ob-skip"><a href="#/home" id="ob-skip2">You can invite your partner or rename anytime · 也可以稍后再邀请 →</a></p>
  </div>`;

  document.getElementById('ob-back').onclick = () => (location.hash = '#/onboarding');
  document.getElementById('ob-skip2').addEventListener('click', (ev) => {
    ev.preventDefault(); // 跳过也走统一出口：有邀请时回到邀请（B02）
    finishOnboarding();
  });
  document.getElementById('ob-create').onclick = async () => {
    const n = document.getElementById('ob-home-name').value.trim();
    await saveHomeName(n); // v3.5（U01）：家名存到服务端，两个人共享同一个名字
    finishOnboarding();
    toast('小屋准备好了');
  };
}

// ================= S01 · 我们的家 =================
async function viewHome(generation = routeGeneration) {
  const room = await api('GET', '/api/home/room');
  if (generation !== routeGeneration) return;
  const me = state.me;
  const pet = room.pet;
  const shared = room.home.isShared;
  const memberNames = (me.home?.members || []).map((m) => m.display_name);
  const onboarded = localStorage.getItem(`manji:onboarded:${me.id}`) === '1';
  const [{ items: memItems }, { items: notifItems }] = await Promise.all([
    api('GET', '/api/memories').catch(() => ({ items: [] })),
    api('GET', '/api/notifications').catch(() => ({ items: [] })),
  ]);
  if (generation !== routeGeneration) return;
  const recent = memItems.filter((m) => m.access === 'full' || m.access === 'own').slice(0, 2);

  const objects = room.objects.map((o) => ({ slotKey: o.slotKey, templateKey: o.templateKey, memory: o.memory }));
  const keepsakes = objects.length + room.storedCount;

  // 链上足迹横幅：点击进永恒之链；数字由 updateChainChip 异步填充（route 渲染后统一触发）
  const chainStrip = document.getElementById('chain-strip');
  if (chainStrip) {
    chainStrip.onclick = () => { location.hash = '#/chain'; };
    chainStrip.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); location.hash = '#/chain'; } };
  }

  // 通知与回顾保留独立入口，让点小狗时完整播放互动。
  const carryNotif = notifItems.find((n) => !n.read_at && n.type === 'memory-shared' && n.source_id);
  let guideItem = null;
  if (!carryNotif && me.preferences?.recallEnabled && !me.preferences?.pauseRecall && objects.length > 0) {
    guideItem = (await api('GET', '/api/recall').catch(() => null))?.item || null;
  }
  if (generation !== routeGeneration) return;
  const dayN = me.home?.createdAt
    ? Math.max(1, Math.floor((Date.now() - new Date(me.home.createdAt).getTime()) / 86400e3) + 1)
    : null;
  const homeName = getHomeName();
  const whoText = homeName || memberNames.join(' × ') || me.displayName;

  // 上下文引导：一次只出现一张（起名 → 第一段回忆 → 邀请），避免卡片堆叠
  const story = !onboarded
    ? { ico: '🐾', title: '认识你的小伙伴', sub: '选择品种，给它一个喜欢的名字', btn: '去选同伴', href: '#/onboarding' }
    : objects.length === 0
    ? { ico: '🕯️', title: '小屋还空着', sub: '留下第一段回忆，挑一件纪念物放进来', btn: '开始', href: '#/new' }
    : !shared
    ? { ico: '📮', title: '邀请一个人回家', sub: '同一段日子，两种记得的方式', btn: '邀请', href: '#/invite' }
    : null;

  $app.innerHTML = `
  <div class="fade-up home-interactive">
    <div class="home-hero">
        <header class="hero-topbar">
          <button class="icon-btn" id="btn-notif" aria-label="通知">${bellIcon()}<span class="dot" style="display:none"></span></button>
          <div class="brand">
            <div class="name">我们的小屋</div>
            <div class="en">${esc(whoText)}${dayN ? ` · DAY ${dayN}` : ''}</div>
          </div>
          ${topbarChainChipHtml()}
          <div class="avatars">
            ${(me.home?.members || []).slice(0, 2)
              .map((m, i) => `<span class="avatar ${i === 1 ? 'rose' : ''}" title="${esc(m.display_name)}">${esc(m.display_name.slice(0, 1))}</span>`)
              .join('')}
          </div>
        </header>
        <div id="interactive-room" class="interactive-room" aria-label="三只小狗的小屋"><div class="loading"><div class="spin"></div>正在打开小屋…</div></div>
    </div>
    <div class="home-sheet">
      <div class="chain-strip" id="chain-strip" role="button" tabindex="0" aria-label="查看永恒之链与 BOT Chain 主网存证">
        <div class="cs-ico" aria-hidden="true">⛓</div>
        <div class="cs-body">
          <div class="cs-title serif">我们的链上足迹 · BOT Chain</div>
          <div class="cs-counts muted tiny">正在读取 BOT 主网…</div>
        </div>
        <span class="cs-go" aria-hidden="true">→</span>
      </div>
      ${story ? `
      <div class="story-card">
        <div class="s-ico">${story.ico}</div>
        <div class="s-body"><div class="s-title">${story.title}</div><div class="s-sub">${story.sub}</div></div>
        <a class="btn sm primary" href="${story.href}">${story.btn}</a>
      </div>` : ''}
      ${recent.length > 0 ? `
      <div class="recent-head"><div class="rh-title">最近的回忆</div><a href="#/memories">全部 →</a></div>
      ${recent
        .map(
          (m) => `<div class="mem-card" data-id="${esc(m.id)}" role="button" tabindex="0">
        <div class="mem-thumb">${m.photoThumbId
          ? `<img src="/api/media/${encodeURIComponent(m.photoThumbId)}?variant=thumb" alt="回忆照片" loading="lazy">`
          : objectIcon(m.objectTemplate || 'shell', 40)}</div>
        <div class="mem-body">
          <div class="mem-title">${esc(m.title)}</div>
          <div class="mem-meta">
            <span class="tag plain">${fmtDate(m.eventDate).slice(5)}</span>
            ${m.visibility === 'home' ? `<span class="tag rose">共同</span>` : `<span class="tag">仅自己</span>`}
          </div>
        </div>
      </div>`
        )
        .join('')}` : `<p class="muted tiny" style="text-align:center;padding:8px 0 2px">${keepsakes > 0 ? '' : '写下的每一段回忆，都会变成小屋里的一件纪念物'}</p>`}
    </div>
  </div>
  ${tabbar('home')}`;

  $app.querySelectorAll('.mem-card[data-id]').forEach((el) => {
    el.onclick = () => (location.hash = `#/memory/${el.dataset.id}`);
    el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        location.hash = `#/memory/${el.dataset.id}`;
      }
    });
  });
  const roomHost = document.getElementById('interactive-room');
  const openContext = () => {
    if (generation !== routeGeneration || !roomHost.isConnected) return;
    if (carryNotif) {
      // 信使：小狗替另一半把东西带给你（环境化通知，代替红点）
      openModal(`<h3>${esc(pet?.name || '小狗')} 叼来了 TA 留下的东西</h3>
        <div style="display:flex;justify-content:center;padding:6px 0 2px">${objectIcon('ticket', 76)}</div>
        <div class="card soft" style="text-align:center;margin-top:10px">
          <div class="serif" style="font-size:16px">${esc(carryNotif.title)}</div>
          <p class="muted tiny" style="margin:4px 0 0">${esc(carryNotif.body)}</p>
        </div>
        <div class="btn-row" style="margin-top:12px">
          <button class="btn ghost" onclick="closeModal()">先不理它</button>
          <button class="btn primary" id="dog-carry-open">打开看看</button>
        </div>`);
      document.getElementById('dog-carry-open').onclick = async () => {
        try {
          await api('POST', '/api/notifications/read', { ids: [carryNotif.id] });
        } catch {}
        closeModal();
        if (generation === routeGeneration) location.hash = `#/memory/${encodeURIComponent(carryNotif.source_id)}`;
      };
      return;
    }
    if (guideItem) {
      // 向导：小狗翻出一件旧物（Memory Agent 的可视化身体）
      openModal(`<h3>还记得这个吗？</h3>
        <div style="display:flex;justify-content:center;padding:6px 0 2px">${objectIcon(guideItem.objectTemplate || 'shell', 76)}</div>
        <div class="card soft" style="text-align:center;margin-top:10px">
          <div class="serif" style="font-size:16px">${esc(guideItem.title)}</div>
          <p class="muted tiny" style="margin:4px 0 0">${fmtDate(guideItem.eventDate)}${guideItem.daysAgo > 0 ? ` · ${guideItem.daysAgo} 天前` : ''}</p>
        </div>
        <div class="btn-row" style="margin-top:12px">
          <button class="btn ghost" id="dog-guide-skip">先不看</button>
          <button class="btn primary" id="dog-guide-open">打开看看</button>
        </div>`);
      document.getElementById('dog-guide-skip').onclick = () => closeModal();
      document.getElementById('dog-guide-open').onclick = () => {
        closeModal();
        location.hash = `#/memory/${encodeURIComponent(guideItem.id)}`;
      };
      return;
    }
  };
  mountRoom(roomHost, {
    pet,
    objects,
    homeId: room.home.id || me.home?.id || '',
    reduceMotion: !!me.preferences?.reduceMotion,
    contextLabel: carryNotif ? '看看 TA 留下的东西' : guideItem ? '回看这段回忆' : '',
    onContextAction: openContext,
    onPetInteract: async (action) => {
      if (generation !== routeGeneration || !roomHost.isConnected) return '';
      const { reaction } = await api('POST', '/api/home/pet/interact', { action });
      return reaction || '';
    },
    onMemoryOpen: (id) => {
      if (generation === routeGeneration && roomHost.isConnected && id) {
        location.hash = `#/memory/${encodeURIComponent(id)}`;
      }
    },
  }).then((controller) => {
    // 模型下载结束时，用户可能已离开首页；立即释放过期场景。
    if (generation !== routeGeneration || !roomHost.isConnected) controller.dispose();
    else activeRoom = controller;
  }).catch((error) => {
    if (generation !== routeGeneration || !roomHost.isConnected) return;
    roomHost.replaceChildren();
    const message = document.createElement('p');
    message.className = 'room-load-error';
    message.textContent = `小屋暂时没有打开：${error.message || '请稍后再试'}`;
    const retry = document.createElement('button');
    retry.className = 'btn ghost';
    retry.textContent = '重新打开小屋';
    retry.addEventListener('click', route);
    roomHost.append(message, retry);
  });
}

// ================= 通知弹层 =================
async function openNotifications() {
  const { items } = await api('GET', '/api/notifications');
  const iconFor = { anniversary: '📅', consent: '✍️', appearance: '🎁', memory: '🐚', promise: '🤝', invite: '🏠' };
  openModal(`
    <h3>通知</h3>
    ${
      items.length === 0
        ? `<div class="empty"><div class="big">很安静</div><p class="tiny">纪念日提醒和承诺确认会出现在这里</p></div>`
        : items
            .map(
              (n) => `<div class="notif ${n.read_at ? '' : 'unread'}">
        <div class="icon">${iconFor[n.type] || '🔔'}</div>
        <div style="flex:1"><div class="t">${esc(n.title)}</div><div class="b">${esc(n.body)}</div></div>
      </div>`
            )
            .join('')
    }
    ${items.length > 0 ? `<button class="btn ghost block" id="notif-read" style="margin-top:12px">全部标为已读</button>` : ''}`);
  const markBtn = document.getElementById('notif-read');
  if (markBtn) {
    markBtn.onclick = async () => {
      await api('POST', '/api/notifications/read', {});
      refreshNotifDot();
      closeModal();
    };
  }
}

function openPetModal(after) {
  const pet = state.me.pet;
  const modal = openModal(`
    <h3>小狗设置</h3>
    <div class="field"><label for="pet-name">名字</label>
      <input class="input" id="pet-name" maxlength="24" value="${esc(pet?.name || '')}" placeholder="给小狗起个名字"></div>
    <div class="field"><label>选择品种</label>
      <div class="radio-cards" id="pet-colors">
        ${['cream', 'caramel', 'cocoa'].map((k) => `<div class="radio-card ${pet?.appearanceKey === k ? 'on' : ''}" data-k="${k}" aria-checked="${pet?.appearanceKey === k}">
          <div style="display:flex;justify-content:center">${dogSVG(k, 56)}</div>
          <div class="t">${{ cream: '柴犬', caramel: '哈士奇', cocoa: '巴哥' }[k]}</div>
        </div>`).join('')}
      </div></div>
    <p class="muted tiny" style="margin-bottom:12px">选择你想命名的同伴。三只小狗都会在小屋里陪你，没有饥饿值，也不需要签到。</p>
    <button class="btn primary block" id="pet-save">保存</button>`);
  let color = pet?.appearanceKey || 'cream';
  // 弹窗控件绑定在弹窗容器内，而不是 $app（B02）
  bindRadioCards(modal, '#pet-colors .radio-card', (c) => {
    color = c.dataset.k;
  });
  document.getElementById('pet-save').onclick = async () => {
    const name = document.getElementById('pet-name').value.trim();
    if (!name) return toast('先给小狗起个名字吧');
    try {
      await api('PATCH', '/api/home/pet', { name, appearanceKey: color });
      state.me = await loadMe();
      closeModal();
      after ? after() : route();
    } catch (e) {
      toast(e.message);
    }
  };
}

// ================= 弹层 =================
let modalEscapeHandler = null;
function openModal(inner) {
  closeModal();
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.id = 'modal';
  mask.innerHTML = `<div class="modal" tabindex="-1"><div class="grip"></div>${inner}</div>`;
  mask.addEventListener('click', (ev) => {
    if (ev.target === mask) closeModal();
  });
  document.body.appendChild(mask);
  // 弹窗焦点与键盘退出：Esc 关闭，焦点收进弹窗，避免键盘用户掉回页面底部（B13）
  modalEscapeHandler = (ev) => {
    if (ev.key === 'Escape') closeModal();
  };
  document.addEventListener('keydown', modalEscapeHandler);
  const box = mask.querySelector('.modal');
  if (box) box.focus({ preventScroll: true });
  return mask;
}
function closeModal() {
  if (modalEscapeHandler) {
    document.removeEventListener('keydown', modalEscapeHandler);
    modalEscapeHandler = null;
  }
  document.getElementById('modal')?.remove();
}
window.closeModal = closeModal;

/** 单选卡组统一绑定：点击与 Enter/Space 都能选，role=radio 可聚焦（B02/B13）
 *  scope 必须是包含卡片的容器（弹窗内的控件绑定在弹窗自身，而不是 $app） */
function bindRadioCards(scope, selector, onPick) {
  const root = scope || document;
  root.querySelectorAll(selector).forEach((card) => {
    card.setAttribute('role', 'radio');
    card.setAttribute('tabindex', '0');
    const activate = () => {
      root.querySelectorAll(selector).forEach((x) => {
        x.classList.remove('on');
        x.setAttribute('aria-checked', 'false');
      });
      card.classList.add('on');
      card.setAttribute('aria-checked', 'true');
      onPick(card);
    };
    card.addEventListener('click', activate);
    card.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        activate();
      }
    });
  });
}

// ================= S02 · 回忆日记 =================
async function viewMemories() {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const q = params.get('q') || '';
  const topic = params.get('topic') || '';
  const [{ items, topics }] = await Promise.all([api('GET', `/api/memories${location.hash.includes('?') ? '?' + location.hash.split('?')[1] : ''}`)]);
  const current = state.me.home;
  const currentItems = items.filter((x) => x.access === 'full' || x.access === 'own');
  const archiveItems = items.filter((x) => x.access === 'archive');

  const cardHtml = (m) => `
    <div class="mem-card" data-id="${m.id}" role="button" tabindex="0">
      <div class="mem-thumb">${m.photoThumbId
        ? `<img src="/api/media/${m.photoThumbId}?variant=thumb" alt="回忆照片" loading="lazy">`
        : objectIcon(m.objectTemplate || 'shell', 40)}</div>
      <div class="mem-body">
        <div class="mem-title">${esc(m.title)}</div>
        <div class="mem-meta">
          <span class="tag plain">${fmtDate(m.eventDate).slice(5)}</span>
          ${m.topic ? `<span class="tag">${esc(m.topic)}</span>` : ''}
          ${m.visibility === 'home' ? `<span class="tag rose">共同</span>` : `<span class="tag">仅自己</span>`}
          ${m.hidden ? `<span class="tag plain">已隐藏</span>` : ''}
          ${m.access === 'archive' ? `<span class="tag plain">归档</span>` : ''}
        </div>
        <div class="mem-persp">
          ${m.perspectives.map((p) => `<span class="mini-avatar ${p.mine ? '' : 'rose'}" title="${esc(p.authorName)}">${esc(p.authorName.slice(0, 1))}</span>`).join('')}
          <span class="tiny muted">${m.perspectives.length === 2 ? '两个人的视角' : m.perspectives.length === 1 ? '一个视角' : ''}</span>
        </div>
      </div>
    </div>`;

  $app.innerHTML = `
  ${topbar({ title: '回忆', en: 'MEMORY DIARY' })}
  <div class="page fade-up">
    <form id="search-form" style="display:flex;gap:8px;margin-bottom:12px">
      <input class="input" id="q" placeholder="按关键词或日期找找…" value="${esc(q)}" style="flex:1">
      <button class="btn ghost" type="submit" aria-label="搜索">🔍</button>
    </form>
    <div class="chips" style="margin-bottom:14px">
      <a class="chip-btn ${!topic ? 'on' : ''}" href="#/memories${q ? `?q=${encodeURIComponent(q)}` : ''}">全部</a>
      ${topics.filter((t) => t !== '其他').map((t) => `<a class="chip-btn ${topic === t ? 'on' : ''}" href="#/memories?topic=${encodeURIComponent(t)}${q ? `&q=${encodeURIComponent(q)}` : ''}">${esc(t)}</a>`).join('')}
      <a class="chip-btn" href="#/storage">🧺 收纳与查找</a>
    </div>
    <button class="btn primary block" id="btn-new">＋ 留下一小段</button>
    <div style="margin-top:16px" id="mem-list">
      ${currentItems.length === 0
        ? `<div class="empty"><div class="big">还没有回忆</div><p class="tiny">一张照片或一句话都可以，先放进来看看</p></div>`
        : currentItems.map(cardHtml).join('')}
    </div>
    ${archiveItems.length > 0 ? `
      <h3 style="margin-top:20px">已归档的回忆</h3>
      <p class="muted tiny">解除关联或共同移除后，只保留你自己的部分。</p>
      ${archiveItems.map(cardHtml).join('')}` : ''}
  </div>
  ${tabbar('memories')}`;

  document.getElementById('btn-new').onclick = () => (location.hash = '#/new');
  document.getElementById('search-form').onsubmit = (ev) => {
    ev.preventDefault();
    const nq = document.getElementById('q').value.trim();
    const p = new URLSearchParams();
    if (nq) p.set('q', nq);
    if (topic) p.set('topic', topic);
    location.hash = `#/memories${p.toString() ? '?' + p.toString() : ''}`;
  };
  $app.querySelectorAll('.mem-card').forEach((el) => {
    el.onclick = () => (location.hash = `#/memory/${el.dataset.id}`);
    el.addEventListener('keydown', (ev) => {
      // 原生按钮语义：Enter/Space 都能打开回忆卡（B13）
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        location.hash = `#/memory/${el.dataset.id}`;
      }
    });
  });

  // U02：共同家里停在列表页时，低频探测另一半的新记录，出现"新动态"提示（不自动重绘）
  if (state.me?.home?.isShared) {
    const listUrl = `/api/memories${location.hash.includes('?') ? '?' + location.hash.split('?')[1] : ''}`;
    watchListFreshness('回忆列表', items.map((m) => m.id).join(','), async () => {
      const { items: fresh } = await api('GET', listUrl);
      return fresh.map((m) => m.id).join(',');
    });
  }
}

// ================= S03 · 留下一小段 =================
function viewNewMemory() {
  const draft = readDraft();
  let photos = []; // File[]：本地待上传照片（含上传失败后待重试的）
  let uploadedIds = []; // 已成功上传、等待随保存提交的照片 ID（B04：保存失败后重试不重传、不丢失）
  let saveKey = newIdemKey(); // 一次逻辑提交一个稳定幂等键；内容变化后换新键（B05）
  const resetSaveKey = () => {
    saveKey = newIdemKey();
  };

  $app.innerHTML = `
  ${topbar({ title: '留下一小段', en: 'A LITTLE MEMORY' })}
  <div class="page fade-up">
    <div id="draft-banner"></div>
    <div id="form-error"></div>
    <div class="card">
      <div class="field">
        <label>照片（最多 6 张，JPEG / PNG / WebP）</label>
        <div class="pick-grid" id="photo-grid">
          <label class="pick" id="pick-add" role="button">＋<span>选照片</span>
            <input type="file" id="photo-input" accept="image/jpeg,image/png,image/webp" multiple class="sr-only">
          </label>
        </div>
        <div class="counter tiny" id="photo-counter"></div>
      </div>
      <div class="field">
        <label for="m-text">这一段回忆（500 字以内）</label>
        <textarea class="textarea" id="m-text" maxlength="500" placeholder="今天的风有点大……"></textarea>
        <div class="counter" id="text-counter">0 / 500</div>
      </div>
      <div class="field">
        <label for="m-date">发生日期（可以补记过去的一天）</label>
        <input class="input" id="m-date" type="date" value="${todayStr()}" max="${todayStr()}">
      </div>
      <div class="field">
        <label id="m-topic-label">主题</label>
        <input type="hidden" id="m-topic" value="">
        <div class="chips" id="topic-chips" role="radiogroup" aria-labelledby="m-topic-label">
          ${['日常', '出游', '美食', '影音', '雨天', '户外', '节日', '其他']
            .map((t) => `<button type="button" class="chip-btn" data-t="${t}">${t}</button>`)
            .join('')}
        </div>
      </div>
      <div class="field">
        <label>范围</label>
        <div class="radio-cards" id="vis-cards">
          <div class="radio-card on" data-v="private"><div class="t">仅自己</div><div class="d">先安静放着</div></div>
          <div class="radio-card" data-v="home"><div class="t">放进家里</div><div class="d">另一位也能看到</div></div>
        </div>
      </div>
      <div id="private-hint" class="form-hint" style="display:none">仅自己可见：不会通知伙伴，也不会出现在对方的房间和回顾里。</div>
      <div class="btn-row">
        <button class="btn ghost" id="btn-draft">存草稿</button>
        <button class="btn primary" id="btn-save">保存</button>
      </div>
      <p class="muted tiny" style="margin-top:10px">保存后会请你在 6 个纪念物里挑一件，把这段回忆放进家里的一个位置。</p>
    </div>
  </div>
  ${tabbar('memories')}`;

  const textEl = document.getElementById('m-text');
  const counter = document.getElementById('text-counter');
  const topicInput = document.getElementById('m-topic');
  const syncTopicChips = () => {
    $app.querySelectorAll('#topic-chips .chip-btn').forEach((c) => {
      c.classList.toggle('on', c.dataset.t === topicInput.value);
    });
  };
  $app.querySelectorAll('#topic-chips .chip-btn').forEach((c) => {
    c.onclick = () => {
      topicInput.value = topicInput.value === c.dataset.t ? '' : c.dataset.t;
      syncTopicChips();
      resetSaveKey();
    };
  });
  textEl.addEventListener('input', () => {
    counter.textContent = `${textEl.value.length} / 500`;
    counter.classList.toggle('over', textEl.value.length > 500);
    resetSaveKey();
  });
  document.getElementById('m-date').addEventListener('change', resetSaveKey);

  let visibility = 'private';
  bindRadioCards($app, '#vis-cards .radio-card', (c) => {
    visibility = c.dataset.v;
    document.getElementById('private-hint').style.display = visibility === 'private' ? 'block' : 'none';
    resetSaveKey();
  });

  // 草稿恢复（明确选择，M52）
  const banner = document.getElementById('draft-banner');
  if (draft && (draft.text || draft.topic || draft.title)) {
    banner.innerHTML = `<div class="form-hint" style="display:flex;align-items:center;gap:8px">
      <span style="flex:1">有一份未完成的草稿（仅保存在这台设备）</span>
      <button class="btn gold sm" id="draft-restore">恢复</button>
      <button class="btn ghost sm" id="draft-drop">丢弃</button>
    </div>`;
    banner.querySelector('#draft-restore').onclick = () => {
      textEl.value = draft.text || '';
      document.getElementById('m-date').value = draft.eventDate || todayStr();
      topicInput.value = draft.topic || '';
      syncTopicChips();
      counter.textContent = `${textEl.value.length} / 500`;
      resetSaveKey();
      banner.innerHTML = '';
      toast('草稿已恢复（照片需要重新选择）');
    };
    banner.querySelector('#draft-drop').onclick = () => {
      clearDraft();
      banner.innerHTML = '';
    };
  }

  const grid = document.getElementById('photo-grid');
  const input = document.getElementById('photo-input');
  input.addEventListener('change', async () => {
    for (const f of input.files) {
      if (photos.length >= 6) break;
      photos.push(f);
    }
    input.value = '';
    resetSaveKey();
    renderPhotos();
  });
  function renderPhotos() {
    grid.querySelectorAll('.pick-cell').forEach((x) => x.remove());
    photos.forEach((f, i) => {
      const cell = document.createElement('div');
      cell.className = 'pick-cell';
      cell.innerHTML = `<img src="${URL.createObjectURL(f)}" alt="待上传照片"><button class="x" aria-label="移除照片">✕</button>`;
      cell.querySelector('.x').onclick = () => {
        photos.splice(i, 1);
        if (i < uploadedIds.length) uploadedIds.splice(i, 1); // 已上传的同步移除，保持与预览一致（B04）
        resetSaveKey();
        renderPhotos();
      };
      grid.insertBefore(cell, document.getElementById('pick-add'));
    });
    document.getElementById('photo-counter').textContent = photos.length > 0 ? `${photos.length} / 6 张` : '';
  }

  const gather = () => ({
    text: textEl.value.trim(),
    eventDate: document.getElementById('m-date').value,
    topic: document.getElementById('m-topic').value || undefined,
    visibility,
  });

  document.getElementById('btn-draft').onclick = () => {
    saveDraft(gather());
    toast('草稿已保存在这台设备上');
  };

  document.getElementById('btn-save').onclick = async () => {
    const errBox = document.getElementById('form-error');
    errBox.innerHTML = '';
    const data = gather();
    if (!data.text && photos.length === 0) {
      errBox.innerHTML = `<div class="form-error">照片或文字至少留一项</div>`;
      return;
    }
    const btn = document.getElementById('btn-save');
    btn.disabled = true;
    btn.textContent = '保存中…';
    try {
      // 只上传尚未成功的照片；失败重试复用已上传 ID 与同一幂等键（B04/B05）
      while (uploadedIds.length < photos.length) {
        try {
          uploadedIds.push(await uploadImage(photos[uploadedIds.length], 'memory'));
        } catch (uploadErr) {
          uploadedIds.length = Math.min(uploadedIds.length, photos.length);
          throw new Error(`「${photos[uploadedIds.length]?.name || '照片'}」上传失败：${uploadErr.message}`);
        }
      }
      const res = await api('POST', '/api/memories', { ...data, photoUploadIds: uploadedIds }, { idempotencyKey: saveKey });
      clearDraft();
      location.hash = `#/new/${res.memoryId}/object`;
    } catch (e) {
      // 保存失败：保留输入、已上传照片与说明，重试只补差量（计划书状态矩阵 / B04）
      btn.disabled = false;
      btn.textContent = '重试保存';
      const keptPhotos = uploadedIds.length;
      errBox.innerHTML = `<div class="form-error">${esc(e.message)}<br><span class="tiny">${
        keptPhotos > 0
          ? `已上传的 ${keptPhotos} 张照片已保留，重试不会重复上传；`
          : ''
      }文字和选择都还在，可以直接重试；也可以先存草稿。</span></div>`;
    }
  };
}

// ================= S04 · 选择纪念物（设计 06/07/08：挑选 → 摆放 → 小狗带回） =================
// 说明：templateKey 与服务端契约不变；展示名对齐 Consensus Bell 渲染素材
const TPL_INFO = {
  shell: { name: '贝壳', hint: '海边、湖边、一次出游', slots: ['窗台', '茶几', '房间角落'] },
  ticket: { name: '信封票根', hint: '电影票、演出、一张明信片', slots: ['沙发旁的小桌', '茶几'] },
  pot: { name: '树桩小罐', hint: '一起做饭、慢慢炖的日子', slots: ['厨房角落', '茶几'] },
  umbrella: { name: '小雨伞', hint: '雨天接送、一起散步', slots: ['门口伞架', '房间角落'] },
  tent: { name: '小帐篷', hint: '露营、野餐、户外一天', slots: ['房间角落', '窗台'] },
  cup: { name: '玻璃小船', hint: '一次出游、静静摆着的纪念', slots: ['茶几', '窗台', '沙发旁的小桌'] },
};
const SLOT_NAME = { window: '窗台', sofa_side: '沙发旁的小桌', kitchen: '厨房角落', door: '门口伞架', corner: '房间角落', table: '茶几' };

/** 小狗送达庆祝层（设计 07_dog_delivery，纯展示，不新增任何接口） */
function showDelivery(templateKey, memoryId, slotLabel) {
  const info = TPL_INFO[templateKey];
  const el = document.createElement('div');
  el.className = 'delivery-overlay fade-up';
  el.innerHTML = `
    <img class="scene-img" src="/assets/img/scene-delivery.png" alt="小狗带回纪念物">
    <div style="position:relative;margin:-46px 0 0">${objectIcon(templateKey, 92)}</div>
    <div class="d-title">${esc(petName())} 带回了一件纪念物</div>
    <div class="d-sub">它把「${esc(info?.name || '纪念物')}」${slotLabel ? `放在了${esc(slotLabel)}` : '收进了收纳盒'}，这段回忆已经放进你们的小屋。</div>
    <button class="btn primary" id="dl-open">打开看看</button>`;
  document.body.appendChild(el);
  document.getElementById('dl-open').onclick = () => {
    el.remove();
    location.hash = `#/memory/${memoryId}`;
  };
}
function petName() {
  return state.me?.pet?.name || '小狗';
}

async function viewObjectPick(memoryId) {
  const detail = await api('GET', `/api/memories/${memoryId}`);
  const room = await api('GET', '/api/home/room');
  const free = new Set(room.freeHomeSlots);
  const current = detail.object;
  let picked = current?.templateKey || null;
  let slot = current?.placement?.slotKey || null;

  const heroHtml = () => {
    if (!picked) {
      return `<div class="treasure-hero" id="t-hero">
        <div class="t-hint" style="margin-top:6px">从下面挑一件，配得上这段回忆</div>
      </div>`;
    }
    const v = TPL_INFO[picked];
    return `<div class="treasure-hero" id="t-hero">
      <div style="display:flex;justify-content:center">${objectIcon(picked, 120)}</div>
      <div class="t-name">${v.name}</div>
      <div class="t-hint">${v.hint}</div>
    </div>`;
  };

  $app.innerHTML = `
  ${topbar({ title: '选择纪念物', en: 'CHOOSE A KEEPSAKE' })}
  <div class="page fade-up">
    <div class="card soft">
      <div class="muted tiny">刚刚保存的回忆</div>
      <div class="serif" style="font-size:17px">${esc(detail.title)}</div>
      <p class="muted tiny">${fmtDate(detail.eventDate)}</p>
    </div>
    ${heroHtml()}
    <div class="card">
      <h3 style="margin-bottom:10px">挑一件放进小屋</h3>
      <div class="tpl-grid" id="tpl-grid">
        ${Object.entries(TPL_INFO).map(([k, v]) => `
          <div class="tpl ${picked === k ? 'on' : ''}" data-k="${k}" role="button" tabindex="0">
            <div class="icon">${objectIcon(k, 50)}</div>
            <div class="name">${v.name}</div>
          </div>`).join('')}
      </div>
      <p class="muted tiny" style="margin-top:10px">推荐只是建议，你想放哪儿都行；换一件或收进盒子，都不会改掉写下的文字和照片。</p>
    </div>
    <div class="card">
      <h3>放的位置</h3>
      <div id="slot-area"></div>
      <label style="display:flex;gap:10px;align-items:center;margin-top:14px;cursor:pointer">
        <input type="radio" name="place" id="opt-store" ${!slot ? 'checked' : ''} style="width:20px;height:20px">
        <span>暂时收纳进盒子（以后再放）</span>
      </label>
    </div>
    <div id="obj-error"></div>
    <button class="btn primary block" id="btn-place">${current ? '更新' : '放进去'}</button>
  </div>
  ${tabbar('home')}`;

  const renderHero = () => {
    const hero = document.getElementById('t-hero');
    if (hero) hero.outerHTML = heroHtml();
  };
  const renderSlots = () => {
    const area = document.getElementById('slot-area');
    const tpl = picked ? TPL_INFO[picked] : null;
    const allSlots = Object.entries(SLOT_NAME);
    area.innerHTML = `<div class="chips">${
      allSlots
        .map(([k, label]) => {
          const recommended = tpl ? tpl.slots.includes(label) : false;
          const isFree = free.has(k);
          const allowed = tpl ? recommended : true; // 模板允许的位置（服务端 allowed_slots）
          return `<button type="button" class="chip-btn ${slot === k ? 'on' : ''}" data-slot="${k}"
            ${isFree && allowed ? '' : 'disabled'}
            title="${!isFree ? '这个位置已经有东西了' : !allowed ? '这件物件不适合放这里' : ''}">${recommended ? '✦ ' : ''}${label}</button>`;
        })
        .join('')
    }</div>`;
    area.querySelectorAll('button[data-slot]').forEach((b) => {
      b.onclick = () => {
        slot = b.dataset.slot;
        document.getElementById('opt-store').checked = false;
        renderSlots();
      };
    });
  };
  renderSlots();
  document.getElementById('opt-store').onchange = (ev) => {
    if (ev.target.checked) {
      slot = null;
      renderSlots();
    }
  };
  $app.querySelectorAll('#tpl-grid .tpl').forEach((t) => {
    const pick = () => {
      $app.querySelectorAll('#tpl-grid .tpl').forEach((x) => x.classList.remove('on'));
      t.classList.add('on');
      picked = t.dataset.k;
      renderHero();
      renderSlots();
    };
    t.onclick = pick;
    t.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault(); // 键盘也能选纪念物（B13）
        pick();
      }
    });
  });

  document.getElementById('btn-place').onclick = async () => {
    const errBox = document.getElementById('obj-error');
    errBox.innerHTML = '';
    const useStore = document.getElementById('opt-store').checked;
    try {
      await api('PUT', `/api/memories/${memoryId}/object`, {
        templateKey: picked,
        slotKey: useStore ? 'store' : slot,
      });
      if (useStore) {
        toast('已收进收纳盒');
        location.hash = `#/memory/${memoryId}`;
      } else {
        showDelivery(picked, memoryId, slot ? SLOT_NAME[slot] : '');
      }
    } catch (e) {
      const extra = e.extra?.freeSlots ? `<br><span class="tiny">还可以放：${e.extra.freeSlots.map((s) => SLOT_NAME[s.key] || s.label || s).join('、')}</span>` : '';
      errBox.innerHTML = `<div class="form-error">${esc(e.message)}${extra}</div>`;
      try {
        const r2 = await api('GET', '/api/home/room');
        free.clear();
        r2.freeHomeSlots.forEach((s) => free.add(s));
        renderSlots();
      } catch {}
    }
  };
}

// ================= S05 · 两个人的视角 =================
async function viewMemoryDetail(memoryId) {
  const d = await api('GET', `/api/memories/${memoryId}`);
  const mine = d.contributions.find((c) => c.mine);
  const archived = d.access === 'archive';

  $app.innerHTML = `
  ${topbar({ title: '回忆', en: 'TWO PERSPECTIVES' })}
  <div class="page fade-up">
    ${
      (() => {
        const photo = d.contributions.flatMap((c) => c.photos)[0];
        const objKey = d.object?.templateKey;
        return `<div class="cover-card">
          ${photo
            ? `<div class="cover-photo-wrap"><img class="cover-photo" src="/api/media/${photo.id}" alt="回忆照片"></div>`
            : objKey
            ? `<div style="display:flex;justify-content:center;padding:10px 0 6px">${objectIcon(objKey, 132)}</div>`
            : ''}
          <h1 style="margin:6px 0 2px">${esc(d.title)}</h1>
          <p class="muted" style="margin:0">${fmtDate(d.eventDate)}${d.topic ? ` · ${esc(d.topic)}` : ''}</p>
          <div style="margin-top:8px"><span class="tag ${d.visibility === 'home' ? 'rose' : 'plain'}">${d.visibility === 'home' ? '共同' : '仅自己'}</span></div>
        </div>`;
      })()
    }

    ${archived ? `<div class="form-hint">这段回忆已归档：只能看到你自己的部分，对方的内容不再展示。</div>` : ''}

    ${d.contributions
      .map(
        (c) => `
      <div class="persp">
        <div class="head">
          <span class="mini-avatar ${c.mine ? '' : 'rose'}">${esc(c.authorName.slice(0, 1))}</span>
          <span class="author">${esc(c.authorName)}${c.mine ? '（我）' : ''}</span>
          <span class="tag ${c.visibility === 'home' ? 'rose' : 'plain'} tiny">${c.visibility === 'home' ? '已共享' : '仅自己'}</span>
          ${c.onChain ? `<a class="tag chain tiny" href="${archived && d.homeId ? `#/chain?home=${encodeURIComponent(d.homeId)}` : '#/chain'}" title="${archived ? '查看已定格的旧链' : '查看永恒之链'}">⛓ 第${c.onChain.blockHeight}块${c.onChain.isCurrentRevision ? '' : ' · 已有新版'}</a>` : ''}
          ${archived ? '' : mainnetTagHtml(c.onChain)}
          <span style="flex:1"></span>
          ${c.mine && !archived ? `<button class="btn ghost sm" data-edit="${c.id}">编辑我的视角</button>` : ''}
        </div>
        <div class="text">${esc(c.text) || '<span class="muted tiny">（这一份只有照片）</span>'}</div>
        ${
          c.photos.length > 0
            ? `<div class="photo-grid">${c.photos.map((p) => `<img src="/api/media/${p.id}" alt="回忆照片" loading="lazy">`).join('')}</div>`
            : ''
        }
        ${
          c.mine && !archived
            ? `<div class="btn-row" style="margin-top:12px">
                ${(!c.onChain || !c.onChain.isCurrentRevision) ? `<button class="btn gold sm" data-chain="${c.id}" data-snippet="${esc(c.text.slice(0, 40))}">⛓ 镌刻上链</button>` : ''}
                ${c.visibility === 'home'
                  ? `<button class="btn ghost sm" data-revoke="${c.id}">不再共享这一份</button>`
                  : `<button class="btn soft sm" data-share="${c.id}">共享给${esc(state.me.home.members.length > 1 ? ' 另一位' : '家里')}</button>`}
               </div>`
            : ''
        }
      </div>`
      )
      .join('')}

    ${
      !mine && !archived
        ? `<div class="card" style="text-align:center">
            <div class="serif" style="font-size:16px">也可以补上你记得的那一天</div>
            <p class="muted tiny" style="margin:6px 0 10px">一张照片或一句话就够，不着急。</p>
            <button class="btn soft" id="btn-add-persp">补上我的视角</button>
          </div>`
        : ''
    }

    ${
      mine && !archived
        ? `<div class="btn-row" style="margin-top:6px">
            <button class="btn danger sm" id="btn-del-contrib">删除我这份内容</button>
          </div>
          <p class="muted tiny" style="margin-top:8px">删除只影响你自己这份；另一人的记录不会被删除。</p>`
        : ''
    }

    ${
      d.object
        ? `<div class="card" style="margin-top:16px">
            <h3>纪念物</h3>
            <div style="display:flex;gap:12px;align-items:center">
              <div>${objectIcon(d.object.templateKey, 56)}</div>
              <div style="flex:1">
                <div>${TPL_INFO[d.object.templateKey]?.name || d.object.templateKey}</div>
                <div class="muted tiny">${
                  d.object.placement?.status === 'displayed' ? `摆在${SLOT_NAME[d.object.placement.slotKey] || d.object.placement.slotKey}` : '收在收纳盒里'
                }</div>
              </div>
            </div>
            ${
              d.object.placement && d.access === 'full'
                ? `<div class="btn-row" style="margin-top:10px">
                    ${d.object.placement.status === 'displayed'
                      ? `<button class="btn ghost sm" id="btn-store">收进盒子</button>
                         <button class="btn ghost sm" id="btn-move">换个位置</button>`
                      : `<button class="btn soft sm" id="btn-restore">放回家里</button>`}
                   </div>`
                : ''
            }
          </div>`
        : !archived
        ? `<a class="btn ghost block" href="#/new/${d.id}/object" style="margin-top:10px">给这段回忆挑一件纪念物</a>`
        : ''
    }

    ${
      d.hasPartner && !archived
        ? `<div class="card soft" style="margin-top:14px">
            <div class="serif" style="margin-bottom:6px">一起把这段回忆做成纪念</div>
            <p class="muted tiny" style="margin-bottom:10px">可以把你们的内容做成一张免费的电子明信片。</p>
            <a class="btn gold sm" href="#/works">去做一份纪念</a>
          </div>`
        : ''
    }

    ${
      d.isCreator && d.access === 'full' && !archived
        ? `<div class="btn-row" style="margin-top:16px">
            <button class="btn ghost sm" id="btn-edit-meta">改标题 / 日期 / 主题</button>
          </div>`
        : ''
    }
    <div class="btn-row" style="margin-top:8px">
      <button class="btn ghost sm" id="btn-toggle-hidden"></button>
      ${d.hasPartner && d.visibility === 'home' && d.access === 'full' && !archived ? `<button class="btn danger sm" id="btn-removal">共同移除…</button>` : ''}
    </div>
    <p class="muted tiny" style="margin-top:10px">个人隐藏只是不在你的默认列表和回顾里出现，不会通知对方。</p>
  </div>
  ${tabbar('memories')}`;

  // 隐藏开关状态
  const hiddenList = await api('GET', '/api/me/hidden-memories').catch(() => ({ items: [] }));
  const hidden = hiddenList.items.some((x) => x.id === d.id && x.hidden);
  const hideBtn = document.getElementById('btn-toggle-hidden');
  hideBtn.textContent = hidden ? '取消个人隐藏' : '在我的列表里隐藏';
  hideBtn.onclick = async () => {
    await api('PUT', `/api/me/memory-preferences/${d.id}`, { hidden: !hidden });
    toast(hidden ? '已恢复到默认列表' : '已隐藏（只影响你自己）');
    route();
  };

  // 编辑本人视角
  $app.querySelectorAll('[data-edit]').forEach((b) => {
    b.onclick = () => openContributionEditor(d, mine, () => route());
  });
  if (document.getElementById('btn-add-persp')) {
    document.getElementById('btn-add-persp').onclick = () => openContributionEditor(d, null, () => route());
  }

  // 镌刻上链（我的视角）
  $app.querySelectorAll('[data-chain]').forEach((b) => {
    b.onclick = () =>
      openAnchorModal({ type: 'contribution', id: b.dataset.chain, snippet: b.dataset.snippet || '我的这一天' });
  });

  // 共享 / 撤回共享
  $app.querySelectorAll('[data-share]').forEach((b) => {
    b.onclick = async () => {
      try {
        await api('POST', `/api/contributions/${b.dataset.share}/share`, {});
        toast('已共享。对方现在也能看到这一份');
        route();
      } catch (e) {
        toast(e.message);
      }
    };
  });
  $app.querySelectorAll('[data-revoke]').forEach((b) => {
    b.onclick = async () => {
      openModal(`<h3>不再共享这一份？</h3>
        <p class="muted" style="font-size:14px">撤回后，对方不能再从服务器读取你的文字、照片，相关作品也会停止下载；<b>对方已打开的页面会在片刻后自动更新</b>。已经保存到对方设备或截图的内容，任何系统都无法收回。</p>
        <div class="btn-row"><button class="btn ghost" onclick="closeModal()">再想想</button>
        <button class="btn primary" id="do-revoke">撤回共享</button></div>`);
      document.getElementById('do-revoke').onclick = async () => {
        try {
          await api('POST', `/api/contributions/${b.dataset.revoke}/revoke`, {});
          closeModal();
          toast('已撤回。这只是你这一份，不影响对方的内容');
          route();
        } catch (e) {
          toast(e.message);
        }
      };
    };
  });

  // 删除本人贡献
  const delBtn = document.getElementById('btn-del-contrib');
  if (delBtn) {
    delBtn.onclick = () => {
      openModal(`<h3>删除我这份内容？</h3>
        <p class="muted" style="font-size:14px">删除后你的文字与照片将不可再访问（保留最小审计标记）；另一人的记录不受影响。</p>
        <div class="btn-row"><button class="btn ghost" onclick="closeModal()">再想想</button>
        <button class="btn primary" id="do-del">确认删除</button></div>`);
      document.getElementById('do-del').onclick = async () => {
        try {
          await api('DELETE', `/api/contributions/${mine.id}`);
          closeModal();
          toast('已删除你这份内容');
          location.hash = '#/memories';
        } catch (e) {
          toast(e.message);
        }
      };
    };
  }

  // 摆放操作
  const storeBtn = document.getElementById('btn-store');
  if (storeBtn) {
    storeBtn.onclick = async () => {
      try {
        await api('PUT', `/api/placements/${d.object.placement.id}`, { action: 'store', expectedRevision: d.object.placement.revision });
        toast('已收进盒子（记录都还在）');
        route();
      } catch (e) {
        toast(e.message);
      }
    };
  }
  const moveBtn = document.getElementById('btn-move');
  if (moveBtn) {
    moveBtn.onclick = async () => {
      openModal(`<h3>换个位置</h3><div id="move-slots" style="display:flex;gap:6px;flex-wrap:wrap;margin:10px 0 14px"></div>`);
      const area = document.getElementById('move-slots');
      const room = await api('GET', '/api/home/room');
      const free = new Set(room.freeHomeSlots);
      free.add(d.object.placement.slotKey);
      for (const [k, label] of Object.entries(SLOT_NAME)) {
        const b = document.createElement('button');
        b.className = `tag ${free.has(k) ? '' : 'plain'}`;
        b.textContent = label;
        if (!free.has(k)) b.disabled = true;
        b.onclick = async () => {
          try {
            await api('PUT', `/api/placements/${d.object.placement.id}`, { slotKey: k, expectedRevision: d.object.placement.revision });
            closeModal();
            toast(`已挪到${label}`);
            route();
          } catch (e) {
            toast(e.message);
          }
        };
        area.appendChild(b);
      }
    };
  }
  const restoreBtn = document.getElementById('btn-restore');
  if (restoreBtn) {
    restoreBtn.onclick = async () => {
      openModal(`<h3>放回家里</h3><div id="move-slots" style="display:flex;gap:6px;flex-wrap:wrap;margin:10px 0 14px"></div>`);
      const area = document.getElementById('move-slots');
      const room = await api('GET', '/api/home/room');
      for (const k of room.freeHomeSlots) {
        const b = document.createElement('button');
        b.className = 'tag';
        b.textContent = SLOT_NAME[k] || k;
        b.onclick = async () => {
          try {
            await api('PUT', `/api/placements/${d.object.placement.id}`, { slotKey: k, expectedRevision: d.object.placement.revision });
            closeModal();
            toast(`已放回${SLOT_NAME[k]}`);
            route();
          } catch (e) {
            toast(e.message);
          }
        };
        area.appendChild(b);
      }
    };
  }

  // 元信息编辑
  const metaBtn = document.getElementById('btn-edit-meta');
  if (metaBtn) {
    metaBtn.onclick = () => {
      openModal(`<h3>编辑回忆信息</h3>
        <div class="field"><label for="e-title">短标题（可不填）</label><input class="input" id="e-title" maxlength="16" value="${esc(d.title === '一段回忆' ? '' : d.title)}"></div>
        <div class="field"><label for="e-date">发生日期</label><input class="input" id="e-date" type="date" value="${d.eventDate}" max="${todayStr()}"></div>
        <div class="field"><label for="e-topic">主题</label><select class="select" id="e-topic">
          <option value="">不选</option>${['日常', '出游', '美食', '影音', '雨天', '户外', '节日', '其他'].map((t) => `<option ${d.topic === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
        <button class="btn primary block" id="e-save">保存</button>`);
      document.getElementById('e-save').onclick = async () => {
        try {
          await api('PATCH', `/api/memories/${d.id}`, {
            title: document.getElementById('e-title').value.trim() || null,
            eventDate: document.getElementById('e-date').value,
            topic: document.getElementById('e-topic').value || null,
            expectedRevision: d.revision,
          });
          closeModal();
          route();
        } catch (e) {
          toast(e.message);
        }
      };
    };
  }

  // 共同移除
  const removalBtn = document.getElementById('btn-removal');
  if (removalBtn) {
    removalBtn.onclick = async () => {
      const waitingMe = d.removalRequestedBy && d.removalRequestedBy !== state.me.id;
      openModal(`<h3>共同移除这段回忆</h3>
        ${waitingMe
          ? `<p style="font-size:14px">对方已经请求移除。确认后：<b>共同入口将移除，各自原始内容仍由本人管理</b>。</p>`
          : `<p style="font-size:14px">移除需要两个人都同意当前版本。发起请求后，对方确认才会移除；<b>共同入口将移除，各自原始内容仍由本人管理</b>。</p>`}
        <div class="btn-row">
          <button class="btn ghost" onclick="closeModal()">再想想</button>
          ${waitingMe
            ? `<button class="btn primary" id="do-approve-removal">确认移除</button>`
            : `<button class="btn primary" id="do-request-removal">发起请求</button>`}
        </div>`);
      const req = document.getElementById('do-request-removal');
      if (req) {
        req.onclick = async () => {
          try {
            await api('POST', `/api/memories/${d.id}/removal-requests`, {});
            closeModal();
            toast('已发出请求，等对方确认');
          } catch (e) {
            toast(e.message);
          }
        };
      }
      const ap = document.getElementById('do-approve-removal');
      if (ap) {
        ap.onclick = async () => {
          try {
            await api('POST', `/api/memories/${d.id}/approve-removal`, { expectedRevision: d.revision });
            closeModal();
            toast('共同入口已移除，各自内容仍在自己的档案里');
            route();
          } catch (e) {
            toast(e.message);
          }
        };
      }
    };
  }

  // B04（v3.5）：页面里有对方可见的共享内容时保持低频校验；撤回后清屏重绘并提示
  if (!archived && d.contributions.some((c) => !c.mine && c.visibility === 'home')) {
    watchSharedMemoryAccess(d.id);
  }
}

// 贡献编辑器（新增 / 编辑本人视角）
function openContributionEditor(d, contribution, done) {
  const isEdit = !!contribution;
  const modal = openModal(`<h3>${isEdit ? '编辑我的视角' : '补上我的视角'}</h3>
    <div id="c-error"></div>
    <div class="field">
      <label>照片（最多 6 张）</label>
      <div class="pick-grid" id="c-grid">
        <label class="pick" id="c-add">＋<span>选照片</span>
          <input type="file" id="c-input" accept="image/jpeg,image/png,image/webp" multiple class="sr-only"></label>
      </div>
    </div>
    <div class="field">
      <label for="c-text">我记得的那一天（500 字以内）</label>
      <textarea class="textarea" id="c-text" maxlength="500" placeholder="你一直护着我手里的冰淇淋…">${esc(contribution?.text || '')}</textarea>
      <div class="counter" id="c-counter">${(contribution?.text || '').length} / 500</div>
    </div>
    <div class="field">
      <div class="radio-cards" id="c-vis">
        <div class="radio-card ${!isEdit || contribution.visibility === 'private' ? 'on' : ''}" data-v="private"><div class="t">仅自己</div></div>
        <div class="radio-card ${isEdit && contribution.visibility === 'home' ? 'on' : ''}" data-v="home"><div class="t">放进家里</div></div>
      </div>
    </div>
    <button class="btn primary block" id="c-save">${isEdit ? '保存新版本' : '留下我的视角'}</button>
    <p class="muted tiny" style="margin-top:8px">${isEdit ? '保存会创建你的新版本；对方基于旧版本的授权会失效。' : '编辑只写你自己的这一份，不会动对方的内容。'}</p>`);

  let newFiles = [];
  let uploadedIds = []; // 已上传待提交的新照片（B04）
  let saveKey = newIdemKey(); // 新增视角的稳定幂等键（B05）
  const removeIds = new Set();
  const grid = document.getElementById('c-grid');
  const input = document.getElementById('c-input');
  const textEl = document.getElementById('c-text');
  textEl.addEventListener('input', () => {
    document.getElementById('c-counter').textContent = `${textEl.value.length} / 500`;
    saveKey = newIdemKey();
  });
  let vis = isEdit ? contribution.visibility : 'private';
  // 绑定在弹窗容器内（B02）
  bindRadioCards(modal, '#c-vis .radio-card', (c) => {
    vis = c.dataset.v;
  });

  const renderGrid = () => {
    grid.querySelectorAll('.pick-cell').forEach((x) => x.remove());
    (contribution?.photos || []).forEach((p) => {
      const cell = document.createElement('div');
      cell.className = 'pick-cell';
      cell.innerHTML = `<img src="/api/media/${p.id}?variant=thumb" alt="已有照片" style="${removeIds.has(p.id) ? 'opacity:.3' : ''}">
        <button class="x" aria-label="移除">${removeIds.has(p.id) ? '↺' : '✕'}</button>`;
      cell.querySelector('.x').onclick = () => {
        if (removeIds.has(p.id)) removeIds.delete(p.id);
        else removeIds.add(p.id);
        saveKey = newIdemKey();
        renderGrid();
      };
      grid.insertBefore(cell, document.getElementById('c-add'));
    });
    newFiles.forEach((f, i) => {
      const cell = document.createElement('div');
      cell.className = 'pick-cell';
      cell.innerHTML = `<img src="${URL.createObjectURL(f)}" alt="待上传"><button class="x" aria-label="移除">✕</button>`;
      cell.querySelector('.x').onclick = () => {
        newFiles.splice(i, 1);
        if (i < uploadedIds.length) uploadedIds.splice(i, 1);
        saveKey = newIdemKey();
        renderGrid();
      };
      grid.insertBefore(cell, document.getElementById('c-add'));
    });
  };
  renderGrid();
  input.addEventListener('change', async () => {
    for (const f of input.files) {
      if ((contribution?.photos.length || 0) - removeIds.size + newFiles.length >= 6) break;
      newFiles.push(f);
    }
    input.value = '';
    saveKey = newIdemKey();
    renderGrid();
  });

  document.getElementById('c-save').onclick = async () => {
    const errBox = document.getElementById('c-error');
    errBox.innerHTML = '';
    const text = textEl.value.trim();
    const kept = (contribution?.photos.length || 0) - removeIds.size;
    if (!text && kept + newFiles.length === 0) {
      errBox.innerHTML = `<div class="form-error">照片或文字至少留一项</div>`;
      return;
    }
    const btn = document.getElementById('c-save');
    btn.disabled = true;
    btn.textContent = '保存中…';
    try {
      while (uploadedIds.length < newFiles.length) {
        uploadedIds.push(await uploadImage(newFiles[uploadedIds.length], 'memory')); // 失败重试只补差量（B04）
      }
      const addIds = [...uploadedIds];
      if (isEdit) {
        await api('PATCH', `/api/contributions/${contribution.id}`, {
          text,
          addPhotoIds: addIds,
          removePhotoIds: [...removeIds],
          expectedRevision: contribution.version,
        });
        if (vis !== contribution.visibility) {
          await api('POST', `/api/contributions/${contribution.id}/${vis === 'home' ? 'share' : 'revoke'}`, {});
        }
      } else {
        const res = await api('POST', `/api/memories/${d.id}/contributions`, {
          text,
          photoUploadIds: addIds,
          visibility: vis,
        }, { idempotencyKey: saveKey });
      }
      closeModal();
      done();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = '重试保存';
      errBox.innerHTML = `<div class="form-error">${esc(e.message)}<br><span class="tiny">内容都还在${
        uploadedIds.length > 0 ? `，已上传的 ${uploadedIds.length} 张照片也已保留` : ''
      }，可以直接重试。</span></div>`;
    }
  };
}

// ================= S11 · 收纳与查找 =================
async function viewStorage() {
  const [{ items, freeSlots }] = await Promise.all([api('GET', '/api/storage')]);
  const [{ items: allMems }] = await Promise.all([api('GET', '/api/memories')]);
  const topics = [...new Set(allMems.map((m) => m.topic).filter(Boolean))];
  const q = '';
  let filterTopic = '';

  $app.innerHTML = `
  ${topbar({ title: '收纳与查找', en: 'BOX & FIND' })}
  <div class="page fade-up">
    <div class="card">
      <h3>收纳盒</h3>
      ${items.length === 0 ? `<div class="empty"><div class="big">盒子是空的</div><p class="tiny">从家里收进来的物件会躺在这里，记录不会被删掉</p></div>` : ''}
      <div id="box-list">
        ${items
          .map(
            (it) => `<div class="mem-card" style="cursor:default">
          <div class="mem-thumb">${objectIcon(it.templateKey, 40)}</div>
          <div class="mem-body">
            <div class="mem-title">${esc(it.memory.title)}</div>
            <div class="mem-meta"><span class="tag plain">${fmtDate(it.memory.eventDate).slice(5)}</span>
            ${it.memory.topic ? `<span class="tag">${esc(it.memory.topic)}</span>` : ''}
            ${it.mine ? '' : `<span class="tag rose tiny">对方放的</span>`}</div>
          </div>
          <button class="btn soft sm" data-restore="${it.placementId}" data-rev="${it.revision}">放回</button>
        </div>`
          )
          .join('')}
      </div>
    </div>
    <div class="card">
      <h3>查找</h3>
      <form id="find-form" class="find-form">
        <input class="input" id="f-q" placeholder="关键词" aria-label="搜索关键词">
        <input class="input" id="f-date" type="date" aria-label="按日期筛选">
        <button class="btn ghost" type="submit" aria-label="搜索">🔍</button>
      </form>
      <div class="chips" style="margin-top:10px">
        ${topics.map((t) => `<button type="button" class="chip-btn" data-topic="${esc(t)}">${esc(t)}</button>`).join('')}
      </div>
      <div id="find-result" style="margin-top:12px"></div>
    </div>
  </div>
  ${tabbar('memories')}`;

  $app.querySelectorAll('[data-restore]').forEach((b) => {
    b.onclick = async () => {
      openModal(`<h3>放回哪里</h3><div id="rs-slots" style="display:flex;gap:6px;flex-wrap:wrap;margin:10px 0 14px"></div>`);
      const area = document.getElementById('rs-slots');
      for (const k of freeSlots) {
        const btn = document.createElement('button');
        btn.className = 'tag';
        btn.textContent = SLOT_NAME[k] || k;
        btn.onclick = async () => {
          try {
            await api('PUT', `/api/placements/${b.dataset.restore}`, { slotKey: k, expectedRevision: Number(b.dataset.rev) });
            closeModal();
            toast(`已放回${SLOT_NAME[k]}`);
            route();
          } catch (e) {
            toast(e.message);
          }
        };
        area.appendChild(btn);
      }
    };
  });

  const doFind = async (q, date, topic) => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (date) p.set('to', date), p.set('from', date);
    if (topic) p.set('topic', topic);
    const { items } = await api('GET', `/api/memories?${p.toString()}`);
    document.getElementById('find-result').innerHTML =
      items.length === 0
        ? `<p class="muted tiny">没有找到匹配的回忆（只搜索你有权看到的内容）</p>`
        : items
            .map(
              (m) => `<a class="mem-card" href="#/memory/${m.id}">
            <div class="mem-thumb">${m.photoThumbId ? `<img src="/api/media/${m.photoThumbId}?variant=thumb" alt="">` : objectIcon(m.objectTemplate || 'shell', 40)}</div>
            <div class="mem-body"><div class="mem-title">${esc(m.title)}</div>
            <div class="mem-meta"><span class="tag plain">${fmtDate(m.eventDate)}</span>${m.topic ? `<span class="tag">${esc(m.topic)}</span>` : ''}</div></div></a>`
            )
            .join('');
  };
  document.getElementById('find-form').onsubmit = (ev) => {
    ev.preventDefault();
    doFind(document.getElementById('f-q').value.trim(), document.getElementById('f-date').value, '');
  };
  $app.querySelectorAll('[data-topic]').forEach((b) => {
    b.onclick = () => doFind('', '', b.dataset.topic);
  });
}

// ================= S09 · 邀请你回家 =================
async function viewInviteCreate() {
  const [{ items }] = await Promise.all([api('GET', '/api/memories')]);
  const sharedMems = items.filter((m) => m.access === 'full' && m.perspectives.some((p) => p.mine && p.shared));
  const invites = await api('GET', '/api/me/spaces').then(() => null).catch(() => null);

  $app.innerHTML = `
  ${topbar({ title: '邀请你回家', en: 'INVITE' })}
  <div class="page fade-up">
    <div class="visit-card">
      <div class="vc-head">
        <span class="vc-ava">${esc((state.me.displayName || '我').slice(0, 1))}</span>
        <div style="flex:1">
          <div class="vc-name">邀请另一个人回来</div>
          <div class="vc-sub">你们会同住一间小屋，共用一只小狗</div>
        </div>
      </div>
      <p class="muted" style="font-size:14px;margin:0 0 12px">对方接受后会和你在同一间小家：可以各自往同一段回忆里补上自己的视角。你现有的私密内容不会被自动公开。</p>
      <div class="field">
        <label for="inv-msg">想对 TA 说的话（可不填）</label>
        <input class="input" id="inv-msg" maxlength="120" placeholder="来把我们记得的日子放在一起吧">
      </div>
      <div class="field">
        <label>围绕一段回忆邀请（可选，需要先共享那段回忆）</label>
        <select class="select" id="inv-mem">
          <option value="">不附预览，只发普通邀请</option>
          ${sharedMems.map((m) => `<option value="${m.id}">${esc(m.title)}（${fmtDate(m.eventDate)}）</option>`).join('')}
        </select>
        <div id="inv-preview-photos"></div>
      </div>
      <div id="inv-error"></div>
      <button class="btn primary block" id="btn-invite">生成邀请</button>
    </div>
    <div class="card" id="inv-result" style="display:none">
      <h3>邀请已生成</h3>
      <p class="muted tiny">链接 7 天内有效，只能使用一次。复制链接发给你想邀请的人；撤销后旧链接立即失效。</p>
      <div class="form-hint break-all" id="inv-link"></div>
      <div class="btn-row">
        <button class="btn ghost" id="btn-copy">复制链接</button>
        <button class="btn danger" id="btn-revoke">撤销邀请</button>
      </div>
    </div>
  </div>
  ${tabbar('me')}`;

  let previewMediaId = null;
  const memSel = document.getElementById('inv-mem');
  memSel.onchange = async () => {
    previewMediaId = null;
    const area = document.getElementById('inv-preview-photos');
    area.innerHTML = '';
    if (!memSel.value) return;
    const d = await api('GET', `/api/memories/${memSel.value}`);
    const mineShared = d.contributions.find((c) => c.mine && c.visibility === 'home');
    const photos = mineShared ? mineShared.photos : [];
    if (photos.length === 0) {
      area.innerHTML = `<p class="muted tiny" style="margin-top:6px">这段回忆还没有你共享的照片，将只发送文字邀请。</p>`;
      return;
    }
    area.innerHTML = `<p class="muted tiny" style="margin:6px 0">点选一张作为预览图（对方接受前只能看到这一张）：</p>
      <div class="photo-grid" style="grid-template-columns:repeat(4,1fr)">${photos
        .map((p) => `<img data-mem="${p.id}" src="/api/media/${p.id}?variant=thumb" alt="候选预览图" style="cursor:pointer;border-radius:10px">`)
        .join('')}</div>`;
    area.querySelectorAll('img').forEach((img) => {
      img.onclick = () => {
        area.querySelectorAll('img').forEach((x) => (x.style.outline = ''));
        img.style.outline = '3px solid var(--rose)';
        previewMediaId = img.dataset.mem;
      };
    });
  };

  let currentInvite = null;
  document.getElementById('btn-invite').onclick = async () => {
    const errBox = document.getElementById('inv-error');
    errBox.innerHTML = '';
    try {
      const res = await api('POST', `/api/homes/${state.me.home.id}/invites`, {
        message: document.getElementById('inv-msg').value.trim() || null,
        previewMediaId,
      });
      currentInvite = res;
      document.getElementById('inv-result').style.display = 'block';
      document.getElementById('inv-link').textContent = `${location.origin}/${res.url}`;
      document
        .getElementById('inv-result')
        .scrollIntoView({ behavior: document.documentElement.classList.contains('reduce-motion') ? 'auto' : 'smooth' });
    } catch (e) {
      errBox.innerHTML = `<div class="form-error">${esc(e.message)}</div>`;
    }
  };
  document.getElementById('btn-copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(document.getElementById('inv-link').textContent);
      toast('链接已复制');
    } catch {
      toast('复制失败，请长按链接手动复制');
    }
  };
  document.getElementById('btn-revoke').onclick = async () => {
    if (!currentInvite) return;
    try {
      await api('POST', `/api/invites/${currentInvite.inviteId}/revoke`, {});
      toast('已撤销，旧链接不能再使用');
      document.getElementById('inv-result').style.display = 'none';
    } catch (e) {
      toast(e.message);
    }
  };
}

// 接受邀请（公开令牌页）
async function viewInviteAccept(params) {
  const token = params.get('t') || '';
  const info = await api('GET', `/api/invites/info?token=${encodeURIComponent(token)}`);
  const loggedIn = !!state.me;
  const usable = info.status === 'pending';

  $app.innerHTML = `
  <div class="page fade-up" style="padding-top:48px">
    <div class="dog-stage breathe">${dogPoseImg('wheat', 130)}</div>
    <div class="visit-card" style="text-align:left">
      <div class="vc-head">
        <span class="vc-ava rose">${esc(info.inviterName.slice(0, 1))}</span>
        <div style="flex:1">
          <div class="vc-name">${esc(info.inviterName)} 邀请你回家</div>
          <div class="vc-sub">一间由回忆慢慢布置起来的小家</div>
        </div>
      </div>
      ${info.message ? `<div class="vc-msg">「${esc(info.message)}」</div>` : ''}
      ${
        info.hasPreview
          ? `<img src="/api/invites/preview?token=${encodeURIComponent(token)}" alt="预览照片"
              style="max-width:200px;border-radius:16px;margin:12px 0 0">`
          : `<p class="muted tiny" style="margin:12px 0 0">（对方没有附上照片预览）</p>`
      }
      <p class="muted tiny" style="margin:12px 0 0">加入后：你们共用一间小家和一只小狗；各自的回忆仍然归各自管理，随时可以免费导出和退出。</p>
      ${
        usable
          ? ''
          : `<div class="form-error" style="margin-top:10px">${
              { used: '这份邀请已经被使用过了', revoked: '这份邀请已被撤销', expired: '这份邀请已过期' }[info.status] || '邀请不可用'
            }</div>`
      }
      ${usable && !loggedIn ? `<p class="muted tiny" style="margin:12px 0 0">需要先注册或登录你自己的账户，不能共用对方的账户。</p>` : ''}
    </div>
    ${
        usable
          ? `<button class="btn primary block" id="btn-accept" ${!loggedIn ? 'disabled' : ''}>${loggedIn ? '接受邀请，回家' : '请先登录或注册'}</button>`
          : `<a class="btn ghost block" href="#/home">回到我的空间</a>`
      }
    ${!loggedIn && usable ? `<div class="btn-row" style="margin-top:10px">
      <a class="btn ghost" href="#/login" data-return>登录</a><a class="btn ghost" href="#/register" data-return>注册</a></div>` : ''}
  </div>`;

  // 记住来处：登录/注册后自动回到这份邀请（B03）
  $app.querySelectorAll('[data-return]').forEach((a) => {
    a.addEventListener('click', () => sessionStorage.setItem('manji:returnTo', location.hash));
  });

  const btn = document.getElementById('btn-accept');
  if (btn && loggedIn) {
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = '正在回家…';
      try {
        await api('POST', '/api/invites/accept', { token });
        state.me = await loadMe();
        toast('欢迎回家');
        location.hash = '#/home';
      } catch (e) {
        btn.disabled = false;
        btn.textContent = '接受邀请，回家';
        openModal(`<h3>暂时不能加入</h3><p class="muted">${esc(e.message)}</p><button class="btn ghost block" onclick="closeModal()">知道了</button>`);
      }
    };
  }
}



// ================= S06 · 说好的承诺 =================
const P_STATUS = {
  proposed: { label: '等你愿意时', cls: '' },
  active: { label: '进行中', cls: 'rose' },
  completed: { label: '已完成', cls: 'ok' },
  paused: { label: '已推迟', cls: 'plain' },
  archived: { label: '已收起', cls: 'plain' },
};

async function viewPromises() {
  const { items } = await api('GET', '/api/promises');
  const shared = state.me.home.isShared;
  const visible = items.filter((p) => p.status !== 'archived');
  const archived = items.filter((p) => p.status === 'archived');

  const cardHtml = (p) => `
    <div class="card">
      <div style="display:flex;gap:8px;align-items:flex-start">
        <div style="flex:1">
          <div class="serif" style="font-size:16px">${esc(p.text)}</div>
          <div class="mem-meta" style="margin-top:6px">
            <span class="tag ${P_STATUS[p.status].cls}">${P_STATUS[p.status].label}${p.needsReconfirm && p.status === 'active' ? ' · 待重新确认' : ''}</span>
            ${p.dueDate ? `<span class="tag plain">${fmtDate(p.dueDate).slice(5)}</span>` : ''}
            <span class="tag plain">${p.scope === 'shared' ? '两个人的' : '我自己的'}</span>
            ${p.onChain ? `<a class="tag chain" href="#/chain" title="查看永恒之链">⛓ 在链上 · 第${p.onChain.blockHeight}块${p.onChain.isCurrentRevision ? '' : ' · 已有新版'}</a>` : ''}
            ${mainnetTagHtml(p.onChain)}
          </div>
          ${p.note ? `<p class="muted tiny" style="margin-top:6px">${esc(p.note)}</p>` : ''}
          ${p.status === 'completed' && p.completedBy ? `<p class="muted tiny" style="margin-top:4px">${esc(p.completedBy)} 记下了这件事完成${p.undoNote ? `；${esc(p.undoNote)}` : ''}</p>` : ''}
          ${p.scope === 'shared' && p.status === 'proposed' && !p.mine ? `<p class="muted tiny" style="margin-top:4px">${esc(p.authorName)} 提出的，等你愿意。</p>` : ''}
        </div>
      </div>
      <div class="btn-row" style="margin-top:12px">
        ${p.waitingMyConfirm ? `<button class="btn rose sm" data-act="accept" data-id="${p.id}">我也愿意</button>` : ''}
        ${p.status === 'active' || p.status === 'proposed' ? `<button class="btn ghost sm" data-act="complete" data-id="${p.id}">记下完成</button>` : ''}
        ${p.status === 'completed' ? `<button class="btn ghost sm" data-act="reopen" data-id="${p.id}">再聊聊这个承诺</button>` : ''}
        ${p.status === 'active' ? `<button class="btn ghost sm" data-act="pause" data-id="${p.id}">推迟</button>` : ''}
        ${p.status === 'paused' ? `<button class="btn ghost sm" data-act="resume" data-id="${p.id}">继续</button>` : ''}
        ${chainEligible(p) ? `<button class="btn gold sm" data-act="chain" data-id="${p.id}">⛓ 镌刻上链</button>` : ''}
        ${p.mine ? `<button class="btn ghost sm" data-act="edit" data-id="${p.id}">修改</button>` : ''}
        ${p.mine ? `<button class="btn ghost sm" data-act="archive" data-id="${p.id}">收起</button>` : ''}
      </div>
    </div>`;

  $app.innerHTML = `
  ${topbar({ title: '说好的承诺', en: 'LITTLE PROMISES' })}
  <div class="page fade-up">
    <div class="seg-tabs"><a class="on" href="#/promises">说好的承诺</a><a href="#/anniversaries">纪念日与作品</a><a href="#/chain">永恒之链</a></div>
    <p class="muted" style="margin-bottom:12px">温和的小约定。不打分、不排名，完成只是记下这件事。</p>
    <button class="btn primary block" id="btn-new-promise">＋ 新的约定</button>
    <div style="margin-top:14px">
      ${visible.length === 0 ? `<div class="empty"><div class="big">还没有约定</div><p class="tiny">一个小小的承诺也好，比如"下周一起做一次早饭"</p></div>` : visible.map(cardHtml).join('')}
    </div>
    ${archived.length > 0 ? `<h3 style="margin-top:16px">已收起</h3>${archived.map(cardHtml).join('')}` : ''}
  </div>
  ${tabbar('memorial')}`;

  // 快捷创建入口带 ?new=1 时自动打开表单（用完即从地址栏清除，避免刷新重复弹出）
  if (location.hash.includes('new=1')) {
    history.replaceState(null, '', '#/promises');
    openPromiseForm(null);
  }
  document.getElementById('btn-new-promise').onclick = () => openPromiseForm(null);
  $app.querySelectorAll('[data-act]').forEach((b) => {
    const p = items.find((x) => x.id === b.dataset.id);
    b.onclick = async () => {
      const act = b.dataset.act;
      try {
        if (act === 'accept') await api('POST', `/api/promises/${p.id}/accept`, {});
        else if (act === 'complete') await api('POST', `/api/promises/${p.id}/complete`, {});
        else if (act === 'pause') await api('POST', `/api/promises/${p.id}/pause`, {});
        else if (act === 'resume') await api('POST', `/api/promises/${p.id}/resume`, {});
        else if (act === 'archive') await api('POST', `/api/promises/${p.id}/archive`, {});
        else if (act === 'edit') return openPromiseForm(p);
        else if (act === 'chain') return openAnchorModal({ type: 'promise', id: p.id, snippet: p.text, shared: p.scope === 'shared' });
        else if (act === 'reopen') {
          const note = prompt('想说什么？（可不填）') || '';
          await api('POST', `/api/promises/${p.id}/reopen`, { note });
        }
        route();
      } catch (e) {
        toast(e.message);
      }
    };
  });

  // U02：共同家里停在约定页时探测另一半的动态
  if (state.me?.home?.isShared) {
    watchListFreshness('约定', items.map((p) => `${p.id}@${p.revision}`).join(','), async () => {
      const { items: fresh } = await api('GET', '/api/promises');
      return fresh.map((p) => `${p.id}@${p.revision}`).join(',');
    });
  }
}

function openPromiseForm(p) {
  const modal = openModal(`<h3>${p ? '修改约定' : '新的约定'}</h3>
    <div id="p-error"></div>
    <div class="field"><label for="p-text">一句约定</label>
      <input class="input" id="p-text" maxlength="60" value="${esc(p?.text || '')}" placeholder="下周一起做一次早饭"></div>
    <div class="field"><label for="p-note">补充（可不填）</label>
      <input class="input" id="p-note" maxlength="120" value="${esc(p?.note || '')}"></div>
    <div class="field"><label for="p-date">日期（可不填）</label>
      <input class="input" id="p-date" type="date" value="${p?.dueDate || ''}"></div>
    ${!p && state.me.home.isShared ? `<div class="field"><label>范围</label>
      <div class="radio-cards" id="p-scope">
        <div class="radio-card on" data-s="personal"><div class="t">我自己的</div></div>
        <div class="radio-card" data-s="shared"><div class="t">两个人的</div><div class="d">对方愿意后生效</div></div>
      </div></div>` : ''}
    ${p && p.scope === 'shared' ? `<p class="muted tiny" style="margin-bottom:10px">改文字或日期后，需要对方重新点一次"我也愿意"。</p>` : ''}
    <button class="btn primary block" id="p-save">保存</button>
    ${p && p.mine ? `<button class="btn danger block" id="p-del" style="margin-top:8px">删除这条</button>` : ''}`);
  let scope = 'personal';
  bindRadioCards(modal, '#p-scope .radio-card', (c) => {
    scope = c.dataset.s;
  });
  // B06（v3.5）：一次表单一个稳定幂等键 + 保存中禁用按钮；慢网双击不会再生成两条一样的约定
  let saveKey = newIdemKey();
  document.getElementById('p-save').onclick = async () => {
    const text = document.getElementById('p-text').value.trim();
    if (!text) return toast('写一句约定吧');
    const btn = document.getElementById('p-save');
    btn.disabled = true;
    btn.textContent = '保存中…';
    try {
      const body = {
        text,
        note: document.getElementById('p-note').value.trim() || null,
        dueDate: document.getElementById('p-date').value || null,
      };
      if (p) await api('PATCH', `/api/promises/${p.id}`, { ...body, expectedRevision: p.revision });
      else await api('POST', '/api/promises', { ...body, scope }, { idempotencyKey: saveKey });
      closeModal();
      route();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = '保存';
      document.getElementById('p-error').innerHTML = `<div class="form-error">${esc(e.message)}</div>`;
    }
  };
  const del = document.getElementById('p-del');
  if (del) {
    del.onclick = async () => {
      await api('DELETE', `/api/promises/${p.id}`);
      closeModal();
      route();
    };
  }
}

// ================= S07 · 纪念日 =================
async function viewAnniversaries() {
  const { items, today } = await api('GET', '/api/anniversaries');

  $app.innerHTML = `
  ${topbar({ title: '纪念日', en: 'ANNIVERSARIES' })}
  <div class="page fade-up">
    <div class="seg-tabs"><a href="#/promises">说好的承诺</a><a class="on" href="#/anniversaries">纪念日与作品</a><a href="#/chain">永恒之链</a></div>
    <button class="btn primary block" id="btn-new-ann">＋ 添加纪念日</button>
    <p class="muted tiny" style="margin:10px 0 14px">只是安安静静的日期提醒。到了那天想做什么，由你们自己决定。</p>
    ${
      items.length === 0
        ? `<div class="empty"><div class="big">还没有纪念日</div><p class="tiny">第一次见面、某个小小的约定日，都可以</p></div>`
        : items
            .map(
              (a) => `
      <div class="card">
        <div style="display:flex;align-items:center;gap:10px">
          <div style="flex:1">
            <div class="serif" style="font-size:17px">${esc(a.title)}</div>
            <div class="mem-meta" style="margin-top:4px">
              <span class="tag plain">${fmtDate(a.date).slice(5)}</span>
              <span class="tag ${a.repeat === 'yearly' ? 'rose' : 'plain'}">${a.repeat === 'yearly' ? '每年' : '一次'}</span>
              ${a.scope === 'shared' ? (a.mine ? `<span class="tag">两个人的</span>` : `<span class="tag rose">两个人的 · ${esc(a.ownerName || '对方')} 记的</span>`) : ''}
              <span class="tag plain">${a.reminderDays === 0 ? '当天提醒' : `提前${a.reminderDays}天`}</span>
            </div>
            ${a.note ? `<p class="muted tiny" style="margin-top:6px">${esc(a.note)}</p>` : ''}
          </div>
          <div style="text-align:center;min-width:64px">
            ${a.isToday
              ? `<div class="serif" style="color:var(--rose);font-size:15px">就是今天</div>`
              : a.passed
              ? `<div class="muted tiny">已过去</div>`
              : `<div class="serif" style="font-size:20px">${a.daysLeft}<div class="tiny muted" style="font-family:var(--sans)">天后</div></div>`}
          </div>
        </div>
        <div class="btn-row" style="margin-top:10px">
          <a class="btn gold sm" href="#/works">制作一份纪念</a>
          ${a.mine ? `<button class="btn ghost sm" data-edit="${a.id}">编辑</button>
          <button class="btn ghost sm" data-del="${a.id}">删除</button>` : ''}
        </div>
      </div>`
            )
            .join('')
    }
    <p class="muted tiny">年度的 2 月 29 日纪念日在平年按 2 月 28 日提醒。提醒目前是站内的，还没有接系统推送。</p>
  </div>
  ${tabbar('memorial')}`;

  // 快捷创建入口带 ?new=1 时自动打开表单
  if (location.hash.includes('new=1')) {
    history.replaceState(null, '', '#/anniversaries');
    openAnnForm(null);
  }
  document.getElementById('btn-new-ann').onclick = () => openAnnForm(null);
  $app.querySelectorAll('[data-edit]').forEach((b) => {
    b.onclick = () => openAnnForm(items.find((x) => x.id === b.dataset.edit));
  });
  $app.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('删除这个纪念日？已排的提醒会取消。')) return;
      try {
        await api('DELETE', `/api/anniversaries/${b.dataset.del}`);
        route();
      } catch (e) {
        toast(e.message);
      }
    };
  });

  // U02：共同家里停在纪念日页时探测另一半的动态（含对方新共享的纪念日）
  if (state.me?.home?.isShared) {
    watchListFreshness('纪念日', items.map((a) => `${a.id}@${a.revision}`).join(','), async () => {
      const { items: fresh } = await api('GET', '/api/anniversaries');
      return fresh.map((a) => `${a.id}@${a.revision}`).join(',');
    });
  }
}

function openAnnForm(a) {
  const modal = openModal(`<h3>${a ? '编辑纪念日' : '添加纪念日'}</h3>
    <div id="a-error"></div>
    <div class="field"><label for="a-title">名字</label>
      <input class="input" id="a-title" maxlength="24" value="${esc(a?.title || '')}" placeholder="第一次见面"></div>
    <div class="field"><label for="a-date">日期（可以是未来）</label>
      <input class="input" id="a-date" type="date" value="${a?.date || todayStr()}"></div>
    <div class="field"><label for="a-repeat">重复</label>
      <select class="select" id="a-repeat">
        <option value="once" ${a?.repeat === 'once' ? 'selected' : ''}>只提醒一次</option>
        <option value="yearly" ${a?.repeat === 'yearly' ? 'selected' : ''}>每年</option>
      </select></div>
    <div class="field"><label for="a-remind">提醒</label>
      <select class="select" id="a-remind">
        <option value="0" ${!a || a.reminderDays === 0 ? 'selected' : ''}>当天</option>
        <option value="1" ${a?.reminderDays === 1 ? 'selected' : ''}>提前 1 天</option>
        <option value="3" ${a?.reminderDays === 3 ? 'selected' : ''}>提前 3 天</option>
        <option value="7" ${a?.reminderDays === 7 ? 'selected' : ''}>提前 7 天</option>
      </select></div>
    ${!a && state.me.home.isShared ? `<div class="field"><label>范围</label>
      <div class="radio-cards" id="a-scope">
        <div class="radio-card on" data-s="personal"><div class="t">只提醒我</div></div>
        <div class="radio-card" data-s="shared"><div class="t">两个人都看到</div></div>
      </div></div>` : ''}
    <button class="btn primary block" id="a-save">保存</button>`);
  let scope = 'personal';
  bindRadioCards(modal, '#a-scope .radio-card', (c) => {
    scope = c.dataset.s;
  });
  document.getElementById('a-save').onclick = async () => {
    const body = {
      title: document.getElementById('a-title').value.trim(),
      date: document.getElementById('a-date').value,
      repeat: document.getElementById('a-repeat').value,
      reminderDays: Number(document.getElementById('a-remind').value),
    };
    if (!body.title) return toast('起个名字');
    try {
      if (a) await api('PATCH', `/api/anniversaries/${a.id}`, { ...body, expectedRevision: a.revision });
      else await api('POST', '/api/anniversaries', { ...body, scope });
      closeModal();
      route();
    } catch (e) {
      document.getElementById('a-error').innerHTML = `<div class="form-error">${esc(e.message)}</div>`;
    }
  };
}

// ================= S08 · 纪念作品与礼物 =================
const WORK_TPL = {
  polaroid: { name: '拍立得', desc: '一张大照片 + 一句话' },
  stamp: { name: '邮票信笺', desc: '信纸风格，适合一句长一点的话' },
  gallery: { name: '小画廊', desc: '多张照片拼成一页' },
};

async function viewWorks() {
  const [{ items: works, subsidyAvailable }] = await Promise.all([api('GET', '/api/works')]);
  const appears = await api('GET', '/api/me/appearances');
  const consents = await api('GET', '/api/consents');
  const pendingForMe = consents.items.filter((c) => c.iAmApprover && c.status === 'pending');

  const statusTag = (w) => {
    const map = {
      queued: ['排队中', 'plain'],
      running: ['生成中…', ''],
      ready: ['已完成', 'ok'],
      failed: ['失败了', 'plain'],
      cancelled: ['已取消', 'plain'],
    };
    const [label, cls] = map[w.status] || [w.status, 'plain'];
    return `<span class="tag ${cls}">${label}</span>`;
  };

  $app.innerHTML = `
  ${topbar({ title: '纪念', en: 'KEEPING & GIFTING' })}
  <div class="page fade-up">
    ${
      pendingForMe.length > 0
        ? `<div class="card" style="border-color:#E8CFC9">
            <h3>等待你的授权</h3>
            ${pendingForMe
              .map(
                (c) => `<div style="padding:8px 0;border-bottom:1px solid var(--line)">
              <p style="font-size:14px">${esc(c.requesterName)} 想在${c.purpose === 'work' ? '一份电子作品' : '一次打包导出'}里使用你选定的 ${c.resourceVersions.length} 个内容版本。</p>
              <p class="muted tiny">授权只覆盖这些版本和这次用途；之后你改了内容或撤回共享，授权自动失效。</p>
              <div class="btn-row" style="margin-top:8px">
                <button class="btn soft sm" data-preview="${c.id}">先看看具体内容</button>
                <button class="btn rose sm" data-approve="${c.id}" data-rev="${c.revision}">同意</button>
                <button class="btn ghost sm" data-reject="${c.id}" data-rev="${c.revision}">先不同意</button>
              </div></div>`
              )
              .join('')}
          </div>`
        : ''
    }

    <div class="card">
      <h3>电子纪念作品</h3>
      <p class="muted" style="font-size:14px">免费的单页电子明信片：选你自己的内容就能做；要包含对方的内容，需要对方对具体版本点头。</p>
      <button class="btn primary block" id="btn-new-work" style="margin-top:8px">＋ 做一份纪念</button>
      <div style="margin-top:14px" id="work-list">
        ${
          works.length === 0
            ? `<div class="empty"><div class="big">还没有作品</div><p class="tiny">做好的明信片会出现在这里，可以随时下载</p></div>`
            : works
                .map(
                  (w) => `<div class="card soft" style="margin-bottom:10px">
            <div style="display:flex;align-items:center;gap:10px">
              <div>${objectIcon('camera', 38)}</div>
              <div style="flex:1">
                <div class="serif">${WORK_TPL[w.templateKey]?.name || w.templateKey}明信片${w.caption ? ` · ${esc(w.caption)}` : ''}</div>
                <div class="mem-meta">${statusTag(w)}${w.includesPartner ? `<span class="tag rose">含对方内容</span>` : ''}</div>
                ${w.failReason ? `<p class="muted tiny">${esc(w.failReason)}</p>` : ''}
              </div>
            </div>
            <div class="btn-row" style="margin-top:10px">
              ${w.status === 'ready' ? `<button class="btn primary sm" data-download="${w.id}">下载 PNG</button>` : ''}
              ${(w.status === 'queued' || w.status === 'failed') && w.status !== 'ready' ? `<span class="tiny muted">在"做一份纪念"里重试</span>` : ''}
              ${w.status === 'ready' ? `<button class="btn ghost sm" data-cancel="${w.id}">删除这份作品</button>` : ''}
            </div>
          </div>`
                )
                .join('')
        }
      </div>
    </div>

    <div class="card">
      <h3>礼物与外观</h3>
      ${
        appears.items.length > 0
          ? appears.items
              .map(
                (a) => `<div class="row"><div><div class="label">✦ 小狗名字牌 · 暖霞色</div>
        <div class="desc">${esc(a.reason)} · ${fmtDate(a.createdAt.slice(0, 10))} 获得，不会因为撤回共享或解除关联被收走</div></div></div>`
              )
              .join('')
          : `<p class="muted" style="font-size:14px">当同一段回忆里两个人各自分享过一份内容，会自动得到一次性的小狗名字牌外观。不需要公开、不需要等量记录。</p>`
      }
      <div class="row">
        <div>
          <div class="label">实体制作补贴</div>
          <div class="desc">印制成实物的补贴活动还没开放</div>
        </div>
        <span class="tag plain">活动开放后查看</span>
      </div>
    </div>
    <p class="muted tiny">已经下载到设备的文件或截图，系统无法收回；对外发布需要双方对具体内容和用途另行确认。</p>
  </div>
  ${tabbar('memorial')}`;

  document.getElementById('btn-new-work').onclick = () => openWorkWizard();
  // 批准前逐项核对申请时锁定的具体内容版本（B10，计划书 5.2）
  $app.querySelectorAll('[data-preview]').forEach((b) => {
    b.onclick = async () => {
      try {
        const pv = await api('GET', `/api/consents/${b.dataset.preview}/preview`);
        const anyStale = pv.items.some((it) => !it.isCurrent);
        openModal(`<h3>将使用的内容</h3>
          <p class="muted tiny" style="margin-bottom:10px">${esc(pv.requesterName)} 申请的 ${pv.purpose === 'work' ? '电子作品' : '打包导出'}只会使用下面这些版本：</p>
          ${pv.items
            .map(
              (it) => `<div class="persp" style="margin-bottom:10px">
                <div class="head">
                  <span class="tag plain tiny">版本 ${it.version}</span>
                  ${it.unavailable ? '<span class="tag plain tiny">已不可用</span>' : it.isCurrent ? '<span class="tag ok tiny">仍是当前版本</span>' : '<span class="tag rose tiny">内容已变化</span>'}
                  ${it.eventDate ? `<span class="muted tiny">${fmtDate(it.eventDate)}</span>` : ''}
                </div>
                <div class="text">${esc(it.text ? it.text.slice(0, 200) + (it.text.length > 200 ? '…' : '') : '（只有照片）')}</div>
                ${
                  it.photoIds.length > 0
                    ? `<div class="photo-grid" style="grid-template-columns:repeat(4,1fr)">${it.photoIds
                        .map((id) => `<img src="/api/media/${id}?variant=thumb" alt="授权范围内的照片" loading="lazy">`)
                        .join('')}</div>`
                    : ''
                }
              </div>`
            )
            .join('')}
          ${anyStale ? `<div class="form-error">有内容在申请后发生了变化，这份授权不能再直接批准；对方需要重新申请。</div>` : ''}
          <div class="btn-row">
            <button class="btn ghost" onclick="closeModal()">再想想</button>
            ${anyStale ? '' : `<button class="btn rose" data-approve="${pv.id}" data-rev="">同意这份授权</button>`}
          </div>`);
        const quick = document.querySelector('#modal [data-approve]');
        if (quick) {
          quick.onclick = async () => {
            const consents2 = await api('GET', '/api/consents');
            const cur = consents2.items.find((x) => x.id === pv.id);
            if (!cur) return;
            try {
              await api('POST', `/api/consents/${pv.id}/respond`, { decision: 'approve', expectedRevision: cur.revision });
              closeModal();
              toast('已同意这份授权（只覆盖选定版本和用途）');
              route();
            } catch (e) {
              toast(e.message);
            }
          };
        }
      } catch (e) {
        toast(e.message);
      }
    };
  });
  $app.querySelectorAll('[data-approve]').forEach((b) => {
    b.onclick = async () => {
      try {
        await api('POST', `/api/consents/${b.dataset.approve}/respond`, { decision: 'approve', expectedRevision: Number(b.dataset.rev) });
        toast('已同意这份授权（只覆盖选定版本和用途）');
        route();
      } catch (e) {
        toast(e.message);
      }
    };
  });
  $app.querySelectorAll('[data-reject]').forEach((b) => {
    b.onclick = async () => {
      try {
        await api('POST', `/api/consents/${b.dataset.reject}/respond`, { decision: 'reject', expectedRevision: Number(b.dataset.rev) });
        toast('已拒绝。对方仍可以只用本人内容制作');
        route();
      } catch (e) {
        toast(e.message);
      }
    };
  });
  $app.querySelectorAll('[data-download]').forEach((b) => {
    b.onclick = async () => {
      try {
        const blob = await apiBlob(`/api/works/${b.dataset.download}/download`);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `慢记-明信片-${b.dataset.download.slice(-6)}.png`;
        a.click();
        URL.revokeObjectURL(url);
      } catch (e) {
        openModal(`<h3>下载不了</h3><p class="muted">${esc(e.message)}</p><button class="btn ghost block" onclick="closeModal()">知道了</button>`);
      }
    };
  });
  $app.querySelectorAll('[data-cancel]').forEach((b) => {
    b.onclick = async () => {
      await api('POST', `/api/works/${b.dataset.cancel}/cancel`, {});
      route();
    };
  });
}

// 作品向导：选回忆 → 选内容 → 选模板 → （含对方内容时）授权 → 生成
async function openWorkWizard() {
  const { items: mems } = await api('GET', '/api/memories');
  const candidates = mems.filter((m) => m.access === 'full' && m.perspectives.length > 0);
  if (candidates.length === 0) {
    return openModal(`<h3>还没有可用的内容</h3><p class="muted">先去留下一小段回忆，再来做纪念。</p>
      <a class="btn primary block" href="#/new" onclick="closeModal()">留下一小段</a>`);
  }
  openModal(`<h3>做一份纪念</h3>
    <div class="field"><label for="w-mem">选一段回忆</label>
      <select class="select" id="w-mem">
        ${candidates.map((m) => `<option value="${m.id}">${esc(m.title)}（${fmtDate(m.eventDate)}）</option>`).join('')}
      </select></div>
    <div id="w-items"></div>
    <div class="field"><label for="w-tpl">模板</label>
      <select class="select" id="w-tpl">
        ${Object.entries(WORK_TPL).map(([k, v]) => `<option value="${k}">${v.name} · ${v.desc}</option>`).join('')}
      </select>
      <p class="muted tiny" style="margin:6px 2px 0">成品会分别排出每位所选作者的文字（各段署名、超长节选），并使用所选内容里最近的最多 3 张照片。</p></div>
    <div class="field"><label for="w-cap">写一句话（可不填）</label>
      <input class="input" id="w-cap" maxlength="60" placeholder="那天风很大，但是很好"></div>
    <div id="w-consent-area"></div>
    <div id="w-error"></div>
    <button class="btn primary block" id="w-go">生成明信片</button>`);

  let selected = new Set();
  const renderItems = async () => {
    const memId = document.getElementById('w-mem').value;
    const d = await api('GET', `/api/memories/${memId}`);
    selected = new Set(d.contributions.map((c) => c.id));
    document.getElementById('w-items').innerHTML = `<div class="field"><label>选哪些内容（勾选本人或已共享的部分）</div>
      ${d.contributions
        .map(
          (c) => `<label style="display:flex;gap:10px;align-items:center;padding:10px 0;border-bottom:1px solid var(--line);cursor:pointer">
        <input type="checkbox" data-c="${c.id}" ${c.mine || c.visibility === 'home' ? 'checked' : 'disabled'}
          style="width:20px;height:20px" ${!c.mine && c.visibility !== 'home' ? 'disabled title="对方没有共享这一份"' : ''}>
        <span style="flex:1"><b>${esc(c.authorName)}${c.mine ? '（我）' : ''}</b><br><span class="muted tiny">${esc((c.text || '（只有照片）').slice(0, 40))}</span></span>
      </label>`
        )
        .join('')}</div>`;
    document.getElementById('w-items').querySelectorAll('input[data-c]').forEach((cb) => {
      cb.onchange = () => {
        if (cb.checked) selected.add(cb.dataset.c);
        else selected.delete(cb.dataset.c);
      };
    });
  };
  await renderItems();
  document.getElementById('w-mem').onchange = renderItems;

  document.getElementById('w-go').onclick = async () => {
    const errBox = document.getElementById('w-error');
    errBox.innerHTML = '';
    const btn = document.getElementById('w-go');
    btn.disabled = true;
    btn.textContent = '准备中…';
    try {
      const memId = document.getElementById('w-mem').value;
      const d = await api('GET', `/api/memories/${memId}`);
      const chosen = d.contributions.filter((c) => selected.has(c.id));
      if (chosen.length === 0) throw new Error('至少选择一份内容');
      const includesPartner = chosen.some((c) => !c.mine);
      let grantId = null;

      if (includesPartner) {
        // 含对方内容：需要已同意的版本授权（M32）
        const consents = await api('GET', '/api/consents');
        const partnerIds = chosen.filter((c) => !c.mine).map((c) => c.id);
        const ok = consents.items.find(
          (g) =>
            g.iAmRequester &&
            g.status === 'approved' &&
            g.purpose === 'work' &&
            g.resourceVersions.length === partnerIds.length &&
            g.resourceVersions.every((rv) => partnerIds.includes(rv.contributionId))
        );
        if (!ok) {
          const created = await api('POST', '/api/consents', {
            purpose: 'work',
            resourceVersions: chosen.filter((c) => !c.mine).map((c) => ({ contributionId: c.id, version: c.version })),
          });
          btn.disabled = false;
          btn.textContent = '生成明信片';
          errBox.innerHTML = `<div class="form-hint">已经向对方发出授权请求（只覆盖这些版本和这次用途）。对方同意后，回到这里继续生成；你也可以<span id="w-self-only" style="color:var(--rose);cursor:pointer">只用自己的内容</span>先做一张。</div>`;
          document.getElementById('w-self-only').onclick = () => {
            selected = new Set(chosen.filter((c) => c.mine).map((c) => c.id));
            if (selected.size === 0) {
              errBox.innerHTML = `<div class="form-error">这段回忆里没有你自己的内容，需要等对方同意。</div>`;
              return;
            }
            document.getElementById('w-go').click();
          };
          return;
        }
        grantId = ok.id;
      }

      const work = await api('POST', '/api/works', {
        templateKey: document.getElementById('w-tpl').value,
        caption: document.getElementById('w-cap').value.trim() || null,
        items: chosen.map((c) => ({ contributionId: c.id, version: c.version })),
        grantId,
      });
      await api('POST', `/api/works/${work.workId}/start`, {});
      btn.textContent = '正在排版…';

      const pngBlob = await composePostcard(
        document.getElementById('w-tpl').value,
        chosen,
        document.getElementById('w-cap').value.trim(),
        d
      );
      btn.textContent = '上传中…';
      const stage = await api('POST', '/api/media/uploads', { purpose: 'work-artifact' });
      await api('PUT', `/api/media/uploads/${stage.uploadId}/blob`, await pngBlob.arrayBuffer(), {
        uploadToken: stage.uploadId,
      });
      await api('POST', `/api/media/uploads/${stage.uploadId}/complete`, {});
      await api('POST', `/api/works/${work.workId}/complete`, { artifactUploadId: stage.uploadId });
      closeModal();
      toast('明信片做好了，可以下载');
      route();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = '再试一次';
      errBox.innerHTML = `<div class="form-error">${esc(e.message)}</div>`;
    }
  };
}

// 明信片渲染（客户端 Canvas 真实排版 → PNG）
async function composePostcard(templateKey, chosen, caption, memoryDetail) {
  const W = 1080;
  const H = 1620;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d');

  const loadPhoto = async (mediaId) => {
    try {
      const blob = await apiBlob(`/api/media/${mediaId}`);
      const bmp = await createImageBitmap(blob);
      return bmp;
    } catch {
      return null;
    }
  };
  const photos = [];
  for (const c of chosen) {
    for (const p of c.photos.slice(0, 3)) {
      const bmp = await loadPhoto(p.id);
      if (bmp) photos.push({ bmp, author: c.authorName });
      if (photos.length >= 3) break;
    }
    if (photos.length >= 3) break;
  }

  // 底色与边框（Consensus Bell 配色）
  g.fillStyle = '#F5EEE6';
  g.fillRect(0, 0, W, H);
  g.strokeStyle = '#B08A5A';
  g.lineWidth = 6;
  g.strokeRect(40, 40, W - 80, H - 80);
  g.strokeStyle = 'rgba(176, 96, 74, 0.35)';
  g.lineWidth = 2;
  g.strokeRect(58, 58, W - 116, H - 116);

  const serif = (size) => `${size}px "Noto Serif SC","Songti SC",SimSun,serif`;
  const sans = (size) => `${size}px "PingFang SC","Microsoft YaHei",sans-serif`;

  // B07（v3.5）：署了两个人的名，就要排进两个人的话——每位所选作者各一段、段前署名，不再只取一人正文
  const paragraphs = chosen
    .filter((c) => c.text && c.text.trim())
    .map((c) => ({ author: c.authorName, mine: !!c.mine, text: c.text.trim() }));
  const authors = [...new Set(chosen.map((c) => c.authorName))].join(' & ');
  const dateStr = fmtDate(memoryDetail.eventDate);
  const title = caption || memoryDetail.title;

  const drawPhotoCard = (x, y, w, h, bmp) => {
    g.save();
    g.fillStyle = '#fff';
    g.shadowColor = 'rgba(140,75,84,0.18)';
    g.shadowBlur = 18;
    g.fillRect(x, y, w, h);
    g.restore();
    const pad = 14;
    const iw = w - pad * 2;
    const ih = h - pad * 2;
    const scale = Math.max(iw / bmp.width, ih / bmp.height);
    const dw = bmp.width * scale;
    const dh = bmp.height * scale;
    g.save();
    g.beginPath();
    g.rect(x + pad, y + pad, iw, ih); // 照片裁剪在白卡相框内，不越过边框（B15）
    g.clip();
    g.drawImage(bmp, x + pad + (iw - dw) / 2, y + pad + (ih - dh) / 2, dw, dh);
    g.restore();
  };
  const wrapText = (text, x, y, maxW, lineH, font, color, maxY = H - 140) => {
    g.font = font;
    g.fillStyle = color;
    let line = '';
    let yy = y;
    for (const ch of text) {
      if (ch === '\n' || g.measureText(line + ch).width > maxW) {
        g.fillText(line, x, yy);
        yy += lineH;
        line = ch === '\n' ? '' : ch;
        if (yy > maxY) break;
      } else {
        line += ch;
      }
    }
    if (line && yy <= maxY) g.fillText(line, x, yy);
    return yy;
  };
  /** 逐段排入每位作者的文字：段前小字署名，段间留白；版面放不下时到此为止，但两段都会从第一段起公平截取 */
  const drawParagraphs = (x, startY, maxW, { font, lineH, labelFont, budget, color = '#252323', labelColor = '#8C4B54', maxY = H - 140 }) => {
    let y = startY;
    for (const para of paragraphs) {
      if (y > maxY - lineH) break;
      g.textAlign = 'left';
      g.font = labelFont;
      g.fillStyle = labelColor;
      g.fillText(`${para.author} 写下`, x, y);
      y += Math.round(lineH * 0.72);
      y = wrapText(para.text.slice(0, budget), x, y, maxW, lineH, font, color, maxY);
      y += Math.round(lineH * 0.5);
    }
    return y;
  };
  // 单作者放宽节选长度，双作者每人收敛一点，保证两段都能出现
  const perBudget = (one, two) => (paragraphs.length > 1 ? two : one);

  if (templateKey === 'polaroid') {
    g.textAlign = 'center';
    g.fillStyle = '#252323';
    g.font = serif(64);
    g.fillText(title.slice(0, 14), W / 2, 170);
    g.font = sans(30);
    g.fillStyle = '#8A7B76';
    g.fillText(`${dateStr} · ${authors}`, W / 2, 226);
    if (photos[0]) {
      drawPhotoCard(W / 2 - 380, 280, 760, 900, photos[0].bmp);
    } else {
      g.strokeStyle = '#E0CDC5';
      g.setLineDash([14, 12]);
      g.strokeRect(W / 2 - 360, 300, 720, 860);
      g.setLineDash([]);
      g.fillStyle = '#C98877';
      g.font = sans(34);
      g.fillText('文字的回忆', W / 2, 740);
    }
    g.textAlign = 'left';
    drawParagraphs(140, 1240, W - 280, {
      font: serif(32), lineH: 44, labelFont: sans(22), budget: perBudget(110, 44), maxY: H - 150,
    });
    g.textAlign = 'center';
    g.fillStyle = '#C98877';
    g.font = sans(26);
    g.fillText('慢记 · MANJI', W / 2, H - 96);
  } else if (templateKey === 'stamp') {
    // 邮票框照片
    if (photos[0]) {
      g.save();
      g.strokeStyle = '#C98877';
      g.lineWidth = 8;
      g.setLineDash([2, 16]);
      g.strokeRect(120, 120, 420, 420);
      g.setLineDash([]);
      g.restore();
      const scale = Math.max(380 / photos[0].bmp.width, 380 / photos[0].bmp.height);
      g.save();
      g.beginPath();
      g.rect(132, 132, 396, 396);
      g.clip();
      g.drawImage(photos[0].bmp, 132 + (396 - photos[0].bmp.width * scale) / 2, 132 + (396 - photos[0].bmp.height * scale) / 2, photos[0].bmp.width * scale, photos[0].bmp.height * scale);
      g.restore();
    }
    g.textAlign = 'right';
    g.fillStyle = '#8C4B54';
    g.font = serif(52);
    g.fillText(title.slice(0, 12), W - 140, 200);
    g.font = sans(28);
    g.fillStyle = '#8A7B76';
    g.fillText(`${dateStr}`, W - 140, 248);
    g.strokeStyle = '#E0CDC5';
    g.beginPath();
    g.moveTo(140, 620);
    g.lineTo(W - 140, 620);
    g.stroke();
    g.textAlign = 'left';
    const endY = drawParagraphs(140, 700, W - 280, {
      font: serif(38), lineH: 54, labelFont: sans(24), budget: perBudget(160, 70), maxY: H - 330,
    });
    g.font = serif(36);
    g.fillStyle = '#8C4B54';
    g.fillText(`—— ${authors}`, 140, Math.min(endY + 70, H - 250));
    g.textAlign = 'center';
    g.fillStyle = '#C98877';
    g.font = sans(26);
    g.fillText('慢记 · MANJI', W / 2, H - 96);
  } else {
    // gallery
    g.textAlign = 'center';
    g.fillStyle = '#252323';
    g.font = serif(56);
    g.fillText(title.slice(0, 16), W / 2, 160);
    g.font = sans(28);
    g.fillStyle = '#8A7B76';
    g.fillText(`${dateStr} · ${authors}`, W / 2, 210);
    const slots = photos.length > 0 ? photos : [null, null, null];
    const cell = (i) => ({ x: 120 + (i % 2) * 440, y: 280 + Math.floor(i / 2) * 440 });
    slots.slice(0, 3).forEach((ph, i) => {
      const { x, y } = cell(i);
      if (ph) drawPhotoCard(x, y, 400, 400, ph.bmp);
      else {
        g.strokeStyle = '#E0CDC5';
        g.setLineDash([12, 10]);
        g.strokeRect(x + 10, y + 10, 380, 380);
        g.setLineDash([]);
      }
    });
    g.textAlign = 'left';
    drawParagraphs(140, 1200, W - 280, {
      font: serif(30), lineH: 40, labelFont: sans(20), budget: perBudget(90, 36), maxY: H - 150,
    });
    g.textAlign = 'center';
    g.fillStyle = '#C98877';
    g.font = sans(26);
    g.fillText('慢记 · MANJI', W / 2, H - 96);
  }

  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  if (!blob) throw new Error('生成图片失败，请重试');
  return blob;
}

// ================= S10 · 我的与隐私 =================
async function viewMe() {
  const me = state.me;
  const spaces = await api('GET', '/api/me/spaces');
  const exports_ = await api('GET', '/api/exports');

  $app.innerHTML = `
  ${topbar({ title: '我的', en: 'ME & PRIVACY' })}
  <div class="page fade-up">
    <div class="card" style="display:flex;gap:14px;align-items:center">
      <span class="avatar" style="width:52px;height:52px;font-size:22px">${esc(me.displayName.slice(0, 1))}</span>
      <div style="flex:1">
        <div class="serif" style="font-size:18px">${esc(me.displayName)}</div>
        <div class="muted tiny">${me.home.isShared ? '和另一个人共用一间小家' : '一个人住，也很好'}${me.home.name ? ` · 「${esc(me.home.name)}」` : ''}</div>
      </div>
      <button class="btn ghost sm" id="btn-rename">改昵称</button>
    </div>

    ${me.home.status !== 'frozen' ? `<div class="card">
      <h3>小屋名字</h3>
      <div style="display:flex;gap:10px;align-items:center">
        <input class="input" id="home-name-input" maxlength="16" value="${esc(getHomeName())}" placeholder="比如：我们的树洞" style="flex:1">
        <button class="btn ghost sm" id="btn-home-name">保存</button>
      </div>
      <p class="muted tiny" style="margin:8px 0 0">家名保存在服务端，两个人看到的是同一个名字；任一方修改都会通知对方。</p>
    </div>` : ''}

    <div class="card">
      <h3>小狗</h3>
      <div style="display:flex;gap:12px;align-items:center">
        ${dogSVG(me.pet?.appearanceKey || 'cream', 72)}
        <div><div class="serif" style="font-size:16px">${esc(me.pet?.name || '未命名')}</div>
        <div class="muted tiny">没有饥饿值、没有签到惩罚</div></div>
        <span style="flex:1"></span>
        <button class="btn ghost sm" id="btn-pet">设置</button>
      </div>
    </div>

    <div class="card">
      <h3>偏好</h3>
      ${[
        ['pauseNotifications', '通知静一静', '纪念日提醒和承诺确认暂时不打扰你'],
        ['recallEnabled', '旧物回顾', '进入小家时可以翻一张旧物卡'],
        ['pauseRecall', '回顾也先停停', '和上一条一起决定要不要回顾'],
        ['reduceMotion', '减少动画', '小狗和环境动画会安静下来'],
      ]
        .map(
          ([k, label, desc]) => `<div class="row"><div><div class="label">${label}</div><div class="desc">${desc}</div></div>
        <label class="switch"><input type="checkbox" data-pref="${k}" ${me.preferences[k] ? 'checked' : ''}><span class="track"></span><span class="thumb"></span></label></div>`
        )
        .join('')}
    </div>

    <div class="card">
      <h3>我的数据</h3>
      <p class="muted" style="font-size:14px">免费导出你自己的全部文字与照片（JSON/Markdown + 原文件打包）。不包含另一人的任何内容，也不需要对方同意。</p>
      <button class="btn primary block" id="btn-export-self" style="margin-top:10px">导出我的内容（ZIP）</button>
      ${exports_.items.length > 0 ? `<div style="margin-top:10px">${exports_.items
        .map(
          (x) => `<div class="row"><div><div class="label">${x.scope === 'self' ? '本人导出' : '授权导出'} · ${fmtDate(x.createdAt.slice(0, 10))}</div>
        <div class="desc">${x.status === 'ready' ? `${Math.round((x.size || 0) / 1024)} KB` : esc(x.failReason || x.status)}</div></div>
        ${x.status === 'ready' ? `<button class="btn ghost sm" data-dl-export="${x.id}">下载</button>` : ''}</div>`
        )
        .join('')}</div>` : ''}
      <p class="muted tiny" style="margin-top:8px">要打包包含对方内容的导出，需要先在"纪念"里获得对方的版本授权。</p>
    </div>

    <div class="card">
      <h3>我的空间</h3>
      ${spaces
        .map(
          (s) => `<div class="row"><div><div class="label">${s.isCurrent ? '当前小家' : s.status === 'frozen' ? '已解除的共同家' : '我的小家'}
        ${s.members.length === 2 ? ` · ${esc(s.members.map((m) => m.display_name).join(' & '))}` : ''}</div>
        <div class="desc">${s.pet ? `小狗：${esc(s.pet)}` : ''}${s.status === 'frozen' ? ' · 旧链上的指纹仍可查看（只读）' : ''}</div></div>
        ${
          s.status === 'frozen'
            ? `<a class="btn ghost sm" href="#/chain?home=${encodeURIComponent(s.id)}">⛓ 查看那条链</a>`
            : s.isCurrent
            ? '<span class="tag rose">在这里</span>'
            : ''
        }</div>`
        )
        .join('')}
    </div>

    <a class="card" href="#/me/privacy" style="display:block;color:inherit">
      <h3 style="margin-bottom:4px">暂停与解除关联</h3>
      <p class="muted" style="font-size:14px;margin:0">分开解释两件事：安静一会儿，或者结束这段共同空间。</p>
    </a>

    ${
      me.isAdmin
        ? `<a class="card soft" href="#/admin" style="display:block;color:inherit">
            <h3 style="margin-bottom:4px">运营后台（管理员）</h3>
            <p class="muted" style="font-size:14px;margin:0">查看使用统计与用户列表。管理员无法查看任何人的私密内容。</p>
          </a>`
        : ''
    }

    <button class="btn ghost block" id="btn-logout" style="margin-top:6px">退出登录</button>
    <p class="muted tiny" style="text-align:center;margin:14px 0 0">慢记 Manji v${APP_VERSION}</p>
  </div>
  ${tabbar('me')}`;

  document.getElementById('btn-rename').onclick = () => {
    openModal(`<h3>改昵称</h3><input class="input" id="rn-name" maxlength="24" value="${esc(me.displayName)}">
      <button class="btn primary block" id="rn-save" style="margin-top:12px">保存</button>`);
    document.getElementById('rn-save').onclick = async () => {
      try {
        await api('PATCH', '/api/me', { displayName: document.getElementById('rn-name').value.trim() });
        state.me = await loadMe();
        closeModal();
        route();
      } catch (e) {
        toast(e.message);
      }
    };
  };
  document.getElementById('btn-pet').onclick = () => openPetModal();
  const homeNameBtn = document.getElementById('btn-home-name');
  if (homeNameBtn) {
    homeNameBtn.onclick = async () => {
      const input = document.getElementById('home-name-input');
      await saveHomeName(input.value.trim());
      route();
    };
  }
  $app.querySelectorAll('[data-pref]').forEach((cb) => {
    cb.onchange = async () => {
      try {
        await api('PUT', '/api/me/preferences', { [cb.dataset.pref]: cb.checked });
        state.me = await loadMe();
        applyMotionPreference(); // 站内偏好立即落到根节点（B12）
        toast('已保存');
      } catch (e) {
        toast(e.message);
        cb.checked = !cb.checked;
      }
    };
  });
  document.getElementById('btn-export-self').onclick = exportSelf;
  $app.querySelectorAll('[data-dl-export]').forEach((b) => {
    b.onclick = async () => {
      try {
        const blob = await apiBlob(`/api/exports/${b.dataset.dlExport}/download`);
        downloadBlob(blob, `慢记-导出.zip`);
      } catch (e) {
        toast(e.message);
      }
    };
  });
  document.getElementById('btn-logout').onclick = async () => {
    await api('POST', '/api/auth/logout', {});
    state.me = null;
    location.hash = '#/welcome';
    route();
  };
}

async function exportSelf() {
  try {
    const res = await api('POST', '/api/exports', { scope: 'self' });
    const blob = await apiBlob(`/api/exports/${res.exportId}/download`);
    downloadBlob(blob, '慢记-我的内容.zip');
    toast('导出完成（只包含你自己的内容）');
  } catch (e) {
    toast(e.message);
  }
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// ================= 运营后台（管理员，只读统计） =================
async function viewAdmin() {
  if (!state.me?.isAdmin) {
    $app.innerHTML = `${topbar({ title: '运营后台', en: 'ADMIN' })}<div class="page">
      <div class="empty"><div class="big">只有管理员可以查看</div>
      <a class="btn ghost" href="#/me">返回</a></div></div>${tabbar('me')}`;
    return;
  }
  const [ov, users] = await Promise.all([api('GET', '/api/admin/overview'), api('GET', '/api/admin/users')]);
  const stat = (label, value) => `
    <div style="background:var(--card);border:1px solid var(--line);border-radius:var(--radius-md);padding:12px 8px;text-align:center">
      <div class="serif" style="font-size:22px">${value}</div>
      <div class="muted tiny">${label}</div>
    </div>`;
  $app.innerHTML = `
  ${topbar({ title: '运营后台', en: 'ADMIN CONSOLE' })}
  <div class="page fade-up">
    <div class="form-hint">管理员视角只包含运营统计与账户列表，<b>不能</b>查看任何用户的回忆正文、照片或私密内容（权限模型对管理员同样生效）。</div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:14px">
      ${stat('用户', ov.users)}
      ${stat('共同小家', ov.homesShared)}
      ${stat('单人小家', ov.homesSolo)}
      ${stat('回忆', ov.memories)}
      ${stat('视角', ov.contributions)}
      ${stat('照片', ov.photos)}
      ${stat('已完成作品', ov.works)}
      ${stat('导出', ov.exports)}
      ${stat('待授权', ov.pendingConsents)}
    </div>
    <div class="card">
      <h3>用户</h3>
      ${users
        .map(
          (u) => `<div class="row"><div><div class="label">${esc(u.displayName)}${u.isAdmin ? ' <span class="tag rose tiny">管理员</span>' : ''}</div>
        <div class="desc">${fmtDate(u.createdAt.slice(0, 10))} 加入 · ${
            { solo: '单人家', shared: '共同家', frozen: '已解除' }[u.homeStatus] || '—'
          } · 记录 ${u.ownContributions} 份</div></div></div>`
        )
        .join('')}
    </div>
    <div class="card">
      <h3>最近操作（最小审计，无正文）</h3>
      ${ov.recentAudit.length === 0 ? '<p class="muted tiny">暂无</p>' : ov.recentAudit
        .map((a) => `<div class="row"><div class="label" style="font-size:14px">${esc(a.actor || '系统')} · ${esc(a.action)}</div>
        <div class="muted tiny">${esc(a.at.slice(5, 16).replace('T', ' '))}</div></div>`)
        .join('')}
    </div>
    <a class="btn ghost block" href="#/me">返回</a>
  </div>
  ${tabbar('me')}`;
}

// ================= S12 · 暂停与解除关联 =================
async function viewPrivacy() {
  const me = state.me;
  const hidden = await api('GET', '/api/me/hidden-memories');

  $app.innerHTML = `
  ${topbar({ title: '关系与空间', en: 'PAUSE & UNLINK' })}
  <div class="page fade-up">
    <div class="card">
      <h3>暂停</h3>
      <p class="muted" style="font-size:14px">暂停是你个人的选择：提醒安静下来、回顾先停一停。不会通知对方"你暂停了"，也不改变对方的任何设置，小狗不会因此难过。</p>
      ${[
        ['pauseNotifications', '通知静一静'],
        ['pauseRecall', '回顾也先停停'],
        ['reduceMotion', '减少动画'],
      ]
        .map(
          ([k, label]) => `<div class="row"><div class="label">${label}</div>
        <label class="switch"><input type="checkbox" data-pref="${k}" ${me.preferences[k] ? 'checked' : ''}><span class="track"></span><span class="thumb"></span></label></div>`
        )
        .join('')}
      <p class="muted tiny">随时可以打开或关闭；恢复时不会自动重新共享你已经撤回的内容。</p>
    </div>

    <div class="card">
      <h3>我隐藏过的回忆</h3>
      ${hidden.items.length === 0
        ? `<p class="muted" style="font-size:14px">没有隐藏的回忆。隐藏只影响你自己的默认列表和回顾，可以随时恢复。</p>`
        : hidden.items.map((m) => `<div class="row"><div><div class="label">${esc(m.title)}</div>
          <div class="desc">${fmtDate(m.eventDate)}${m.hidden ? ' · 已隐藏' : ''}${m.excludeFromRecall ? ' · 不回顾' : ''}</div></div>
          <button class="btn ghost sm" data-unhide="${m.id}">恢复</button></div>`).join('')}
    </div>

    <div class="card" id="unlink-card" style="${me.home.isShared ? '' : 'display:none'}">
      <h3>解除关联</h3>
      <p class="muted" style="font-size:14px">解除后：</p>
      <ul class="muted" style="font-size:14px;padding-left:18px;margin:6px 0 12px">
        <li>共同小家立即冻结，两个人都不再能打开对方的旧内容</li>
        <li>你自己的回忆、照片和小狗陪伴都还在，可以继续使用和免费导出</li>
        <li>待处理的邀请、授权和含对方内容的作品任务都会取消</li>
        <li>已经下载到设备的文件或截图，系统无法收回</li>
      </ul>
      <p class="muted tiny" style="margin-bottom:10px">单方确认即可完成，不需要对方批准，也不需要删除回忆。</p>
      <button class="btn danger block" id="btn-unlink">解除关联</button>
    </div>
    ${!me.home.isShared ? `<div class="card"><h3>解除关联</h3><p class="muted" style="font-size:14px">你现在在一个人的小家里，没有需要解除的共同关联。</p></div>` : ''}

    <a class="btn ghost block" href="#/me">返回</a>
  </div>
  ${tabbar('me')}`;

  $app.querySelectorAll('[data-pref]').forEach((cb) => {
    cb.onchange = async () => {
      try {
        await api('PUT', '/api/me/preferences', { [cb.dataset.pref]: cb.checked });
        state.me = await loadMe();
        applyMotionPreference(); // 站内偏好立即落到根节点（B12）
      } catch (e) {
        toast(e.message);
        cb.checked = !cb.checked;
      }
    };
  });
  $app.querySelectorAll('[data-unhide]').forEach((b) => {
    b.onclick = async () => {
      await api('PUT', `/api/me/memory-preferences/${b.dataset.unhide}`, { hidden: false, excludeFromRecall: false });
      toast('已恢复');
      route();
    };
  });
  const unlinkBtn = document.getElementById('btn-unlink');
  if (unlinkBtn) {
    unlinkBtn.onclick = () => {
      openModal(`<h3>确定解除关联？</h3>
        <p class="muted" style="font-size:14px">共同小家会立即冻结；你自己的内容、小狗和免费导出不受影响。这个操作立即生效，不需要对方批准。</p>
        <div class="btn-row"><button class="btn ghost" onclick="closeModal()">再想想</button>
        <button class="btn primary" id="do-unlink">确认解除</button></div>`);
      document.getElementById('do-unlink').onclick = async () => {
        try {
          await api('POST', `/api/homes/${state.me.home.id}/unlink`, { confirm: true });
          state.me = await loadMe();
          closeModal();
          toast('已解除。你回到了自己的空间，内容都还在');
          location.hash = '#/home';
        } catch (e) {
          toast(e.message);
        }
      };
    };
  }
}

// ================= v3.4 永恒之链（约定与日记上链存证） =================
/** 约定卡片是否显示「镌刻上链」：个人约定由本人上链；共同约定须两人都点过"我也愿意"。 */
function chainEligible(p) {
  if (p.onChain && p.onChain.isCurrentRevision) return false;
  if (p.scope === 'personal') return p.mine;
  return p.status !== 'proposed' && !p.needsReconfirm;
}

/** 镌刻确认弹窗（v3.5 / U03：如实说明这是本地存证——不夸大成公共区块链式的绝对承诺）。 */
function openAnchorModal({ type, id, snippet, shared }) {
  const quote = snippet && snippet.length > 0 ? `「${snippet.slice(0, 36)}${snippet.length > 36 ? '…' : ''}」` : '';
  openModal(`<h3>把这一刻镌刻上链</h3>
    <div class="anchor-quote serif">${esc(quote) || '这一刻'}</div>
    <p class="muted" style="font-size:14px;margin:6px 0 10px">把此刻封存成一条可校验的记录：</p>
    <ul class="anchor-notes">
      <li>链上保存的是这句话的<b>指纹</b>（哈希），<b>不是原文</b>——原文与照片永远只属于你们。</li>
      <li>这是<b>本地存证</b>：由你们自己的慢记服务记账并校验，<b>尚未提交公共区块链</b>。写好后按当前规则不可修改，任何改动都会被全链校验发现。</li>
      <li>建议随后在链页<b>导出整条链/存证凭证</b>并妥善备份——服务与数据的保管责任在你们自己手里。</li>
      <li>往后内容更新，可以镌刻新的块；此刻的指纹会一直留在这条链上。</li>
      ${shared ? '<li>这条约定你们两个人都点过「我也愿意」。</li>' : ''}
    </ul>
    <div class="btn-row"><button class="btn ghost" onclick="closeModal()">再想想</button>
    <button class="btn primary" id="do-anchor">我愿意，镌刻</button></div>`);
  document.getElementById('do-anchor').onclick = async () => {
    const mask = document.getElementById('modal');
    mask.querySelector('.modal').innerHTML = `
      <div class="anchor-mining">
        <div class="mine-ring">⛓</div>
        <h3 style="margin:14px 0 4px">正在镌刻…</h3>
        <p class="muted tiny" id="mine-step">计算这一刻的内容指纹…</p>
        <p class="muted tiny">正在寻找一个以 0000 开头的哈希，通常只要一瞬间</p>
      </div>`;
    const steps = ['计算这一刻的内容指纹…', '寻找 0000 开头的哈希…', '把新区块接到链上…'];
    let si = 0;
    const timer = setInterval(() => {
      si = Math.min(si + 1, steps.length - 1);
      const el = document.getElementById('mine-step');
      if (el) el.textContent = steps[si];
    }, 350);
    try {
      const res = await api('POST', '/api/chain/anchor', { type, id });
      clearInterval(timer);
      mask.querySelector('.modal').innerHTML = `
        <div class="anchor-done">
          <div class="seal">⛓</div>
          <h3 style="margin:12px 0 2px">第 ${res.blockHeight} 块 · 已封存</h3>
          <p class="muted tiny" style="margin:0">这一刻的指纹已写进你们的永恒之链（本地存证，记得导出备份）。</p>
          <div class="chain-hash-card">
            <div><span class="muted tiny">区块哈希</span><div class="chain-hash">${res.blockHash}</div></div>
            <div><span class="muted tiny">内容承诺</span><div class="chain-hash">${res.commitment}</div></div>
          </div>
          <p class="muted tiny" style="margin:4px 0 10px">想让它永远作数？现在就用钱包把这个指纹刻上 <b>BOT Chain 主网</b>——从那一刻起，它不依赖任何服务器，任何人（包括我们自己）都无法修改。</p>
          <div class="btn-row"><button class="btn ghost" id="anchor-close">好</button>
          <button class="btn primary" id="anchor-seal-mainnet">⛓ 刻上 BOT 主网</button></div>
        </div>`;
      document.getElementById('anchor-close').onclick = () => { closeModal(); route(); };
      // 一步上链：弹窗内直接用钱包签名（无钱包/不支持时退化为去永恒之链页）
      const sealBtn = document.getElementById('anchor-seal-mainnet');
      sealBtn.onclick = async () => {
        const modalEl = mask.querySelector('.modal');
        const step = (t) => { const el = document.getElementById('seal-step'); if (el) el.textContent = t; };
        try {
          modalEl.innerHTML = `
            <div class="anchor-mining">
              <div class="mine-ring">⛓</div>
              <h3 style="margin:14px 0 4px">正在刻上 BOT 主网…</h3>
              <p class="muted tiny" id="seal-step">准备交易数据…</p>
              <p class="muted tiny">在钱包弹窗里确认这笔交易（合约只收到一个承诺哈希）</p>
            </div>`;
          if (!botwallet.isConnected()) { step('连接钱包…'); await botwallet.connect(); }
          step('确认 BOT 主网（链 677）…');
          const { txHash, explorer } = await sealViaWallet(res.anchorId);
          step('已发送，等待出块…');
          modalEl.innerHTML = `
            <div class="anchor-done">
              <div class="seal">⛓</div>
              <h3 style="margin:12px 0 2px">已刻上 BOT 主网</h3>
              <p class="muted tiny" style="margin:0 0 8px">这一刻的指纹已由你的钱包写进 BOT Chain，等待出块确认后永久不可修改。</p>
              <div class="chain-hash-card">
                <div><span class="muted tiny">主网交易</span><div class="chain-hash">${txHash}</div></div>
              </div>
              <div class="btn-row">
                ${explorer ? `<a class="btn gold" href="${explorer}/tx/${txHash}" target="_blank" rel="noopener">浏览器查看交易</a>` : ''}
                <button class="btn primary" id="seal-done">好</button>
              </div>
            </div>`;
          document.getElementById('seal-done').onclick = () => { closeModal(); location.hash = '#/chain'; route(); };
          refreshNotifDot();
        } catch (e) {
          closeModal();
          if (/未检测到浏览器钱包/.test(e.message)) {
            toast('未检测到钱包插件：可去永恒之链页由服务端代提交');
            location.hash = '#/chain';
          } else {
            toast(e.message);
          }
          route();
        }
      };
      refreshNotifDot();
    } catch (e) {
      clearInterval(timer);
      closeModal();
      if (e.code === 'ALREADY_ON_CHAIN') { toast(e.message); route(); }
      else toast(e.message);
    }
  };
}

const CHAIN_STATUS_TAG = {
  intact: { cls: 'ok', label: '与现在一致' },
  superseded: { cls: 'plain', label: '已有新版 · 此刻永存' },
  gone: { cls: 'plain', label: '原文已删 · 指纹仍在' },
  mismatch: { cls: 'rose', label: '与内容不一致' },
};

/** 约定/日记卡片的主网徽章：已确认显示主网序号，确认中提示等待（点击进永恒之链页） */
function mainnetTagHtml(onChain) {
  const m = onChain && onChain.mainnet;
  if (!m) return '';
  if (m.status === 'confirmed') {
    return `<a class="tag chain ok" href="#/chain" title="这一刻的指纹已登记在 BOT Chain 主网，任何人无法修改——点击查看交易">⛓ 主网 #${m.sealIndex}</a>`;
  }
  if (m.status === 'submitted') {
    return `<a class="tag chain" href="#/chain" title="交易已发上 BOT Chain 主网，等待确认">⛓ 主网确认中</a>`;
  }
  if (m.status === 'pending') {
    return `<a class="tag chain" href="#/chain" title="已加入 BOT Chain 主网提交队列">⛓ 待上主网</a>`;
  }
  return '';
}

/**
 * 用连接的钱包把一条承诺直接刻上 BOT 主网（镌刻弹窗与永恒之链页共用的核心一步）：
 * 取 calldata → 确保 BOT 主网 → 钱包签名广播 → 入队并回填交易哈希。返回 {txHash, explorer}。
 */
async function sealViaWallet(anchorId) {
  const cd = await api('GET', `/api/chain/onchain/seal-calldata/${encodeURIComponent(anchorId)}`);
  if (!botwallet.isConnected()) await botwallet.connect();
  if (!botwallet.onRightChain()) await botwallet.ensureChain();
  const txHash = await botwallet.sendTx({ to: cd.contract, data: cd.calldata });
  await api('POST', `/api/chain/onchain/${encodeURIComponent(anchorId)}`).catch(() => {});
  await api('POST', `/api/chain/onchain/${encodeURIComponent(anchorId)}/bind`, { txHash });
  return { txHash, explorer: cd.explorer };
}

// ================= BOT Chain 公开核验门户（免登录） =================
// 任何人——包括不使用慢记的人——都能在这里向 BOT Chain 主网直接提问：
// 一笔交易登记过哪些承诺，或一条承诺是否已被登记。这是「存证不依赖本应用」的公开承诺。
async function viewVerify() {
  let info = null;
  try { info = await api('GET', '/api/public/onchain/info'); } catch { /* 未配置或链不可达 */ }
  const c = info || {};
  const addrUrl = c.explorer && c.contract ? `${c.explorer}/address/${c.contract}` : null;

  $app.innerHTML = `
  <main class="verify-page">
    <header class="v-header">
      <div class="v-brand serif">慢记 <small>MANJI</small></div>
      <a class="v-home muted tiny" href="#/welcome">← 回首页</a>
    </header>
    <section class="v-hero">
      <div class="v-chainmark" aria-hidden="true"><svg viewBox="0 0 96 24" fill="none"><path d="M10 12c0-3.6 2.9-6.5 6.5-6.5H26c3.6 0 6.5 2.9 6.5 6.5s-2.9 6.5-6.5 6.5h-9.5C12.9 18.5 10 15.6 10 12Z" stroke="currentColor" stroke-width="1.6"/><path d="M35.5 12c0-3.6 2.9-6.5 6.5-6.5h9.5c3.6 0 6.5 2.9 6.5 6.5s-2.9 6.5-6.5 6.5H42c-3.6 0-6.5-2.9-6.5-6.5Z" stroke="currentColor" stroke-width="1.6"/><path d="M61 12c0-3.6 2.9-6.5 6.5-6.5H77c3.6 0 6.5 2.9 6.5 6.5s-2.9 6.5-6.5 6.5h-9.5C63.9 18.5 61 15.6 61 12Z" stroke="currentColor" stroke-width="1.6"/></svg></div>
      <h1 class="serif">BOT Chain 公开存证核验</h1>
      <p class="muted">慢记把约定与日记的承诺指纹登记在 BOT Chain 主网。在这里，<b>无需登录、无需信任我们</b>——
        输入一笔主网交易哈希，或一条承诺哈希（见「存证凭证」导出文件），直接向链提问。</p>
    </section>
    ${info ? `
    <section class="v-contract card soft">
      <div class="v-contract-row"><span class="muted tiny">合约</span>
        ${addrUrl ? `<a class="mono-link" href="${addrUrl}" target="_blank" rel="noopener">${c.contract}</a>` : `<span class="mono-link">${c.contract}</span>`}</div>
      <div class="v-contract-row"><span class="muted tiny">网络</span><span class="tiny">BOT Chain Mainnet · 链 ${c.chainId}</span></div>
      <div class="v-contract-row"><span class="muted tiny">链上已登记</span><span class="tag ok tiny">${typeof c.sealCount === 'number' ? `${c.sealCount} 条承诺` : '—'}</span></div>
      ${c.explorer ? `<div class="v-contract-row"><span class="muted tiny">浏览器</span><a class="mono-link" href="${c.explorer}" target="_blank" rel="noopener">${c.explorer.replace(/^https?:\/\//, '')}</a></div>` : ''}
    </section>` : `<div class="form-hint">公共链核验暂不可用（未配置或链不可达）。</div>`}
    <section class="v-lookup">
      <div class="field"><input class="input" id="v-input" placeholder="0x… 粘贴交易哈希或承诺哈希（64 位十六进制）" autocomplete="off" spellcheck="false"></div>
      <div id="v-err"></div>
      <button class="btn primary block" id="v-go">向 BOT 主网核验</button>
      <div id="v-result"></div>
    </section>
    <footer class="v-footer muted tiny">⛓ Built on <b>BOT Chain</b> · 存证一旦登记，永久 append-only，任何人（包括慢记自己）都无法修改或删除</footer>
  </main>`;

  const input = document.getElementById('v-input');
  const errBox = document.getElementById('v-err');
  const resultBox = document.getElementById('v-result');
  document.getElementById('v-go').onclick = async () => {
    errBox.innerHTML = '';
    resultBox.innerHTML = '<p class="muted tiny" style="margin:12px 0">正在向 BOT 主网提问…</p>';
    const raw = input.value.trim();
    try {
      const r = await api('GET', `/api/public/onchain/lookup?hash=${encodeURIComponent(raw)}`);
      const ex = r.chain && r.chain.explorer;
      if (r.kind === 'tx') {
        const t = r.tx;
        const sealRows = (t.seals || []).map((s) => `
          <div class="v-seal">
            <span class="tag ok tiny">#${s.index}</span>
            <div class="chain-hash">${s.commitment}</div>
            <span class="muted tiny">${fmtIso(s.sealedAtIso)}</span>
          </div>`).join('');
        resultBox.innerHTML = `
          <div class="card soft" style="margin-top:12px">
            <div class="v-contract-row"><span class="muted tiny">类型</span><span class="tiny">主网交易${t.isOurContract ? '' : '（非慢记合约的交易）'}</span></div>
            <div class="v-contract-row"><span class="muted tiny">状态</span><span class="tag ${t.status ? 'ok' : 'rose'} tiny">${t.status ? 'Success' : 'Failed / Reverted'}</span></div>
            <div class="v-contract-row"><span class="muted tiny">区块</span><span class="tiny">${t.blockNumber ?? '—'}</span></div>
            <div class="v-contract-row"><span class="muted tiny">发起者</span><span class="mono-link">${t.from}</span></div>
            ${sealRows ? `<div class="v-contract-row"><span class="muted tiny">登记的承诺</span></div>${sealRows}` : '<p class="muted tiny" style="margin:8px 0 0">这笔交易没有触发慢记合约的 Sealed 事件。</p>'}
            ${ex ? `<div class="btn-row" style="margin-top:10px"><a class="btn ghost sm" href="${ex}/tx/${t.hash}" target="_blank" rel="noopener">在浏览器打开这笔交易</a></div>` : ''}
          </div>`;
      } else {
        const m = r.commitment;
        resultBox.innerHTML = m.found ? `
          <div class="chain-integrity ok" style="margin-top:12px">
            <div class="ic">✓</div>
            <div><div class="t serif">已在 BOT 主网登记</div>
            <div class="muted tiny">登记序号 #${m.index} · ${fmtIso(m.sealedAtIso)} · 任何人改不了这条记录</div></div>
          </div>
          <div class="chain-hash" style="margin-top:8px">${m.hash}</div>` : `
          <div class="chain-integrity bad" style="margin-top:12px">
            <div class="ic">✗</div>
            <div><div class="t serif">主网上没有这条承诺</div>
            <div class="muted tiny">它尚未被提交，或交易尚未被确认。</div></div>
          </div>
          <div class="chain-hash" style="margin-top:8px">${m.hash}</div>`;
      }
    } catch (e) {
      resultBox.innerHTML = '';
      errBox.innerHTML = `<div class="form-error">${esc(e.message)}</div>`;
    }
  };
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') document.getElementById('v-go').click(); });
}

/** 永恒之链总览：整条链、逐块摘要（按权限显示标题）、完整性校验、凭证与整链导出。?home= 查看已定格旧链（B08，只读）。 */
let sealPollTimer = null; // 主网提交状态轮询（模块级：换页重渲染后旧 interval 不会泄漏）
let walletUnsub = null; // 钱包状态监听（重进链页时先退订旧的，避免监听器累积）
let puppyPollTimer = null; // Agent OS 小狗身份注册轮询（模块级 + 页面清理双保险：切页/整页重绘都不泄漏）
async function viewChain() {
  if (puppyPollTimer) { clearInterval(puppyPollTimer); puppyPollTimer = null; } // 进入链页先清旧轮询（route 开头的页面清理之外再兜一层）
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const archiveHome = params.get('home');
  let c;
  try {
    c = await api('GET', archiveHome ? `/api/chain/archive/${encodeURIComponent(archiveHome)}` : '/api/chain');
  } catch (e) {
    if (!archiveHome && e.code === 'UNAVAILABLE') {
      $app.innerHTML = `${topbar({ title: '永恒之链', en: 'ETERNAL CHAIN' })}<div class="page"><div class="empty">
        <div class="big">这个家已解除关联</div>
        <p class="muted tiny">那条链已经定格：链上只有内容指纹，不会再变，也不再增长。可以在「我的 → 我的空间」打开已解除家的旧链。</p>
        <a class="btn ghost" href="#/home">回到小家</a></div></div>${tabbar('memorial')}`;
      return;
    }
    if (e.code === 'NOT_FOUND') {
      $app.innerHTML = `${topbar({ title: '永恒之链', en: 'ETERNAL CHAIN' })}<div class="page"><div class="empty">
        <div class="big">打不开这条旧链</div>
        <p class="muted tiny">只能查看自己参与过的、已解除关联的共同家。</p>
        <a class="btn ghost" href="#/me">回到我的</a></div></div>${tabbar('memorial')}`;
      return;
    }
    throw e;
  }
  const archived = !!c.archived;
  // v3.6 公共链：BOT Chain 主网状态与提交记录（未配置或权限异常时整个面板隐藏，不影响本地链）
  let oc = null;
  if (!archived) {
    try {
      const [st, list] = await Promise.all([
        api('GET', '/api/chain/onchain/status'),
        api('GET', '/api/chain/onchain'),
      ]);
      if (st.mode !== 'off') oc = { st, items: list.items || [] };
    } catch { /* 面板隐藏 */ }
  }
  // v3.6 Agent OS：链上小狗身份卡（独立于上面的 BOT Chain 存证面板；接口缺失或未配置时静默降级，不影响本地链）
  let ag = null;
  if (!archived) {
    const [st, puppy] = await Promise.all([
      api('GET', '/api/agentos/status').catch(() => null),
      api('GET', '/api/agentos/puppy').catch(() => null), // 小狗还没注册时 404，视为未注册
    ]);
    if (st) ag = { ...st, puppy: puppy || st.puppy || null };
  }
  const sealByAnchor = new Map((oc ? oc.items : []).map((i) => [i.anchorId, i]));
  const shortHex = (h) => (h ? `${h.slice(0, 8)}…${h.slice(-6)}` : '');
  const byHeight = new Map();
  for (const a of c.anchors) byHeight.set(a.blockHeight, a);
  const heights = [0, ...c.anchors.map((a) => a.blockHeight)];

  const blockHtml = (h) => {
    if (h === 0) {
      return `<div class="chain-block genesis">
        <div class="chain-head"><span class="chain-h">#0</span><span class="chain-title serif">创世块</span>
          <span style="flex:1"></span><span class="tag plain tiny">家建立的那天</span></div>
        <p class="muted tiny" style="margin:6px 0 8px">愿每一段被认真写下的话，都值得被永远记住。此后每一块，都是两个人亲手封存的瞬间。</p>
        <div class="chain-hash">${c.genesisHash}</div>
      </div>`;
    }
    const a = byHeight.get(h);
    const st = CHAIN_STATUS_TAG[a.status] || CHAIN_STATUS_TAG.plain;
    return `<div class="chain-block">
      <div class="chain-head"><span class="chain-h">#${a.blockHeight}</span>
        <span class="chain-title serif">${esc(a.title)}</span>
        <span style="flex:1"></span><span class="tag ${st.cls} tiny">${st.label}</span></div>
      <div class="chain-meta muted tiny">${fmtIso(a.anchoredAt)} · 第 ${a.revision} 版 · ${a.type === 'promise' ? '约定' : '日记'}</div>
      <div class="chain-hash">${a.commitment}</div>
      ${a.canView ? `<button class="btn ghost sm chain-proof" data-proof="${a.anchorId}">存证凭证</button>` : ''}
      ${oc ? `<div class="seal-chip" data-seal-chip="${a.anchorId}">${sealChipInner(a.anchorId)}</div>` : ''}
    </div>`;
  };

  /** 每个区块的 BOT Chain 主网状态行（seal-chip 的内层内容，供轮询时局部刷新）：未提交给入口，已提交给状态 + 交易链接 + 核验 */
  function sealChipInner(anchorId) {
    if (!oc) return '';
    const s = sealByAnchor.get(anchorId);
    if (!s) {
      return `<button class="btn gold sm" data-seal="${anchorId}">⛓ 提交到 BOT 主网</button>
        <span class="muted tiny">用自己的钱包直接把这一刻刻上链</span>`;
    }
    const tx = s.txHash && oc.st.explorer
      ? `<a class="mono-link" target="_blank" rel="noopener" href="${oc.st.explorer}/tx/${s.txHash}" title="在区块浏览器查看交易">${shortHex(s.txHash)}</a>`
      : '';
    if (s.status === 'confirmed') {
      return `<span class="tag ok tiny">⛓ 主网已登记 #${s.sealIndex}</span>${tx}<button class="btn ghost sm" data-verify="${anchorId}" data-commitment="${s.commitment}">向主网核验</button>`;
    }
    if (s.status === 'submitted') {
      return `<span class="tag chain tiny">主网：已发送，等待确认</span>${tx}<button class="btn ghost sm" data-verify="${anchorId}" data-commitment="${s.commitment}">向主网核验</button>`;
    }
    if (s.status === 'pending') return '<span class="tag plain tiny">主网：等待提交</span>';
    return `<span class="tag rose tiny" title="${esc(s.error || '')}">主网：上次提交失败</span><button class="btn ghost sm" data-seal="${anchorId}">重试</button>`;
  }

  /** BOT Chain 主网面板：合约信息 + 连接钱包（C 端主网交互入口） */
  function botchainPanelHtml() {
    if (!oc) return '';
    const { st } = oc;
    const addrUrl = st.explorer && st.contract ? `${st.explorer}/address/${st.contract}` : null;
    const countChip = typeof st.chainSealCount === 'number'
      ? `<a class="tag ok tiny" ${addrUrl ? `href="${addrUrl}" target="_blank" rel="noopener"` : ''} title="BOT 主网合约上所有钱包登记的承诺总数">主网已登记 ${st.chainSealCount} 条承诺</a>`
      : '';
    return `
    <div class="botchain-panel" id="botchain-panel">
      <div class="bc-head">
        <div class="bc-title serif">⛓ BOT Chain 主网存证</div>
        <span class="tag chain tiny">${st.modeText} · 链 ${st.chainId}</span>
        ${countChip}
      </div>
      <p class="bc-value serif">被刻上主网的那一刻，不再依赖任何服务器或公司——任何人，包括我们自己，都无法再修改或删除。</p>
      <div class="bc-meta muted tiny">
        合约 ${st.contract}${addrUrl ? `（<a class="mono-link" target="_blank" rel="noopener" href="${addrUrl}">${shortHex(st.contract)} · 浏览器</a>）` : ''}
        ${st.explorer ? ` · <a class="mono-link" target="_blank" rel="noopener" href="${st.explorer}">scan.botchain.ai</a>` : ''}
      </div>
      <div class="bc-wallet" id="bc-wallet"></div>
      <p class="muted tiny" style="margin:8px 0 0">上链的只有这句话的指纹（哈希），没有正文、照片或成员身份；登记一旦确认永久不可撤回。连接钱包后，由<b>你的钱包</b>直接签名把承诺写上 BOT 主网。· <a href="#/verify">任何人可免登录核验 →</a></p>
    </div>`;
  }

  /** 钱包区域：未连接给按钮；已连接给地址与链状态 */
  function renderWalletArea() {
    const el = document.getElementById('bc-wallet');
    if (!el || !oc) return;
    if (!botwallet.isConnected()) {
      const hint = botwallet.hasWallet()
        ? '连接后即可用你的钱包直接签名上链'
        : '未检测到钱包插件：也可由服务端代提交（下方按钮提交时自动选择）';
      el.innerHTML = `<button class="btn primary sm" id="bc-connect">连接钱包</button><span class="muted tiny">${hint}</span>`;
      const btn = document.getElementById('bc-connect');
      if (btn) btn.onclick = async () => {
        try {
          await botwallet.connect();
          toast('钱包已连接，正在核对 BOT 主网…');
          await botwallet.ensureChain().catch(() => {});
          renderWalletArea();
        } catch (e) { toast(e.message); }
      };
    } else {
      const right = botwallet.onRightChain();
      const addr = botwallet.wallet.address;
      el.innerHTML = `<span class="tag ${right ? 'ok' : 'rose'} tiny" title="${addr}">${shortHex(addr)} ${right ? '· 已连接 BOT 主网' : '· 未在 BOT 主网'}</span>
        ${right ? '' : '<button class="btn ghost sm" id="bc-switch">切到 BOT 主网</button>'}`;
      const sw = document.getElementById('bc-switch');
      if (sw) sw.onclick = async () => {
        try { await botwallet.ensureChain(); renderWalletArea(); }
        catch (e) { toast(e.message); }
      };
    }
  }

  /** 提交一条承诺到 BOT 主网：优先用户钱包直发（v2 合约开放写入），否则走服务端 relayer */
  async function submitToMainnet(anchorId) {
    if (!oc) return;
    try {
      if (!botwallet.isConnected() && botwallet.hasWallet()) {
        await botwallet.connect(); // 钱包弹授权框
        await botwallet.ensureChain().catch(() => {});
        renderWalletArea();
      }
      if (botwallet.isConnected() && oc.st.walletDirect) {
        // —— C 端钱包直发：页面取 calldata → 钱包签名 → 广播 → 回填对账 ——
        toast('请在钱包里确认这笔 BOT 主网交易（合约只收到一个承诺哈希）…');
        const { txHash } = await sealViaWallet(anchorId);
        toast(`已由你的钱包发上主网：${txHash.slice(0, 12)}… 等待确认`);
        startSealPolling();
        route();
      } else {
        // —— 服务端路径：auto 模式由统一 relayer 代发；manual 模式给出可直接发送的 calldata ——
        const r = await api('POST', `/api/chain/onchain/${encodeURIComponent(anchorId)}`);
        if (r.manual) {
          openModal(`<h3>手动提交到 BOT 主网</h3>
            <p class="muted tiny" style="margin:6px 0 10px">向合约 <b>${esc(r.manual.contract)}</b>（链 ${r.manual.chainId}）发送以下调用数据（seal 函数，参数只有一个 32 字节承诺哈希）：</p>
            <div class="chain-hash" style="word-break:break-all">${r.manual.calldata}</div>
            <p class="muted tiny">用任意 EVM 钱包（MetaMask / Remix）发送后，把交易哈希回填给管理员即可自动确认。</p>
            <div class="btn-row"><button class="btn ghost" onclick="closeModal()">好</button></div>`);
        } else {
          toast('已加入提交队列，由服务端代提交（约 15 秒内发送）');
          startSealPolling();
          route();
        }
      }
    } catch (e) {
      toast(e.message);
    }
  }

  /** 向主网核验一条承诺：连接了钱包就经钱包 RPC 直读（sealOf），否则问服务端 */
  async function verifyOnMainnet(anchorId, commitment) {
    if (!oc) return;
    try {
      if (botwallet.isConnected()) {
        const raw = await botwallet.ethCall({ to: oc.st.contract, data: '0x3038bfa5' + commitment.replace(/^0x/, '') });
        const w = (raw || '').slice(2).match(/.{64}/g) || [];
        const found = w.length >= 3 && BigInt('0x' + w[0]) !== 0n;
        toast(found
          ? `钱包直读主链 ✓ 已登记（index=${Number(BigInt('0x' + w[1]))}）`
          : '钱包直读主链：这条承诺尚未登记');
      } else {
        const v = await api('GET', `/api/chain/onchain/verify/${encodeURIComponent(anchorId)}`);
        toast(v.onChain.found ? `主网核验 ✓ 已登记 index=${v.onChain.sealIndex}` : '主网上还没有这条承诺');
      }
    } catch (e) { toast(e.message); }
  }

  /** 有未完结的提交时轮询刷新状态徽章（局部更新，不整页重渲染）。计时器放模块级，防止换页后旧轮询泄漏。 */
  function startSealPolling() {
    if (sealPollTimer || !oc) return;
    let count = 0;
    sealPollTimer = setInterval(async () => {
      count += 1;
      try {
        const list = await api('GET', '/api/chain/onchain');
        oc.items = list.items || [];
        for (const it of oc.items) sealByAnchor.set(it.anchorId, it);
        for (const el of $app.querySelectorAll('[data-seal-chip]')) {
          el.innerHTML = sealChipInner(el.dataset.sealChip);
        }
        const busy = oc.items.some((i) => i.status === 'pending' || i.status === 'submitted');
        if (!busy || count >= 20) { clearInterval(sealPollTimer); sealPollTimer = null; }
      } catch { /* 轮询失败静默 */ }
    }, 8000);
  }

  /** 链上小狗身份的阶段文案（自链铸造状态机：PENDING→SUBMITTED→REGISTERED / FAILED） */
  const PUPPY_STATUS_TEXT = {
    PENDING: '铸造参数已备好，等你在钱包里签名确认…',
    SUBMITTED: '铸造交易已发上 BOT 主网，等出块确认…',
    FAILED: '上一次铸造没有成功，可以换一个名字再试。',
  };

  /** 链上小狗卡：自托管 ManjiPuppyIdentity 的四态（未配置 / 未铸造 / 铸造中 / 已铸造） */
  function puppyCardHtml() {
    if (!ag) return '';
    if (ag.mode !== 'self') {
      return `
      <div class="puppy-card" id="puppy-card">
        <div class="pc-head">
          <div class="pc-title serif">🐕 链上小狗</div>
          <span class="tag plain tiny">等待接入</span>
        </div>
        <p class="muted tiny" style="margin:8px 0 0">链上小狗身份（名字上链、链上生日、存钱罐）已就绪——等待服务端配置小狗身份合约（PUPPY_IDENTITY_CONTRACT）。</p>
      </div>`;
    }
    const totalChip = typeof ag.totalPuppies === 'number' && ag.totalPuppies > 0
      ? `<span class="tag chain tiny" title="链上小狗身份合约已铸造的总数">链上已有 ${ag.totalPuppies} 只小狗</span>`
      : '';
    const p = ag.puppy;
    if (!p) {
      return `
      <div class="puppy-card" id="puppy-card">
        <div class="pc-head">
          <div class="pc-title serif">🐕 链上小狗</div>
          <span class="tag chain tiny">BOT Chain · 链 ${esc(String(ag.chainId ?? ''))}</span>
          ${totalChip}
        </div>
        <p class="pc-value serif">给我们的小狗也铸一枚链上身份：一个写上 BOT Chain 就改不了的名字。</p>
        <p class="muted tiny" style="margin:6px 0 10px">由<b>你的钱包</b>直接签名铸造（ERC-8004 风格身份 NFT，不可转让）：名字与生日永远在链上，任何人——包括我们自己——都改不了；身份还带一个「存钱罐」地址，可以给它 BOT 当零花钱。</p>
        <div class="btn-row"><button class="btn primary sm" id="puppy-register">给我们的小狗铸链上身份</button></div>
      </div>`;
    }
    if (p.status !== 'REGISTERED') {
      const statusText = PUPPY_STATUS_TEXT[p.status] || `当前状态：${esc(p.status || '准备中…')}`;
      // 还没上链（PENDING/FAILED）都可以重开铸造弹窗改名字再试；SUBMITTED 等出块
      const retryable = p.status === 'PENDING' || p.status === 'FAILED' || !!p.error;
      const tagText = p.status === 'SUBMITTED' ? '铸造中' : '待铸造';
      return `
      <div class="puppy-card" id="puppy-card">
        <div class="pc-head">
          <div class="pc-title serif">🐕 ${esc(p.name || '家里的小狗')}</div>
          <span class="tag chain tiny">${tagText}</span>
        </div>
        <p class="pc-value serif">小狗正在 BOT Chain 上落户口——有了自己的名字，就有了一个谁也拿不走的身份。</p>
        <p class="pc-status muted tiny">${statusText}这一页每 15 秒会自己看一眼进度。</p>
        ${p.error ? `<p class="muted tiny" style="margin:6px 0 0">上一次尝试遇到点问题：${esc(p.error)}</p>` : ''}
        ${retryable ? `<div class="btn-row" style="margin-top:8px"><button class="btn ghost sm" id="puppy-retry">换名字再试一次</button></div>` : ''}
      </div>`;
    }
    const registryUrl = ag.explorer && ag.contract ? `${ag.explorer}/address/${ag.contract}` : null;
    const accountUrl = ag.explorer && p.accountAddress ? `${ag.explorer}/address/${p.accountAddress}` : null;
    return `
    <div class="puppy-card" id="puppy-card">
      <div class="pc-head">
        <div class="pc-title serif">🐕 ${esc(p.name || '家里的小狗')}</div>
        <span class="tag ok tiny" title="链上小狗身份 NFT（ERC-8004 风格，不可转让）的编号">链上身份 #${esc(String(p.agentTokenId ?? ''))}</span>
        ${totalChip}
      </div>
      <p class="pc-value serif">小狗在 BOT Chain 上有了自己的名字——写上去，就谁也改不了。</p>
      <div class="pc-meta muted tiny">
        身份合约${registryUrl ? `（<a class="mono-link" href="${registryUrl}" target="_blank" rel="noopener">${shortHex(ag.contract)} · 浏览器</a>）` : ''}
        ${p.mintTxUrl ? ` · <a class="mono-link" href="${p.mintTxUrl}" target="_blank" rel="noopener" title="铸造交易">铸造交易 ↗</a>` : ''}
      </div>
      <div class="pc-row muted tiny">
        <span>存钱罐</span>
        ${accountUrl
          ? `<a class="mono-link" href="${accountUrl}" target="_blank" rel="noopener" title="在浏览器查看小狗的存钱罐地址">${esc(p.accountAddress)}</a>`
          : `<span class="mono-link">${esc(p.accountAddress || '—')}</span>`}
      </div>
      <div class="btn-row" style="margin-top:10px">
        <button class="btn ghost sm" id="puppy-verify">向主网核验这个身份</button>
      </div>
      <div class="pc-tip">
        <span class="muted tiny">给小狗一点 BOT 当零花钱（从你的钱包直接转给它）：</span>
        <div class="pc-tip-form">
          <input class="input" id="puppy-tip-amount" inputmode="decimal" placeholder="1.5" autocomplete="off">
          <span class="muted tiny">BOT</span>
          <button class="btn gold sm" id="puppy-tip-btn">打赏</button>
        </div>
        <p class="muted tiny" style="margin:6px 0 0">链上到账，进的是小狗自己的存钱罐；金额原样发出，不加也不减。</p>
      </div>
    </div>`;
  }

  /** 铸造小狗链上身份：弹窗填名字与存钱罐 → 服务端备好 calldata → 连接的钱包签名 mint → 回填交易 → 轮询出块 */
  async function registerPuppyIdentity() {
    const defaultWallet = botwallet.isConnected() ? botwallet.wallet.address : '';
    const defaultName = (ag && ag.puppy && ag.puppy.name) || '';
    openModal(`<h3>给小狗铸链上身份</h3>
      <div class="anchor-quote serif">写上 BOT Chain 的名字，谁也改不了。</div>
      <div class="field" style="margin-top:10px"><label class="muted tiny">小狗的名字（上链后不可改，约 10 个汉字以内）</label>
        <input class="input" id="puppy-name-input" maxlength="32" value="${esc(defaultName)}" placeholder="比如：毛毛"></div>
      <div class="field" style="margin-top:8px"><label class="muted tiny">存钱罐地址（打赏发这里；可填你的钱包，也可另建一个）</label>
        <input class="input" id="puppy-wallet-input" value="${esc(defaultWallet)}" placeholder="0x…"></div>
      <p class="muted tiny" style="margin:8px 0 10px">铸造交易由<b>你的钱包</b>直接签名发上 BOT 主网（链 677），页面只准备数据。身份 NFT 不可转让：它属于这个小狗，就永远属于。</p>
      <div id="puppy-mint-err"></div>
      <div class="btn-row"><button class="btn ghost" id="puppy-mint-cancel">再想想</button>
      <button class="btn primary" id="puppy-mint-go">⛓ 在钱包里铸造</button></div>`);
    document.getElementById('puppy-mint-cancel').onclick = closeModal;
    document.getElementById('puppy-mint-go').onclick = async () => {
      const errBox = document.getElementById('puppy-mint-err');
      errBox.innerHTML = '';
      const name = String(document.getElementById('puppy-name-input').value || '').trim();
      const agentWallet = String(document.getElementById('puppy-wallet-input').value || '').trim();
      const nb = new TextEncoder().encode(name);
      if (nb.length === 0 || nb.length > 32) {
        errBox.innerHTML = '<div class="form-error">名字长度需在 1-32 字节之间（约 10 个汉字以内）</div>';
        return;
      }
      if (!/^0x[0-9a-fA-F]{40}$/.test(agentWallet)) {
        errBox.innerHTML = '<div class="form-error">存钱罐地址格式不对（0x 开头的 40 位十六进制）</div>';
        return;
      }
      const btn = document.getElementById('puppy-mint-go');
      btn.disabled = true;
      btn.textContent = '正在准备…';
      try {
        const prep = await api('POST', '/api/agentos/puppy/register', { name, agentWallet });
        if (!botwallet.isConnected()) await botwallet.connect();
        if (!botwallet.onRightChain()) await botwallet.ensureChain();
        btn.textContent = '请在钱包里确认…';
        toast('请在钱包里确认这笔铸造交易（名字会永远写上 BOT Chain）…');
        const txHash = await botwallet.sendTx({ to: prep.contract, data: prep.calldata });
        await api('POST', '/api/agentos/puppy/bind', { txHash });
        closeModal();
        toast(`已由你的钱包铸出：交易 ${shortHex(txHash)}，等出块确认`);
        route(); // 重绘成「铸造中」卡片并启动轮询
      } catch (e) {
        if (e.code === 'ALREADY_REGISTERED') { closeModal(); toast('小狗已经有链上身份了'); route(); return; }
        toast(e.message);
        btn.disabled = false;
        btn.textContent = '⛓ 在钱包里铸造';
      }
    };
  }

  /** 核验小狗的链上身份：连了钱包就经钱包 RPC 直读 IdentityRegistry.ownerOf（选择器 0x6352211e + tokenId，不依赖慢记后端），否则问服务端 */
  async function verifyPuppyOwner() {
    const p = ag && ag.puppy;
    if (!ag || !p || !p.agentTokenId) return;
    const btn = document.getElementById('puppy-verify');
    if (btn) btn.disabled = true;
    try {
      if (botwallet.isConnected()) {
        const data = '0x6352211e' + BigInt(p.agentTokenId).toString(16).padStart(64, '0');
        const raw = await botwallet.ethCall({ to: ag.contract, data });
        const owner = '0x' + String(raw || '').replace(/^0x/, '').slice(-40);
        toast(/^0x0{40}$/i.test(owner)
          ? '钱包直读主链：链上还没有这个身份'
          : `钱包直读主链 ✓ 身份 #${p.agentTokenId} 属于 ${shortHex(owner)}`);
      } else {
        const v = await api('GET', '/api/agentos/puppy/verify');
        toast(v && v.found
          ? `主网核验 ✓ 身份 #${p.agentTokenId} 真实在链上${v.owner ? `，属于 ${shortHex(v.owner)}` : ''}`
          : '主网上还没有查到这个身份');
      }
    } catch (e) {
      toast(e.message);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /** 给小狗打赏 BOT：先在慢记落一笔 pending，再用连接的钱包直发原生转账，最后回填交易哈希（照 sealViaWallet 的模式） */
  async function tipPuppy() {
    const p = ag && ag.puppy;
    if (!ag || !p || !p.accountAddress) return;
    const input = document.getElementById('puppy-tip-amount');
    const btn = document.getElementById('puppy-tip-btn');
    const amountBot = String((input && input.value) || '').trim();
    const n = Number(amountBot);
    if (!amountBot || !Number.isFinite(n) || n <= 0 || n > 1000) {
      toast('想给小狗多少 BOT？填一个大于 0、不超过 1000 的小数目');
      return;
    }
    if (btn) { btn.disabled = true; btn.textContent = '打赏中…'; }
    try {
      const t = await api('POST', '/api/agentos/puppy/tip', { amountBot });
      // amountWei 是十进制字符串：BigInt(字符串) 无损换算成 wei 再转十六进制给钱包——绝不过 Number，wei 级精度丢不得
      if (!botwallet.isConnected()) await botwallet.connect();
      if (!botwallet.onRightChain()) await botwallet.ensureChain();
      toast('请在钱包里确认这笔给小狗的 BOT 转账…');
      const txHash = await botwallet.sendTx({ to: t.toAddress, value: '0x' + BigInt(t.amountWei).toString(16) });
      await api('POST', `/api/agentos/puppy/tip/${encodeURIComponent(t.tipId)}/bind`, { txHash });
      toast(`已给小狗转了 ${amountBot} BOT：交易 ${shortHex(txHash)}，等链上确认`);
      if (input) input.value = '';
    } catch (e) {
      toast(e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '打赏'; }
    }
  }

  /** 注册中的小狗身份进度轮询：每 15 秒整页 route() 重绘（重绘先清掉本计时器、再按需重建，循环自洽；切页由页面清理与哈希守卫双保险收口） */
  function startPuppyPolling() {
    if (puppyPollTimer) return;
    let count = 0;
    puppyPollTimer = setInterval(async () => {
      if (!location.hash.startsWith('#/chain')) { clearInterval(puppyPollTimer); puppyPollTimer = null; return; }
      count += 1;
      try {
        const st = await api('GET', '/api/agentos/status');
        if (st && st.puppy && st.puppy.status === 'REGISTERED') toast('小狗的链上身份注册好了 🐕');
      } catch { /* 本轮查询失败不打扰，交给下一次 */ }
      if (count >= 20) { clearInterval(puppyPollTimer); puppyPollTimer = null; } // 上限兜底
      route();
    }, 15000);
    registerPageCleanup(() => { clearInterval(puppyPollTimer); puppyPollTimer = null; });
  }

  $app.innerHTML = `
  ${topbar({ title: '永恒之链', en: archived ? 'FROZEN CHAIN' : 'ETERNAL CHAIN' })}
  <div class="page fade-up">
    <div class="seg-tabs"><a href="#/promises">说好的承诺</a><a href="#/anniversaries">纪念日与作品</a><a class="on" href="#/chain">永恒之链</a></div>
    ${archived ? `<div class="form-hint" style="margin-bottom:10px">⛓ 这是一条<b>已定格的旧链</b>：解除关联后只读保留，不再增长。下面只显示你现在有权查看的部分；你自己的旧凭证仍可下载核验。</div>` : ''}
    <div class="chain-integrity ${c.integrity.ok ? 'ok' : 'bad'}" id="chain-integrity">
      <div class="ic">${c.integrity.ok ? '✓' : '✗'}</div>
      <div>
        <div class="t serif">${c.integrity.ok ? '链条完整' : `链在第 ${c.integrity.brokenAt} 块断裂`}</div>
        <div class="muted tiny">已逐块按各自算法版本重算验证 ${c.integrity.checkedBlocks} 块 · 高度 ${c.height} · 镌刻了 ${c.anchors.length} 个瞬间${archived ? ' · 已定格' : ''}</div>
      </div>
      ${archived ? '<span class="tag plain">只读</span>' : '<button class="btn ghost sm" id="btn-verify">再验证一次</button>'}
    </div>
    ${botchainPanelHtml()}
    ${puppyCardHtml()}
    ${c.anchors.length === 0 ? `<div class="empty"><div class="big">${archived ? '这条旧链上没有可给你看的瞬间' : '还没有镌刻任何瞬间'}</div>
      <p class="muted tiny">${archived ? '链上只保存指纹；无权查看的部分不在此展示。' : '在约定或日记里点「镌刻上链」，把值得永远记住的一刻接到链上。'}</p>
      ${archived ? '' : '<a class="btn ghost" href="#/promises">去看看约定</a>'}</div>` : ''}
    <div class="chain-list">${heights.map(blockHtml).join('')}</div>
    <div class="card soft" style="margin-top:14px">
      <div class="serif" style="margin-bottom:6px">这条链是什么</div>
      <p class="muted tiny" style="margin:0 0 8px">它由一块块哈希首尾相连：每一块都攥着上一块的指纹，所以改掉任何一块，后面全部对不上——<b>按当前规则可校验、不可篡改</b>。</p>
      <p class="muted tiny" style="margin:0 0 8px">${esc(c.honesty || '')}</p>
      <div class="btn-row"><button class="btn ghost sm" id="btn-export-chain">导出整条链（JSON）</button></div>
    </div>
  </div>
  ${tabbar('memorial')}`;

  // BOT Chain 主网面板：钱包区域渲染 + 事件委托挂在链列表容器上（轮询局部刷新徽章不会冲掉处理器）
  renderWalletArea();
  if (walletUnsub) walletUnsub();
  walletUnsub = botwallet.onWalletChange(() => renderWalletArea());

  // 链上小狗卡：渲染后对卡内控件直绑（卡片不做局部刷新轮询，整页 route() 重绘会连带重建这些绑定）
  const puppyRegisterBtn = document.getElementById('puppy-register');
  if (puppyRegisterBtn) puppyRegisterBtn.onclick = registerPuppyIdentity;
  const puppyRetryBtn = document.getElementById('puppy-retry');
  if (puppyRetryBtn) puppyRetryBtn.onclick = registerPuppyIdentity;
  const puppyVerifyBtn = document.getElementById('puppy-verify');
  if (puppyVerifyBtn) puppyVerifyBtn.onclick = verifyPuppyOwner;
  const puppyTipBtn = document.getElementById('puppy-tip-btn');
  if (puppyTipBtn) puppyTipBtn.onclick = tipPuppy;
  const puppyTipInput = document.getElementById('puppy-tip-amount');
  if (puppyTipInput) puppyTipInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') tipPuppy(); });
  if (ag && ag.mode === 'self' && ag.puppy && ag.puppy.status !== 'REGISTERED') startPuppyPolling();
  if (oc) {
    $app.querySelector('.chain-list').addEventListener('click', (ev) => {
      const sealBtn = ev.target.closest('[data-seal]');
      if (sealBtn) { submitToMainnet(sealBtn.dataset.seal); return; }
      const vBtn = ev.target.closest('[data-verify]');
      if (vBtn) verifyOnMainnet(vBtn.dataset.verify, vBtn.dataset.commitment);
    });
    if (oc.items.some((i) => i.status === 'pending' || i.status === 'submitted')) startSealPolling();
  }

  const verifyBtn = document.getElementById('btn-verify');
  if (verifyBtn) {
    verifyBtn.onclick = async () => {
      try {
        const v = await api('GET', '/api/chain/verify');
        const box = document.getElementById('chain-integrity');
        box.className = `chain-integrity ${v.ok ? 'ok' : 'bad'}`;
        box.querySelector('.ic').textContent = v.ok ? '✓' : '✗';
        box.querySelector('.t').textContent = v.ok ? '链条完整' : `链在第 ${v.brokenAt} 块断裂`;
        toast(v.ok ? '验证通过：每一块的哈希都对得上' : `验证发现断裂：第 ${v.brokenAt} 块被改动过`);
        if (!v.ok) route();
      } catch (e) {
        toast(e.message);
      }
    };
  }
  document.getElementById('btn-export-chain').onclick = async () => {
    try {
      const blob = await apiBlob(`/api/chain/export${archived ? `?home=${encodeURIComponent(archiveHome)}` : ''}`);
      downloadBlob(blob, archived ? '慢记-已定格的链.json' : '慢记-永恒之链.json');
      toast('已导出（只有指纹与区块，没有原文）');
    } catch (e) {
      toast(e.message);
    }
  };
  $app.querySelectorAll('[data-proof]').forEach((b) => {
    b.onclick = async () => {
      try {
        const blob = await apiBlob(`/api/chain/proof/${b.dataset.proof}`);
        downloadBlob(blob, '慢记-存证凭证.json');
        toast('凭证已下载，可离线核验');
      } catch (e) {
        toast(e.message);
      }
    };
  });
}

function fmtIso(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ================= 启动 =================

(async function boot() {
  console.info(`[慢记] Manji v${APP_VERSION}`);
  await loadMe();
  applyMotionPreference();
  route();
  // v3.5（U02 关联）：回到窗口时静默刷新一次自己的资料——
  // 例如另一半刚刚接受邀请，这页不刷新也能在下一次打开表单时拿到"已是共同家"的状态
  window.addEventListener('focus', () => {
    if (state.me) loadMe().then(() => applyMotionPreference()).catch(() => {});
  });
  // v3.5（U01）：旧版本家名只存在各自设备——启动时静默上迁一次到服务端
  migrateLegacyHomeName().catch(() => {});
})();
