import * as THREE from 'three';
import { drawDog } from './dog2d-art.js';

const TAU = Math.PI * 2;
const clamp = THREE.MathUtils.clamp;
const BREEDS = { shiba: '柴犬', husky: '哈士奇', pug: '巴哥' };
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
  ['12_happy', '开心比心', 3.2, false],
  ['13_tilt_left', '向左歪头', 3, false],
  ['14_tilt_right', '向右歪头', 3, false],
  ['15_nod', '点点头', 2.8, false],
  ['16_look_around', '好奇张望', 3.6, false],
];

function neutral(facing = 1) {
  return { bounce: 0, headY: 0, jump: 0, bodyTilt: 0, headTilt: 0, tailWag: 0,
    leftPaw: 0, rightPaw: 0, blink: 0, eyeSmile: 0, crouch: 0, lie: 0,
    sleep: 0, stretch: 0, heart: 0, sparkle: 0, mouthOpen: 0,
    legCycle: 0, lookX: 0, breath: 0, facing };
}

function smooth(value) { const t = clamp(value, 0, 1); return t * t * (3 - 2 * t); }
function envelope(t, edge = .2) { return smooth(t / edge) * smooth((1 - t) / edge); }
function pulse(t, center, width) {
  const distance = Math.abs(t - center) / width;
  return distance >= 1 ? 0 : (1 + Math.cos(Math.PI * distance)) / 2;
}

/** All offsets use the art's canonical 512 px space; positive Y lifts a part. */
function samplePose(name, time, duration, facing) {
  const pose = neutral(facing);
  const t = clamp(time / duration, 0, 1);
  if (t <= 0 || t >= 1) return pose;
  const e = envelope(t), s = Math.sin(TAU * t);
  switch (name) {
    case '01_idle':
      pose.breath = .018 * s;
      pose.headY = .8 * (1 - Math.cos(TAU * t));
      pose.headTilt = .015 * s;
      pose.tailWag = .05 * Math.sin(TAU * t * 2);
      pose.blink = pulse(t, .73, .025);
      break;
    case '02_blink':
      pose.blink = Math.max(pulse(t, .28, .07), pulse(t, .63, .085));
      pose.eyeSmile = .18 * e;
      pose.headTilt = .025 * s * e;
      pose.headY = -1.2 * pose.blink;
      break;
    case '03_tail_wag':
      pose.tailWag = .68 * Math.sin(TAU * t * 5) * e;
      pose.bodyTilt = .035 * Math.sin(TAU * t * 5) * e;
      pose.eyeSmile = .3 * e;
      pose.mouthOpen = .2 * e;
      break;
    case '04_walk':
      pose.legCycle = TAU * 4 * t;
      pose.bounce = 3 * (1 - Math.cos(pose.legCycle * 2)) / 2;
      pose.bodyTilt = .023 * Math.sin(pose.legCycle);
      pose.tailWag = .16 * Math.sin(pose.legCycle);
      pose.headTilt = -.017 * Math.sin(pose.legCycle);
      break;
    case '05_run':
      pose.legCycle = TAU * 6 * t;
      pose.bounce = 9 * (1 - Math.cos(pose.legCycle * 2)) / 2;
      pose.bodyTilt = .045 * Math.sin(pose.legCycle);
      pose.tailWag = .33 * Math.sin(pose.legCycle);
      pose.mouthOpen = .6 * e;
      pose.eyeSmile = .3 * e;
      pose.sparkle = .4 * e;
      break;
    case '06_jump': {
      const flight = t > .28 && t < .72 ? Math.sin(Math.PI * (t - .28) / .44) : 0;
      pose.jump = 36 * flight;
      pose.crouch = .55 * pulse(t, .18, .14) + .35 * pulse(t, .8, .12);
      pose.leftPaw = .28 * flight;
      pose.rightPaw = .28 * flight;
      pose.eyeSmile = .48 * e;
      pose.mouthOpen = .25 * flight;
      pose.sparkle = .75 * pulse(t, .53, .21);
      pose.tailWag = .18 * s * e;
      break;
    }
    case '07_sit':
      pose.crouch = e;
      pose.breath = .015 * s * e;
      pose.headTilt = -.07 * Math.sin(Math.PI * t) * e;
      pose.tailWag = .15 * Math.sin(TAU * t * 3) * e;
      pose.eyeSmile = .2 * e;
      break;
    case '08_lie_down':
      pose.lie = e;
      pose.headY = -6 * e;
      pose.eyeSmile = .35 * e;
      pose.tailWag = .12 * Math.sin(TAU * t * 3) * e;
      pose.breath = .01 * s * e;
      break;
    case '09_sleep':
      pose.lie = e;
      pose.sleep = smooth((t - .12) / .14) * smooth((.92 - t) / .14);
      pose.blink = pose.sleep;
      pose.headY = -4 * e;
      pose.breath = .025 * Math.sin(TAU * t * 2) * e;
      break;
    case '10_stretch':
      pose.stretch = e;
      pose.crouch = .16 * e;
      pose.headY = -4 * e;
      pose.leftPaw = .32 * e;
      pose.rightPaw = .32 * e;
      pose.eyeSmile = .65 * e;
      pose.tailWag = .14 * Math.sin(TAU * t * 2) * e;
      break;
    case '11_paw_wave':
      pose.rightPaw = (.85 + .24 * Math.sin(TAU * t * 3)) * e;
      pose.bodyTilt = .055 * e;
      pose.headTilt = -.08 * e;
      pose.eyeSmile = .3 * e;
      pose.tailWag = .24 * Math.sin(TAU * t * 3) * e;
      break;
    case '12_happy':
      pose.heart = e;
      pose.sparkle = .85 * e;
      pose.eyeSmile = .9 * e;
      pose.leftPaw = -.48 * e;
      pose.rightPaw = -.48 * e;
      pose.bounce = 4.5 * Math.abs(Math.sin(TAU * t * 2)) * e;
      pose.headTilt = .08 * s * e;
      pose.mouthOpen = .4 * e;
      pose.tailWag = .5 * Math.sin(TAU * t * 4) * e;
      break;
    case '13_tilt_left':
      pose.headTilt = -.27 * e;
      pose.lookX = -.3 * e;
      pose.headY = 1.7 * e;
      pose.eyeSmile = .15 * e;
      pose.tailWag = .1 * s * e;
      break;
    case '14_tilt_right':
      pose.headTilt = .27 * e;
      pose.lookX = .3 * e;
      pose.headY = 1.7 * e;
      pose.eyeSmile = .15 * e;
      pose.tailWag = -.1 * s * e;
      break;
    case '15_nod':
      pose.headY = 7 * Math.sin(TAU * t * 2) * e;
      pose.headTilt = .035 * s * e;
      pose.eyeSmile = .32 * e;
      pose.breath = .006 * s * e;
      break;
    case '16_look_around':
      pose.lookX = .9 * s * e;
      pose.headTilt = .12 * s * e;
      pose.headY = 1.5 * Math.sin(Math.PI * t) * e;
      pose.blink = pulse(t, .49, .04);
      pose.tailWag = .1 * Math.sin(TAU * t * 2) * e;
      break;
  }
  return pose;
}

