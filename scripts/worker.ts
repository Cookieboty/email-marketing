import cron, { type ScheduledTask } from "node-cron";
import { prisma } from "@/lib/prisma";
import { recomputeSegmentCount } from "@/lib/modules/segment/service";
import { recomputeAllUsers } from "@/lib/modules/segment/engagement";
import {
  scheduledCampaignTrigger,
  processSendQueue,
  abTestEvaluator,
  softBounceRetry,
  leaseRecover,
  campaignCompleter,
  automationRunProcessor,
  birthdayChecker,
  reEngagementChecker,
  campaignStatsAggregator,
  domainStatAggregator,
  deliverabilityAlertChecker,
  sendTimePreferenceCalculator,
} from "@/lib/modules/campaign/worker-jobs";
import { cleanupInboundRequestLogs } from "@/lib/modules/api-client/cleanup";
import {
  importTickHandler,
  importRunHandler,
  markStaleImportJobs,
} from "@/lib/modules/import/worker-jobs";

const LOCK_KEY = "email_worker";
const DRY_RUN = process.env.WORKER_DRY_RUN === "true";

interface WorkerContext {
  shutdownRequested: boolean;
  scheduledTasks: ScheduledTask[];
  lockHeld: boolean;
}

const ctx: WorkerContext = {
  shutdownRequested: false,
  scheduledTasks: [],
  lockHeld: false,
};

function log(level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    component: "worker",
    msg,
    ...extra,
  };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(payload));
}

/**
 * 尝试获取 PostgreSQL session-level advisory lock，确保单实例运行。
 *
 * 实现细节：
 *  - 使用 `pg_try_advisory_lock(hashtext('email_worker'))`
 *  - 这是 session 级锁，连接断开后自动释放，避免崩溃后死锁
 *  - 必须使用同一连接持有/释放，因此通过单例 Prisma 客户端保持长连接
 *
 * DRY_RUN / 缺少 DATABASE_URL 时直接返回 true，便于本地烟囱测试与单测。
 */
export async function acquireLock(): Promise<boolean> {
  if (DRY_RUN || !process.env.DATABASE_URL) {
    log("warn", "advisory lock skipped (dry-run or DATABASE_URL not set)", {
      reason: DRY_RUN ? "WORKER_DRY_RUN=true" : "DATABASE_URL missing",
      lockKey: LOCK_KEY,
    });
    ctx.lockHeld = false;
    return true;
  }

  const rows = await prisma.$queryRaw<Array<{ locked: boolean }>>`
    SELECT pg_try_advisory_lock(hashtext(${LOCK_KEY})) AS locked
  `;
  const locked = rows[0]?.locked === true;
  ctx.lockHeld = locked;
  if (!locked) {
    log("error", "failed to acquire advisory lock", { lockKey: LOCK_KEY });
  }
  return locked;
}

export async function releaseLock(): Promise<void> {
  if (DRY_RUN || !process.env.DATABASE_URL) return;
  if (!ctx.lockHeld) return;
  try {
    await prisma.$queryRaw<Array<{ unlocked: boolean }>>`
      SELECT pg_advisory_unlock(hashtext(${LOCK_KEY})) AS unlocked
    `;
    ctx.lockHeld = false;
    log("info", "advisory lock released", { lockKey: LOCK_KEY });
  } catch (e) {
    log("warn", "failed to release advisory lock", { error: String(e) });
  }
}

let currentJob: string | null = null;

async function runExclusive(name: string, fn: () => Promise<void>): Promise<void> {
  if (ctx.shutdownRequested) return;
  if (currentJob) {
    log("info", `skipping ${name}, ${currentJob} is running`);
    return;
  }
  currentJob = name;
  try {
    await fn();
  } catch (e) {
    log("error", `job ${name} failed`, { error: e instanceof Error ? e.message : String(e) });
  } finally {
    currentJob = null;
  }
}

