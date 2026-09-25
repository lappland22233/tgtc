import { createHash } from 'crypto';

/** 参与选号的最小账号形状（`id` 稳定、`weight` 为正整数） */
export interface WeightedUserAccount {
  id: string;
  weight: number;
}

export interface UserAccountPickResult<T extends WeightedUserAccount> {
  account: T;
  /** true 表示规则指定的优先账号不可用，已按权重回落选择（调用方可据此告警） */
  fallbackFromPreferred: boolean;
}

/**
 * 用户账号**确定性**选号（按权重展平 + 稳定种子）。
 *
 * 为什么必须是纯函数且确定性：
 * - MTProto 的 `random_id` 服务端去重维度是**发送者账号**，只有同一逻辑操作
 *   （同一任务）每次重试都落到同一账号，确定性 `random_id` 才能阻止重复转发；
 *   原实现用进程内游标轮转，重试会换账号 → 换一个发送者重新转发一份，属「重试不幂等」；
 * - 用种子（任务 ID / 中继幂等键）而非游标，还能让账号分流在**重启后保持一致**；
 * - 抽成无依赖纯函数供镜像（`user_copy`）与账号池中继（策略 B）共用，
 *   避免两处实现漂移出「一个用种子、一个用游标」的不一致。
 */
export function pickUserAccount<T extends WeightedUserAccount>(
  candidates: T[],
  preferredAccountId: string | null | undefined,
  seed: string,
): UserAccountPickResult<T> {
  if (preferredAccountId) {
    const preferred = candidates.find((item) => item.id === preferredAccountId);
    if (preferred) return { account: preferred, fallbackFromPreferred: false };
  }
  const expanded: T[] = [];
  for (const item of candidates) {
    const weight = Math.max(1, Math.min(Math.floor(item.weight) || 1, 10));
    for (let index = 0; index < weight; index += 1) expanded.push(item);
  }
  const digest = createHash('sha256').update(seed).digest();
  return {
    account: expanded[digest.readUInt32BE(0) % expanded.length],
    fallbackFromPreferred: Boolean(preferredAccountId),
  };
}
