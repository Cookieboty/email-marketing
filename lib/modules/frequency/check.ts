/**
 * 频次控制命中检查。
 *
 * 设计：
 *  - 单条 active 配置；无配置 → 直接放行（isOverLimit 返回 false）。
 *  - 时间窗口：since = now - periodDays * 24h（UTC，不做日历对齐，避免时区抖动）。
 *  - 实时查询 DB（不缓存）：因为 sentAt 持续增长，缓存收益低且容易导致放过。
 *  - 对单次发送场景，热路径会先 isSuppressed → isOverLimit → enqueue；
 *    此处一次 SQL count 即可完成。
 */

import { frequencyRepository } from "./repository";

export interface FrequencyCheckResult {
  overLimit: boolean;
  count: number;
  /** 当前 active 配置；null 表示无限制 */
  cap: { maxEmails: number; periodDays: number } | null;
}

export async function checkFrequency(userId: string): Promise<FrequencyCheckResult> {
  const cap = await frequencyRepository.findActive();
  if (!cap) return { overLimit: false, count: 0, cap: null };
  const since = new Date(Date.now() - cap.periodDays * 24 * 60 * 60 * 1000);
  const count = await frequencyRepository.countSentSince(userId, since);
  return {
    overLimit: count >= cap.maxEmails,
    count,
    cap: { maxEmails: cap.maxEmails, periodDays: cap.periodDays },
  };
}

export async function isOverLimit(userId: string): Promise<boolean> {
  const r = await checkFrequency(userId);
  return r.overLimit;
}
