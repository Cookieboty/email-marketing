/**
 * Campaign 状态机。
 *
 * 数据来源：specs/modules/campaign-sending.md「状态转换」表格 + 生命周期图。
 * 所有合法转换在下方 TRANSITIONS 中显式列出；未列出则一律拒绝。
 *
 * 设计原则：
 *  - 纯函数：不依赖 Prisma，便于单测穷举。
 *  - 「触发原因」字段（reason）用于审计；assertTransition 失败抛 ValidationError，
 *    携带 from/to/reason 三元组，便于排错。
 *  - 乐观锁辅助：buildOptimisticUpdate(expected, next) 生成 Prisma updateMany
 *    的 where/data，调用方按 count===0 抛 ConflictError。
 */

import type { CampaignStatus } from "@prisma/client";
import { ValidationError } from "@/lib/errors";

/** 触发动作，用于审计/UI 显示。 */
export type CampaignTransitionReason =
  | "schedule" // DRAFT → SCHEDULED
  | "send" // DRAFT/SCHEDULED → SENDING/AB_TESTING
  | "ab_test_start" // DRAFT/SCHEDULED → AB_TESTING
  | "ab_test_winner_send" // AB_TESTING → SENDING
  | "ab_test_winner_complete" // AB_TESTING → COMPLETED
  | "pause" // SENDING → PAUSED
  | "resume" // PAUSED → SENDING
  | "cancel" // 多源 → CANCELLED
  | "complete" // SENDING → COMPLETED（worker 自动）
  | "fail" // SENDING → FAILED（worker 自动）
  | "retry"; // FAILED → SENDING

/** 终态：进入后不可再转出。 */
export const TERMINAL_STATES: ReadonlyArray<CampaignStatus> = [
  "COMPLETED",
  "CANCELLED",
];

/**
 * 合法转换矩阵：from -> 允许的 (to, reason) 集合。
 * 与 specs §285-307 表格一一对应。
 */
const TRANSITIONS: Record<
  CampaignStatus,
  ReadonlyArray<{ to: CampaignStatus; reason: CampaignTransitionReason }>
> = {
  DRAFT: [
    { to: "SCHEDULED", reason: "schedule" },
    { to: "SENDING", reason: "send" },
    { to: "AB_TESTING", reason: "ab_test_start" },
    { to: "CANCELLED", reason: "cancel" },
  ],
  SCHEDULED: [
    { to: "SENDING", reason: "send" },
    { to: "AB_TESTING", reason: "ab_test_start" },
    { to: "CANCELLED", reason: "cancel" },
  ],
  AB_TESTING: [
    { to: "SENDING", reason: "ab_test_winner_send" },
    { to: "COMPLETED", reason: "ab_test_winner_complete" },
    { to: "CANCELLED", reason: "cancel" },
  ],
  SENDING: [
    { to: "PAUSED", reason: "pause" },
    { to: "COMPLETED", reason: "complete" },
    { to: "CANCELLED", reason: "cancel" },
    { to: "FAILED", reason: "fail" },
  ],
  PAUSED: [
    { to: "SENDING", reason: "resume" },
    { to: "CANCELLED", reason: "cancel" },
  ],
  FAILED: [
    { to: "SENDING", reason: "retry" },
    { to: "CANCELLED", reason: "cancel" },
  ],
  COMPLETED: [],
  CANCELLED: [],
};

export function isTerminal(status: CampaignStatus): boolean {
  return TERMINAL_STATES.includes(status);
}

/** 给定 from→to 是否存在合法转换（任意 reason）。 */
export function canTransition(
  from: CampaignStatus,
  to: CampaignStatus,
): boolean {
  return TRANSITIONS[from].some((t) => t.to === to);
}

/** 给定 from + reason 时，唯一确定的目标状态；不存在返回 null。 */
export function targetStateFor(
  from: CampaignStatus,
  reason: CampaignTransitionReason,
): CampaignStatus | null {
  const t = TRANSITIONS[from].find((x) => x.reason === reason);
  return t ? t.to : null;
}

/** 列出当前状态可用的所有 (to, reason) 选项；UI 据此显示按钮。 */
export function listAllowedTransitions(
  from: CampaignStatus,
): ReadonlyArray<{ to: CampaignStatus; reason: CampaignTransitionReason }> {
  return TRANSITIONS[from];
}

/**
 * 强校验：from→to 不合法时抛出 ValidationError，错误码 invalid_transition。
 * 调用方在 service 层使用，便于路由统一返回 400。
 */
export function assertTransition(
  from: CampaignStatus,
  to: CampaignStatus,
  reason?: CampaignTransitionReason,
): void {
  if (reason) {
    const expected = targetStateFor(from, reason);
    if (expected === null) {
      throw new ValidationError(
        `Action "${reason}" not allowed from status ${from}`,
      );
    }
    if (expected !== to) {
      throw new ValidationError(
        `Action "${reason}" from ${from} expects target ${expected}, got ${to}`,
      );
    }
    return;
  }
  if (!canTransition(from, to)) {
    throw new ValidationError(
      `Invalid campaign status transition: ${from} → ${to}`,
    );
  }
}

/**
 * 乐观锁 update 帮助器：返回 where 子句，要求 status === expected 才更新。
 *
 * 使用方式：
 *   const result = await prisma.campaign.updateMany({
 *     where: optimisticWhere(id, expectedStatus),
 *     data: { status: nextStatus, ...rest },
 *   });
 *   if (result.count === 0) throw new ConflictError("Campaign status changed concurrently");
 */
export function optimisticWhere(id: string, expected: CampaignStatus) {
  return { id, status: expected };
}
