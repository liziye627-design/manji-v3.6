# 慢记 Manji · BOT Chain 集成说明与录屏脚本

> 本文回应评审意见："暂未看到 BOT Chain 与核心产品功能的明确关系，请说明具体使用 BOT Chain 的功能，并提供完整操作录屏、主网合约地址和对应交易链接；保证页面有 C 端可交互（可连接钱包并部署在主网 677）。"

## 一、结论速览

| 评审要求 | 慢记的现状 |
| --- | --- |
| 主网合约地址 | **BOT Chain 主网（链 677）** `ManjiEternalChain` **v2**：[`0x59551d78e15ee25e512c678bfd4b6781f065f560`](https://scan.botchain.ai/address/0x59551d78e15ee25e512c678bfd4b6781f065f560) |
| C 端可交互（连接钱包） | 「永恒之链」页内置 **连接钱包（EIP-1193，MetaMask/OKX/TokenPocket 等）**，自动添加/切换 BOT 主网 677，**由用户自己的钱包直接签名上链** |
| 哪一步写入 BOT Chain Mainnet | 两条路径，见下文第三节；页面每一步都有明确的 UI 状态与浏览器交易链接 |
| 交易链接 | 见下文第四节证据表（部署、E2E、任意钱包直写均有真实交易） |
| 线上地址 | **https://love.agentcrop.work** （已部署，登录后进入「纪念 → 永恒之链」） |

慢记是"两个人的回忆小家"：约定与日记先在本地永恒之链镌刻（哈希存证），再**自愿**把承诺哈希提交 BOT Chain 公共链。BOT Chain 在产品中的角色是**公共存证账本**：链上登记的承诺指纹永久不可篡改、任何人可独立核验，使存证不依赖本应用是否存活。

## 二、具体使用的 BOT Chain 功能

| 合约功能 | 在产品中的作用 | 调用方 |
| --- | --- | --- |
| `seal(bytes32)` / `sealBatch(bytes32[])` | 登记一条/一批承诺哈希（SHA-256(域名‖内容‖随机盐)，32 字节；不含正文/照片/身份） | v2 起任何钱包；或服务端 relayer |
| `sealOf(bytes32)` | 核验一条承诺是否已登记（返回 found/index/sealedAt）——任何人可独立调用，不依赖本应用 | 用户钱包 / 服务端 / 任意第三方 |
| `anchorHead(bytes16,bytes32,uint64)` | 锚定本地永恒之链最新头部哈希：一笔交易保护整条本地链的历史 | owner/relayer |
| `sealCount()` / `sealAt(i)` / `headOf` | 公开只读：第三方完整拉取与复核 | 任意人 |
| `Sealed` 事件 | 链上登记回执（承诺、序号、时间戳），可被浏览器与索引器追踪 | — |

隐私模型：默认路径由统一 relayer 账户代发（成员地址不出现在交易里）；**钱包直发路径**由成员自愿选择（该钱包地址会公开出现在交易发起者里——这正是"这一笔是我亲手刻上去"的证明）。无论哪条路径，**链上都只有哈希，没有正文**。

## 三、端到端流程：哪一步写入 BOT Chain Mainnet

### 路径 A：用户钱包直发（C 端主网交互，v3.6.1 上线，录屏主推）

1. 打开 https://love.agentcrop.work，登录，进入「纪念 → 永恒之链」。
2. 页面显示 **⛓ BOT Chain 主网存证** 面板：合约地址（可点进浏览器）、链 677、当前模式。
3. 点击 **连接钱包** → 钱包弹授权框（eth_requestAccounts）→ 自动添加/切换 **BOT Chain Mainnet（677）**。
4. 在任一已镌刻的区块上点击 **⛓ 提交到 BOT 主网**。
5. **写入 BOT Chain Mainnet 的就是这一步**：页面把 `seal(承诺哈希)` 的交易交给用户钱包 → 钱包弹出签名确认（可见合约地址与 calldata，calldata 只有 4 字节选择器 + 32 字节哈希）→ 用户确认 → 交易广播上链。
6. 页面回填交易哈希，徽章变为「主网：已发送，等待确认」并给出 [scan.botchain.ai](https://scan.botchain.ai) 交易链接；确认后变为「⛓ 主网已登记 #序号」。
7. 点击 **向主网核验** → 经用户钱包的 RPC 直接 `eth_call sealOf`（或服务端核验）→ 显示是否已登记及序号。

### 路径 B：服务端 relayer 代提交（后端链上交互，隐私默认路径）

1. 用户在区块上点击「提交到 BOT 主网」，页面选择服务端代提交（未连接钱包时自动回退；或运营环境配置为自动模式）。
2. 服务端把承诺加入队列，后台每 15 秒查重（先 `sealOf` 确认未登记）。
3. **写入 BOT Chain Mainnet 的一步**：relayer 用统一代提交账户（`0x4844F22482B0e08dc9b44d153a723863F576b178`）本地签名 `seal`/`sealBatch` 交易并经 `eth_sendRawTransaction` 广播。
4. 出块后服务端自动回填登记序号与时间，页面徽章更新并给出浏览器链接。

> 两条路径写入的是同一个合约的同一类数据；A 路径交易发起者是用户钱包，B 路径是 relayer。私钥只在开发机 `.env.local`，永不进入仓库与线上服务器。

## 四、主网交易证据（全部可在 scan.botchain.ai 查验）

**当前生效合约 v2（VERSION()="2"，seal 对所有钱包开放）**

| 事项 | 交易哈希 / 链接 |
| --- | --- |
| v2 部署交易（块 26176256，gasUsed 757475） | [0x502c6f306d86265c462d2f73ace29f329b157c1aeaaa4d83bda2706e048ab1c9](https://scan.botchain.ai/tx/0x502c6f306d86265c462d2f73ace29f329b157c1aeaaa4d83bda2706e048ab1c9) |
| E2E：约定+日记经 sealBatch 登记（index=0,1，relayer 路径，2026-10-10） | [0x7b2dfc064c80bc73e97a7be168bb342fc7d2c5518cef5cd56333f84e1e3ffc46](https://scan.botchain.ai/tx/0x7b2dfc064c80bc73e97a7be168bb342fc7d2c5518cef5cd56333f84e1e3ffc46) |
| E2E：本地链头部 anchorHead（高度 2，2026-10-10） | [0x2cfe6dfbf3e5a0ede1032b15e6cf6d1fac99ef456c9a65b70a88ad366de35354](https://scan.botchain.ai/tx/0x2cfe6dfbf3e5a0ede1032b15e6cf6d1fac99ef456c9a65b70a88ad366de35354) |
| **任意普通钱包直写证明**：随机钱包 0xFB578a33…1269A（非 owner/relayer）直接 seal 成功（index=2，2026-10-10） | [0x19f0035b03a29fd839ec31dcad3a559bfd72bd77877cf55fe6dc3340aaa329f2](https://scan.botchain.ai/tx/0x19f0035b03a29fd839ec31dcad3a559bfd72bd77877cf55fe6dc3340aaa329f2) |

**历史合约（数据仍可独立核验，记录见 `contracts/DEPLOYED-mainnet.json`）**

| 合约 | 事项 | 交易哈希 |
| --- | --- | --- |
| v1 `0xDf6d55959BD6abCdE5750D800F782637115b672D` | sealBatch E2E（index=0,1） | [0xe23664b7…13be3](https://scan.botchain.ai/tx/0xe23664b7a32b1a07b1829c041d4379ad1a9708dee7cd57b2b93f03c751713be3) |
| v1 | anchorHead 头部锚定 | [0x28b9d50b…49770](https://scan.botchain.ai/tx/0x28b9d50bc14ace58f80817e1330490bde17fe225d1ad9c2ff062e90f00b49770) |
| v0 `0x9757b6fd786fb77545a288e98fc06a6c04bfc627` | 部署交易 | [0x7961f165…48a4b](https://scan.botchain.ai/tx/0x7961f1650163b75d52448235912acbb7e47a3e29b5d5e9253895527fb2448a4b) |
| v0 | seal 测试指纹（index=0） | [0x1f11efed…d615e](https://scan.botchain.ai/tx/0x1f11efed9e0958e200cfc06fc811cf297319ba8c89527e4a01bace8703cd615e) |

## 五、录屏脚本（供项目方录制，约 3 分钟）

准备：Chrome + MetaMask（或 OKX 钱包），钱包内有少量 BOT 付 Gas；慢记账号一对（双方同意的共同约定）。

1. **0:00–0:20** 打开 https://love.agentcrop.work → 欢迎页即展示「有些话，值得永远作数」区块（BOT Chain 主网 · 链 677 徽章）；点「免登录核验存证」进入 **#/verify 公开核验门户**：无需登录即可看到合约、主网登记总数，粘贴一笔交易哈希当场查回登记的承诺（评审可现场自测这一页）。
2. **0:20–0:35** 登录 → 写下一条双方同意的约定 → 点「⛓ 镌刻上链」→「我愿意，镌刻」→ 本地永恒之链出块。
3. **0:35–1:10** 在「已封存」弹窗直接点 **「⛓ 刻上 BOT 主网」**（一步完成，无需跳页）：连接钱包 → 自动切到 BOT 主网（链 677）→ 钱包签名弹窗特写（To=合约地址、Data=`0xb07eeda8`+承诺哈希，没有正文）→ 确认。
4. **1:10–1:40** 弹窗变为「已刻上 BOT 主网」并给出交易哈希 → 点「浏览器查看交易」打开 scan.botchain.ai 交易页等状态变 Success。
5. **1:40–2:10** 回到「永恒之链」页：面板显示合约、主网登记总数；该块徽章为「⛓ 主网已登记 #N」；点「向主网核验」经钱包 RPC 直读 sealOf。
6. **2:10–2:30** 约定列表卡片带「⛓ 主网 #N」绿色徽章——链上状态融入产品主界面。
7. **2:30–3:00**（可选，证明后端路径）在开发机运行 `node tests/onchain-e2e-mainnet.mjs`，展示 relayer 自动 sealBatch + anchorHead 的控制台输出与两笔交易链接。

> 门户地址：**https://love.agentcrop.work/#/verify**（免登录）。任何人在任何设备打开即可核验，完全不依赖慢记账号体系。

## 六、评审可独立核验（不依赖本项目）

```bash
# 合约代码与版本（VERSION() 返回 "2"）
curl -s https://rpc.botchain.ai -X POST -H 'content-type: application/json' -d \
 '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"0x59551d78e15ee25e512c678bfd4b6781f065f560","data":"0xffa1ad74"},"latest"]}'

# 已登记承诺总数（sealCount()）
curl -s https://rpc.botchain.ai -X POST -H 'content-type: application/json' -d \
 '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"0x59551d78e15ee25e512c678bfd4b6781f065f560","data":"0x726804ab"},"latest"]}'

# 核验任意钱包直写的承诺（sealOf，返回 found/index/sealedAt；承诺哈希取自交易 0x19f0035b… 的 calldata）
curl -s https://rpc.botchain.ai -X POST -H 'content-type: application/json' -d \
 '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"0x59551d78e15ee25e512c678bfd4b6781f065f560","data":"0x3038bfa56d616e6a692d7065726d697373696f6e6c6573732d70726f62652d323032362d"},"latest"]}'
```

合约源码：`contracts/ManjiEternalChain.sol`（solc 0.8.24，无代理、无升级、无删除，append-only；owner 唯一权限是轮换 relayer）。

## 七、已上线：链上小狗身份（自托管 ManjiPuppyIdentity，ERC-8004 风格）

让每只小狗在 BOT Chain 上拥有**自己的链上身份**：名字直接写上链（谁也改不了）、铸造时间即链上生日、附带「存钱罐」地址可收 BOT 打赏。**铸造由成员自己的钱包直接签名**——比服务端代办更强的 C 端主网交互。

背景：官方 Agent OS 托管 API（Agent Wallet + IdentityRegistry）按项目签发 key，慢记暂未获批，因此自部署了语义一致的 [ManjiPuppyIdentity 合约](../contracts/ManjiPuppyIdentity.sol)（ERC-8004 风格：ownerOf / getAgentWallet / tokenURI；身份 NFT 不可转让；tokenURI 是链上自包含的 data-URI 身份文件，含爪印 SVG 头像，不依赖任何服务器）。官方 API 契约规格保留在 [docs/agentos-api-spec.md](docs/agentos-api-spec.md)，将来获批可随时切回托管模式。

| 能力 | 说明 |
| --- | --- |
| 小狗链上身份 NFT | 成员钱包在页面里直接签名 mint（名字 + 存钱罐地址）；合约地址见下表，tokenId 即「链上身份 #N」 |
| ownerOf 公开核验 | 任何人可对合约直接 `eth_call ownerOf(tokenId)`（选择器 `0x6352211e`）核验身份归属，不依赖本应用存活 |
| BOT 打赏存钱罐 | 身份自带存钱罐地址（owner 可经 setAgentWallet 更换），成员用已连接的钱包直接向小狗转 BOT，交易哈希回填慢记留档 |

**主网证据（scan.botchain.ai 可验）：**

| 事项 | 交易哈希 / 链接 |
| --- | --- |
| ManjiPuppyIdentity 部署（`0x9acf5fb43b544d4a62ee5b66d78e1d79c87466d5`，块 26192525，gasUsed 1548048） | [0x6f38e1f5…93b8cc](https://scan.botchain.ai/tx/0x6f38e1f5f6cdb64fce666d8e88cc3ade696348547d888ef5451282374293b8cc) |
| 史上第一枚铸造：mint("慢记小狗·链上第一名", 存钱罐) → tokenId=0，gasUsed 137520；ownerOf/nameOf/getAgentWallet/tokenURI 链上复核一致 | [0x9dc5fdd7…320beb](https://scan.botchain.ai/tx/0x9dc5fdd7d64567d52773958ef48b842e9961d22ef8a5511dbeb9a2065e320beb) |

录屏补充（在第五节脚本的第 5 步后加入）：在「永恒之链」页的「🐕 链上小狗」卡片点「给我们的小狗铸链上身份」→ 填名字与存钱罐 → 钱包签名确认 → 卡片变「链上身份 #N」并给出铸造交易链接 → 点「向主网核验这个身份」→（可选）打赏 BOT 给小狗的存钱罐。
