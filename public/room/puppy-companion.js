import * as THREE from 'three';
import { loadPuppyScene, preparePuppyMaterials } from '../puppy/puppy3d.js';

const TAU = Math.PI * 2;
const clamp = THREE.MathUtils.clamp;
const BREEDS = { shiba: '柴犬', husky: '哈士奇', pug: '巴哥' };
// 同一只小狗按品种做轻微调色：奶白 / 冷雾灰 / 可可暖棕，保持家具奶油色调和谐。
const TINT = { shiba: 0xffffff, husky: 0xdde7f3, pug: 0xf3dcc0 };
// 与 2D 伙伴一致的视觉高度（配合 room.js 的出生点缩放 ~0.78）。
const TARGET_HEIGHT = 1.32;

const DEFINITIONS = [
  ['01_idle', '待机呼吸', 3.6, true],
  ['02_blink', '眨眨眼', 2.6, false],
  ['03_tail_wag', '摇尾巴', 2.8, false],
  ['04_walk', '小步走', 2.8, true],
  ['05_run', '开心跑', 2.4, true],
  ['06_jump', '跳一跳', 2.8, false],
  ['07_sit', '乖乖坐', 3.2, false],
  ['08_lie_down', '趴下来', 3.6, false],
  ['09_sleep', '打瞌睡', 4, false],
  ['10_stretch', '伸懒腰', 3.6, false],
  ['11_paw_wave', '挥挥爪', 3.2, false],
  ['12_happy', '开心转圈', 3.2, false],
  ['13_tilt_left', '向左歪头', 3, false],
  ['14_tilt_right', '向右歪头', 3, false],
  ['15_nod', '点点头', 2.8, false],
  ['16_look_around', '好奇张望', 3.6, false],
];

function neutral() {
  // 全部通道使用米 / 弧度；squash 为负是压扁、正是拉伸。
  return { bob: 0, squash: 0, pitch: 0, roll: 0, yaw: 0, hop: 0, breath: 0, spin: 0 };
}

function smooth(value) { const t = clamp(value, 0, 1); return t * t * (3 - 2 * t); }
function envelope(t, edge = .2) { return smooth(t / edge) * smooth((1 - t) / edge); }
function pulse(t, center, width) {
  const distance = Math.abs(t - center) / width;
  return distance >= 1 ? 0 : (1 + Math.cos(Math.PI * distance)) / 2;
}

/** 整体挤压伸展（squash & stretch）风格的动作采样：一条狗的身体做可爱风格化表演。 */
function samplePose(name, time, duration) {
  const pose = neutral();
  const t = clamp(time / duration, 0, 1);
  if (t <= 0 || t >= 1) return pose;
  const e = envelope(t), s = Math.sin(TAU * t);
  switch (name) {
    case '01_idle':
      pose.breath = .009 * s;
      pose.yaw = .035 * Math.sin(TAU * t / 2);
      break;
    case '02_blink':
      pose.bob = -.006 * Math.max(pulse(t, .3, .06), pulse(t, .66, .07));
      break;
    case '03_tail_wag':
      pose.roll = .038 * Math.sin(TAU * t * 5) * e;
      pose.yaw = .05 * Math.sin(TAU * t * 5) * e;
      pose.breath = .006 * s * e;
      break;
    case '04_walk':
      pose.bob = .014 * Math.abs(Math.sin(TAU * t * 2));
      pose.pitch = .018 + .012 * Math.sin(TAU * t * 4);
      pose.roll = .016 * Math.sin(TAU * t * 2);
      break;
    case '05_run':
      pose.bob = .026 * Math.abs(Math.sin(TAU * t * 3));
      pose.pitch = .05 + .02 * Math.sin(TAU * t * 6);
      pose.roll = .03 * Math.sin(TAU * t * 3);
      break;
    case '06_jump': {
      const flight = t > .3 && t < .72 ? Math.sin(Math.PI * (t - .3) / .42) : 0;
      pose.hop = .17 * flight;
      pose.squash = -.055 * pulse(t, .16, .12) - .05 * pulse(t, .82, .1) + .035 * flight;
      pose.pitch = -.05 * flight;
      break;
    }
    case '07_sit':
      pose.squash = -.09 * e;
      pose.pitch = -.045 * e;
      pose.bob = -.008 * e;
      pose.breath = .008 * s * e;
      break;
    case '08_lie_down':
      pose.squash = -.2 * e;
      pose.pitch = .055 * e;
      pose.bob = -.045 * e;
      break;
    case '09_sleep':
      pose.squash = -.2 * e;
      pose.pitch = .05 * e;
      pose.bob = -.045 * e;
      pose.breath = .012 * Math.sin(TAU * t * 2) * e;
      pose.roll = .012 * s * e;
      break;
    case '10_stretch':
      pose.pitch = .1 * Math.sin(Math.PI * Math.min(1, t / .7));
      pose.squash = .03 * Math.sin(Math.PI * Math.min(1, t / .7));
      pose.bob = -.006 * e;
      break;
    case '11_paw_wave':
      pose.roll = .06 * Math.sin(TAU * t * 3) * e;
      pose.yaw = .05 * Math.sin(TAU * t * 3 + .6) * e;
      pose.bob = .006 * Math.abs(Math.sin(TAU * t * 3)) * e;
      break;
    case '12_happy':
      pose.spin = TAU * smooth(t);
      pose.hop = .05 * Math.abs(Math.sin(TAU * t * 3)) * e;
      pose.squash = .02 * Math.sin(TAU * t * 6) * e;
      break;
    case '13_tilt_left':
      pose.roll = -.16 * e;
      pose.yaw = -.06 * e;
      break;
    case '14_tilt_right':
      pose.roll = .16 * e;
      pose.yaw = .06 * e;
      break;
    case '15_nod':
      pose.pitch = .09 * Math.sin(TAU * t * 2) * e;
      break;
    case '16_look_around':
      pose.yaw = .3 * Math.sin(TAU * t) * e;
      pose.roll = .03 * Math.sin(TAU * t + .8) * e;
      break;
  }
  return pose;
}

