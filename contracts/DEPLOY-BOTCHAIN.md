# ManjiEternalChain 主网部署与应用接入指南（BOT Chain）

本指南适配**新版合约 ManjiEternalChain**（慢记 v3.6）。与旧版 Heartbell 合约（`record`/`recordedAt`/`initialAdmin`/`initialWriter`）的接口不同，凡与旧版不同处均已注明。

> ✅ **本次交付已完成主网部署**（2026-10-08），信息见 `contracts/DEPLOYED-mainnet.json`：
> - 合约地址：`0x9757b6fd786fb77545a288e98fc06a6c04bfc627`
> - 部署交易：`0x7961f1650163b75d52448235912acbb7e47a3e29b5d5e9253895527fb2448a4b`（区块 25925515）
> - 浏览器：https://scan.botchain.ai/tx/0x7961f1650163b75d52448235912acbb7e47a3e29b5d5e9253895527fb2448a4b
>
> 以下步骤供重新部署（新地址/换钱包）时使用。

## 一、导入合约并编译

1. 打开 https://remix.ethereum.org ，新建工作空间，上传 `contracts/ManjiEternalChain.sol`（单文件、无 import 依赖）。
2. 点击该合约文件，左侧 **Compile**：
   - **Compiler：`0.8.24`**（新版要求；旧版 0.8.37 不适用于本合约）
   - **EVM Version：`paris`**
   - **Optimization：勾选，Runs：`200`**
3. 点击 **Compile ManjiEternalChain.sol**，确认无红色错误、无警告。
   - 本地等价命令：`npm i solc@0.8.24 && node scripts/compile-contract.mjs`（同时导出 ABI 与字节码到 `contracts/build/`）。

## 二、连接钱包并部署主网

1. MetaMask 添加并切换到 BOT 主网：
   - 网络名称：BOT Chain Mainnet；Chain ID：`677`
   - RPC：`https://rpc.botchain.ai`；代币符号：`BOT`
   - 浏览器：`https://scan.botchain.ai`
2. 确认部署钱包有主网 BOT（测试 BOT 不能支付主网手续费）。
3. Remix 左侧 **Deploy & Run** → Environment 选 **Browser Extension → MetaMask** 并允许连接。
4. 确认 Remix 显示 **Chain ID 677**。Contract 选择 `ManjiEternalChain`。
5. **构造参数：无**。新版合约 constructor 不接收任何参数——部署者自动成为 `owner` 与 `relayer`（与旧版填写 `initialAdmin`/`initialWriter` 不同）。
   - 若想让「应用后端签名钱包」区别于管理钱包：部署后调用一次 `setRelayer(应用钱包地址)`（唯一的管理操作）。
   - 填的是钱包地址，不是私钥。
6. 合约不接收资金，**Value 保持 0**。
7. 点击 **Deploy**，在 MetaMask 核对主网、账户与手续费后确认，等待成功，**不要重复点击**。
8. 在 **Deployed Contracts** 卡片复制完整 `0x` 合约地址。

## 三、保存并验证

1. 从 Remix 交易记录复制部署交易哈希，到 https://scan.botchain.ai 搜索，确认 **Success**。
2. 展开合约实例，读取（读操作不花 Gas）：
   - `owner()` → 应为部署钱包地址
   - `relayer()` → 应为部署钱包（或 `setRelayer` 指定的应用钱包）
   - `sealCount()` → 当前已登记承诺数
   - 新版没有 `paused()`——合约不存在暂停功能，也没有任何修改/删除已登记数据的后台函数。
3. 核心写入测试（真实主网交易，消耗主网 BOT）。**新版接口是 `seal`，不是 `record`**：
   - 切到 relayer 钱包，对 `seal(bytes32)` 输入一个尚未登记过的测试指纹：
     `0x1111111111111111111111111111111111111111111111111111111111111111`
   - 确认并等待成功。再对 `sealOf(bytes32)` 输入同一指纹点 Call：返回 `found=true`、非零 `sealedAt` 即登记成功（**新版是 `sealOf`，不是 `recordedAt`）。
   - 我们的实测：交易 `0x1f11efed…cd615e`，gas 90731，sealOf → index=0。
4. 回到 Compile → Compilation Details 复制保存 **ABI**（或直接用 `contracts/build/ManjiEternalChain.abi.json`）。

保存材料：合约代码、ABI、编译参数、主网合约地址、部署交易哈希、核心功能交易哈希（赛事部署核验用；`contracts/DEPLOYED-mainnet.json` 即此记录）。

## 四、交给 Agent 接入应用（已完成，要点复述）

