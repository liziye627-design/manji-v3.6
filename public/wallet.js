// 慢记 Manji v3.6 —— BOT Chain 主网钱包直连模块
// 零依赖的 EIP-1193 封装：适配 MetaMask / OKX / TokenPocket 等注入 window.ethereum 的浏览器钱包。
// 职责：连接账户、切换/添加 BOT Chain 主网（链 677）、用用户钱包直发合约交易与 BOT 原生转账、经钱包 RPC 做只读 eth_call。
// 私钥与签名完全在钱包内完成；本模块只发起请求，不接触任何机密。
export const CHAIN_ID_DEC = 677;
export const BOT_CHAIN_PARAMS = {
  chainId: '0x2a5', // 677
  chainName: 'BOT Chain Mainnet',
  nativeCurrency: { name: 'BOT', symbol: 'BOT', decimals: 18 },
  rpcUrls: ['https://rpc.botchain.ai'],
  blockExplorerUrls: ['https://scan.botchain.ai'],
};

export const wallet = {
  provider: null,
  address: null,
  chainId: null,
};

const listeners = new Set();
let eventsBound = false;

/** 多钱包同时注入时 ethereum.providers 是数组；优先挑常见钱包，否则取第一个 */
export function detectProvider() {
  const eth = window.ethereum;
  if (!eth) return null;
  if (Array.isArray(eth.providers) && eth.providers.length) {
    return eth.providers.find((p) => p.isMetaMask || p.isOkxWallet || p.isTokenPocket) || eth.providers[0];
  }
  return eth;
}

export const hasWallet = () => !!detectProvider();
export const isConnected = () => !!wallet.address;
export const onRightChain = () => wallet.chainId === BOT_CHAIN_PARAMS.chainId;

function notify() {
  for (const fn of listeners) {
    try { fn({ ...wallet }); } catch { /* 监听方异常不影响其他监听 */ }
  }
}

export function onWalletChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function bindEvents(p) {
  if (eventsBound || !p.on) return;
  eventsBound = true;
  p.on('accountsChanged', (accs) => {
    wallet.address = (accs && accs[0]) || null;
    notify();
  });
  p.on('chainChanged', (cid) => {
    wallet.chainId = cid || null;
    notify();
  });
}

/** 请求连接钱包账户（会弹钱包授权框），成功后记录地址与当前链 */
export async function connect() {
  const p = detectProvider();
  if (!p) {
    throw new Error('未检测到浏览器钱包：请先安装 MetaMask / OKX 等插件，或用钱包 App 的内置浏览器打开慢记');
  }
  const accounts = await p.request({ method: 'eth_requestAccounts' });
  wallet.provider = p;
  wallet.address = (accounts && accounts[0]) || null;
  wallet.chainId = await p.request({ method: 'eth_chainId' }).catch(() => null);
  bindEvents(p);
  notify();
  return wallet.address;
}

/** 切到 BOT Chain 主网；钱包里没有这条链时先添加（wallet_addEthereumChain） */
export async function ensureChain() {
  const p = wallet.provider || detectProvider();
  if (!p) throw new Error('钱包未连接');
  try {
    await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: BOT_CHAIN_PARAMS.chainId }] });
  } catch (err) {
    const addable = err && (err.code === 4902 || err.code === -32603 || /Unrecognized chain|添加.*链/i.test(err.message || ''));
    if (!addable) throw err;
    await p.request({ method: 'wallet_addEthereumChain', params: [BOT_CHAIN_PARAMS] });
  }
  wallet.chainId = await p.request({ method: 'eth_chainId' }).catch(() => null);
  notify();
  return onRightChain();
}

/** 用户钱包直发交易——页面 C 端写入 BOT 主网的核心一步：合约调用带 data；原生转账（如给小狗 BOT 打赏）只带 value（hex wei 字符串）。按需组装，旧调用不变 */
export async function sendTx({ to, data, from, value }) {
  if (!wallet.provider) throw new Error('钱包未连接');
  const params = { from: from || wallet.address, to };
  if (data) params.data = data;
  if (value) params.value = value;
  return await wallet.provider.request({ method: 'eth_sendTransaction', params: [params] });
}

/** 经用户钱包的 RPC 做只读调用（sealOf 核验：独立于慢记后端的链上直读） */
export async function ethCall({ to, data }) {
  if (!wallet.provider) throw new Error('钱包未连接');
  return await wallet.provider.request({ method: 'eth_call', params: [{ from: wallet.address, to, data }, 'latest'] });
}

/** 通过钱包 RPC 查交易回执（未上块返回 null） */
export async function getReceipt(txHash) {
  if (!wallet.provider) throw new Error('钱包未连接');
  return await wallet.provider.request({ method: 'eth_getTransactionReceipt', params: [txHash] }).catch(() => null);
}
