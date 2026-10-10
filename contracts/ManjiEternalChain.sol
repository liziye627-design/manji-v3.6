// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title ManjiEternalChain —— 慢记·永恒之链 公共锚定合约（v1）
 * @notice 把两位成员共同封存的日记与约定，以「内容承诺（commitment）」的形式登记到 BOT Chain。
 *
 * ## 隐私模型（依据《心动铃铛-关系上链隐私与退出机制研究》）
 * 1. 链上永远只有内容指纹：承诺 = SHA-256("manji-anchor-v1" + "\n" + canonicalJSON(内容) + "\n" + salt)，
 *    以 32 字节（bytes32）传入本合约。正文、照片、昵称、钱包、关系状态一律不上链；
 * 2. salt 是 32 字节密码学随机数，只保存在链下（双方各自的存证凭证里）。
 *    外部观察者即使拿到全部链上数据，也无法枚举、比对出任何正文；
 * 3. 提交路径二选一，由成员在应用里自愿选择：
 *    a) 默认：由统一「代提交账户（relayer）」发送——成员地址不出现在交易的任何位置；
 *    b) 钱包直发（v2 开放）：成员用自己的钱包在页面里直接签名发送 seal 交易——
 *       此时该钱包地址会公开出现在交易发起者里。这是自我托管签名的固有属性，
 *       也是「这一笔是我亲手刻上去」的证明；承诺内容仍然只是哈希。
 * 4. 双方同意在链下核验：共同约定须两人都点过「我也愿意」（应用内强制），
 *    日记由作者本人发起。本合约只登记承诺，不复核、也无法复核同意过程——
 *    这是诚实的信任边界：合约证明「某承诺在时间 T 已被登记」，
 *    不证明「登记时确已取得双方同意」；同意凭证由双方各自离线保存。
 *
 * ## 为什么不用双签名进合约
 * 把两份钱包签名作为参数发进合约并不能匿名：任何人都可从签名恢复出签署地址，
 * 反而把成员地址写进了公开的交易输入。因此同意核验留在链下，合约输入只有哈希。
 *
 * ## 不可篡改的边界
 * 合约没有任何修改、删除、暂停或升级已登记数据的函数；没有代理、没有 owner 后台写权限。
 * owner（部署者，构造时固定、不可转让）唯一的操作是更换 relayer；
 * relayer 私钥最坏情况下的影响也只是登记无效哈希（垃圾数据），无法触碰任何已登记承诺。
 * v2 起 seal/sealBatch 对所有人开放（公共存证账本：任何钱包都能登记一个哈希，
 * 重复登记被 AlreadySealed 拒绝；垃圾哈希与真实承诺在链上不可区分，这正是匿名性的来源），
 * anchorHead 仍仅限 owner/relayer——头部槽位是稀缺资源，开放的写权限只给 append-only 的承诺。
 * 合约不接收任何转账。
 */