export function registerSchedules(): ScheduledTask[] {
  const tasks: ScheduledTask[] = [];

  // 每分钟
  tasks.push(
    cron.schedule("* * * * *", () => {
      void runExclusive("every-minute", async () => {
        await scheduledCampaignTrigger();
        await processSendQueue();
        await softBounceRetry();
        await campaignCompleter();
        await automationRunProcessor();
        await importRunHandler();
      });
    }),
  );

  // 每 5 分钟
  tasks.push(
    cron.schedule("*/5 * * * *", () => {
      void runExclusive("every-5-min", async () => {
        await leaseRecover();
        await campaignStatsAggregator();
        await domainStatAggregator();
        await deliverabilityAlertChecker();
        await importTickHandler();
        await markStaleImportJobs();
      });
    }),
  );

  // 每 10 分钟 — A/B 测试评估
  tasks.push(
    cron.schedule("*/10 * * * *", () => {
      void runExclusive("ab-test-eval", abTestEvaluator);
    }),
  );

  // 每日 03:00
  tasks.push(
    cron.schedule("0 3 * * *", () => {
      void runExclusive("daily-3am", async () => {
        await runSegmentDailyRecompute();
        await runEngagementDailyRecompute();
        await cleanupInboundRequestLogs();
      });
    }),
  );

  // 每日 09:00 — 生日检查
  tasks.push(
    cron.schedule("0 9 * * *", () => {
      void runExclusive("birthday", birthdayChecker);
    }),
  );

  // 每日 10:00 — 再激活
  tasks.push(
    cron.schedule("0 10 * * *", () => {
      void runExclusive("re-engagement", reEngagementChecker);
    }),
  );

  // 每周一 04:00
  tasks.push(
    cron.schedule("0 4 * * 1", () => {
      void runExclusive("weekly-mon-4am", sendTimePreferenceCalculator);
    }),
  );

  return tasks;
}

/**
 * 每日全量重算所有分群的 userCount。
 *
 * 设计：
 *  - 串行处理（事件循环友好），单次失败不影响后续 segment
 *  - DRY_RUN 时跳过，仅打印
 *  - 系统内置「全部用户」isSystem=true 也参与，因为它的 userCount 也要刷新
 */
export async function runSegmentDailyRecompute(): Promise<void> {
  if (DRY_RUN) {
    log("info", "segment recompute skipped (dry-run)");
    return;
  }
  const startedAt = Date.now();
  let processed = 0;
  let failed = 0;
  try {
    const segments = await prisma.segment.findMany({ select: { id: true, name: true } });
    log("info", "segment daily recompute start", { count: segments.length });
    for (const seg of segments) {
      try {
        const result = await recomputeSegmentCount(seg.id);
        processed += 1;
        log("info", "segment recomputed", {
          segmentId: seg.id,
          name: seg.name,
          userCount: result.userCount,
        });
      } catch (e) {
        failed += 1;
        log("error", "segment recompute failed", {
          segmentId: seg.id,
          name: seg.name,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } catch (e) {
    log("error", "segment daily recompute fatal", {
      error: e instanceof Error ? e.message : String(e),
    });
  } finally {
    log("info", "segment daily recompute done", {
      processed,
      failed,
      durationMs: Date.now() - startedAt,
    });
  }
}

/**
 * 每日全量重算所有非 PENDING 用户的活跃度评分（engagementScore）。
 *
 * 设计：
 *  - 与 segment 重算同槽位调度（daily-3am），避免分散资源占用
 *  - DRY_RUN 时跳过；底层 recomputeAllUsers 内部分页串行，仅在真实变化时写库
 *  - 失败计入日志，不抛出，不影响后续 cron tick
 */
export async function runEngagementDailyRecompute(): Promise<void> {
  if (DRY_RUN) {
    log("info", "engagement recompute skipped (dry-run)");
    return;
  }
  log("info", "engagement daily recompute start");
  try {
    const result = await recomputeAllUsers({
      onError: (userId, err) => {
        log("error", "engagement recompute user failed", {
          userId,
          error: err instanceof Error ? err.message : String(err),
        });
      },
    });
    log("info", "engagement daily recompute done", {
      processed: result.processed,
      updated: result.updated,
      failed: result.failed,
      durationMs: result.durationMs,
    });
  } catch (e) {
    log("error", "engagement daily recompute fatal", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

async function shutdown(signal: string) {
  if (ctx.shutdownRequested) return;
  ctx.shutdownRequested = true;
  log("info", `received ${signal}, shutting down`);

  for (const task of ctx.scheduledTasks) {
    try {
      task.stop();
    } catch (e) {
      log("warn", "failed to stop cron task", { error: String(e) });
    }
  }

  try {
    await releaseLock();
  } catch (e) {
    log("warn", "failed to release advisory lock", { error: String(e) });
  }

  try {
    await prisma.$disconnect();
  } catch (e) {
    log("warn", "failed to disconnect prisma", { error: String(e) });
  }

  log("info", "shutdown complete");
  process.exit(0);
}

async function main() {
  log("info", "worker starting", { node: process.version, dryRun: DRY_RUN });

  const locked = await acquireLock();
  if (!locked) {
    log("error", "another worker instance is already running, exiting");
    process.exit(1);
  }

  ctx.scheduledTasks = registerSchedules();
  log("info", "Acquired advisory lock, scheduler started", {
    cronJobs: ctx.scheduledTasks.length,
  });

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

// 仅当被直接运行时才启动；测试中 import 不会触发副作用
const isDirectRun =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("scripts/worker.ts");

if (isDirectRun) {
  main().catch((e) => {
    log("error", "worker fatal error", { error: String(e) });
    process.exit(1);
  });
}
