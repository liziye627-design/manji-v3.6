# BOT Chain Agent OS 集成规格（供慢记小狗链上身份集成使用）

> 来源：dev-docs.botchain.ai（Agent OS：Agent Wallet + Agent Identity），2026-10-10 抓取整理。
> **状态更新（2026-10-10）：官方 key 暂未获批，v3.6.3 已改为自托管方案上线**——自部署 ManjiPuppyIdentity 合约
> （地址与核验记录见 contracts/DEPLOYED-mainnet.json 的 puppyIdentity 节；集成设计见 §3，但 §3.3 的注册/轮询
> 已按"钱包直发 mint + 回执对账"重写，代码以 server/domain/agentos.js 为准）。本规格保留官方 API 契约，
> 将来获批 key 可切回托管模式。

## 0. 总原则

- Agent OS 走**官方托管 API**（服务端调用，持有 API key），不像 ManjiEternalChain 那样自部署合约。
- **API key 未配置时功能整体降级为"未配置"状态**（参照 `server/routes/onchain.js` 的 `ONCHAIN_NOT_CONFIGURED` 模式），绝不影响主流程。
- key 格式 `ak_<env>_k_<keyid>.<secret>`，放 `.env.local` 的 `AGENTOS_API_KEY`，只显示一次，绝不入库/日志。
- 主网 API：钱包 `https://wallet-api.botchain.ai`，身份 `https://identity-api.botchain.ai`；测试网（Bohr）：`wallet-api.bohr.life` / `identity-api.bohr.life`，链 968。
- 鉴权：请求头 `X-API-Key: <key>`。所有写接口带 `Idempotency-Key`（UUID）。

## 1. Agent Wallet（ERC-4337 托管账户）

- 机制：Kernel v0.3.3 智能账户 + 标准 EntryPoint v0.7 `0x0000000071727De22E5E9d8BAf0edAc6f37da032`；CREATE2 预计算地址，`deployment_status`：PREDICTED（可收不可转，转账返回 409 WALLET_NOT_READY）→ DEPLOYING → DEPLOYED。平台托管私钥、代付部署 gas。
- `POST /v1/wallets`：body `{ external_agent_id, chain_id, idempotency_key }`（chain_id 主网 677）。响应含 `id`(wallet_id)、`account_address`（收款地址）、`owner_address`（控制地址，**勿转账给它**；身份注册需要）。
- 白名单**强制**：空白名单不能向任何地址转账。`POST /v1/wallets/{id}/whitelist` 按 (wallet_id, chain_id, address) 增删收款人；入金前先配白名单。
- `POST /v1/wallets/{id}/deploy`：显式部署，轮询 `GET /v1/wallets/{id}` 至 DEPLOYED。
- `POST /v1/wallets/{id}/transfers`：`amount` 为最小单位的纯数字字符串；原生代币 `token_address` 用字面量 `BOT_NATIVE`；禁止自转账。
- `GET /v1/user-operations/{hash}`：终态 SUCCEEDED / REVERTED（上链失败）/ FAILED（未上链）。
- `POST /v1/wallets/{id}/status`：PAUSED（可恢复）/ REVOKED（永久）。
- 错误码示例：WHITELIST_DENIED、INSUFFICIENT_BALANCE、WALLET_NOT_READY。
- Webhook（可选）：校验 `X-Callback-Token`（常数时间比较）、快速 2xx、幂等、按 `updated_at` 乱序防护。**首版集成用轮询，不接 webhook。**

## 2. Agent Identity（ERC-8004，链上身份 NFT）

- 主网 IdentityRegistry（代理地址，始终调用它）：`0xB43Edfb9C7609cF645e932B2fF20f26F0d4488dE`（测试网 `0xec8fFbC3c9A34AdDCbB3A14F91db2bd26A8b99c0`）。
- 合约是 ERC-721（AgentIdentity / 符号 AGENT）。链上只读验证（任何人可调，无需 key）：
  - `ownerOf(uint256)` 选择器 `0x6352211e` → 控制者地址；revert 视为"不存在"。
  - `getAgentWallet(uint256)` → Agent 钱包地址（零地址=未绑定）。
  - `tokenURI(uint256)` 选择器 `0xc87b56dd` → 描述文件 URL；验证时按"读 tokenURI → 原样取文件 → 文件字段与链上一致"流程，URI 会变、勿永久缓存。
  - `getVersion()` 当前 2.0.0。
- `POST /v1/agents/identities`（identity-api）：body 必含 `external_agent_id`、`wallet_id`、`chain_id`、`owner_address`、`wallet_address`、`metadata`（`name` 必填非空）。需 Idempotency-Key。**一个 wallet_id 全局只能属于一个身份（409）**。返回 202 + `identity_id`。注意：写接口响应包在 `identity` 字段里，读接口直接返回对象（最常见集成错误）。
- 状态流转：PENDING → GAS_FUNDING → REGISTERING → METADATA_PENDING → REGISTERED。轮询 `GET /v1/agents/identities/{id}`。REGISTERED 后可查到 agent token id（NFT tokenId）。
- 钱包绑定：REGISTERED 后 `POST /v1/agents/identities/{id}/wallet-binding`（过早调返回 425），完成时 `wallet_binding_status=CONFIRMED`。
- 错误处理：400/401/404/409 不重试；425 稍后重试；5xx 指数退避。更新元数据会重新发布文件并更新链上 URI。
- 首版集成范围：注册 + 轮询到 REGISTERED + 读 token id / ownerOf 展示；**不做** suspend / 元数据更新 / webhook。

## 3. 慢记集成设计（已定稿，实现按此执行）

