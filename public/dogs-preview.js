import * as THREE from 'three';
import { createDog2D } from './room/dog2d.js';
const $=s=>document.querySelector(s), host=$('#canvas-host'), canvas=document.createElement('canvas');
canvas.setAttribute('aria-label','二维小狗与十六个小动作');host.appendChild(canvas);
const ctx=canvas.getContext('2d'), names={shiba:['柴犬','A little Shiba Inu'],husky:['哈士奇','A little Husky'],pug:['巴哥','A little Pug']}, dogs=new Map();
let selected='shiba',current,action,paused=false,zoom=1,frames=0,last=0,frameId,disposed=false;
function play(id){
 if(action)action.stop(); action=current.animator.clipAction(current.clips.find(c=>c.name===id));action.reset().setLoop(THREE.LoopRepeat,Infinity).play();
 $('#action-select').value=id;for(const b of document.querySelectorAll('[data-action]'))b.setAttribute('aria-pressed',String(b.dataset.action===id));
 $('#duration').textContent=action.getClip().duration.toFixed(1)+' 秒';
}
function select(breed){
 if(current)current.animator.stopAllAction();selected=breed;if(!dogs.has(breed))dogs.set(breed,createDog2D(breed));current=dogs.get(breed);action=null;
 $('#dog-name').textContent=names[breed][0];$('#dog-en').textContent=names[breed][1];$('#dog-note').textContent={shiba:'暖橘色的小伙伴，圆圆脸颊，藏着一点点俏皮。',husky:'灰蓝的小伙伴，亮亮眼睛里装着一点好奇。',pug:'奶茶色的小伙伴，软软垂耳，皱皱的小脸也很温柔。'}[breed];
 $('#stage-breed').textContent=names[breed][0]+' · 2D 小伙伴';$('#stage-number').textContent='No. 0'+(Object.keys(names).indexOf(breed)+1);
 for(const b of document.querySelectorAll('button[data-breed]'))b.setAttribute('aria-pressed',String(b.dataset.breed===breed));
 $('#action-select').replaceChildren();$('#action-buttons').replaceChildren();
 for(const c of current.meta.clips){const o=document.createElement('option');o.value=c.id;o.textContent=c.label;$('#action-select').appendChild(o);const b=document.createElement('button');b.type='button';b.textContent=c.label;b.dataset.action=c.id;b.onclick=()=>play(c.id);$('#action-buttons').appendChild(b);}
 play('01_idle');$('#load-state').hidden=true;$('#action-select').disabled=$('#pause').disabled=$('#replay').disabled=false;$('#clip-count').textContent='16 个动效';$('#model-info').textContent='原创 2D 角色 · 16 个独立动效';document.body.dataset.ready='true';document.body.dataset.breed=breed;
}
function resize(){const r=host.getBoundingClientRect(),dpr=Math.min(devicePixelRatio,2);canvas.width=Math.round(r.width*dpr);canvas.height=Math.round(r.height*dpr);}
function tick(now){if(disposed)return;frameId=requestAnimationFrame(tick);const dt=Math.min((now-(last||now))/1000,.05);last=now;if(!paused)current.animator.update(dt);
 const w=canvas.width,h=canvas.height,s=Math.min(w*.94,h*.94)*zoom;ctx.clearRect(0,0,w,h);ctx.fillStyle='rgba(123,98,64,.09)';ctx.beginPath();ctx.ellipse(w*.5,h*.52+s*.407,s*.27,s*.036,0,0,Math.PI*2);ctx.fill();ctx.drawImage(current.sprite.material.map.image,(w-s)/2,h*.52-s*.5,s,s);$('#timeline').value=action.time/action.getClip().duration;$('#playback-status').textContent=paused?'暂停，慢慢看':'循环预览';frames++;}
for(const b of document.querySelectorAll('button[data-breed]'))b.onclick=()=>select(b.dataset.breed);
$('#action-select').onchange=e=>play(e.target.value);$('#pause').onclick=()=>{paused=!paused;$('#pause').textContent=paused?'▶ 继续动作':'Ⅱ 暂停动作';$('#pause').setAttribute('aria-pressed',String(paused));};$('#replay').onclick=()=>play($('#action-select').value);
$('#front-view').onclick=()=>{current.setFacing(1);$('#front-view').setAttribute('aria-pressed','true');$('#side-view').setAttribute('aria-pressed','false');};$('#side-view').onclick=()=>{current.setFacing(-1);$('#front-view').setAttribute('aria-pressed','false');$('#side-view').setAttribute('aria-pressed','true');};$('#reset-view').onclick=()=>{zoom=1;current.setFacing(1);};$('#zoom-in').onclick=()=>{zoom=Math.min(1.8,zoom*1.1);};$('#zoom-out').onclick=()=>{zoom=Math.max(.6,zoom/1.1);};canvas.addEventListener('wheel',e=>{e.preventDefault();zoom=THREE.MathUtils.clamp(zoom*Math.exp(-e.deltaY*.001),.6,1.8);},{passive:false});
const observer=new ResizeObserver(resize);observer.observe(host);select('shiba');resize();frameId=requestAnimationFrame(tick);
window.dogPreview={snapshot:()=>({ready:true,renderStyle:'2d',selected,paused,frames,clip:action.getClip().name,clipTime:action.time,clipCount:current.clips.length,animation:current.snapshot(),zoom})};
window.addEventListener('pagehide',e=>{if(e.persisted)return;disposed=true;cancelAnimationFrame(frameId);observer.disconnect();for(const d of dogs.values()){d.animator.stopAllAction();d.sprite.material.map.dispose();d.sprite.material.dispose();}},{once:true});
