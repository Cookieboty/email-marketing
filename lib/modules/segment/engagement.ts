/**
 * 用户参与度评分（engagementScore）计算。
 *
 * 公式来源：specs/modules/user-management.md §498-526
 *
 *   recencyDecay  = max(0, 1 - lastActivityDays / 180)         // 180 天衰减到 0
 *   raw           = openedLast30d * 2
 *                 + clickedLast30d * 5
 *                 + totalOpens   * 0.1
 *                 + totalClicks  * 0.3
 *   engagementScore = min(100, round(raw * recencyDecay, 1))   // 我们存 Int，故再四舍五入到整数
 *
 * 数据源（解耦 spec 中"events"为可读源）：
 *   - 近 30 天 opens / clicks：CampaignRecipient.openedAt / clickedAt
 *   - 历史累计 opens / clicks：EmailEvent.type IN ("opened","clicked")
 *     由于 EmailEvent 没有 userId 列（schema:432），通过 campaignRecipient 关联到 user
 *   - 最后活跃时间：取 user.lastEmailOpenedAt / lastEmailClickedAt 中较新者；都为空则视为 180 天前（衰减 = 0）
 *
 * 性能：
 *   - 单用户：4~6 次 count 查询；可接受
 *   - 批量：分页扫描 user，对每个 userId 串行计算 + 写回；DRY_RUN / 无 DATABASE_URL 时 noop
 *   - 不强求严格事务（评分允许临时不一致）
 *
 * 失败策略：
 *   - 单用户失败仅 log + 继续，不影响整批
 *   - 写回若 score 无变化，跳过 update（少写一行）
 */

import { prisma } from "@/lib/prisma";

export interface EngagementInput {
  openedLast30d: number;
  clickedLast30d: number;
  totalOpens: number;
  totalClicks: number;
  /** 自最近一次 open/click 的天数；无活动传 null（视为 180） */
  lastActivityDays: number | null;
}

const DECAY_WINDOW_DAYS = 180;
const RECENT_WINDOW_DAYS = 30;
const RECENT_OPEN_WEIGHT = 2;
const RECENT_CLICK_WEIGHT = 5;
const TOTAL_OPEN_WEIGHT = 0.1;
const TOTAL_CLICK_WEIGHT = 0.3;
const MAX_SCORE = 100;

/**
 * 纯函数：根据预聚合输入计算最终 engagementScore（0..100，Int）。
 *
 * 数值规则：
 *   - lastActivityDays 为 null 视为 180（recencyDecay = 0 → 输出 0）
 *   - 极大原始分截断到 100
 *   - 先按 spec 留 1 位小数 (`Math.round(raw*10)/10`)，再 round 到 Int 存库
 */
export function computeEngagementScore(input: EngagementInput): number {
  const days = input.lastActivityDays ?? DECAY_WINDOW_DAYS;
  const recencyDecay = Math.max(0, 1 - days / DECAY_WINDOW_DAYS);
  const raw =
    input.openedLast30d * RECENT_OPEN_WEIGHT +
    input.clickedLast30d * RECENT_CLICK_WEIGHT +
    input.totalOpens * TOTAL_OPEN_WEIGHT +
    input.totalClicks * TOTAL_CLICK_WEIGHT;
  const decayed = raw * recencyDecay;
  const oneDecimal = Math.round(decayed * 10) / 10;
  return Math.max(0, Math.min(MAX_SCORE, Math.round(oneDecimal)));
}

function daysBetween(a: Date, b: Date): number {
  return (a.getTime() - b.getTime()) / (24 * 60 * 60 * 1000);
}

/**
 * 拉取单用户聚合输入。导出仅用于单测桩点；生产代码请使用 recomputeForUser。
 */
export async function aggregateUserActivity(
  userId: string,
  now: Date = new Date(),
): Promise<EngagementInput | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      lastEmailOpenedAt: true,
      lastEmailClickedAt: true,
    },
  });
  if (!user) return null;

  const since = new Date(now.getTime() - RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const [openedLast30d, clickedLast30d, totalOpens, totalClicks] = await Promise.all([
    prisma.campaignRecipient.count({
      where: { userId, openedAt: { gte: since } },
    }),
    prisma.campaignRecipient.count({
      where: { userId, clickedAt: { gte: since } },
    }),
    prisma.emailEvent.count({
      where: { type: "opened", campaignRecipient: { userId } },
    }),
    prisma.emailEvent.count({
      where: { type: "clicked", campaignRecipient: { userId } },
    }),
  ]);

  const lastActivityAt = pickLatest(user.lastEmailOpenedAt, user.lastEmailClickedAt);
  const lastActivityDays = lastActivityAt
    ? Math.max(0, daysBetween(now, lastActivityAt))
    : null;

  return { openedLast30d, clickedLast30d, totalOpens, totalClicks, lastActivityDays };
}

function pickLatest(a: Date | null, b: Date | null): Date | null {
  if (a && b) return a.getTime() >= b.getTime() ? a : b;
  return a ?? b ?? null;
}

export async function recomputeForUser(
  userId: string,
  now: Date = new Date(),
): Promise<number | null> {
  const input = await aggregateUserActivity(userId, now);
  if (!input) return null;
  const score = computeEngagementScore(input);
  await prisma.user.updateMany({
    where: { id: userId, engagementScore: { not: score } },
    data: { engagementScore: score },
  });
  return score;
}

export interface RecomputeAllResult {
  processed: number;
  updated: number;
  failed: number;
  durationMs: number;
}

/**
 * 全量重算所有 optInStatus != PENDING 的用户。
 *
 * 设计：
 *   - 按 id 升序游标分页（pageSize 默认 500），避免 OFFSET 抖动
 *   - 单页内串行（保护 DB 连接池）；可未来再加 worker pool
 *   - 入参 onError 用于上报指标；默认仅吞掉异常并计数
 */
export async function recomputeAllUsers(opts: {
  pageSize?: number;
  now?: Date;
  onError?: (userId: string, err: unknown) => void;
} = {}): Promise<RecomputeAllResult> {
  const pageSize = opts.pageSize ?? 500;
  const now = opts.now ?? new Date();
  const result: RecomputeAllResult = {
    processed: 0,
    updated: 0,
    failed: 0,
    durationMs: 0,
  };
  const startedAt = Date.now();
  let cursor: string | null = null;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const page: { id: string }[] = await prisma.user.findMany({
      where: { optInStatus: { not: "PENDING" } },
      select: { id: true },
      orderBy: { id: "asc" },
      take: pageSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (page.length === 0) break;

    for (const u of page) {
      try {
        const before = await prisma.user.findUnique({
          where: { id: u.id },
          select: { engagementScore: true },
        });
        const score = await recomputeForUser(u.id, now);
        result.processed += 1;
        if (score != null && before && before.engagementScore !== score) {
          result.updated += 1;
        }
      } catch (err) {
        result.failed += 1;
        opts.onError?.(u.id, err);
      }
    }

    cursor = page[page.length - 1].id;
  }

  result.durationMs = Date.now() - startedAt;
  return result;
}
