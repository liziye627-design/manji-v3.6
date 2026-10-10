// 慢记 Manji —— 把 contracts/build 里的 ManjiEternalChain 字节码部署到公共链主网（真实交易、真实 Gas）。
// 运行前置：.env.local 已配置 ONCHAIN_RPC_URL / ONCHAIN_CHAIN_ID / ONCHAIN_RELAYER_KEY（部署账户），
// 且已 npm run compile:contract 生成最新字节码。运行：node scripts/deploy-mainnet.mjs
// 私钥只在本地签名，不进入任何日志输出；部署后请把新地址写回 .env.local 的 ONCHAIN_CONTRACT
// 并更新 contracts/DEPLOYED-mainnet.json。
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ethers = await import('ethers');
const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------- 读 .env.local（与 server/config.js 同一优先级：进程环境变量优先） ----------
function loadEnvLocal() {
  const text = readFileSync(path.join(ROOT, '.env.local'), 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
loadEnvLocal();

const RPC_URL = process.env.ONCHAIN_RPC_URL;
const CHAIN_ID = Number(process.env.ONCHAIN_CHAIN_ID);
const BYTECODE = readFileSync(path.join(ROOT, "contracts", "build", (process.argv[2] ? process.argv[2] : "ManjiEternalChain") + ".bytecode.txt"), "utf8").trim();

if (!RPC_URL || !CHAIN_ID || !process.env.ONCHAIN_RELAYER_KEY) {
  console.error('缺少 ONCHAIN_RPC_URL / ONCHAIN_CHAIN_ID / ONCHAIN_RELAYER_KEY（见 .env.local）');
  process.exit(1);
}

// ---------- JSON-RPC（fetch 失败自动降级 curl：与服务端 public-chain.js 同一套经验） ----------
let seq = 1;
async function rpcViaCurl(bodyJson) {
  const { stdout } = await execFileAsync(
    'curl', ['-sS', '-m', '30', '-X', 'POST', RPC_URL, '-H', 'content-type: application/json', '-d', bodyJson],
    { windowsHide: true }
  );
  return JSON.parse(stdout);
}
async function rpc(method, params) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: seq++, method, params });
  const interpret = (json) => {
    if (!json || json.error) throw new Error(`RPC ${method} 失败: ${json && json.error ? json.error.message : '空响应'}`);
    return json.result;
  };
  try {
    const res = await fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    return interpret(await res.json().catch(() => null));
  } catch (err) {
    return interpret(await rpcViaCurl(body));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitForTx(txHash, what) {
  for (let i = 0; i < 60; i++) {
    const receipt = await rpc('eth_getTransactionReceipt', [txHash]).catch(() => null);
    if (receipt) {
      if (receipt.status !== '0x1') throw new Error(`${what} 交易回滚：${txHash}`);
      return receipt;
    }
    process.stdout.write('.');
    await sleep(3000);
  }
  throw new Error(`等待 ${what} 确认超时：${txHash}`);
}

// ---------- 部署 ----------
const wallet = new ethers.Wallet(process.env.ONCHAIN_RELAYER_KEY);
console.log(`部署账户：${wallet.address}（链 ${CHAIN_ID} · ${RPC_URL}）`);

const [nonceHex, gasPriceHex, estimate] = await Promise.all([
  rpc('eth_getTransactionCount', [wallet.address, 'pending']),
  rpc('eth_gasPrice', []),
  rpc('eth_estimateGas', [{ from: wallet.address, data: BYTECODE }]).catch(() => null),
]);
const gasLimit = estimate ? Math.ceil((Number(BigInt(estimate)) * 1.3) / 1000) * 1000 : 1_500_000;
console.log(`nonce=${Number(BigInt(nonceHex))} gasPrice=${Number(BigInt(gasPriceHex)) / 1e9}gwei gasLimit=${gasLimit}`);

const raw = await wallet.signTransaction({
  chainId: CHAIN_ID, nonce: Number(BigInt(nonceHex)), gasLimit, gasPrice: BigInt(gasPriceHex),
  data: BYTECODE, type: 0,
});
const deployTx = await rpc('eth_sendRawTransaction', [raw]);
console.log(`部署交易已广播：${deployTx}`);
const receipt = await waitForTx(deployTx, '部署');
const address = receipt.contractAddress;
console.log(`\n合约已部署：${address}`);
console.log(`  部署交易：${deployTx}`);
console.log(`  区块：${Number(BigInt(receipt.blockNumber))} · gasUsed：${Number(BigInt(receipt.gasUsed))}`);

// ---------- 部署后核验（eth_call 只读） ----------
const code = await rpc('eth_getCode', [address, 'latest']);
console.log(`\neth_getCode：${(code.length - 2) / 2} 字节`);
const owner = await rpc('eth_call', [{ to: address, data: '0x8da5cb5b' }, 'latest']); // owner()
const relayer = await rpc('eth_call', [{ to: address, data: '0x8406c079' }, 'latest']); // relayer()
const versionRaw = await rpc('eth_call', [{ to: address, data: '0xffa1ad74' }, 'latest']); // VERSION()
const words = versionRaw.slice(2).match(/.{64}/g) || [];
const vlen = words.length >= 2 ? Number(BigInt('0x' + words[1])) : 0; // ABI string：word0=偏移 word1=字节长度
const version = vlen ? Buffer.from(words.slice(2).join('').slice(0, vlen * 2), 'hex').toString('utf8') : '?';
const count = await rpc('eth_call', [{ to: address, data: '0x726804ab' }, 'latest']); // sealCount()
console.log(`owner()      = 0x${owner.slice(26)}`);
console.log(`relayer()    = 0x${relayer.slice(26)}`);
console.log(`VERSION()    = ${version}`);
console.log(`sealCount()  = ${Number(BigInt(count))}`);
console.log('\n下一步：把新地址写入 .env.local 的 ONCHAIN_CONTRACT，并更新 contracts/DEPLOYED-mainnet.json。');
