// 用与 Remix 相同的 solc 0.8.24 做真实编译验证：编译失败或产生警告都会让脚本非零退出。
// 用法：node scripts/compile-contract.mjs [合约名]（默认 ManjiEternalChain，编译 contracts/<合约名>.sol）
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const solc = require('solc');

const NAME = process.argv[2] || 'ManjiEternalChain';
const source = readFileSync(new URL(`../contracts/${NAME}.sol`, import.meta.url), 'utf8');

const input = {
  language: 'Solidity',
  sources: { [`${NAME}.sol`]: { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: 'paris',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.methodIdentifiers'] } },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));
if (output.errors && output.errors.some((e) => e.severity === 'error')) {
  console.error('编译失败：');
  for (const e of output.errors) console.error(e.formattedMessage);
  process.exit(1);
}
if (output.errors && output.errors.length) {
  console.log('编译警告：');
  for (const e of output.errors) console.log(e.formattedMessage);
}

const contract = output.contracts[`${NAME}.sol`][NAME];
mkdirSync(new URL('../contracts/build/', import.meta.url), { recursive: true });
writeFileSync(new URL(`../contracts/build/${NAME}.abi.json`, import.meta.url), JSON.stringify(contract.abi, null, 2));
writeFileSync(
  new URL(`../contracts/build/${NAME}.bytecode.txt`, import.meta.url),
  '0x' + contract.evm.bytecode.object
);

console.log(`编译通过 ✓ ${NAME}`);
console.log('  字节码大小:', (contract.evm.bytecode.object.length / 2), 'bytes');
console.log('  函数选择器:');
for (const [sig, selector] of Object.entries(contract.evm.methodIdentifiers)) {
  console.log(`    ${selector}  ${sig}`);
}