### 3.1 环境变量（.env.local，机密）
```
AGENTOS_API_KEY=          # 官方签发，ak_mainnet_…；空=功能关闭
AGENTOS_WALLET_API=https://wallet-api.botchain.ai
AGENTOS_IDENTITY_API=https://identity-api.botchain.ai
AGENTOS_CHAIN_ID=677
```
（`server/config.js` 增加 `agentos` 段，加载方式与 onchain 一致。）

### 3.2 数据库（新表，参照 db.js 现有建表风格）
```sql
CREATE TABLE IF NOT EXISTS agentos_identities (
  home_id TEXT PRIMARY KEY,            -- 一个家一条：小狗的链上身份
  external_agent_id TEXT NOT NULL,     -- 例：manji-<home_id>-puppy
  wallet_id TEXT, account_address TEXT, owner_address TEXT,
  wallet_status TEXT DEFAULT 'PENDING',   -- PREDICTED/DEPLOYING/DEPLOYED
  identity_id TEXT, agent_token_id INTEGER, identity_status TEXT DEFAULT 'PENDING',
  -- PENDING→GAS_FUNDING→REGISTERING→METADATA_PENDING→REGISTERED
  registered_at TEXT, error TEXT, created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS agentos_tips (
  id TEXT PRIMARY KEY, home_id TEXT NOT NULL, from_user_id TEXT NOT NULL,
  amount_bot TEXT NOT NULL, tx_hash TEXT, status TEXT DEFAULT 'pending',
  created_at TEXT, updated_at TEXT
);
```

### 3.3 路由（server/routes/agentos.js，风格同 onchain.js）
- `GET /api/agentos/status`：{ mode: off|ready, chainId, identityRegistry, puppy: null|卡片数据 }。**登录可看**。registry 地址主网 `0xB43Edf…88dE`。
- `POST /api/agentos/puppy/register`：幂等。流程（服务端串行编排，全部 try/catch 落库）：
  1. 已 REGISTERED → 409 ALREADY_REGISTERED（带现有卡片）；
  2. 无 key → 409 AGENTOS_NOT_CONFIGURED；
  3. 读宠物名（现有 pets 表，getPet）作 metadata.name（必填非空；无名字用「慢记小狗」）；
  4. 建 wallet（POST /v1/wallets，external_agent_id=`manji-<homeId>-puppy`）→ 落库 PREDICTED；
  5. 注册身份（POST /v1/agents/identities，含 wallet_id/owner_address/wallet_address/metadata）；
  6. 返回 { identityId, status }，后台每 15s 轮询（复用 onchain 的 setInterval 模式，unref）：
     钱包 DEPLOYED 触发 deploy 调用（PREDICTED→显式 deploy）；身份到 REGISTERED 记 agent_token_id；失败落 error。
- `GET /api/agentos/puppy`：卡片数据（小狗名、agentTokenId、accountAddress、状态、error）。
- `POST /api/agentos/puppy/tip`：body { amountBot }。落 agentos_tips 一行 pending 并返回 { tipId, toAddress: account_address, amountWei }——**实际转账由成员已连接的钱包在前端直接发 BOT 转账交易（to=account_address）**，前端拿到 txHash 后 `POST /api/agentos/puppy/tip/:tipId/bind { txHash }` 落库（参照 onchain bind 模式，剥 0x）。金额换算：amountWei = BigInt(Math.round(amountBot*1e6))*10n**12n（避免浮点直转）。
- `server/index.js`：注册路由 + 启动轮询（如 `startAgentosPoller()`）+ PUBLIC_ROUTES 不放行（全部需登录）。

### 3.4 前端（public/app.js + styles.css；不新增文件）
- 永恒之链页 BOT Chain 面板下方新增「🐕 链上小狗」卡片：
  - off：提示"已准备好接入 BOT Chain Agent OS（ERC-8004 链上身份）——等待官方 API key"，附 `docs/agentos-api-spec.md` 说明；
  - 未注册：按钮「给我们的小狗上链上身份」→ POST register → 卡片变轮询态（15s 刷新）；
  - REGISTERED：展示 `链上身份 #agentTokenId`（NFT）、ownerOf 验证按钮（连接钱包时经钱包 RPC `ownerOf` eth_call 直读 registry，选择器 0x6352211e + tokenId；否则服务端核验接口 `GET /api/agentos/puppy/verify`）、浏览器地址链接 `https://scan.botchain.ai/address/0xB43Edf…`；
  - 打赏：连接钱包后按钮「给小狗 BOT 打赏」→ 输入金额 → sealViaWallet 同款模式发原生转账（to=account_address, value=wei）→ bind。**value 转账用 eth_sendTransaction params 里 value 字段（hex wei）**。
- `GET /api/agentos/puppy/verify`：服务端经 rpc()（复用 public-chain.js 的 rpc）eth_call ownerOf(tokenId)，返回 owner 地址。
- 事件委托挂链页容器（`.chain-list` 之外的卡片也要绑：直接在 viewChain 渲染后 querySelector 绑定即可，卡片不做局部刷新轮询，整页 route() 刷新）。
- 文案基调：温暖、不堆术语；核心句「小狗在 BOT Chain 上有了自己的名字和钱包」。

### 3.5 测试（tests/agentos-acceptance.mjs，纯离线，风格同 onchain-acceptance.mjs）
- API key 缺失时 status=off、register 409；
- amount→wei 换算正确（1.5 BOT → 1500000000000000000）；
- ownerOf calldata = 0x6352211e + tokenId 左补零；
- wallet/identity 请求体字段符合规格（mock fetch 断言 URL/头/body）。
- package.json scripts 增加 `"test:agentos": "node tests/agentos-acceptance.mjs"`。

### 3.6 明确不做（首版）
- webhook、suspend、元数据更新、小狗钱包主动转账（transfers）、白名单管理（打赏是外部转入，无需白名单；小狗钱包转出留待官方确认场景）。
