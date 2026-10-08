// 慢记 Manji v3.5 —— 区块哈希算法版本（B01）
// 背景：v3.4 早期区块哈希参与串包含内部家编号（home_id）；v3.4 起改为随机链编号（chain_id）。
// 升级后如果一律按新规则重算旧块，原有存证链会从第 0 块被误判为损坏。
// 原则：每个区块记录自己使用的算法版本；旧块保留原值、按旧规则验证；新链使用新规则。
// 绝不静默重写旧哈希——用户可能已经下载过旧凭证。
import { createHash } from 'node:crypto';

/** v1（2026-10 v3.3–v3.4 早期）：SHA-256("manji-block-v1"|home_id|height|timestamp|prevHash|payload|nonce) */
export const BLOCK_ALGO_V1 = 'v1-home-key';
/** v2（v3.4 起）：SHA-256("manji-block-v1"|chain_id|height|timestamp|prevHash|payload|nonce)，chain_id 为随机链编号 */
export const BLOCK_ALGO_V2 = 'v2-chain-id';

export const BLOCK_HASH_DOMAIN = 'manji-block-v1';

const sha = (s) => createHash('sha256').update(s).digest('hex');

/** 统一的重算入口：idKey 是该算法版本参与哈希的编号（v1=home_id，v2=chain_id） */
export function blockHashRaw(idKey, block) {
  return sha(
    [BLOCK_HASH_DOMAIN, idKey, block.height, block.timestamp, block.prev_hash, block.payload, block.nonce].join('|')
  );
}

/** 判断一个已有区块符合哪种算法（迁移回填与验证兜底用）；都对不上返回 null（视为被改动，交由校验如实报告） */
export function detectBlockAlgo(homeId, chainId, block) {
  if (blockHashRaw(homeId, block) === block.hash) return BLOCK_ALGO_V1;
  if (chainId && blockHashRaw(chainId, block) === block.hash) return BLOCK_ALGO_V2;
  return null;
}

/** 两种算法的对外说明（写入导出与凭证，供第三方离线复算） */
export function algoNote(algo) {
  return algo === BLOCK_ALGO_V1
    ? `hash = SHA-256("${BLOCK_HASH_DOMAIN}"|homeKey|height|timestamp|prevHash|payload|nonce)，以 "|" 连接；homeKey 是这条链创建时的应用内部编号（随机字符串，非用户身份）`
    : `hash = SHA-256("${BLOCK_HASH_DOMAIN}"|chainId|height|timestamp|prevHash|payload|nonce)，以 "|" 连接；chainId 是这条链的随机编号（非用户身份、非应用内关联键）`;
}
