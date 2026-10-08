# 慢记 Manji v3.0 · 开发决定记录

记录本次开发中做出的、计划书未逐项锁定的实现决定。均为计划书 1.4 节允许的 MVP 假设或工程选择，应在上线评审时复核。

## 身份与家

- 每个用户注册即拥有一间 `solo` 个人家 + 一只家小狗；`users.current_home_id` 指向当前活跃家。
- 接受邀请后：发起者之家转为 `shared`，受邀者 `current_home_id` 切换到共同家；受邀者自己的个人家保持 `solo` 不冻结，其内容在"回忆"里以"我的其他空间"可见（仅本人内容）。这是对"旧共同容器保留最小结构"的对称处理。
- 解除关联后：共同家 `frozen`，双方 `current_home_id` 回到各自个人家；若个人小狗仍为默认名/外观，则继承共同家小狗的名字与外观（计划书 6.4.5"可保留共同选定的小狗外观与名字"的落地）。
- 冻结家的容器对成员保留"归档视图"：只返回本人贡献与安全元信息；无本人可展示内容且标题来自对方时显示"已归档的回忆"。

## 内容与权限

- 容器可见性：`container.visibility = home` 当且仅当存在任一成员的共享贡献；全部撤回后回落 `private`。
- 纪念物与摆放：物件 `visibility` 跟随作者贡献的共享状态在 `private`/`home` 层之间移动；撤回共享时若共同层占位冲突则收入收纳盒。两个层级的位置占用互相独立。
- 每层每位置最多一个 `displayed` 摆放；并发抢占同一位置返回 409 并附当前空位列表。
- 事件日期不允许未来（未来安排属于承诺/纪念日）；默认业务今天（Asia/Shanghai）。
- 标题可留空；`safeTitle` 由本人最新版正文截取或"一段回忆"兜底，撤权/冻结时对外只暴露 safeTitle。

## 媒体

- 上传三步：`POST /api/media/uploads`（登记暂存）→ `PUT /api/media/uploads/:id/blob`（原始字节，≤10MiB）→ `POST /api/media/uploads/:id/complete`（魔数与结构校验：JPEG 段遍历、PNG IHDR/IEND、WebP RIFF 块）。校验失败即删除暂存文件，不产生可访问的孤儿文件。
- 缩略图由客户端 Canvas 生成（最长边 640 JPEG），与原图同一权限通道读取；服务端不落任何公开 URL。
- 响应头 `Cache-Control: private, no-store`，撤权后立即失效（浏览器已下载副本无法收回，界面如实说明）。

## 授权、作品与导出

- ConsentGrant 绑定"具体贡献版本集合 + 用途（作品/导出）+ 接收范围"；批准后任何一版有新版本或撤回共享，授权自动失效，引用它的任务取消、产物停止下载。
- 明信片渲染：客户端 Canvas 真实排版（3 个模板）生成 PNG → 上传为作品产物；任务状态 `queued → running → ready/failed/cancelled` 全部真实，下载时第三次验权。
- 导出：服务端即时构建 ZIP（STORED），含 manifest.json、memories.md、本人（或获授权版本）正文与原附件；下载时再次验权。

## 提醒与回顾

- 站内提醒在用户拉取 `/api/notifications` 时惰性生成，`(userId, sourceId, occurrenceDate)` 唯一键去重；生成前重新校验归属、范围、暂停与家状态。
- 回顾（旧物卡）按需拉取，候选经过授权、隐藏、排除、删除、冻结、摆放状态过滤；可整体关闭或排除单条。

## 工程

- 写操作支持 `Idempotency-Key`（同键同负载重放原结果、同键异负载 409）；更新操作支持 `expectedRevision`（不匹配 409 且不覆盖）。
- 变更类请求要求自定义头 `X-Manji-Client`，配合 SameSite=Lax 作为 CSRF 防线；服务端不启用 CORS。
- 密码 scrypt；会话令牌 256 位随机、库内存 SHA-256 摘要；日志不输出令牌、邀请码明文与正文。
- 前端草稿仅存本设备 localStorage，按 userId 隔离，切换登录不互见；"恢复草稿"需用户明确点击。

## 浏览器走查中发现并修复的问题

- 「我的」页 spaces 数据解构错误（`spaces.data.map` → `spaces.map`）。
- toast 提示淡出后仍拦截点击 → 增加 `pointer-events: none`。
- 空家状态下全屏遮罩盖住房间插画 → 改为房间卡片下方的引导条。
- 已放置纪念物在插画中不够醒目 → 增加投影底座与白色提示环；小狗增加项圈提升辨识度。
- 视觉分析服务曾把 44px 贝壳误认为毛线团，加大可见性处理后确认可识别。

## 已知未完成项（诚实清单）

- 缩略图依赖客户端 Canvas：老浏览器（不支持 Canvas 的环境）无法上传照片，但文字回忆不受影响。
- 提醒仅站内，未接系统推送（计划书允许）。
- 制作补贴、语音、实体制作等 P1 未实现，界面显示"活动开放后查看"。
- 未做登录失败限流（单机演示风险低，上线前应补）。
- M10/M36/M50 的失败注入场景未做专项脚本（对应防御为实现层：幂等键、失败重试 UI、事务回滚）。

## v3.6 公共链锚定（BOT Chain 主网）

- 合约 `ManjiEternalChain`（Solidity 0.8.24/paris/优化 200）：只登记承诺哈希与本地链头部哈希；`seal/sealBatch(≤256)/anchorHead` 三个 append-only 写入口，`sealOf/sealsOf/sealCount/sealAt/headOf` 读核验；`owner`（部署即固定）唯一操作是 `setRelayer`；不接收转账；重复承诺按 `AlreadySealed` 回滚，头部只可向前（`HeadNotAdvancing`）。
- 双方同意不上链复核（链下强制），交易由统一 relayer 账户发送——不把成员钱包签名发进合约（签名可恢复地址，反而暴露身份）。
- `anchorHead` 的 bytes16 链编号 = SHA-256(应用链编号 base64url 串) 前 16 字节（链编号是随机串非十六进制，派生规则确定性、可第三方复算）。
- 服务端零 npm 依赖：自实现 Keccak-256（载入时与 solc 编译输出的 7 个函数选择器比对自检）；JSON-RPC 用原生 fetch，失败自动降级 curl（本机实测主网节点对 Node TLS 指纹丢包）；ethers 仅为可选依赖（自动提交的本地签名），缺失时降级手动模式。
- 提交后台：15 秒循环带互斥锁（重入曾造成重复提交并被合约回滚，已修复）；只提交「已成功调用 sealOf 确认不在链上」的行；确认以回执 + 链上 sealOf/headOf 双重判定，支持自愈。
- 机密管理：relayer 私钥只存 `.env.local`（`config.js` 在 `.env` 之后加载覆盖；`.gitignore` 与交付打包双重排除）。
- 主网部署与实测记录见 `contracts/DEPLOYED-mainnet.json`（地址 `0x9757b6fd…c627`）。