contract ManjiEternalChain {
    // ---------- 常量 ----------
    string public constant APP = "manji-eternal-chain";
    string public constant VERSION = "2";
    /// @notice 单笔交易最多登记的承诺数量（限制单笔 Gas，也避免长数组扰乱浏览器展示）
    uint256 public constant MAX_BATCH = 256;

    // ---------- 存储 ----------
    /// @notice 部署者：唯一权限是更换 relayer。构造时固定，不可转让（更少的权力 = 更可预测）
    address public immutable owner;
    /// @notice 统一代提交账户：默认代替两位成员发送登记交易（隐私路径），也是唯一可锚定头部的账户之一（可以是部署者自己）
    address public relayer;

    /// 一条承诺的登记回执：出现在链上的序号与时间
    struct SealRecord {
        uint64 index; // 全合约第几条（0 起），可用 sealAt(index) 反查承诺
        uint64 sealedAt; // 登记时的区块时间戳（秒）；0 表示未登记
    }

    /// 一条本地「永恒之链」的头部锚定回执
    struct HeadAnchor {
        bytes32 headHash; // 本地链最新区块哈希（锚定头部 = 一次交易保护整条本地链的历史）
        uint64 localHeight; // 被锚定时的本地链高度
        uint64 anchoredAt; // 锚定时的区块时间戳（秒）；0 表示从未锚定
    }

    /// 承诺 => 登记回执（全局唯一：承诺含 32 字节随机盐，天然不会冲突）
    mapping(bytes32 => SealRecord) private _seals;
    /// 按登记顺序排列的全部承诺（公开只读，便于第三方完整拉取核验）
    bytes32[] private _sealList;
    /// 本地链编号（应用生成的随机 16 字节，非用户身份）=> 最新头部锚定
    mapping(bytes16 => HeadAnchor) private _heads;

    // ---------- 事件 ----------
    /// @notice 一条承诺被永久登记。不含发送者地址（交易发起者本身是公开的，由 relayer 模型统一承担）
    event Sealed(bytes32 indexed commitment, uint64 index, uint64 sealedAt);
    /// @notice 一条本地链的最新头部被锚定
    event HeadAnchored(bytes16 indexed localChainId, bytes32 headHash, uint64 localHeight, uint64 anchoredAt);
    /// @notice relayer 轮换（唯一的后台操作，不触及任何已登记数据）
    event RelayerRotated(address indexed previous, address indexed next);

    // ---------- 错误 ----------
    error Unauthorized(address caller);
    error ZeroCommitment();
    error EmptyBatch();
    error BatchTooLarge(uint256 size, uint256 max);
    error AlreadySealed(bytes32 commitment, uint64 index); // 重复登记被拒绝：同一条内容+盐只会有一条链上记录
    error ZeroLocalChainId();
    error ZeroHeadHash();
    error HeadNotAdvancing(bytes16 localChainId, uint64 currentHeight, uint64 proposedHeight);
    error IndexOutOfBounds(uint256 index, uint256 count);
    error NoEtherAccepted();

    modifier onlyWriter() {
        if (msg.sender != owner && msg.sender != relayer) revert Unauthorized(msg.sender);
        _;
    }

    constructor() {
        owner = msg.sender;
        relayer = msg.sender;
    }

    // 不接收任何转账：本合约是公共存证账本，不是资金托管
    receive() external payable {
        revert NoEtherAccepted();
    }

    // ---------- 写入（append-only，仅此三个入口） ----------

    /**
     * @notice 登记一条内容承诺（一次日记或一次约定）。调用前应用已链下核验双方同意。
     *         v2 起对任何钱包开放：应用默认经 relayer 代发（成员地址不上链），
     *         成员也可在页面里用自己的钱包直接签名发送（该地址将公开出现在交易发起者里）。
     * @param commitment SHA-256("manji-anchor-v1"‖canonicalJSON(内容)‖salt) 的 32 字节值
     * @return index 全链登记序号（0 起）
     */
    function seal(bytes32 commitment) external returns (uint64 index) {
        index = _sealOne(commitment);
    }

    /**
     * @notice 批量登记承诺（同一交易内完成，节省手续费）。整批原子：任一条重复或为零值则全部回滚，
     *         调用方需先在链下去重。与 seal 一样对任何钱包开放（v2）。
     * @return firstIndex 本批第一条的登记序号（批内第 i 条 = firstIndex + i）
     */
    function sealBatch(bytes32[] calldata commitments) external returns (uint64 firstIndex) {
        uint256 n = commitments.length;
        if (n == 0) revert EmptyBatch();
        if (n > MAX_BATCH) revert BatchTooLarge(n, MAX_BATCH);
        firstIndex = uint64(_sealList.length);
        for (uint256 i = 0; i < n; i++) {
            _sealOne(commitments[i]);
        }
    }

    /**
     * @notice 锚定一条本地「永恒之链」的最新头部。头部哈希覆盖该链此前全部区块，
     *         一次锚定即让第三方可核验「截至时间 T，这条本地链的完整状态就是它」。
     *         同一条本地链只能向前锚定更高的高度（只进不退）。
     * @param localChainId 应用为这条本地链生成的随机链编号（base64url 串）经
     *                     SHA-256 取前 16 字节得到的 bytes16——确定性派生，第三方用导出文件
     *                     里的链编号串按同一规则即可复算；它是随机编号，不是用户身份
     * @param headHash     本地链当前最新区块哈希
     * @param localHeight  该区块的高度
     */
    function anchorHead(bytes16 localChainId, bytes32 headHash, uint64 localHeight) external onlyWriter {
        if (localChainId == bytes16(0)) revert ZeroLocalChainId();
        if (headHash == bytes32(0)) revert ZeroHeadHash();
        HeadAnchor storage current = _heads[localChainId];
        if (current.anchoredAt != 0 && localHeight <= current.localHeight) {
            revert HeadNotAdvancing(localChainId, current.localHeight, localHeight);
        }
        uint64 at = uint64(block.timestamp);
        _heads[localChainId] = HeadAnchor({headHash: headHash, localHeight: localHeight, anchoredAt: at});
        emit HeadAnchored(localChainId, headHash, localHeight, at);
    }

    // ---------- 读取与核验 ----------

    /// @notice 已登记承诺总数
    function sealCount() external view returns (uint256) {
        return _sealList.length;
    }

    /// @notice 按序号反查承诺（供第三方完整拉取与复核）
    function sealAt(uint256 index) external view returns (bytes32 commitment) {
        if (index >= _sealList.length) revert IndexOutOfBounds(index, _sealList.length);
        return _sealList[index];
    }

    /// @notice 核验一条承诺是否已登记。这是「公共链存证」的核心读接口：
    ///         任何人（无需登录、无需信任本应用）拿凭证里的承诺即可核验。
    function sealOf(bytes32 commitment) external view returns (bool found, uint64 index, uint64 sealedAt) {
        SealRecord memory r = _seals[commitment];
        return (r.sealedAt != 0, r.index, r.sealedAt);
    }

    /// @notice 批量核验（演示与对账用，一次调用省去多轮往返）
    function sealsOf(bytes32[] calldata commitments) external view returns (bool[] memory found) {
        found = new bool[](commitments.length);
        for (uint256 i = 0; i < commitments.length; i++) {
            found[i] = _seals[commitments[i]].sealedAt != 0;
        }
    }

    /// @notice 查询一条本地链的最新头部锚定
    function headOf(bytes16 localChainId)
        external
        view
        returns (bool found, bytes32 headHash, uint64 localHeight, uint64 anchoredAt)
    {
        HeadAnchor memory h = _heads[localChainId];
        return (h.anchoredAt != 0, h.headHash, h.localHeight, h.anchoredAt);
    }

    // ---------- 后台（仅 relayer 轮换，不触及任何已登记数据） ----------

    function setRelayer(address next) external {
        if (msg.sender != owner) revert Unauthorized(msg.sender);
        if (next == address(0)) revert ZeroRelayer();
        emit RelayerRotated(relayer, next);
        relayer = next;
    }

    error ZeroRelayer();

    // ---------- 内部 ----------
    function _sealOne(bytes32 commitment) private returns (uint64 index) {
        if (commitment == bytes32(0)) revert ZeroCommitment();
        SealRecord storage existing = _seals[commitment];
        if (existing.sealedAt != 0) revert AlreadySealed(commitment, existing.index);
        index = uint64(_sealList.length);
        uint64 at = uint64(block.timestamp);
        _seals[commitment] = SealRecord({index: index, sealedAt: at});
        _sealList.push(commitment);
        emit Sealed(commitment, index, at);
    }
}
