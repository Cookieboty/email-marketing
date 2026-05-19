/**
 * Outbound Importer 数据访问层。
 *
 * 关联 spec：specs/modules/outbound-importer.md
 *
 * 集中所有 prisma 查询，便于在 runner / API / worker 间共享，
 * 同时让单元测试只 mock 这一层而非全 prisma。
 */

import { ImportJobStatus, type ImportJob, type ImportSource, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export type ImportSourceRow = ImportSource;
export type ImportJobRow = ImportJob;

export const importRepository = {
  /** ImportSource: list / get / create / update / delete */
  async listSources(): Promise<ImportSourceRow[]> {
    return prisma.importSource.findMany({ orderBy: { createdAt: "desc" } });
  },

  async getSource(id: string): Promise<ImportSourceRow | null> {
    return prisma.importSource.findUnique({ where: { id } });
  },

  async createSource(data: Prisma.ImportSourceUncheckedCreateInput): Promise<ImportSourceRow> {
    return prisma.importSource.create({ data });
  },

  async updateSource(
    id: string,
    data: Prisma.ImportSourceUncheckedUpdateInput,
  ): Promise<ImportSourceRow> {
    return prisma.importSource.update({ where: { id }, data });
  },

  async deleteSource(id: string): Promise<void> {
    await prisma.importSource.delete({ where: { id } });
  },

  async touchLastRun(id: string, at: Date): Promise<void> {
    await prisma.importSource.update({ where: { id }, data: { lastRunAt: at } });
  },

  /** 列出所有 enabled + schedule != null 的 source（worker import.tick 用）。 */
  async listScheduledSources(): Promise<ImportSourceRow[]> {
    return prisma.importSource.findMany({
      where: { enabled: true, schedule: { not: null } },
    });
  },

  /** ImportJob */
  async listJobs(sourceId: string, take = 50, skip = 0): Promise<ImportJobRow[]> {
    return prisma.importJob.findMany({
      where: { sourceId },
      orderBy: { createdAt: "desc" },
      take,
      skip,
    });
  },

  async getJob(id: string): Promise<ImportJobRow | null> {
    return prisma.importJob.findUnique({ where: { id } });
  },

  async hasRunningJob(sourceId: string): Promise<boolean> {
    const cnt = await prisma.importJob.count({
      where: { sourceId, status: { in: [ImportJobStatus.PENDING, ImportJobStatus.RUNNING] } },
    });
    return cnt > 0;
  },

  async createJob(data: Prisma.ImportJobUncheckedCreateInput): Promise<ImportJobRow> {
    return prisma.importJob.create({ data });
  },

  async updateJob(
    id: string,
    data: Prisma.ImportJobUncheckedUpdateInput,
  ): Promise<ImportJobRow> {
    return prisma.importJob.update({ where: { id }, data });
  },

  /** 拿一个最早的 PENDING job（FIFO）；同 source 已有 RUNNING 的会跳过。 */
  async pickPendingJob(): Promise<ImportJobRow | null> {
    const pending = await prisma.importJob.findMany({
      where: { status: ImportJobStatus.PENDING },
      orderBy: { createdAt: "asc" },
      take: 20,
    });
    for (const j of pending) {
      const running = await prisma.importJob.count({
        where: { sourceId: j.sourceId, status: ImportJobStatus.RUNNING },
      });
      if (running === 0) return j;
    }
    return null;
  },

  /** 标记僵尸 RUNNING job（updatedAt < cutoff）为 FAILED。返回受影响数。 */
  async markStaleRunningAsFailed(cutoff: Date): Promise<number> {
    const stale = await prisma.importJob.findMany({
      where: { status: ImportJobStatus.RUNNING, updatedAt: { lt: cutoff } },
      select: { id: true },
    });
    if (stale.length === 0) return 0;
    await prisma.importJob.updateMany({
      where: { id: { in: stale.map((s) => s.id) } },
      data: {
        status: ImportJobStatus.FAILED,
        failureReason: "stale: running > threshold",
        completedAt: new Date(),
      },
    });
    return stale.length;
  },

  /** ImportJobError */
  async addJobError(data: Prisma.ImportJobErrorUncheckedCreateInput): Promise<void> {
    await prisma.importJobError.create({ data });
  },

  async listJobErrors(jobId: string, take = 1000): Promise<
    Array<{
      row: number;
      field: string | null;
      message: string;
      rawData: Prisma.JsonValue | null;
    }>
  > {
    return prisma.importJobError.findMany({
      where: { jobId },
      orderBy: { row: "asc" },
      take,
      select: { row: true, field: true, message: true, rawData: true },
    });
  },

  async deleteJobErrors(jobId: string): Promise<void> {
    await prisma.importJobError.deleteMany({ where: { jobId } });
  },
};
