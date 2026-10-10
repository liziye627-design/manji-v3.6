// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title ManjiPuppyIdentity —— 慢记·链上小狗身份（ERC-8004 风格，自托管）
 * @notice 每个共同家的小狗可以铸一枚链上身份：名字写上链（谁也改不了）、铸造时间即链上生日、
 *         附一个「存钱罐」地址（getAgentWallet，成员可换）。身份 NFT 不可转让——它属于这个小狗，
 *         就永远属于这个小狗；想要新名字就铸新身份，旧身份永远留在链上。
 *
 * 为什么自托管：BOT Chain 官方 Agent OS 托管 API 按项目签发 key，本应用暂未获批；
 * 本合约实现同样的核心语义（ownerOf / getAgentWallet / tokenURI 链上身份文件），
 * 且铸造由用户自己的钱包直接签名——比服务端代办更强的 C 端链上交互。
 * 合约无 owner、无后台、不可暂停、不可修改任何已铸身份；不接收转账。
 */
contract ManjiPuppyIdentity {
    // ---------- 常量 ----------
    string public constant APP = "manji-puppy-identity";
    string public constant VERSION = "1";
    uint256 public constant MAX_NAME_BYTES = 32; // 名字最长 32 字节（UTF-8 约 10 个汉字），控制铸造成本

    // ---------- 存储 ----------
    string[] private _names; // tokenId => 名字（上链即永恒）
    struct Puppy {
        address agentWallet; // 存钱罐：打赏发这里；身份 owner 可随时更换
        uint64 bornAt;       // 铸造时的区块时间 = 链上生日
    }
    mapping(uint256 => Puppy) private _puppies;
    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;

    // ---------- 事件 ----------
    event PuppyRegistered(uint256 indexed tokenId, address indexed owner, address indexed agentWallet, string name, uint64 bornAt);
    event AgentWalletSet(uint256 indexed tokenId, address indexed previous, address indexed next);

    // ---------- 错误 ----------
    error Unauthorized(address caller);
    error ZeroAddress();
    error ZeroTokenId();
    error EmptyName();
    error NameTooLong(uint256 len);
    error NonTransferable();
    error NoEtherAccepted();

    constructor() {
        // 无 owner、无角色：部署即永恒，任何人都能铸造
    }

    receive() external payable {
        revert NoEtherAccepted();
    }

    // ---------- 写入（仅此两个入口，append-only） ----------

    /**
     * @notice 给小狗铸一枚链上身份。由成员自己的钱包直接调用（页面引导）。
     * @param puppyName  小狗的名字（1-32 字节 UTF-8；上链后不可改）
     * @param agentWallet 存钱罐地址（打赏发这里；可以填你自己的钱包，也可以专门建一个）
     */
    function mint(string calldata puppyName, address agentWallet) external returns (uint256 tokenId) {
        uint256 len = bytes(puppyName).length;
        if (len == 0) revert EmptyName();
        if (len > MAX_NAME_BYTES) revert NameTooLong(len);
        if (agentWallet == address(0)) revert ZeroAddress();
        tokenId = _names.length;
        uint64 at = uint64(block.timestamp);
        _names.push(puppyName);
        _puppies[tokenId] = Puppy(agentWallet, at);
        _owners[tokenId] = msg.sender;
        _balances[msg.sender] += 1;
        emit PuppyRegistered(tokenId, msg.sender, agentWallet, puppyName, at);
    }

    /** 身份 owner 更换存钱罐地址（名字与生日永远不可改） */
    function setAgentWallet(uint256 tokenId, address next) external {
        address owner = ownerOf(tokenId);
        if (msg.sender != owner) revert Unauthorized(msg.sender);
        if (next == address(0)) revert ZeroAddress();
        address previous = _puppies[tokenId].agentWallet;
        _puppies[tokenId].agentWallet = next;
        emit AgentWalletSet(tokenId, previous, next);
    }

    // ---------- 读取与核验（任何人可调，不依赖本应用） ----------

    function name() external pure returns (string memory) {
        return "Manji Puppy Identity";
    }
    function symbol() external pure returns (string memory) {
        return "MPUPPY";
    }
    function totalSupply() external view returns (uint256) {
        return _names.length;
    }
    function balanceOf(address who) external view returns (uint256) {
        return _balances[who];
    }
    function ownerOf(uint256 tokenId) public view returns (address) {
        address owner = _owners[tokenId];
        if (owner == address(0)) revert ZeroTokenId();
        return owner;
    }
    function nameOf(uint256 tokenId) external view returns (string memory) {
        require(tokenId < _names.length, "ZeroTokenId");
        return _names[tokenId];
    }
    function bornAtOf(uint256 tokenId) external view returns (uint64) {
        require(tokenId < _names.length, "ZeroTokenId");
        return _puppies[tokenId].bornAt;
    }
    /// @notice ERC-8004 风格：这个身份（小狗）的钱包地址
    function getAgentWallet(uint256 tokenId) external view returns (address) {
        require(tokenId < _names.length, "ZeroTokenId");
        return _puppies[tokenId].agentWallet;
    }

    /**
     * @notice 链上自包含的身份文件：data-URI JSON（base64），不依赖任何服务器存活。
     *         内容由链上存储直接拼出，任何人可用同一规则复算比对。
     */
    function tokenURI(uint256 tokenId) external view returns (string memory) {
        require(tokenId < _names.length, "ZeroTokenId");
        Puppy memory p = _puppies[tokenId];
        // 有意不用未命名的内部函数调用，保持可读：拼 JSON 再整体 base64
        string memory json = string.concat(
            '{"name":"', _names[tokenId],
            '","description":"Manji puppy on-chain identity (ERC-8004 style, self-custodied). Immutable name, on-chain birthday and tip jar.",',
            '"image":"data:image/svg+xml;base64,', _pawSvgBase64(),
            '","external_url":"https://love.agentcrop.work/#/chain",',
            '"attributes":[{"trait_type":"born_at","value":"', _uintToString(p.bornAt),
            '"},{"trait_type":"agent_wallet","value":"', _addressToString(p.agentWallet),
            '"},{"trait_type":"registry","value":"manji-puppy-identity"}]}'
        );
        return string.concat("data:application/json;base64,", _base64(bytes(json)));
    }

    // ---------- 内部工具 ----------
    function _pawSvgBase64() private pure returns (string memory) {
        bytes memory svg = abi.encodePacked(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="20" fill="#F6E7CB"/><g fill="#8A6420"><ellipse cx="30" cy="38" rx="9" ry="12"/><ellipse cx="70" cy="38" rx="9" ry="12"/><ellipse cx="14" cy="58" rx="8" ry="10"/><ellipse cx="86" cy="58" rx="8" ry="10"/><path d="M50 52c14 0 24 12 24 22 0 8-10 12-24 12S26 82 26 74c0-10 10-22 24-22Z"/></g></svg>'
        );
        return _base64(svg);
    }
    function _uintToString(uint256 v) private pure returns (string memory) {
        if (v == 0) return "0";
        uint256 x = v;
        uint256 digits;
        while (x != 0) { digits++; x /= 10; }
        bytes memory buf = new bytes(digits);
        x = v;
        while (x != 0) { buf[--digits] = bytes1(uint8(48 + x % 10)); x /= 10; }
        return string(buf);
    }
    function _addressToString(address a) private pure returns (string memory) {
        return _toHexString(uint256(uint160(a)), 40);
    }
    function _toHexString(uint256 v, uint256 len) private pure returns (string memory) {
        bytes memory alphabet = "0123456789abcdef";
        bytes memory buf = new bytes(2 * len + 2);
        buf[0] = "0"; buf[1] = "x";
        for (uint256 i = 0; i < len; i++) {
            buf[2 * len + 1 - 2 * i] = alphabet[v & 0xf];
            v >>= 4;
            buf[2 * len - 2 * i] = alphabet[v & 0xf];
            v >>= 4;
        }
        return string(buf);
    }

    function _base64(bytes memory data) private pure returns (string memory) {
        bytes memory alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        uint256 len = data.length;
        if (len == 0) return "";
        uint256 encodedLen = 4 * ((len + 2) / 3);
        bytes memory out = new bytes(encodedLen);
        uint256 i;
        uint256 j;
        for (; i + 2 < len; i += 3) {
            uint256 n = (uint256(uint8(data[i])) << 16) | (uint256(uint8(data[i + 1])) << 8) | uint256(uint8(data[i + 2]));
            out[j++] = alphabet[(n >> 18) & 0x3f];
            out[j++] = alphabet[(n >> 12) & 0x3f];
            out[j++] = alphabet[(n >> 6) & 0x3f];
            out[j++] = alphabet[n & 0x3f];
        }
        if (len % 3 == 1) {
            uint256 n = uint256(uint8(data[i])) << 16;
            out[j++] = alphabet[(n >> 18) & 0x3f];
            out[j++] = alphabet[(n >> 12) & 0x3f];
            out[j++] = "=";
            out[j++] = "=";
        } else if (len % 3 == 2) {
            uint256 n = (uint256(uint8(data[i])) << 16) | (uint256(uint8(data[i + 1])) << 8);
            out[j++] = alphabet[(n >> 18) & 0x3f];
            out[j++] = alphabet[(n >> 12) & 0x3f];
            out[j++] = alphabet[(n >> 6) & 0x3f];
            out[j++] = "=";
        }
        return string(out);
    }
}
