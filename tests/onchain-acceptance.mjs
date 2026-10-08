// 慢记 Manji v3.6 —— 公共链锚定离线验收（不需要网络、不需要部署合约）
// 验收四件事：
//   1. keccak-256 实现正确（公开向量 + 与编译器输出的函数选择器逐一比对）；
//   2. 发往公共链的 calldata 逐字节符合 EVM ABI（这是「手动提交指引」给用户看的东西，必须精确）；
//   3. 链上返回值解码正确（含未登记/已登记两种情形的编码样本）；
//   4. 承诺计算与 v3.5 本地永恒之链完全一致（同一篇日记/约定，本地链与公共链登记同一个哈希）。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { keccak256, selectorOf } from '../server/domain/keccak.js';
import {
  buildSealCalldata, buildSealBatchCalldata, buildSealOfCalldata, buildAnchorHeadCalldata, buildHeadOfCalldata,
  parseSealOfResult, parseHeadOfResult, chainIdBytes16Hex, isHex64, isHex32,
} from '../server/domain/public-chain.js';

let passed = 0;
const check = (name, fn) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

console.log('v3.6 公共链锚定离线验收');

check('keccak-256 公开测试向量', () => {
  assert.equal(keccak256(''), 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(keccak256('abc'), '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
});

check('函数选择器与 solc 0.8.24 编译输出一致（keccak.js 载入时也已自检）', () => {
  assert.equal(selectorOf('seal(bytes32)'), 'b07eeda8');
  assert.equal(selectorOf('sealBatch(bytes32[])'), 'bf7707e8');
  assert.equal(selectorOf('sealOf(bytes32)'), '3038bfa5');
  assert.equal(selectorOf('anchorHead(bytes16,bytes32,uint64)'), '3f81a88e');
  assert.equal(selectorOf('headOf(bytes16)'), '2b2b7096');
  assert.equal(selectorOf('sealCount()'), '726804ab');
});

const C1 = 'a'.repeat(64);
const C2 = '0123456789abcdef'.repeat(4);
const HEAD = 'f'.repeat(64);
// 应用真实生成的链编号是 base64url 随机串（server/core.js randomToken），不是十六进制
const CHAIN_ID_STR = 'kIhdBSyHwJSPewmjPhsarA';
const CHAIN_ID16 = chainIdBytes16Hex(CHAIN_ID_STR);

check('seal(bytes32) calldata：选择器 + 单个 32 字节参数', () => {
  assert.equal(buildSealCalldata(C1), '0xb07eeda8' + C1);
  assert.equal(buildSealCalldata(C2), '0xb07eeda8' + C2);
});

check('sealBatch(bytes32[]) calldata：偏移 0x20 + 长度 + 逐字参数', () => {
  assert.equal(
    buildSealBatchCalldata([C1, C2]),
    '0xbf7707e8' + '0'.repeat(62) + '20' + '0'.repeat(63) + '2' + C1 + C2
  );
});

check('sealOf(bytes32) calldata（核验用只读调用）', () => {
  assert.equal(buildSealOfCalldata(C1), '0x3038bfa5' + C1);
});

check('anchorHead(bytes16,bytes32,uint64) calldata：链编号 SHA-256 前 16 字节右补零、uint 大端左侧补零', () => {
  assert.equal(
    buildAnchorHeadCalldata(CHAIN_ID_STR, HEAD, 42),
    '0x3f81a88e' + CHAIN_ID16.padEnd(64, '0') + HEAD + (42).toString(16).padStart(64, '0')
  );
});

check('headOf(bytes16) calldata（与 anchorHead 用同一个派生链编号）', () => {
  assert.equal(buildHeadOfCalldata(CHAIN_ID_STR), '0x2b2b7096' + CHAIN_ID16.padEnd(64, '0'));
});

check('链编号派生：SHA-256 前 16 字节、确定性、与 base64url 原串一一对应', () => {
  assert.equal(CHAIN_ID16.length, 32);
  assert.equal(isHex32(CHAIN_ID16), true);
  assert.equal(chainIdBytes16Hex(CHAIN_ID_STR), CHAIN_ID16);
  assert.notEqual(chainIdBytes16Hex('另一个链编号'), CHAIN_ID16);
  // 与 server/core.js 的 sha256 交叉验证（此处直接用 node:crypto 复算同一规则）
  assert.equal(CHAIN_ID16, createHash('sha256').update(CHAIN_ID_STR).digest('hex').slice(0, 32));
});

check('sealOf 返回值解码：未登记（全零）与已登记（bool+两个 uint64）', () => {
  const zero = '0x' + '0'.repeat(64 * 3);
  assert.deepEqual(parseSealOfResult(zero), { found: false, index: null, sealedAt: null });
  const w = (n) => BigInt(n).toString(16).padStart(64, '0');
  const found = '0x' + w(1) + w(7) + w(1791888000);
  assert.deepEqual(parseSealOfResult(found), { found: true, index: 7, sealedAt: 1791888000 });
  // 数据缺失（如 RPC 返回 0x）时不得误报已登记
  assert.equal(parseSealOfResult('0x').found, false);
});

check('headOf 返回值解码：未登记与已登记', () => {
  const zero = '0x' + '0'.repeat(64 * 4);
  assert.equal(parseHeadOfResult(zero).found, false);
  const w = (n) => BigInt(n).toString(16).padStart(64, '0');
  const found = '0x' + w(1) + HEAD + w(12) + w(1791888000);
  assert.deepEqual(parseHeadOfResult(found), { found: true, headHash: HEAD, localHeight: 12, anchoredAt: 1791888000 });
});

check('十六进制校验拒绝错误长度与非十六进制（防止把坏数据发上链）', () => {
  assert.equal(isHex64(C1), true);
  assert.equal(isHex64('0x' + C1), false); // 不带 0x 前缀的裸哈希才是我们的内部表示
  assert.equal(isHex64(C1.slice(0, 63)), false);
  assert.equal(isHex64('z'.repeat(64)), false);
  assert.equal(isHex32(CHAIN_ID16), true);
  assert.equal(isHex32(CHAIN_ID16 + 'ab'), false);
});

check('批次超限被拒绝（与合约 MAX_BATCH=256 一致，交易发出去也会整体回滚）', () => {
  const tooMany = Array(257).fill(C1);
  assert.throws(() => buildSealBatchCalldata(tooMany), /最多 256/);
});

// ---- 与本地永恒之链的一致性（直接复用链域模块的承诺函数，而非复制公式） ----
// chain.js 会打开数据库，放在纯函数断言之后执行。
{
  const { commitmentOf } = await import('../server/domain/chain.js');
  const canonical = { type: 'promise', id: 'pr1', revision: 1, text: '每周一起看一部电影', note: '', dueDate: '', scope: 'shared' };
  const salt = 'ab'.repeat(32);
  const c1 = commitmentOf(canonical, salt);

  check('本地承诺 → 64 位十六进制，可直接作为 bytes32 提交公共链', () => {
    assert.equal(c1, commitmentOf(canonical, salt), '同一内容+盐必须得到同一承诺');
    assert.equal(isHex64(c1), true);
  });

  check('承诺对字段顺序不敏感（规范化按键名排序，双方可独立复算）', () => {
    const reordered = { scope: canonical.scope, dueDate: canonical.dueDate, note: canonical.note, text: canonical.text, revision: canonical.revision, id: canonical.id, type: canonical.type };
    assert.equal(c1, commitmentOf(reordered, salt));
  });

  check('承诺对内容改动敏感（改一个字，公共链与本地链都会立即对不上）', () => {
    assert.notEqual(c1, commitmentOf({ ...canonical, text: '每周一起看两部电影' }, salt));
    assert.notEqual(c1, commitmentOf(canonical, 'cd'.repeat(32)), '换盐也应得到不同承诺');
  });
}

console.log(`\n${passed} 项全部通过`);
