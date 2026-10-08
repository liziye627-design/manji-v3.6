import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const MODEL_URL = '/assets/models/puppy.glb';
const clamp = THREE.MathUtils.clamp;

/**
 * 加载小狗 GLB（每次调用独立加载，浏览器 HTTP 缓存负责去重；
 * 不做模块级共享，避免多处挂载后的释放互相影响）。
 */
export function loadPuppyScene() {
  return new GLTFLoader().loadAsync(MODEL_URL).then((gltf) => gltf.scene);
}

/** 统一材质与阴影设置：投影用前面、贴图各向异性过滤。 */
export function preparePuppyMaterials(root, { castShadow = true } = {}) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = castShadow;
    o.receiveShadow = false;
    o.frustumCulled = false;
    const m = o.material;
    if (m?.isMeshStandardMaterial) {
      m.shadowSide = THREE.FrontSide;
      if (m.map) m.map.anisotropy = 4;
      m.needsUpdate = true;
    }
  });
}

function disposeTree(tree) {
  const geometries = new Set(), materials = new Set(), textures = new Set();
  tree.traverse((o) => {
    if (o.geometry) geometries.add(o.geometry);
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) if (m) materials.add(m);
  });
  for (const m of materials) {
    for (const v of Object.values(m)) if (v?.isTexture) textures.add(v);
    m.dispose();
  }
  for (const t of textures) { t.source?.data?.close?.(); t.dispose(); }
  geometries.forEach((g) => g.dispose());
}

/**
 * 欢迎/登录页的小狗 Hero 渲染：
 * - 透明画布叠在原有手绘场景上，模型就绪后由 onReveal 通知外层做交叉淡入；
 * - ACES 色调映射 + 暖色三点布光 + ShadowMaterial 柔和接地影；
 * - 待机呼吸/缓慢张望 + 指针视差；减少动画时只渲染静帧；
 * - 页面隐藏、移出视口或宿主脱离文档时自动暂停并释放。
 */
export function mountPuppyHero(host, options = {}) {
  const controller = { dispose: null, ready: null };
  let disposed = false, frameId = 0, previous = 0;
  let renderer, resizeObserver, intersectionObserver;
  let inView = true, revealed = false;
  const reduced = !!options.reduced || matchMedia('(prefers-reduced-motion: reduce)').matches;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, .05, 12);
  camera.position.set(.45, .55, 1.82);
  camera.lookAt(0, .35, 0);

  const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
  const onPointerMove = (event) => {
    pointer.tx = clamp((event.clientX / innerWidth) * 2 - 1, -1, 1);
    pointer.ty = clamp((event.clientY / innerHeight) * 2 - 1, -1, 1);
  };

  function resize() {
    if (!renderer || disposed) return;
    const w = Math.max(1, host.clientWidth), h = Math.max(1, host.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (reduced) renderAt(performance.now(), 0);
  }

  function renderAt(now, dt) {
    if (!scene.userData.puppy) return;
    const puppy = scene.userData.puppy;
    if (!reduced) {
      const t = now / 1000;
      pointer.x += (pointer.tx - pointer.x) * Math.min(1, dt * 4);
      pointer.y += (pointer.ty - pointer.y) * Math.min(1, dt * 4);
      // 呼吸 + 缓慢张望 + 指针视差（眼睛看不远处的用户）
      const breath = 1 + .011 * Math.sin(t * 2 * Math.PI / 3.4);
      puppy.scale.setScalar(breath);
      puppy.rotation.y = .12 * Math.sin(t * 2 * Math.PI / 9.5) + pointer.x * .24;
      puppy.rotation.z = pointer.x * -.02;
      puppy.position.y = .004 * Math.sin(t * 2 * Math.PI / 3.4 + Math.PI / 2);
    }
    renderer.render(scene, camera);
    if (!revealed) { revealed = true; options.onReveal?.(); }
  }

  function tick(now) {
    if (disposed || !host.isConnected) { controller.dispose(); return; }
    frameId = requestAnimationFrame(tick);
    if (document.hidden || !inView) { previous = now; return; }
    const dt = Math.min((now - (previous || now)) / 1000, .075);
    previous = now;
    renderAt(now, dt);
  }

  controller.dispose = () => {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(frameId);
    removeEventListener('pointermove', onPointerMove);
    resizeObserver?.disconnect();
    intersectionObserver?.disconnect();
    if (scene.userData.puppy) disposeTree(scene.userData.puppy);
    for (const light of [...scene.children]) if (light.isLight) scene.remove(light);
    renderer?.dispose();
    renderer?.forceContextLoss();
    renderer?.domElement.remove();
  };

  controller.ready = (async () => {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setClearColor(0x000000, 0);
    host.appendChild(renderer.domElement);

    const puppy = await loadPuppyScene();
    if (disposed) { disposeTree(puppy); return; }
    preparePuppyMaterials(puppy);
    scene.add(puppy);
    scene.userData.puppy = puppy;

    // 暖色三点布光：主光（投影）+ 冷补光 + 轮廓光，配半球环境光。
    scene.add(new THREE.HemisphereLight(0xfff4e2, 0xcbb394, 1.05));
    const key = new THREE.DirectionalLight(0xffeeda, 2.3);
    key.position.set(1.15, 2.3, 1.5);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    Object.assign(key.shadow.camera, { left: -.7, right: .7, top: .9, bottom: -.2, near: .5, far: 6 });
    key.shadow.radius = 5;
    key.shadow.normalBias = .02;
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xdfe9ff, .75);
    fill.position.set(-1.6, 1.1, .7);
    scene.add(fill);
    const rim = new THREE.DirectionalLight(0xfff3e0, 1.0);
    rim.position.set(-.35, 1.7, -1.8);
    scene.add(rim);

    // 接地柔影：只接收阴影的透明圆片，不遮住手绘地板。
    const catcher = new THREE.Mesh(
      new THREE.CircleGeometry(.36, 48),
      new THREE.ShadowMaterial({ opacity: .3 })
    );
    catcher.rotation.x = -Math.PI / 2;
    catcher.position.y = .0006;
    catcher.receiveShadow = true;
    scene.add(catcher);

    resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);
    intersectionObserver = new IntersectionObserver((entries) => { inView = entries[entries.length - 1].isIntersecting; });
    intersectionObserver.observe(host);
    addEventListener('pointermove', onPointerMove, { passive: true });
    resize();
    if (reduced) renderAt(performance.now(), 0);
    else frameId = requestAnimationFrame(tick);
  })().catch((error) => {
    console.warn('小狗 3D 展示不可用，继续使用插画：', error?.message || error);
    controller.dispose();
  });

  return controller;
}
