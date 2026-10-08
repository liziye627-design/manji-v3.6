// 慢记 Manji v3.3 —— 纪念物图片与三犬头像。
// 首页实时模型由 room/room.js 加载；此处图片只用于欢迎、选择与设置。
// 保留兼容导出与 appearanceKey 契约，不把图片姿态当成完整动画。

const IMG = '/assets/img';
const DOG_IMG = '/assets/dogs';
const attr = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// templateKey → 渲染素材（服务端 6 模板 key 不变；展示名见 app.js TPL_INFO）
const OBJ_ASSETS = {
  shell: { file: 'obj-shell.png', ratio: 321 / 448 },
  ticket: { file: 'obj-ticket.png', ratio: 370 / 448 },
  pot: { file: 'obj-pot.png', ratio: 431 / 448 },
  umbrella: { file: 'obj-umbrella.png', ratio: 428 / 448 },
  tent: { file: 'obj-tent.png', ratio: 360 / 448 },
  cup: { file: 'obj-cup.png', ratio: 462 / 448 },
  camera: { file: 'obj-camera.png', ratio: 436 / 448 },
  boat: { file: 'obj-boat.png', ratio: 382 / 448 },
  suitcase: { file: 'obj-suitcase.png', ratio: 435 / 448 },
  plant: { file: 'obj-plant.png', ratio: 702 / 448 },
  plant_alt: { file: 'obj-plant-alt.png', ratio: 703 / 448 },
  big_tent: { file: 'obj-big-tent.png', ratio: 348 / 448 },
};

// 保留服务端 PET_APPEARANCES：cream → 柴犬，caramel → 哈士奇，cocoa → 巴哥。
const DOG_ASSETS = {
  cream: { file: 'shiba.png', ratio: 1, name: '柴犬' },
  caramel: { file: 'husky.png', ratio: 1, name: '哈士奇' },
  cocoa: { file: 'pug.png', ratio: 1, name: '巴哥' },
};
// 兼容旧页面的插画入口，实际动作在实时小屋内执行。
export const DOG_POSES = {
  stand: DOG_ASSETS.cream,
  sit: DOG_ASSETS.cream,
  sleep: DOG_ASSETS.cream,
  carry: DOG_ASSETS.cream,
  wheat: DOG_ASSETS.cream,
};

export function objectIcon(key, size = 44) {
  const a = OBJ_ASSETS[key] || OBJ_ASSETS.shell;
  const w = size;
  const h = Math.round(size * a.ratio);
  return `<img class="obj-icon obj-img" src="${IMG}/${a.file}" width="${w}" height="${h}" alt="" loading="lazy" decoding="async">`;
}

export function dogSVG(appearance = 'cream', size = 96) {
  const a = DOG_ASSETS[appearance] || DOG_ASSETS.cream;
  const w = size;
  const h = Math.round(size * a.ratio);
  return `<img class="dog-img dog-portrait" src="${DOG_IMG}/${a.file}" width="${w}" height="${h}" alt="${a.name}" decoding="async">`;
}

export function dogPoseImg(pose = 'sit', width = 160, cls = 'dog-img') {
  const a = DOG_POSES[pose] || DOG_POSES.sit;
  return `<img class="${attr(cls)} dog-portrait" src="${DOG_IMG}/${a.file}" width="${width}" height="${Math.round(width * a.ratio)}" alt="${a.name}" decoding="async">`;
}

/* 旧版静态页面的兼容入口；完整状态动画由实时小屋负责。 */
export const DOG_STATE_SPRITE = {
  rest: (appearance) => (DOG_ASSETS[appearance] || DOG_ASSETS.cream).file,
  greet: (appearance) => (DOG_ASSETS[appearance] || DOG_ASSETS.cream).file,
  play: (appearance) => (DOG_ASSETS[appearance] || DOG_ASSETS.cream).file,
  guide: (appearance) => (DOG_ASSETS[appearance] || DOG_ASSETS.cream).file,
  carry: (appearance) => (DOG_ASSETS[appearance] || DOG_ASSETS.cream).file,
  sleep: (appearance) => (DOG_ASSETS[appearance] || DOG_ASSETS.cream).file,
};

export function dogStateImg(state = 'rest', appearance = 'cream', width = 170, cls = '') {
  const file = (DOG_STATE_SPRITE[state] || DOG_STATE_SPRITE.rest)(appearance);
  const known = [...Object.values(DOG_ASSETS), ...Object.values(DOG_POSES)].find((a) => a.file === file);
  const r = known ? known.ratio : 1;
  return `<img class="${attr(cls)} dog-portrait" src="${DOG_IMG}/${file}" width="${width}" height="${Math.round(width * r)}" alt="${known?.name || '小狗'}" decoding="async">`;
}

// 房间舞台：微缩场景 + 固定摆放点位（百分比坐标，随容器等比缩放）
export const SLOT_POS = {
  window: { x: 73.5, y: 44, w: 13 },
  kitchen: { x: 88, y: 24, w: 13 },
  sofa_side: { x: 50, y: 52, w: 13 },
  table: { x: 46, y: 72, w: 15 },
  door: { x: 10.5, y: 47, w: 13 },
  corner: { x: 86, y: 66, w: 13 },
};

