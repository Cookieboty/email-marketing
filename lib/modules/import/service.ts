/**
 * Outbound Importer service：CRUD + 触发 job + 序列化。
 *
 * 关联 spec：specs/modules/outbound-importer.md §218-244 / phase-10 §10.8-10.10
 *
 * 职责：
 *  - 校验 URL（HTTPS + 非内网）
 *  - 校验 fieldMapping 合法性
 *  - 加密/解密 authValue
 *  - 序列化时屏蔽 authValue 明文（只返回 hasAuth: boolean）
 *  - 触发/取消 job
 */

import { ImportAuthType, ImportJobStatus, Prisma } from "@prisma/client";
import { audit } from "@/lib/audit";
import { AppError, ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { validateFieldMapping, type FieldMapping } from "./mapper";
import { encryptSecret } from "./secrets";
import { validateTargetUrl } from "./security";
import { importRepository, type ImportSourceRow, type ImportJobRow } from "./repository";
import type {
  CreateImportSourceInput,
  TriggerJobInput,
  UpdateImportSourceInput,
} from "./schema";

export interface SerializedImportSource {
  id: string;
  name: string;
  description: string | null;
  baseUrl: string;
  authType: ImportAuthType;
  authHeader: string | null;
  hasAuth: boolean;
  headers: Record<string, unknown> | null;
  paginationType: string;
  pageSize: number;
  pageSizeParam: string | null;
  pageParam: string | null;
  cursorParam: string | null;
  cursorJsonPath: string | null;
  dataJsonPath: string;
  fieldMapping: FieldMapping;
  schedule: string | null;
  enabled: boolean;
  lastRunAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export function serializeImportSource(s: ImportSourceRow): SerializedImportSource {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    baseUrl: s.baseUrl,
    authType: s.authType,
    authHeader: s.authHeader,
    hasAuth: !!s.authValue,
    headers: (s.headers as Record<string, unknown> | null) ?? null,
    paginationType: s.paginationType,
    pageSize: s.pageSize,
    pageSizeParam: s.pageSizeParam,
    pageParam: s.pageParam,
    cursorParam: s.cursorParam,
    cursorJsonPath: s.cursorJsonPath,
    dataJsonPath: s.dataJsonPath,
    fieldMapping: s.fieldMapping as unknown as FieldMapping,
    schedule: s.schedule,
    enabled: s.enabled,
    lastRunAt: s.lastRunAt?.toISOString() ?? null,
    createdBy: s.createdBy,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

export function serializeImportJob(j: ImportJobRow): Record<string, unknown> {
  return {
    id: j.id,
    sourceId: j.sourceId,
    status: j.status,
    isDryRun: j.isDryRun,
    totalFetched: j.totalFetched,
    totalCreated: j.totalCreated,
    totalUpdated: j.totalUpdated,
    totalSkipped: j.totalSkipped,
    totalErrored: j.totalErrored,
    cursor: j.cursor,
    currentPage: j.currentPage,
    startedAt: j.startedAt?.toISOString() ?? null,
    completedAt: j.completedAt?.toISOString() ?? null,
    failureReason: j.failureReason,
    createdBy: j.createdBy,
    createdAt: j.createdAt.toISOString(),
    updatedAt: j.updatedAt.toISOString(),
  };
}

interface ActorCtx {
  actorId?: string | null;
  req?: { headers: Headers } | null;
}

function assertFieldMapping(fm: FieldMapping): void {
  const errs = validateFieldMapping(fm);
  if (errs.length > 0) {
    throw new ValidationError(
      "Invalid fieldMapping",
      errs.map((e) => ({ path: ["fieldMapping", e.field], message: e.message })),
    );
  }
}

export const importSourceService = {
  async list(): Promise<SerializedImportSource[]> {
    const rows = await importRepository.listSources();
    return rows.map(serializeImportSource);
  },

  async getById(id: string): Promise<SerializedImportSource> {
    const row = await importRepository.getSource(id);
    if (!row) throw new NotFoundError("ImportSource not found");
    return serializeImportSource(row);
  },

  async create(input: CreateImportSourceInput, ctx: ActorCtx): Promise<SerializedImportSource> {
    validateTargetUrl(input.baseUrl);
    assertFieldMapping(input.fieldMapping as FieldMapping);
    const data: Prisma.ImportSourceUncheckedCreateInput = {
      name: input.name,
      description: input.description ?? null,
      baseUrl: input.baseUrl,
      authType: input.authType,
      authValue:
        input.authType !== ImportAuthType.NONE && input.authValue
          ? encryptSecret(input.authValue)
          : null,
      authHeader: input.authHeader ?? null,
      headers: input.headers
        ? (input.headers as unknown as Prisma.InputJsonValue)
        : Prisma.JsonNull as unknown as Prisma.InputJsonValue,
      paginationType: input.paginationType,
      pageSize: input.pageSize,
      pageSizeParam: input.pageSizeParam ?? null,
      pageParam: input.pageParam ?? null,
      cursorParam: input.cursorParam ?? null,
      cursorJsonPath: input.cursorJsonPath ?? null,
      dataJsonPath: input.dataJsonPath,
      fieldMapping: input.fieldMapping as unknown as Prisma.InputJsonValue,
      schedule: input.schedule ?? null,
      enabled: input.enabled,
      createdBy: ctx.actorId ?? null,
    };
    const row = await importRepository.createSource(data);
    audit({
      action: "import_source.create",
      entityType: "ImportSource",
      entityId: row.id,
      actorType: "ADMIN",
      details: { name: row.name, baseUrl: row.baseUrl },
      req: ctx.req ?? null,
    });
    return serializeImportSource(row);
  },

  async update(
    id: string,
    input: UpdateImportSourceInput,
    ctx: ActorCtx,
  ): Promise<SerializedImportSource> {
    const existing = await importRepository.getSource(id);
    if (!existing) throw new NotFoundError("ImportSource not found");

    const data: Prisma.ImportSourceUncheckedUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.description !== undefined) data.description = input.description ?? null;
    if (input.baseUrl !== undefined) {
      validateTargetUrl(input.baseUrl);
      data.baseUrl = input.baseUrl;
    }
    if (input.authType !== undefined) data.authType = input.authType;
    if (input.authValue !== undefined) {
      data.authValue =
        input.authValue && input.authValue.length > 0 ? encryptSecret(input.authValue) : null;
    }
    if (input.authHeader !== undefined) data.authHeader = input.authHeader ?? null;
    if (input.headers !== undefined) {
      data.headers = input.headers
        ? (input.headers as unknown as Prisma.InputJsonValue)
        : (Prisma.JsonNull as unknown as Prisma.InputJsonValue);
    }
    if (input.paginationType !== undefined) data.paginationType = input.paginationType;
    if (input.pageSize !== undefined) data.pageSize = input.pageSize;
    if (input.pageSizeParam !== undefined) data.pageSizeParam = input.pageSizeParam ?? null;
    if (input.pageParam !== undefined) data.pageParam = input.pageParam ?? null;
    if (input.cursorParam !== undefined) data.cursorParam = input.cursorParam ?? null;
    if (input.cursorJsonPath !== undefined) data.cursorJsonPath = input.cursorJsonPath ?? null;
    if (input.dataJsonPath !== undefined) data.dataJsonPath = input.dataJsonPath;
    if (input.fieldMapping !== undefined) {
      assertFieldMapping(input.fieldMapping as FieldMapping);
      data.fieldMapping = input.fieldMapping as unknown as Prisma.InputJsonValue;
    }
    if (input.schedule !== undefined) data.schedule = input.schedule ?? null;
    if (input.enabled !== undefined) data.enabled = input.enabled;

    const updated = await importRepository.updateSource(id, data);
    audit({
      action: "import_source.update",
      entityType: "ImportSource",
      entityId: id,
      actorType: "ADMIN",
      details: { fields: Object.keys(data) },
      req: ctx.req ?? null,
    });
    return serializeImportSource(updated);
  },

  async remove(id: string, ctx: ActorCtx): Promise<void> {
    const existing = await importRepository.getSource(id);
    if (!existing) throw new NotFoundError("ImportSource not found");
    await importRepository.deleteSource(id);
    audit({
      action: "import_source.delete",
      entityType: "ImportSource",
      entityId: id,
      actorType: "ADMIN",
      details: { name: existing.name },
      req: ctx.req ?? null,
    });
  },

  async triggerJob(
    sourceId: string,
    input: TriggerJobInput,
    ctx: ActorCtx,
  ): Promise<ImportJobRow> {
    const src = await importRepository.getSource(sourceId);
    if (!src) throw new NotFoundError("ImportSource not found");
    if (!src.enabled) {
      throw new AppError("Source is disabled", { status: 400, code: "import_source_disabled" });
    }
    if (await importRepository.hasRunningJob(sourceId)) {
      throw new ConflictError("Another job is already running or pending for this source");
    }
    let cursor: string | null = null;
    let currentPage = 0;
    if (input.resume) {
      // 找上一个 RUNNING/FAILED job 的 cursor 作为续跑起点
      const recent = await importRepository.listJobs(sourceId, 5, 0);
      const last = recent.find((j) => j.status !== ImportJobStatus.PENDING);
      if (last) {
        cursor = last.cursor;
        currentPage = last.currentPage;
      }
    }
    const job = await importRepository.createJob({
      sourceId,
      status: ImportJobStatus.PENDING,
      isDryRun: input.dryRun,
      cursor,
      currentPage,
      createdBy: ctx.actorId ?? null,
    });
    audit({
      action: "import_job.start",
      entityType: "ImportJob",
      entityId: job.id,
      actorType: "ADMIN",
      details: { sourceId, dryRun: input.dryRun, resume: input.resume },
      req: ctx.req ?? null,
    });
    return job;
  },

  async cancelJob(jobId: string, ctx: ActorCtx): Promise<ImportJobRow> {
    const job = await importRepository.getJob(jobId);
    if (!job) throw new NotFoundError("ImportJob not found");
    if (job.status !== ImportJobStatus.PENDING && job.status !== ImportJobStatus.RUNNING) {
      throw new ConflictError(`Cannot cancel job in status ${job.status}`);
    }
    const updated = await importRepository.updateJob(jobId, {
      status: ImportJobStatus.CANCELLED,
      completedAt: new Date(),
      failureReason: job.failureReason ?? "cancelled by admin",
    });
    audit({
      action: "import_job.cancel",
      entityType: "ImportJob",
      entityId: jobId,
      actorType: "ADMIN",
      details: { sourceId: job.sourceId },
      req: ctx.req ?? null,
    });
    return updated;
  },
};