function blendPose(from, to, amount) {
  const result = {};
  for (const key of Object.keys(to)) result[key] = from[key] + (to[key] - from[key]) * amount;
  return result;
}

class PuppyAction {
  constructor(animator, clip) {
    this.animator = animator;
    this.clip = clip;
    this.name = clip.name;
    this.duration = clip.duration;
    this.time = 0;
    this.timeScale = 1;
    this.enabled = true;
    this.paused = false;
    this.clampWhenFinished = false;
    this.loop = THREE.LoopRepeat;
    this.repetitions = Infinity;
    this._weight = 1;
    this._playing = false;
    this._ended = false;
    this._cycles = 0;
  }
  getClip() { return this.clip; }
  setEffectiveTimeScale(value) { this.timeScale = Number.isFinite(value) ? Math.max(0, value) : 1; this.paused = false; return this; }
  setEffectiveWeight(value) { this._weight = clamp(Number.isFinite(value) ? value : 1, 0, 1); return this; }
  getEffectiveWeight() {
    if (!this.enabled) return 0;
    const transition = this.animator._transition;
    if (transition?.to === this) return this._weight * smooth((this.animator.time - transition.start) / transition.duration);
    if (transition?.from === this) return this._weight * (1 - smooth((this.animator.time - transition.start) / transition.duration));
    return this._weight;
  }
  reset() { this.time = 0; this._cycles = 0; this._ended = false; this.enabled = true; this.paused = false; return this; }
  stopFading() {
    if (this.animator._transition?.to === this || this.animator._transition?.from === this) this.animator._transition = null;
    return this;
  }
  setLoop(mode, count = Infinity) { this.loop = mode; this.repetitions = count === Infinity ? Infinity : Math.max(1, Math.floor(count)); return this; }
  play() { this._playing = true; this.enabled = true; this.animator._active = this; return this; }
  stop() {
    this._playing = false;
    this.time = 0;
    this._cycles = 0;
    this._ended = false;
    if (this.animator._active === this) this.animator._active = null;
    return this;
  }
  isRunning() { return this._playing && this.enabled && !this.paused && !this._ended && this.timeScale > 0; }
  crossFadeFrom(previous, duration = .18) {
    if (previous !== this && duration > 0) {
      this.animator._transition = { from: previous, to: this, start: this.animator.time, duration, pose: { ...this.animator.pose } };
    }
    return this;
  }
  _advance(delta) {
    if (!this.isRunning() || delta <= 0) return false;
    this.time += delta * this.timeScale;
    if (this.time < this.duration) return false;
    const cycles = Math.floor((this.time + 1e-10) / this.duration);
    if (this.loop !== THREE.LoopOnce && this._cycles + cycles < this.repetitions) {
      this._cycles += cycles;
      this.time %= this.duration;
      return false;
    }
    this.time = this.duration;
    this._ended = true;
    this._playing = false;
    this.paused = this.clampWhenFinished;
    return true;
  }
}

