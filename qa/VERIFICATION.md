# 慢记 Manji v3.6 验证报告（公共链锚定 / BOT Chain 主网）

日期：2026-10-08。本报告记录 v3.6「日记与承诺上链」交付的验证过程与证据。所有结论均可复现，命令附后。

## 1. 合约编译验证（真实 solc）

- 工具：solc 0.8.24（与部署一致），命令 `node scripts/compile-contract.mjs`
- 结果：**编译通过，0 error / 0 warning**；字节码 3454 字节；ABI 与字节码导出至 `contracts/build/`
- 14 个函数选择器由编译器输出（b07eeda8=seal(bytes32) 等），并被 `server/domain/keccak.js` 在载入时逐一比对自检——服务端 Keccak-256 实现与编译器一致。

## 2. 离线验收（不需要网络）

`node tests/onchain-acceptance.mjs` → **15/15 通过**：

- Keccak-256 公开向量（空串、abc）+ 7 个编译器选择器交叉验证
- seal/sealBatch/sealOf/anchorHead/headOf 的 calldata 逐字节符合 EVM ABI
- sealOf/headOf 返回值解码（未登记/已登记/空响应不误报）
- 十六进制与批次上限（256）校验
- 承诺与本地永恒之链完全一致：同内容同盐同哈希、字段顺序无关、改一字即变

## 3. 回归（v3.5 及之前功能不受影响）

- `node tests/run-acceptance.mjs` → **101/101 通过**
- `npm run test:chain` → **18/18 通过**（本地永恒之链：双方同意门槛、篡改检测、导出复算等）
- `npm run test:navigation` → **21/21 通过**

## 4. 主网部署与功能验证（BOT Chain 677，真实交易）

| 步骤 | 结果 |
|---|---|
| 部署前断言 | `eth_chainId` = 0x2a5（677）精确匹配，余额 0.2587 BOT，预估 Gas 808146 |
| 部署 | tx `0x7961f1650163b75d52448235912acbb7e47a3e29b5d5e9253895527fb2448a4b`，区块 25925515，Gas 800625，**Success** |
| 代码落地 | `eth_getCode` 读到 3361 字节运行时代码 |
| 角色读取 | `owner()` = `relayer()` = `0x4844F22482B0e08dc9b44d153a723863F576b178` |
| seal 测试 | 测试指纹 `0x1111…11`（应用代码生成的 calldata），tx `0x1f11efed…cd615e`，Gas 90731 |
| sealOf 核验 | found=true, index=0, sealedAt=2026-10-08T03:03:40Z；sealCount 0→1 |

## 5. 应用端到端实测（`node tests/onchain-e2e-mainnet.mjs`，真实主网交易）

流程：注册两人 → 成家 → 共同约定（双方点「我也愿意」）→ 本地镌刻 → 「提交公共链」→ 后台自动提交 → 应用内核验；日记同流程；另做本地链头部锚定。

- 约定+日记两条承诺经 **sealBatch 一笔交易**登记：tx `0x2402891f6264c32fc35d65cd23e4283f0d25f5f9d8dbe470ccf055efe7f57040`（index=5、6）
- 应用内 sealOf 核验：found=true, index=5, sealedAt=2026-10-08T03:24:08Z
- 本地链头部（高度 2）anchorHead 锚定：tx `0xba19388f8f97b1bad8923abea18657b8c78b00d50084e46fbca2989e1cec1dd8`，已确认
- 浏览器可查：https://scan.botchain.ai/tx/0x2402891f6264c32fc35d65cd23e4283f0d25f5f9d8dbe470ccf055efe7f57040

## 6. 开发中发现并修复的问题（真实缺陷，均已修复并复测）

1. **后台循环重入导致重复提交**：tick 异步耗时超过 15 秒间隔时，`setInterval` 重入，两轮并发读到同一批 pending 重复发交易（被合约 `AlreadySealed` 回滚、浪费 Gas）。修复：互斥锁；且只提交「已成功调用 sealOf 确认不在链上」的行（网络故障宁可等待，绝不盲发）。
2. **链编号编码错误**：应用链编号是 base64url 串（非 32 位十六进制），`anchorHead` 校验抛错且失败静默，头部锚定永远无法确认。修复：bytes16 = SHA-256(链编号串) 前 16 字节（确定性、可第三方复算），并给提交失败加日志。
3. **测试期望串拼接错误**（sealBatch 偏移字 65 字符）：模块输出本来就正确，修正测试。
4. **本机 Node TLS 被主网节点选择性丢包**（fetch/https 均超时，curl 可通）：RPC 层增加 curl 自动降级，签名保持本地。

## 7. 隐私核验

- 链上交易输入/存储/事件仅含：承诺哈希、（头部锚定的）链编号派生字节、哈希与高度、序号、时间戳。**无正文、无照片、无成员地址、无关系状态、无类型标记。**
- 成员地址不出现在任何交易（发起者为统一 relayer 专用账户）。
- salt 与正文只存链下；存证凭证与整链导出不含正文。

## 8. 复现命令

```bash
npm i                                   # 安装可选依赖 ethers（自动提交签名用）
npm run compile:contract                # 需 npm i solc@0.8.24（或 NODE_PATH 指向已装目录）
npm run test:onchain                    # 离线 15 项
npm run test:chain                      # 本地链 18 项
node tests/run-acceptance.mjs           # 101 项
npm run test:navigation                 # 21 项
node tests/onchain-e2e-mainnet.mjs      # 主网端到端（真实 Gas，需 .env.local 配置 relayer 私钥）
node scripts/start-home.mjs             # 浏览器体验（永恒之链页 → 提交公共链 → 核验）
```
