/**
 * Outbound Importer worker handlers：
 *   - importTickHandler: 每 5min 执行；查找到期 schedule 的 source，创建 PENDING job
 *   - importRunHandler:  每 1min 执行；拉一个 PENDING job 调 runImportJob
 *   - markStaleImportJobs: 僵尸检测，RUNNING > N min 自动 FAILED
 *
 * 关联 spec：specs/modules/outbound-importer.md §202-216 / phase-10 §10.7
 */

import { ImportJobStatus } from "@prisma/client";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { audit } from "@/lib/audit";
import { importRepository } from "./repository";
import { runImportJob } from "./runner";

const log = logger.child("import-worker");

/** 极简 cron 解析：仅用于"是否到期"判断。复杂 cron 表达式由调度时间窗口近似。 */
function isScheduleDue(schedule: string, lastRunAt: Date | null, now: Date): boolean {
  // 不实现完整 cron，而是基于"上次执行间隔"近似：
  //  - "*/N * * * *"     → N min
  //  - "0 * * * *"       → 60 min
  //  - "0 H * * *"       → 24h
  //  - 其他 / null       → 视为 5min
  if (!lastRunAt) return true;
  const elapsedMs = now.getTime() - lastRunAt.getTime();
  let intervalMs = 5 * 60 * 1000;
  const t = schedule.trim();
  const everyN = t.match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/);
  if (everyN && everyN[1]) {
    intervalMs = Math.max(1, Number(everyN[1])) * 60 * 1000;
  } else if (/^0\s+\*\s+\*\s+\*\s+\*$/.test(t)) {
    intervalMs = 60 * 60 * 1000;
  } else if (/^0\s+\d{1,2}\s+\*\s+\*\s+\*$/.test(t)) {
    intervalMs = 24 * 60 * 60 * 1000;
  }
  return elapsedMs >= intervalMs;
}

export async function importTickHandler(): Promise<void> {
  const now = new Date();
  const sources = await importRepository.listScheduledSources();
  for (const s of sources) {
    if (!s.schedule) continue;
    if (!isScheduleDue(s.schedule, s.lastRunAt, now)) continue;
    if (await importRepository.hasRunningJob(s.id)) {
      log.debug("skip schedule, running job exists", { sourceId: s.id });
      continue;
    }
    const job = await importRepository.createJob({
      sourceId: s.id,
      status: ImportJobStatus.PENDING,
      isDryRun: false,
    });
    await importRepository.touchLastRun(s.id, now);
    audit({
      action: "import_job.start",
      entityType: "ImportJob",
      entityId: job.id,
      actorType: "SYSTEM",
      details: { sourceId: s.id, scheduled: true },
    });
    log.info("scheduled import job created", { sourceId: s.id, jobId: job.id });
  }
}

export async function importRunHandler(): Promise<void> {
  const job = await importRepository.pickPendingJob();
  if (!job) return;
  log.info("running import job", { jobId: job.id, sourceId: job.sourceId });
  await runImportJob(job.id);
}

export async function markStaleImportJobs(): Promise<void> {
  const minutes = env().IMPORT_JOB_STALE_MINUTES;
  const cutoff = new Date(Date.now() - minutes * 60 * 1000);
  const n = await importRepository.markStaleRunningAsFailed(cutoff);
  if (n > 0) log.warn("marked stale import jobs as failed", { count: n });
}

export const __testing = { isScheduleDue };