function blendPose(from, to, amount) {
  const result = { ...to };
  for (const key of Object.keys(to)) {
    if (key === 'facing') continue;
    // Feet use a cyclic phase. Take the shortest arc when blending out of a walk.
    const delta = key === 'legCycle' ? Math.atan2(Math.sin(to[key] - from[key]), Math.cos(to[key] - from[key])) : to[key] - from[key];
    result[key] = from[key] + delta * amount;
  }
  return result;
}

class DogAction {
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

class DogAnimator extends THREE.EventDispatcher {
  constructor(breed, clips, canvas, texture) {
    super();
    this.breed = breed;
    this.clips = clips;
    this.canvas = canvas;
    this.context = canvas.getContext('2d');
    if (!this.context) throw new Error('浏览器无法创建小狗的 2D 画布。');
    this.texture = texture;
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
    const known = this.clips.find(item => item.name === (typeof clip === 'string' ? clip : clip?.name));
    if (!known) throw new Error('未找到这个小狗动作。');
    if (!this._actions.has(known.name)) this._actions.set(known.name, new DogAction(this, known));
    return this._actions.get(known.name);
  }
  update(delta = 0) {
    const elapsed = Math.max(0, Number.isFinite(delta) ? delta : 0) * Math.max(0, this.timeScale);
    this.time += elapsed;
    const finished = [];
    for (const action of this._actions.values()) if (action._advance(elapsed)) finished.push(action);
    const action = this._active;
    let pose = action ? samplePose(action.name, action.time, action.duration, this.facing) : neutral(this.facing);
    if (action && action._weight < 1) pose = blendPose(neutral(this.facing), pose, action._weight);
    if (this._transition && this._transition.to === action) {
      const progress = clamp((this.time - this._transition.start) / this._transition.duration, 0, 1);
      pose = blendPose(this._transition.pose, pose, smooth(progress));
      if (progress >= 1) this._transition = null;
    }
    this.pose = pose;
    this._draw();
    // Dispatch after drawing the endpoint. The room may start idle from this callback.
    for (const ended of finished) this.dispatchEvent({ type: 'finished', action: ended, direction: 1 });
    return this;
  }
  _draw() {
    drawDog(this.context, this.breed, this.pose, this.canvas.width);
    this.texture.needsUpdate = true;
    this.frame++;
  }
  setFacing(value) {
    const facing = value < 0 ? -1 : 1;
    if (this.facing === facing) return;
    this.facing = facing;
    this.pose.facing = facing;
    this._draw();
  }
  stopAllAction() {
    for (const action of this._actions.values()) action.stop();
    this._active = null;
    this._transition = null;
    return this;
  }
  uncacheRoot() { this.stopAllAction(); this._actions.clear(); }
  snapshot() {
    return { style: '2d', breed: this.breed, pose: { ...this.pose }, frame: this.frame,
      activeAction: this._active?.name || null, actionTime: this._active?.time || 0,
      duration: this._active?.duration || 0, facing: this.facing, time: this.time };
  }
}

/** Original local 2D art; no imported models, external pictures, or simulated bones. */
export function createDog2D(breed) {
  if (!BREEDS[breed]) throw new Error(`不支持的小狗类型：${breed}`);
  const clips = DEFINITIONS.map(([name, , duration]) => Object.freeze({ name, duration }));
  const meta = { breed, label: BREEDS[breed], style: '2d', clips: DEFINITIONS.map(([id, label, duration_seconds, loop]) => ({
    id, label, duration_seconds, loop, origin: 'original_2d_procedural',
  })) };
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 768;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.name = `Dog2D_${breed}_live_art`;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, alphaTest: .02, depthWrite: false, toneMapped: false });
  const sprite = new THREE.Sprite(material);
  sprite.name = `Dog2D_${breed}`;
  sprite.center.set(.5, 48 / 512);
  sprite.scale.set(1.35, 1.35, 1);
  const model = new THREE.Group();
  model.name = `Companion2D_${breed}`;
  model.userData.style = '2d';
  model.add(sprite);
  const animator = new DogAnimator(breed, clips, canvas, texture);
  animator.clipAction(clips[0]).play();
  animator.update(0);
  return { model, animator, clips, meta, sprite,
    snapshot: () => animator.snapshot(), setFacing: value => animator.setFacing(value) };
}
