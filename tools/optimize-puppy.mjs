// 一次性素材管线：把 Tripo 导出的高模小狗压成网页可用的 GLB。
// 用法：node tools/optimize-puppy.mjs <输入.glb> <输出.glb>
// 依赖 tools/ 下未入库的 @gltf-transform/* + meshoptimizer + sharp。
import { NodeIO } from '@gltf-transform/core';
import { KHRMeshQuantization } from '@gltf-transform/extensions';
import { weld, simplify, dedup, prune, flatten, quantize, compressTexture } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('用法: node tools/optimize-puppy.mjs <输入.glb> <输出.glb>');
  process.exit(1);
}

const countTris = (doc) =>
  doc.getRoot().listMeshes().reduce((sum, m) =>
    sum + m.listPrimitives().reduce((s, p) => s + p.getIndices().getCount() / 3, 0), 0);

const io = new NodeIO().registerExtensions([KHRMeshQuantization]);
const doc = await io.read(input);
const trisBefore = Math.round(countTris(doc));

// 展平成单一网格，weld 合并重复顶点（simplify 前置），meshopt 减面到约 6.5%。
await MeshoptSimplifier.ready;
await doc.transform(flatten(), weld(), simplify({ simplifier: MeshoptSimplifier, ratio: 0.065, error: 0.0008 }));
const trisAfter = Math.round(countTris(doc));

// 顶点属性量化（KHR_mesh_quantization，three.js GLTFLoader 原生支持）。
await doc.transform(quantize({ quantizePosition: 14, quantizeNormal: 8, quantizeTexcoord: 12 }));

// 贴图逐张压缩：底色/金属粗糙度走 JPEG，法线贴图保 PNG 避免方向噪点。
const normalTextures = new Set(
  doc.getRoot().listMaterials().map((m) => m.getNormalTexture?.()).filter(Boolean)
);
for (const texture of doc.getRoot().listTextures()) {
  const isNormal = normalTextures.has(texture);
  await compressTexture(texture, {
    encoder: sharp,
    resize: [1024, 1024],
    targetFormat: isNormal ? 'png' : 'jpeg',
    quality: isNormal ? undefined : 86,
  });
}

await doc.transform(dedup(), prune());

await io.write(output, doc);
const bytes = (await import('node:fs')).statSync(output).size;
console.log(`三角形: ${trisBefore} -> ${trisAfter}`);
console.log(`输出大小: ${(bytes / 1048576).toFixed(2)} MB -> ${output}`);