export function roomSVG({ objects = [], dog = null, nameplate = false, showSlots = true, bare = false } = {}) {
  const bySlot = {};
  for (const o of objects) bySlot[o.slotKey] = o;
  const slots = showSlots
    ? Object.entries(SLOT_POS)
        .map(([key, p]) => {
          const occ = bySlot[key];
          if (occ) {
            const a = OBJ_ASSETS[occ.templateKey] || OBJ_ASSETS.shell;
            return `<button class="placed-obj" data-slot="${key}" data-memory="${attr(occ.memory.id)}" role="button" tabindex="0"
              aria-label="${attr(occ.memory.title)}" style="left:${p.x}%;top:${p.y}%;width:${p.w}%">
              <img src="${IMG}/${a.file}" alt="" style="width:100%" loading="lazy" decoding="async"></button>`;
          }
          return `<button class="slot-btn" data-slot="${key}" role="button" tabindex="0"
            aria-label="空位置" title="这个位置还空着" style="left:${p.x}%;top:${p.y}%"></button>`;
        })
        .join('')
    : Object.entries(bySlot)
        .map(([key, occ]) => {
          const p = SLOT_POS[key] || { x: 50, y: 50, w: 14 };
          const a = OBJ_ASSETS[occ.templateKey] || OBJ_ASSETS.shell;
          return `<button class="placed-obj" data-slot="${attr(key)}" data-memory="${attr(occ.memory.id)}" role="button" tabindex="0"
            aria-label="${attr(occ.memory.title)}" style="left:${p.x}%;top:${p.y}%;width:${p.w}%">
            <img src="${IMG}/${a.file}" alt="" style="width:100%" loading="lazy" decoding="async"></button>`;
        })
        .join('');
  const dogEl = dog
    ? (() => {
        const state = dog.state || 'rest';
        return `<div class="room-dog ${state === 'carry' ? 'walk-in' : ''} ${state === 'greet' ? 'wiggle' : ''}" id="stage-dog"
          data-state="${attr(state)}" role="button" tabindex="0" aria-label="${attr(dog.name || '小狗')}"
          style="left:${dog.x ?? 63}%;top:${dog.y ?? 76}%;width:${dog.w ?? 22}%">
          ${dog.say ? `<div class="dog-bubble" id="dog-bubble">${attr(dog.say)}</div>` : ''}
          ${dogStateImg(state, dog.appearanceKey, 200, '')}</div>`;
      })()
    : '';
  if (bare) {
    // 仅图层（用于沉浸式 Hero：场景图由外层控制）
    return `${dogEl}${slots}`;
  }
  return `<div class="room-stage">
    <img class="scene" src="${IMG}/scene-home.png" alt="我们的小屋" decoding="async">
    ${dogEl}
    ${slots}
  </div>`;
}

export function tabIcon(name) {
  const paths = {
    home: `<path d="M4 11.2 12 4.5l8 6.7V19a1.5 1.5 0 0 1-1.5 1.5h-4v-6h-5v6h-4A1.5 1.5 0 0 1 4 19Z"/>`,
    memories: `<rect x="5" y="3.5" width="14" height="17" rx="2.5"/><circle cx="9.5" cy="8.5" r="1.6"/><path d="M8 17l3.2-3.6 2.3 2.4 2-2 2.5 3.2"/>`,
    promises: `<path d="M8.5 13.5c-2-1.8-4-3.4-4-5.6a2.6 2.6 0 0 1 4.6-1.6l.9 1 .9-1a2.6 2.6 0 0 1 4.6 1.6c0 2.2-2 3.8-4 5.6L12 14.4Z"/><path d="M4.5 19.5h15"/>`,
    memorial: `<rect x="4" y="5" width="16" height="15.5" rx="2.5"/><path d="M8 3.5v3M16 3.5v3M4 10h16"/><path d="M12 17.6s-3-1.7-3-3.9a1.7 1.7 0 0 1 3-1.1 1.7 1.7 0 0 1 3 1.1c0 2.2-3 3.9-3 3.9Z"/>`,
    me: `<circle cx="12" cy="8.6" r="3.6"/><path d="M5 20c.7-3.7 3.6-5.6 7-5.6s6.3 1.9 7 5.6"/>`,
  };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || ''}</svg>`;
}

export function bellIcon(size = 20) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M18 9a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6"/><path d="M10.3 19a2 2 0 0 0 3.4 0"/>
  </svg>`;
}

// 工具栏图标（右侧悬浮操作）
export function toolIcon(name) {
  const paths = {
    write: `<path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3Z"/><path d="M13.5 6.5l3 3"/>`,
    box: `<path d="M4 7.5 12 4l8 3.5v9L12 20l-8-3.5v-9Z"/><path d="M4 7.5 12 11l8-3.5M12 11v9"/>`,
    invite: `<path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5v-11Z"/><path d="m5 7 7 5.5L19 7"/>`,
    plus: `<path d="M12 5v14M5 12h14"/>`,
  };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || ''}</svg>`;
}