export class PuppyAnimator extends THREE.EventDispatcher {
  constructor(breed, clips, rig) {
    super();
    this.breed = breed;
    this.clips = clips;
    this.rig = rig;
    this.time = 0;
    this.timeScale = 1;
    this.frame = 0;
    this.facing = 1;
    this.pose = neutral();
    this._actions = new Map();
    this._active = null;
    this._transition = null;
  }
  clipAction(clip) {
    const known = this.clips.find((item) => item.name === (typeof clip === 'string' ? clip : clip?.name));
    if (!known) throw new Error('未找到这个小狗动作。');
    if (!this._actions.has(known.name)) this._actions.set(known.name, new PuppyAction(this, known));
    return this._actions.get(known.name);
  }
  update(delta = 0) {
    const elapsed = Math.max(0, Number.isFinite(delta) ? delta : 0) * Math.max(0, this.timeScale);
    this.time += elapsed;
    const finished = [];
    for (const action of this._actions.values()) if (action._advance(elapsed)) finished.push(action);
    const action = this._active;
    let pose = action ? samplePose(action.name, action.time, action.duration) : neutral();
    if (action && action._weight < 1) pose = blendPose(neutral(), pose, action._weight);
    if (this._transition && this._transition.to === action) {
      const progress = clamp((this.time - this._transition.start) / this._transition.duration, 0, 1);
      pose = blendPose(this._transition.pose, pose, smooth(progress));
      if (progress >= 1) this._transition = null;
    }
    this.pose = pose;
    this._apply();
    for (const ended of finished) this.dispatchEvent({ type: 'finished', action: ended, direction: 1 });
    return this;
  }
  _apply() {
    const { rig, pose } = this;
    // 挤压围绕脚底（rig 原点在地面），纵向缩放的同时横向反向补偿，保持体积感。
    const sy = 1 + pose.squash + pose.breath;
    const sxz = 1 - (pose.squash + pose.breath) * .55;
    rig.scale.set(sxz, sy, sxz);
    rig.position.y = pose.bob + pose.hop;
    rig.rotation.set(pose.pitch, pose.yaw + pose.spin, pose.roll + this.facing * .012);
    this.frame++;
  }
  setFacing(value) {
    const facing = value < 0 ? -1 : 1;
    if (this.facing === facing) return;
    this.facing = facing;
    this._apply();
  }
  stopAllAction() {
    for (const action of this._actions.values()) action.stop();
    this._active = null;
    this._transition = null;
    return this;
  }
  uncacheRoot() { this.stopAllAction(); this._actions.clear(); }
  snapshot() {
    return { style: '3d', breed: this.breed, pose: { ...this.pose }, frame: this.frame,
      activeAction: this._active?.name || null, actionTime: this._active?.time || 0,
      duration: this._active?.duration || 0, facing: this.facing, time: this.time };
  }
}

/** 首页客厅的 3D 小狗：与 createDog2D 同构的视觉对象，供 room.js 直接替换使用。 */
export async function createPuppy3D(breed) {
  if (!BREEDS[breed]) throw new Error(`不支持的小狗类型：${breed}`);
  const scene = await loadPuppyScene();
  preparePuppyMaterials(scene);
  const tint = TINT[breed];
  if (tint !== 0xffffff) {
    scene.traverse((o) => {
      if (o.isMesh && o.material?.isMeshStandardMaterial) {
        o.material = o.material.clone();
        o.material.color.set(tint);
      }
    });
  }
  const box = new THREE.Box3().setFromObject(scene);
  const height = Math.max(1e-6, box.max.y - box.min.y);
  const inner = new THREE.Group();
  inner.name = `PuppyInner_${breed}`;
  inner.scale.setScalar(TARGET_HEIGHT / height);
  inner.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
  inner.add(scene);
  const rig = new THREE.Group();
  rig.name = `PuppyRig_${breed}`;
  rig.add(inner);
  const model = new THREE.Group();
  model.name = `Companion3D_${breed}`;
  model.userData.style = '3d';
  model.add(rig);
  const clips = DEFINITIONS.map(([name, , duration]) => Object.freeze({ name, duration }));
  const meta = { breed, label: BREEDS[breed], style: '3d', clips: DEFINITIONS.map(([id, label, duration_seconds, loop]) => ({
    id, label, duration_seconds, loop, origin: 'puppy_glb_procedural_rigid',
  })) };
  const animator = new PuppyAnimator(breed, clips, rig);
  animator.clipAction(clips[0]).play();
  animator.update(0);
  return { model, animator, clips, meta, rig,
    snapshot: () => animator.snapshot(), setFacing: (value) => animator.setFacing(value) };
}
