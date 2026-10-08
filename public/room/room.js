import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { planPath, segmentIsWalkable } from './navigation.js';
import { createDog2D } from './dog2d.js';

const BASE = '/assets/models/';
const BREEDS = ['shiba', 'husky', 'pug'];
const NAMES = { shiba: '柴犬', husky: '哈士奇', pug: '巴哥' };
const APPEARANCE = { cream: 'shiba', caramel: 'husky', cocoa: 'pug' };
const INK = 0x796451;
const clamp = THREE.MathUtils.clamp;
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const point = o => ({ x: o.position.x, z: o.position.z });
const json = async url => { const r = await fetch(url); if (!r.ok) throw new Error('素材加载失败'); return r.json(); };

/** Realtime homepage room. All commands are local; business callbacks keep existing API permissions. */
export async function mountRoom(host, options = {}) {
  let disposed = false, ready = false, frameId = 0, previous = 0, frames = 0;
  let selected = APPEARANCE[options.pet?.appearanceKey] || 'shiba', closeView = false;
  const events = [], dogs = new Map(), abort = new AbortController(), ownedTrees = new Set();
  const reduced = !!options.reduceMotion || matchMedia('(prefers-reduced-motion: reduce)').matches;
  host.innerHTML = `
    <div class="room-viewport" data-room-viewport>
      <div class="room-canvas"></div><div class="room-memory-layer"></div>
      <div class="room-loading" role="status"><span class="room-loading-dot"></span>小伙伴正在回家…</div>
      <div class="room-scene-label"><span></span> OUR LITTLE HOME</div>
      <button type="button" class="room-focus" aria-label="近看选中的小狗" aria-pressed="false">近看小狗</button>
      <button type="button" class="room-reset-view" aria-label="恢复房间视角" title="恢复视角">⌖</button>
      <div class="room-bubble" hidden></div>
    </div>
    <div class="room-companion-dock">
      <div class="room-dock-heading"><span class="room-eyebrow">一点陪伴，一点日常</span><span class="room-live-dot">在家</span></div>
      <div class="room-dog-choices" role="group" aria-label="选择小伙伴">
        ${BREEDS.map(b => `<button type="button" data-dog="${b}" aria-pressed="false"><img src="/assets/dogs/${b}.png" alt=""><span>${NAMES[b]}</span></button>`).join('')}
      </div>
      <div class="room-status-row"><p class="room-status" role="status" aria-live="polite">正在整理小屋…</p><button type="button" class="room-stop" data-command="stop" disabled>停下</button></div>
      <progress class="room-progress" max="1" value="0" aria-label="当前动作或路线进度"></progress>
      <div class="room-primary-actions" role="group" aria-label="和小狗互动">
        <button type="button" data-command="pat" disabled>摸摸头 <span>♡</span></button>
        <button type="button" data-command="tilt_left" disabled>歪歪头</button>
        <button type="button" data-command="roam" disabled>在家走走 <span>↗</span></button>
      </div>
      <p class="room-help">点小狗和它打招呼 · 点地面让它走过去</p>
      <div class="room-context"></div>
      <details class="room-more"><summary>更多小动作 <span>16</span></summary><div class="room-action-grid" role="group" aria-label="完整动作"></div></details>
      <p class="room-motion-note" ${reduced ? '' : 'hidden'}>已减少自动动画，点选的动作和行走仍会完整播放。</p>
    </div>`;
  const $ = s => host.querySelector(s);
  const canvasHost = $('.room-canvas'), viewport = $('.room-viewport');
  const status = $('.room-status'), progress = $('.room-progress'), bubble = $('.room-bubble');
  const on = (element, type, fn) => element.addEventListener(type, fn, { signal: abort.signal });
  const log = (type, d, extra = {}) => { events.push({ type, dog: d?.id, at: performance.now(), ...extra }); if (events.length > 120) events.shift(); };
  let bubbleUntil = 0;
  const say = (text, seconds = 4) => { if (disposed) return; bubble.textContent = text; bubble.hidden = false; bubbleUntil = performance.now() + seconds * 1000; };
  const announce = text => { if (!disposed) status.textContent = text; };
  const scene = new THREE.Scene(); scene.background = new THREE.Color('#f7f1e8');
  const camera = new THREE.OrthographicCamera(-5, 5, 5, -5, .1, 80);
  let renderer, observer, layout, room, routeLine, goalMarker;
  const memoryPins = [];
  const controller = {
    selectDog: id => select(id),
    playAction: id => { const d = dogs.get(selected); if (d) request(d, { type: 'action', clip: id }); },
    moveTo: target => { const d = dogs.get(selected); return d ? request(d, { type: 'move', target }) : false; },
    stop: () => { const d = dogs.get(selected); if (d) stop(d); },
    snapshot: () => ({ ready, disposed, selected, frames, reducedMotion: reduced,
      drawCalls: renderer?.info.render.calls, triangles: renderer?.info.render.triangles,
      events: events.slice(), dogs: [...dogs.values()].map(d => ({ id: d.id, position: point(d.wrapper), mode: d.mode,
        clip: d.current?.getClip().name, clipTime: d.current?.time, duration: d.current?.getClip().duration,
        path: d.path?.map(p => ({ ...p })) || [], goal: d.goal, queued: d.pending?.type || null, completed: d.completed,
        weight: d.current?.getEffectiveWeight(), visible: d.wrapper.visible, renderStyle: '2d', animation: d.visual.snapshot() })) }),
    project: (p) => project(p),
    projectDog: id => { const d = dogs.get(id); if (!d) return null; return project({ x: d.wrapper.position.x, y: d.wrapper.position.y + .42, z: d.wrapper.position.z }); },
    dispose,
  };
  host.roomController = controller;

  function disposeTree(tree) {
    const geometries = new Set(), materials = new Set(), textures = new Set();
    tree.traverse(o => { if (o.geometry) geometries.add(o.geometry); for (const m of (Array.isArray(o.material) ? o.material : [o.material])) if (m) materials.add(m); if (o.isSkinnedMesh) o.skeleton.dispose(); });
    for (const m of materials) { for (const v of Object.values(m)) if (v?.isTexture) textures.add(v); m.dispose(); }
    for (const t of textures) { t.source?.data?.close?.(); t.dispose(); }
    geometries.forEach(g => g.dispose());
  }
  function dispose() {
    if (disposed) return;
    disposed = true; ready = false; cancelAnimationFrame(frameId); abort.abort(); observer?.disconnect();
    for (const d of dogs.values()) { d.mixer.stopAllAction(); d.mixer.uncacheRoot(d.model); }
    disposeTree(scene);
    for (const tree of ownedTrees) if (!tree.parent) disposeTree(tree);
    ownedTrees.clear(); renderer?.dispose(); renderer?.forceContextLoss();
    if (host.roomController === controller) delete host.roomController;
  }
  const ensureConnected = () => { if (disposed || !host.isConnected || host.roomController !== controller) { dispose(); return false; } return true; };
  function showFallback(message) {
    const ownsHost = host.roomController === controller;
    dispose();
    if (!ownsHost || !host.isConnected) return;
    canvasHost.replaceChildren(); const poster = document.createElement('img'); poster.src = BASE + 'room-fallback.png'; poster.alt = '小屋静态预览'; canvasHost.appendChild(poster);
    $('.room-loading')?.remove(); status.textContent = message;
    $('.room-context').replaceChildren();
    const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'room-retry'; retry.textContent = '重新加载'; retry.onclick = () => mountRoom(host, options); $('.room-context').appendChild(retry);
    $('.room-help').textContent = '可重新加载场景，其他回忆功能仍可使用。';
    host.querySelectorAll('[data-dog],[data-command],[data-clip]').forEach(b => b.disabled = true);
  }

  function heightAt(p) {
    const ground = layout.ground, r = ground.rug;
    if (!r) return ground.floorY + .003;
    const rho = Math.sqrt(((p.x - r.cx) / r.rx) ** 2 + ((p.z - r.cz) / r.rz) ** 2);
    const t = THREE.MathUtils.smoothstep(1 - rho, -.025, .045);
    return THREE.MathUtils.lerp(ground.floorY, r.heightY, t) + (ground.footClearance ?? .003);
  }
  function world(d, dynamic = true) {
    return { bounds: layout.bounds, obstacles: layout.obstacles, agentRadius: layout.agentRadius,
      cellSize: .09, agentId: d.id, dogs: dynamic ? [...dogs.values()].filter(o => o.wrapper.visible).map(other => ({ id: other.id, ...point(other.wrapper), radius: layout.agentRadius })) : [] };
  }
  function actionFor(d, suffix) { return d.meta.clips.find(c => c.id === suffix || c.id.endsWith('_' + suffix)); }
  function switchAction(d, id, once = false) {
    const next = d.actions.get(id); if (!next) return false;
    const old = d.current;
    if (old === next && !once && old.isRunning()) return true;
    next.stopFading().reset().setEffectiveTimeScale(1).setEffectiveWeight(1);
    next.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, once ? 1 : Infinity);
    next.clampWhenFinished = once; next.play();
    if (old && old !== next) { next.crossFadeFrom(old, .18, false); d.fades.push({ action: old, after: d.mixer.time + .20 }); }
    d.current = next; return true;
  }
  function idle(d) { d.mode = 'idle'; switchAction(d, actionFor(d, 'idle').id); }
  function finish(d) {
    const pending = d.pending; d.pending = null;
    idle(d);
    if (pending) request(d, pending);
    else if (d.id === selected) announce(`${d.name}在陪着你。`);
  }
  function perform(d, command) {
    const clip = actionFor(d, command.clip); if (!clip) return false;
    d.mode = 'acting'; d.path = []; d.goal = null; d.pending = null;
    switchAction(d, clip.id, true); log('action_start', d, { clip: clip.id, duration: d.current.getClip().duration });
    if (d.id === selected) { announce(`${d.name} · ${clip.label}`); drawRoute(d); }
    return true;
  }
  function describeFailure(result) {
    if (result.blockedBy?.kind === 'dog') return '另一位小伙伴在这里，换个位置试试。';
    if (result.reason.includes('outside') || result.reason.includes('boundary')) return '点小屋里面的空地，它才能走过去。';
    return '这里被家具挡住了，试试客厅前面的空地。';
  }
  function startMove(d, target, tour = []) {
    const result = planPath(point(d.wrapper), target, world(d));
    if (!result.ok) { log('path_rejected', d, { target, reason: result.reason }); announce(describeFailure(result)); say(describeFailure(result)); return false; }
    if (result.distance < .02 || result.path.length < 2) {
      d.path = []; d.goal = null; d.tour = []; d.pending = null; idle(d); drawRoute(d);
      announce(`${d.name}已经到这里啦。`); log('arrived', d, { goal: target, position: point(d.wrapper) }); return true;
    }
    d.path = result.path; d.pathIndex = 1; d.goal = { ...target }; d.totalDistance = result.distance;
    d.travelled = 0; d.tour = tour; d.blockedFor = 0; d.lastReplan = -10; d.mode = 'walking';
    switchAction(d, actionFor(d, 'walk').id); log('path_start', d, { path: result.path, distance: result.distance });
    if (d.id === selected) { announce(`${d.name}正在走过去…`); drawRoute(d); }
    return true;
  }
  function request(d, command) {
    if (!ready || disposed) return false;
    if (command.type === 'move') {
      const check = planPath(point(d.wrapper), command.target, world(d));
      if (!check.ok) { const message = describeFailure(check); announce(message); say(message); log('path_rejected', d, { target: command.target, reason: check.reason }); return false; }
    }
    if (d.mode === 'acting') {
      d.pending = command;
      announce(`${d.name}做完这个动作就${command.type === 'move' ? '走过去' : '做下一个动作'}。`);
      log('command_queued', d, { command: command.type }); return true;
    }
    d.tour = [];
    return command.type === 'action' ? perform(d, command) : startMove(d, command.target, command.tour);
  }
  function stop(d) {
    d.pending = null; d.tour = []; d.path = []; d.goal = null;
    idle(d); log('user_stop', d); drawRoute(d); announce(`${d.name}停下来陪你了。`);
  }
  function select(id) {
    if (!dogs.has(id)) return;
    selected = id; const d = dogs.get(id);
    // Only the chosen companion stays in the room; the others rest out of sight and never block paths.
    for (const other of dogs.values()) {
      if (other.id === id) { other.wrapper.visible = true; continue; }
      if (other.wrapper.visible) { other.pending = null; other.tour = []; other.path = []; other.goal = null; other.mode = 'idle'; other.wrapper.visible = false; }
    }
    for (const button of host.querySelectorAll('[data-dog]')) button.setAttribute('aria-pressed', String(button.dataset.dog === id));
    const grid = $('.room-action-grid'); grid.replaceChildren();
    for (const c of d.meta.clips) { const b = document.createElement('button'); b.type = 'button'; b.dataset.clip = c.id; b.textContent = c.label; b.title = `${c.label} · 完整播放 ${c.duration_seconds.toFixed(1)} 秒`; grid.appendChild(b); }
    announce(d.mode === 'walking' ? `${d.name}正在走过去…` : d.mode === 'acting' ? `${d.name} · ${actionFor(d, d.current.getClip().name)?.label || '正在活动'}` : `${d.name}在陪着你。`);
    drawRoute(d); log('select', d);
  }
  function drawRoute(d) {
    if (!routeLine || !goalMarker) return;
    routeLine.geometry.dispose();
    const path = d.mode === 'walking' ? [point(d.wrapper), ...d.path.slice(d.pathIndex)] : [];
    routeLine.geometry = new THREE.BufferGeometry().setFromPoints(path.map(p => new THREE.Vector3(p.x, heightAt(p) + .018, p.z)));
    routeLine.visible = path.length > 1; goalMarker.visible = path.length > 1;
    if (d.goal && path.length > 1) goalMarker.position.set(d.goal.x, heightAt(d.goal) + .023, d.goal.z);
    for (const dog of dogs.values()) dog.halo.visible = dog.id === selected;
  }
  function project(p) {
    const v = new THREE.Vector3(p.x, p.y ?? .1, p.z).project(camera), r = canvasHost.getBoundingClientRect();
    return { x: r.left + (v.x + 1) * r.width / 2, y: r.top + (1 - v.y) * r.height / 2, visible: v.z > -1 && v.z < 1 && Math.abs(v.x) < .94 && Math.abs(v.y) < .94 };
  }
  function resize() {
    if (!renderer || disposed) return;
    const w = Math.max(1, canvasHost.clientWidth), h = Math.max(1, canvasHost.clientHeight), aspect = w / h;
    renderer.setSize(w, h, false);
    // Fit the complete room footprint and walls with a little breathing space.
    const height = Math.max(7.5, 8.15 / aspect);
    camera.left = -height * aspect / 2; camera.right = height * aspect / 2; camera.top = height / 2; camera.bottom = -height / 2; camera.updateProjectionMatrix();
    updatePins();
  }
  function updatePins() {
    const rect = canvasHost.getBoundingClientRect();
    const occupied = [];
    for (const pin of memoryPins) {
      const p = project(pin.position); pin.el.hidden = !p.visible;
      if (!p.visible) continue;
      const origin = { x: clamp(p.x - rect.left + (pin.offsetX || 0), 22, rect.width - 22), y: clamp(p.y - rect.top, 32, rect.height - 20) };
      const candidates = [origin];
      for (let ring = 1; ring <= 4; ring++) for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const candidate = { x: origin.x + dx * 42 * ring, y: origin.y + dy * 42 * ring };
        if (candidate.x >= 22 && candidate.x <= rect.width - 22 && candidate.y >= 32 && candidate.y <= rect.height - 20) candidates.push(candidate);
      }
      const chosen = candidates.find(c => occupied.every(o => Math.hypot(o.x - c.x, o.y - c.y) >= 42)) || origin;
      occupied.push(chosen); pin.el.style.left = `${chosen.x}px`; pin.el.style.top = `${chosen.y}px`;
    }
  }
  function roam(d) {
    const goals = (layout.waypoints || []).filter(p => distance(point(d.wrapper), p) > .6 && planPath(point(d.wrapper), p, world(d)).ok);
    if (!goals.length) { say('伙伴们挡住了路，先点一处近一点的空地吧。'); return; }
    const start = point(d.wrapper), next = goals.sort((a, b) => distance(start, b) - distance(start, a))[0];
    request(d, { type: 'move', target: { x: next.x, z: next.z }, tour: [start] });
  }
  function updateDog(d, dt) {
    // Reduced motion stops ambient idling; requested actions still run at real duration.
    if (!reduced || d.mode !== 'idle' || d.fades.length) d.mixer.update(dt);
    d.fades = d.fades.filter(f => { if (d.mixer.time >= f.after) { if (f.action !== d.current) f.action.stop(); return false; } return true; });
    if (d.mode === 'walking') {
      const current = point(d.wrapper), target = d.path[d.pathIndex];
      if (!target) { d.path = []; d.goal = null; finish(d); if (d.id === selected) drawRoute(d); return; }
      const len = distance(current, target), direction = Math.atan2(target.x - current.x, target.z - current.z);
      if (Math.abs(target.x - current.x) > .015) d.visual.setFacing(target.x >= current.x ? 1 : -1);
      const angleDelta = Math.atan2(Math.sin(direction - d.wrapper.rotation.y), Math.cos(direction - d.wrapper.rotation.y));
      d.wrapper.rotation.y += clamp(angleDelta, -dt * 5.5, dt * 5.5);
      // Turn before advancing to avoid side-sliding into corners.
      const speed = Math.abs(angleDelta) > .7 ? .04 : .62;
      const step = Math.min(len, speed * dt);
      const next = len > 1e-6 ? { x: current.x + (target.x - current.x) / len * step, z: current.z + (target.z - current.z) / len * step } : current;
      if (segmentIsWalkable(current, next, world(d))) {
        d.wrapper.position.set(next.x, heightAt(next), next.z); d.travelled += step; d.blockedFor = 0;
        if (len <= .02 || step >= len) {
          // Never snap through the final centimeters: the same continuous check applies.
          if (segmentIsWalkable(next, target, world(d))) d.wrapper.position.set(target.x, heightAt(target), target.z);
          d.pathIndex++;
          if (d.pathIndex >= d.path.length) {
            log('arrived', d, { goal: d.goal, position: point(d.wrapper) });
            const nextGoal = d.tour?.shift();
            d.path = []; d.goal = null;
            if (nextGoal && startMove(d, nextGoal, d.tour)) return;
            d.completed++; finish(d);
          }
        }
      } else {
        d.blockedFor += dt;
        if (d.mixer.time - d.lastReplan > .6) {
          d.lastReplan = d.mixer.time;
          const replanned = planPath(current, d.goal, world(d));
          if (replanned.ok) { d.path = replanned.path; d.pathIndex = 1; log('path_replanned', d); }
        }
        if (d.blockedFor > 2.5) { stop(d); say('先让这位小伙伴过去，再点一次目的地吧。'); }
      }
      if (d.id === selected) drawRoute(d);
    }
    d.halo.position.y = .01;
  }
  function tick(now) {
    if (disposed || !ensureConnected()) return;
    frameId = requestAnimationFrame(tick);
    if (document.hidden) { previous = now; return; }
    const dt = Math.min((now - (previous || now)) / 1000, .075); previous = now;
    for (const d of dogs.values()) if (d.wrapper.visible) updateDog(d, dt);
    const d = dogs.get(selected);
    if (d) {
      progress.value = d.mode === 'acting' ? clamp(d.current.time / Math.max(.01, d.current.getClip().duration), 0, 1)
        : d.mode === 'walking' ? clamp(d.travelled / Math.max(.01, d.totalDistance), 0, 1) : 0;
      progress.dataset.busy = String(d.mode !== 'idle');
      $('.room-stop').disabled = d.mode === 'idle';
      if (!bubble.hidden) {
        if (now > bubbleUntil) bubble.hidden = true;
        else { const p = project({ ...point(d.wrapper), y: d.wrapper.position.y + 1.05 }); const r = viewport.getBoundingClientRect(); bubble.style.left = `${clamp(p.x - r.left, 80, r.width - 80)}px`; bubble.style.top = `${Math.max(36, p.y - r.top)}px`; }
      }
    }
    if (closeView && d) {
      const target = new THREE.Vector3(d.wrapper.position.x, .5, d.wrapper.position.z);
      camera.position.copy(target).add(new THREE.Vector3(8, 6.84, 12.1)); camera.lookAt(target);
      updatePins();
    }
    renderer.render(scene, camera); frames++;
  }

  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.7)); renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.2;
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.domElement.setAttribute('aria-label', '可互动的小屋：点选小狗，再点地面移动。下方也有动作按钮。');
    renderer.domElement.setAttribute('role', 'img'); canvasHost.appendChild(renderer.domElement);
    on(renderer.domElement, 'webglcontextlost', event => { event.preventDefault(); showFallback('画面暂时中断，重新加载就能回家。'); });
    const loader = new GLTFLoader();
    const loadModel = async file => { const data = await loader.loadAsync(BASE + file); if (disposed) disposeTree(data.scene); else ownedTrees.add(data.scene); return data; };
    const [layoutData, roomData] = await Promise.all([json(BASE + 'room-layout.json'), loadModel('home-room.glb')]);
    const dogData = BREEDS.map(id => ({ id, visual: createDog2D(id) }));
    for (const d of dogData) ownedTrees.add(d.visual.model);
    if (!ensureConnected()) return controller;
    layout = layoutData; room = roomData.scene; scene.add(room);
    room.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    scene.add(new THREE.HemisphereLight(0xfff7e7, 0xb4a593, 2.2));
    const sunlight = new THREE.DirectionalLight(0xffefda, 3.2); sunlight.position.set(-3, 8, 5); sunlight.castShadow = true;
    sunlight.shadow.mapSize.set(2048, 2048); Object.assign(sunlight.shadow.camera, { left: -5, right: 5, top: 5, bottom: -5, near: .5, far: 20 }); sunlight.shadow.normalBias = .018; sunlight.shadow.bias = -.00015; scene.add(sunlight);
    sunlight.shadow.radius = 3;
    const fill = new THREE.DirectionalLight(0xeaf1ff, 1.3); fill.position.set(4, 5, -3); scene.add(fill);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(100, 100), new THREE.MeshStandardMaterial({ color: 0xf7f1e8, roughness: 1 })); floor.rotation.x = -Math.PI / 2; floor.position.y = -.35; floor.receiveShadow = true; scene.add(floor);
    camera.position.fromArray(layout.camera.position); camera.lookAt(...(layout.camera.target || [0, 1.16, -.1]));
    for (const data of dogData) {
      const wrapper = new THREE.Group(), model = data.visual.model, spawn = layout.spawns[data.id];
      wrapper.name = 'companion_' + data.id; wrapper.position.set(spawn.x, heightAt(spawn), spawn.z); wrapper.rotation.y = spawn.yaw ?? .35;
      model.scale.setScalar(spawn.scale ?? .8); wrapper.add(model); scene.add(wrapper);
      wrapper.visible = data.id === selected;
      model.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; } });
      const mixer = data.visual.animator, actions = new Map(data.visual.clips.map(c => [c.name, mixer.clipAction(c)]));
      const halo = new THREE.Mesh(new THREE.RingGeometry(.22, .255, 48), new THREE.MeshBasicMaterial({ color: 0xc89b66, transparent: true, opacity: .8, depthWrite: false, side: THREE.DoubleSide })); halo.rotation.x = -Math.PI / 2; wrapper.add(halo);
      const d = { id: data.id, name: selected === data.id ? options.pet?.name || NAMES[data.id] : NAMES[data.id], model, wrapper, mixer, actions, meta: data.visual.meta, visual: data.visual,
        halo, fades: [], mode: 'idle', path: [], pathIndex: 1, goal: null, pending: null, tour: [], completed: 0, current: null };
      mixer.addEventListener('finished', event => {
        if (disposed || d.mode !== 'acting' || event.action !== d.current) return;
        log('action_finished', d, { clip: event.action.getClip().name, time: event.action.time });
        d.completed++; finish(d);
      });
      dogs.set(d.id, d); idle(d); mixer.update(.001);
    }
    routeLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: INK, transparent: true, opacity: .65, dashSize: .08, gapSize: .05 })); routeLine.frustumCulled = false; scene.add(routeLine);
    // Solid line material avoids unstable dash attributes when the dynamic path is rebuilt.
    routeLine.material.dispose(); routeLine.material = new THREE.LineBasicMaterial({ color: INK, transparent: true, opacity: .52 });
    goalMarker = new THREE.Mesh(new THREE.RingGeometry(.105, .135, 40), new THREE.MeshBasicMaterial({ color: 0x9b614c, side: THREE.DoubleSide, depthWrite: false })); goalMarker.rotation.x = -Math.PI / 2; scene.add(goalMarker);
    const slotMap = { kitchen: 'shelf', sofa_side: 'wall', door: 'side_wall', corner: 'storage' };
    for (const object of options.objects || []) {
      const pos = layout.slots[slotMap[object.slotKey] || object.slotKey]; if (!pos || !object.memory?.id) continue;
      const button = document.createElement('button'); button.type = 'button'; button.className = 'room-memory-pin'; button.textContent = '✦';
      button.title = object.memory.title || '打开这段回忆'; button.setAttribute('aria-label', button.title);
      on(button, 'click', () => options.onMemoryOpen?.(object.memory.id)); $('.room-memory-layer').appendChild(button);
      memoryPins.push({ el: button, slot: object.slotKey, position: Array.isArray(pos) ? { x: pos[0], y: pos[1] + .08, z: pos[2] } : pos });
    }
    // A public memory and a private memory may legally share one room slot.
    for (const slot of new Set(memoryPins.map(p => p.slot))) {
      const group = memoryPins.filter(p => p.slot === slot);
      group.forEach((pin, i) => { pin.offsetX = (i - (group.length - 1) / 2) * 40; });
    }
    if (options.contextLabel && options.onContextAction) { const b = document.createElement('button'); b.type = 'button'; b.className = 'room-context-button'; b.textContent = options.contextLabel + ' →'; on(b, 'click', options.onContextAction); $('.room-context').appendChild(b); }
    on(host, 'click', async event => {
      const breedButton = event.target.closest('[data-dog]'); if (breedButton) { select(breedButton.dataset.dog); return; }
      const clipButton = event.target.closest('[data-clip]'); if (clipButton) { request(dogs.get(selected), { type: 'action', clip: clipButton.dataset.clip }); return; }
      const command = event.target.closest('[data-command]')?.dataset.command; if (!command || !ready) return;
      const d = dogs.get(selected);
      if (command === 'stop') stop(d);
      else if (command === 'roam') roam(d);
      else { request(d, { type: 'action', clip: command === 'pat' ? 'nod' : command });
        if (command === 'pat') { try { const reply = await options.onPetInteract?.('pat'); if (reply && selected === d.id) say(reply); } catch { say('它听到你啦。'); } }
      }
    });
    const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2();
    let pointerDown;
    on(renderer.domElement, 'pointerdown', e => { pointerDown = { x: e.clientX, y: e.clientY, id: e.pointerId }; });
    on(renderer.domElement, 'pointerup', e => {
      if (!pointerDown || pointerDown.id !== e.pointerId || Math.hypot(e.clientX - pointerDown.x, e.clientY - pointerDown.y) > 10) return;
      pointerDown = null; const r = renderer.domElement.getBoundingClientRect(); pointer.set((e.clientX - r.left) / r.width * 2 - 1, 1 - (e.clientY - r.top) / r.height * 2);
      scene.updateMatrixWorld(true); raycaster.setFromCamera(pointer, camera);
      const present = [...dogs.values()].filter(d => d.wrapper.visible);
      const hits = raycaster.intersectObjects([room, ...present.map(d => d.model)], true);
      if (hits.length) {
        const d = present.find(d => { let o = hits[0].object; while (o) { if (o === d.model) return true; o = o.parent; } return false; });
        if (d) { select(d.id); request(d, { type: 'action', clip: d.completed % 2 ? 'nod' : 'tilt_left' }); say(`${d.name}注意到你啦。`); log('dog_picked', d); return; }
      }
      const hit = hits[0]?.point;
      if (hit && hit.y < .14 && hit.y >= -.005) request(dogs.get(selected), { type: 'move', target: { x: hit.x, z: hit.z } });
      else { say('点客厅里的空地，它就会走过去。'); announce('家具上不能走，试试前面的空地。'); log('surface_rejected', dogs.get(selected)); }
    });
    const resetView = () => { closeView = false; camera.zoom = 1; camera.position.fromArray(layout.camera.position); camera.lookAt(...layout.camera.target); $('.room-focus').setAttribute('aria-pressed', 'false'); resize(); };
    on($('.room-reset-view'), 'click', resetView);
    on($('.room-focus'), 'click', () => { if (closeView) resetView(); else { closeView = true; camera.zoom = 4.4; camera.updateProjectionMatrix(); $('.room-focus').setAttribute('aria-pressed', 'true'); } });
    observer = new ResizeObserver(resize); observer.observe(canvasHost); resize();
    ready = true; $('.room-loading').remove(); host.dataset.roomReady = 'true';
    host.querySelectorAll('.room-primary-actions button').forEach(b => b.disabled = false);
    select(selected); frameId = requestAnimationFrame(tick); log('ready');
    return controller;
  } catch (error) {
    log('load_error', null, { message: error.message });
    if (!disposed) showFallback('互动场景加载失败，当前显示静态预览。');
    console.warn('Interactive room unavailable:', error.message);
    return controller;
  }
}