慢记 v3.6 已接入主网，接入信息：

- 合约代码：`contracts/ManjiEternalChain.sol`
- ABI：`contracts/build/ManjiEternalChain.abi.json`
- 主网合约地址：`0x9757b6fd786fb77545a288e98fc06a6c04bfc627`
- 部署交易哈希：`0x7961f1650163b75d52448235912acbb7e47a3e29b5d5e9253895527fb2448a4b`
- Chain ID：`677`；RPC：`https://rpc.botchain.ai`；浏览器：`https://scan.botchain.ai`
- Writer（relayer）地址：`0x4844F22482B0e08dc9b44d153a723863F576b178`

接口变化核对（旧 Heartbell → 新 ManjiEternalChain）：
`record(bytes32)` → `seal(bytes32)`；`recordedAt(bytes32)` → `sealOf(bytes32) returns (bool,uint64,uint64)`；
新增 `sealBatch`（批量）、`anchorHead`（本地链头部锚定）、`headOf`、`sealCount`、`sealAt`、`sealsOf`；
管理接口只剩 `setRelayer(address)`（无 admin 双角色、无暂停）。

应用侧实现（已在 v3.6 完成并实测）：
- `server/domain/keccak.js`：零依赖 Keccak-256（选择器与编译器输出比对自检）
- `server/domain/public-chain.js`：提交队列、自动代提交（本地签名+JSON-RPC 广播，fetch 失败自动 curl 兜底）、sealOf/headOf 实时核验、幂等与自愈
- `server/routes/onchain.js`：`GET/POST /api/chain/onchain*` 系列接口
- 启动时校验 `.env` 的 `ONCHAIN_CHAIN_ID` 必须为 677 才启用主网模式（`onchainMode()`）

## 五、本机配置环境

慢记的机密文件是 **`.env.local`**（`server/config.js` 会在 `.env` 之后加载并覆盖同名项），文件名不能带 `.txt` 后缀。`.env`（非机密）与 `.env.local`（机密）都已存在于本交付目录。

`.env`（可随项目分发，不含密钥）：

```
ONCHAIN_RPC_URL=https://rpc.botchain.ai
ONCHAIN_CHAIN_ID=677
ONCHAIN_CONTRACT=0x9757b6fd786fb77545a288e98fc06a6c04bfc627
ONCHAIN_EXPLORER=https://scan.botchain.ai
```

`.env.local`（绝不提交、绝不出现在交付压缩包中）：

```
ONCHAIN_RELAYER_KEY=0x授权Writer的完整私钥（0x开头）
```

- 自动代提交需要可选依赖 ethers：`npm i`（package.json 已列为 optionalDependencies）。
- 不装 ethers / 不配私钥时自动降级为**手动模式**：应用给出可直接粘贴的 calldata，用任意钱包发送后回填交易哈希，应用轮询回执自动确认。
- 确认策略：应用以 `eth_getTransactionReceipt` 出块回执 + 链上 `sealOf/headOf` 复核双重确认为准。
- **不要把私钥发给任何人（包括 Agent），不要提交 .env.local。**

## 六、启动应用并验证主网接入

1. 进入项目目录：`cd 慢记v3.6-日记承诺上链-交付`
2. 停止旧服务后执行：`npm start`（Node ≥ 22.5）。
3. 打开 `http://127.0.0.1:4173`，完成一次存证流程：共同约定双方点「我也愿意」→ 本地镌刻 → 「提交公共链」→（自动模式 15 秒内发送）→ 详情页「核验」。
4. 从页面取得真实交易哈希，到 https://scan.botchain.ai 查询。
5. 确认：交易成功；目标是上述主网合约；事件 `Sealed(bytes32,uint64,uint64)` 对应应用生成的承诺指纹；`sealOf(指纹)` 查询结果为已登记。
6. 自动化等价验证：`node tests/onchain-e2e-mainnet.mjs`（真实主网交易，消耗少量 BOT；我们在交付时已跑通全流程）。

完成这些检查，才算应用主网接入成功。

## 已知边界与诚实声明

- 上链的只有承诺哈希与本地链头部哈希：没有正文、照片、成员身份或关系状态；salt 只在链下。
- 交易由统一 relayer 账户发送，成员钱包地址不进交易；relayer 地址本身公开可见（它是一个专用账户，不关联任何用户身份）。
- 合约证明「某承诺在某时刻已登记」，不证明「登记时已取得双方同意」——同意核验在应用内完成，凭证由成员各自离线保存。
- 承诺一旦上链永久不可撤回（这是可核验性的来源，也请在提交前想清楚）。
