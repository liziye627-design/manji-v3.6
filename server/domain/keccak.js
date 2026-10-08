// 慢记 Manji v3.6 —— Keccak-256（以太坊原版 Keccak，非 FIPS SHA3-256）
// 用途：计算 EVM 函数选择器与事件主题，使公共链查询（eth_call / eth_getLogs）零依赖可用。
// 实现为标准 Keccak-f[1600] 海绵函数（rate=136 字节、legacy 填充 0x01…0x80），
// 载入时立即用三个公开测试向量自检，任何一个不符都会让进程失败启动——绝不静默给出错误哈希。
const EMPTY_KECCAK256 = 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470';
const ABC_KECCAK256 = '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45';

const ROUND_CONSTANTS = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const ROTATION_OFFSETS = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44];
const PI_PERMUTATION = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];

const MASK64 = (1n << 64n) - 1n;

function rotl64(x, n) {
  const v = x & MASK64;
  return ((v << n) | (v >> (64n - n))) & MASK64;
}

function keccakF(state) {
  for (let round = 0; round < 24; round++) {
    // θ
    const bc = new Array(5);
    for (let x = 0; x < 5; x++) {
      bc[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
    }
    for (let x = 0; x < 5; x++) {
      const t = bc[(x + 4) % 5] ^ rotl64(bc[(x + 1) % 5], 1n);
      for (let y = 0; y < 25; y += 5) state[y + x] ^= t;
    }
    // ρ + π
    let t = state[1];
    for (let i = 0; i < 24; i++) {
      const j = PI_PERMUTATION[i];
      const tmp = state[j];
      state[j] = rotl64(t, BigInt(ROTATION_OFFSETS[i]));
      t = tmp;
    }
    // χ
    for (let y = 0; y < 25; y += 5) {
      const a0 = state[y], a1 = state[y + 1], a2 = state[y + 2], a3 = state[y + 3], a4 = state[y + 4];
      state[y] = a0 ^ (~a1 & a2 & MASK64);
      state[y + 1] = a1 ^ (~a2 & a3 & MASK64);
      state[y + 2] = a2 ^ (~a3 & a4 & MASK64);
      state[y + 3] = a3 ^ (~a4 & a0 & MASK64);
      state[y + 4] = a4 ^ (~a0 & a1 & MASK64);
    }
    // ι
    state[0] ^= ROUND_CONSTANTS[round];
  }
}

const RATE = 136; // 1088 bit

function keccak256Bytes(input) {
  // legacy Keccak 填充：追加 0x01，零填充，末字节置 0x80（SHA3 标准是 0x06，二者不通用）
  const padded = new Uint8Array((((input.length / RATE) | 0) + 1) * RATE);
  padded.set(input);
  padded[input.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;

  const state = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += RATE) {
    for (let lane = 0; lane < RATE / 8; lane++) {
      let v = 0n;
      for (let b = 7; b >= 0; b--) v = (v << 8n) | BigInt(padded[off + lane * 8 + b]);
      state[lane] ^= v;
    }
    keccakF(state);
  }

  const out = Buffer.alloc(32);
  for (let lane = 0; lane < 4; lane++) {
    let v = state[lane];
    for (let b = 0; b < 8; b++) {
      out[lane * 8 + b] = Number(v & 0xffn);
      v >>= 8n;
    }
  }
  return out;
}

export function keccak256(data) {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
  return keccak256Bytes(buf).toString('hex');
}

export function selectorOf(signature) {
  return keccak256(signature).slice(0, 8);
}

// ---------- 载入自检：公开向量 + 编译器给出的真实选择器（scripts/compile-contract.mjs 输出） ----------
const SELF_CHECKS = [
  ['', EMPTY_KECCAK256],
  ['abc', ABC_KECCAK256],
  ['seal(bytes32)', null], // 下方与编译器结果比对
];
for (const [input, expected] of SELF_CHECKS) {
  if (expected !== null && keccak256(input) !== expected) {
    throw new Error(`keccak256 自检失败：keccak256(${JSON.stringify(input)}) ≠ 已知向量`);
  }
}
// 这些选择器来自 solc 0.8.24 对 ManjiEternalChain.sol 的真实编译输出；不符说明本实现有错。
const COMPILED_SELECTORS = {
  'seal(bytes32)': 'b07eeda8',
  'sealBatch(bytes32[])': 'bf7707e8',
  'sealOf(bytes32)': '3038bfa5',
  'sealsOf(bytes32[])': 'f7317251',
  'anchorHead(bytes16,bytes32,uint64)': '3f81a88e',
  'headOf(bytes16)': '2b2b7096',
  'sealCount()': '726804ab',
};
for (const [sig, expected] of Object.entries(COMPILED_SELECTORS)) {
  if (selectorOf(sig) !== expected) {
    throw new Error(`keccak256 自检失败：selectorOf("${sig}") = ${selectorOf(sig)} ≠ 编译器结果 ${expected}`);
  }
}
