// PuppyAnimator 契约测试：模拟 room.js 的调用方式（switchAction/淡出/finish 事件），
// 在 Node 里直接驱动，不依赖浏览器与 rAF。
import * as THREE from '../public/vendor/three/three.module.js';
import { PuppyAnimator } from '../public/room/puppy-companion.js';

const clips = [
  { name: '01_idle', duration: 3.6 },
  { name: '04_walk', duration: 2.8 },
  { name: '06_jump', duration: 2.8 },
];
const rig = { scale: { set() {} }, position: { y: 0 }, rotation: { set() {} } };
const animator = new PuppyAnimator('shiba', clips, rig);
const actions = new Map(clips.map(c => [c.name, animator.clipAction(c)]));
const finished = [];

animator.addEventListener('finished', e => finished.push(e.action.name));

// room.js switchAction 的复刻：一次性动作 LoopOnce + clampWhenFinished
function switchAction(id, once = false) {
  const next = actions.get(id);
  const old = current;
  next.stopFading().reset().setEffectiveTimeScale(1).setEffectiveWeight(1);
  next.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, once ? 1 : Infinity);
  next.clampWhenFinished = once;
  next.play();
  if (old && old !== next) next.crossFadeFrom(old, .18, false);
  current = next;
}
let current = null;

const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exit(1); } };

// 1) 待机循环：超过一个周期仍在播
switchAction('01_idle');
for (let i = 0; i < 100; i++) animator.update(.05); // 5s > 3.6s
assert(current.isRunning() === true, '循环动作应持续运行');
assert(finished.length === 0, '循环动作不应触发 finished');

// 2) 一次性动作：到时触发 finished，time 停在 duration
switchAction('06_jump', true);
for (let i = 0; i < 70; i++) animator.update(.05); // 3.5s > 2.8s
assert(finished.length === 1 && finished[0] === '06_jump', '一次性动作应恰好触发一次 finished');
assert(Math.abs(current.time - 2.8) < 1e-6, '结束后 time 应停在 duration');
assert(current.isRunning() === false, '结束后不应处于运行态');

// 3) 淡出中的旧动作 stop 后不影响新动作
switchAction('04_walk');
for (let i = 0; i < 30; i++) animator.update(.05);
assert(current === actions.get('04_walk') && current.isRunning(), '行走循环应运行中');
assert(Number.isFinite(animator.pose.bob), '姿态通道应为有限数值');

// 4) setFacing 只影响 roll 偏置，不抛错
animator.setFacing(-1);
assert(animator.facing === -1, 'facing 应更新为 -1');

console.log('PuppyAnimator 契约测试全部通过 ✔ (finished:', finished.join(','), ')');
