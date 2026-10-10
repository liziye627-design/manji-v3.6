// 远端中继（运维工具）：生产跑 manual 模式（无私钥）时，为其 pending 的密封/头部锚定发真实主网交易。
// 生产入队（登录后 POST /api/chain/onchain/:id 与 /head）→ 从生产库读出参数 → 本机执行：
//   node scripts/relay-mainnet.mjs <承诺哈希64hex>                        # 只发 seal
//   node scripts/relay-mainnet.mjs <承诺> <链编号串> <头哈希> <本地高度>   # seal + anchorHead
// 生产的 15 秒轮询会经 sealOf/headOf 自愈确认；外部中继的交易哈希需手动回填生产库（见 BOT-CHAIN 文档）。
// 私钥只从本机 .env.local 读取，绝不入生产。
import { buildSealCalldata, buildAnchorHeadCalldata } from '../server/domain/public-chain.js';
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
for (const line of readFileSync(path.join(ROOT, '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const RPC = process.env.ONCHAIN_RPC_URL, CHAIN = Number(process.env.ONCHAIN_CHAIN_ID), TO = process.env.ONCHAIN_CONTRACT;
let seq = 1;
async function rpc(method, params) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: seq++, method, params });
  try {
    const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    return j.result;
  } catch (e) {
    const { stdout } = await execFileAsync('curl', ['-sS','-m','30','-X','POST',RPC,'-H','content-type: application/json','-d',body],{windowsHide:true});
    const j = JSON.parse(stdout);
    if (j.error) throw new Error(j.error.message);
    return j.result;
  }
}
const wallet = new ethers.Wallet(process.env.ONCHAIN_RELAYER_KEY);
console.log('中继账户:', wallet.address);
async function send(data, label) {
  const [nonceHex, gasPriceHex] = await Promise.all([
    rpc('eth_getTransactionCount', [wallet.address, 'pending']),
    rpc('eth_gasPrice', []),
  ]);
  const raw = await wallet.signTransaction({ chainId: CHAIN, nonce: Number(BigInt(nonceHex)), gasLimit: 200000, gasPrice: BigInt(gasPriceHex), to: TO, data, type: 0 });
  const tx = await rpc('eth_sendRawTransaction', [raw]);
  console.log(label, 'tx:', tx);
  return tx;
}
const [commitment, chainIdStr, headHash, height] = process.argv.slice(2);
if (/^[0-9a-f]{64}$/.test(commitment || '')) await send(buildSealCalldata(commitment), 'seal');
if (chainIdStr && headHash && height) await send(buildAnchorHeadCalldata(chainIdStr, headHash, Number(height)), 'anchorHead');
console.log('完成：生产 15 秒轮询会自动确认（sealOf/headOf 自愈）');
