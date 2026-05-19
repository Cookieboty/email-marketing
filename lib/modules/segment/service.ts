/**
 * 分群业务服务。
 *
 * 职责：
 *  - 校验 + 写库（CRUD）
 *  - create/update 后立即重算 userCount + lastCalculatedAt
 *  - 名称冲突 → ConflictError；不存在 → NotFoundError；系统分群保护 → ForbiddenError；
 *    被 Campaign 引用 → ConflictError
 *  - 写 AuditLog（fire-and-forget）
 *
 * 性能注意：
 *  - 大型分群 count 可能慢；spec §312 建议大分群依赖 cron 缓存而非每次同步重算
 *  - 同步 recompute 用于「编辑后让前端立即看到结果」；批量重算走 worker（recomputeAllStale）
 */

import { Prisma } from "@prisma/client";
import { audit } from "@/lib/audit";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import {
  parseSegmentCondition,
  type SegmentCondition,
} from "./conditions";
import { segmentRepository, parseStoredConditions } from "./repository";
import type {
  CreateSegmentInput,
  ListSegmentsQuery,
  SegmentPreviewQuery,
  UpdateSegmentInput,
} from "./schema";

interface ActorContext {
  actorType: "ADMIN" | "SYSTEM" | "WEBHOOK";
  req?: { headers: Headers } | null;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

async function ensureNameAvailable(name: string, ignoreId?: string): Promise<void> {
  const existing = await segmentRepository.findByName(name);
  if (existing && existing.id !== ignoreId) {
    throw new ConflictError("Segment name already exists");
  }
}

/**
 * 重算单个分群的 userCount，写回 DB。
 *
 * - 通过 conditions JSON 重新解析（防御）
 * - 用 compiler 生成 where，跑 prisma.user.count
 * - 同时写 lastCalculatedAt
 */
export async function recomputeSegmentCount(id: string): Promise<{
  userCount: number;
  lastCalculatedAt: Date;
}> {
  const seg = await segmentRepository.findById(id);
  if (!seg) throw new NotFoundError("Segment not found");
  const tree = parseStoredConditions(seg.conditions);
  const userCount = await segmentRepository.countMatching(tree);
  const updated = await segmentRepository.update(id, {
    userCount,
    lastCalculatedAt: new Date(),
  });
  return {
    userCount: updated.userCount,
    lastCalculatedAt: updated.lastCalculatedAt as Date,
  };
}

export const segmentService = {
  list(query: ListSegmentsQuery) {
    return segmentRepository.list(query);
  },

  async getById(id: string) {
    const s = await segmentRepository.findById(id);
    if (!s) throw new NotFoundError("Segment not found");
    return s;
  },

  /**
   * 创建分群。本方法会先把条件树编译并立即跑一次 count，
   * 失败（例如 conditions 无效到了 SQL 层）将作为 ValidationError 返回。
   */
  async create(input: CreateSegmentInput, ctx: ActorContext) {
    await ensureNameAvailable(input.name);
    const tree = input.conditions as SegmentCondition;
    const userCount = await safeCount(tree);

    let segment;
    try {
      segment = await segmentRepository.create({
        name: input.name,
        description: input.description ?? null,
        conditions: tree as unknown as Prisma.InputJsonValue,
        userCount,
        lastCalculatedAt: new Date(),
        isSystem: false,
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError("Segment name already exists");
      throw err;
    }

    audit({
      action: "segment.create",
      entityType: "Segment",
      entityId: segment.id,
      actorType: ctx.actorType,
      details: { name: segment.name, userCount },
      req: ctx.req ?? null,
    });
    return segment;
  },

  async update(id: string, input: UpdateSegmentInput, ctx: ActorContext) {
    const existing = await segmentRepository.findById(id);
    if (!existing) throw new NotFoundError("Segment not found");
    if (existing.isSystem && (input.conditions !== undefined || input.name !== undefined)) {
      // 系统内置分群只允许更新 description，避免破坏「全部用户」等核心语义
      throw new ForbiddenError("System segment can only update description");
    }

    if (input.name !== undefined && input.name !== existing.name) {
      await ensureNameAvailable(input.name, id);
    }

    const data: Prisma.SegmentUncheckedUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.description !== undefined) data.description = input.description ?? null;
    if (input.conditions !== undefined) {
      const tree = input.conditions as SegmentCondition;
      data.conditions = tree as unknown as Prisma.InputJsonValue;
      data.userCount = await safeCount(tree);
      data.lastCalculatedAt = new Date();
    }

    let segment;
    try {
      segment = await segmentRepository.update(id, data);
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError("Segment name already exists");
      throw err;
    }

    audit({
      action: "segment.update",
      entityType: "Segment",
      entityId: id,
      actorType: ctx.actorType,
      details: {
        name: segment.name,
        fields: Object.keys(input),
        userCount: segment.userCount,
      },
      req: ctx.req ?? null,
    });
    return segment;
  },

  async delete(id: string, ctx: ActorContext) {
    const existing = await segmentRepository.findById(id);
    if (!existing) throw new NotFoundError("Segment not found");
    if (existing.isSystem) throw new ForbiddenError("System segment cannot be deleted");

    const referenced = await prisma.campaign.count({ where: { segmentId: id } });
    if (referenced > 0) {
      throw new ConflictError(
        `Segment is referenced by ${referenced} campaign(s) and cannot be deleted`,
      );
    }

    await segmentRepository.delete(id);
    audit({
      action: "segment.delete",
      entityType: "Segment",
      entityId: id,
      actorType: ctx.actorType,
      details: { name: existing.name },
      req: ctx.req ?? null,
    });
  },

  /** 同步重算一个分群的 userCount。手动触发或编辑后调用。 */
  async refresh(id: string, ctx: ActorContext) {
    const result = await recomputeSegmentCount(id);
    audit({
      action: "segment.refresh",
      entityType: "Segment",
      entityId: id,
      actorType: ctx.actorType,
      details: { userCount: result.userCount },
      req: ctx.req ?? null,
    });
    return result;
  },

  /** 预览前 N 个匹配用户；用于编辑器与详情页右侧面板。 */
  async preview(id: string, query: SegmentPreviewQuery) {
    const seg = await segmentRepository.findById(id);
    if (!seg) throw new NotFoundError("Segment not found");
    const tree = parseStoredConditions(seg.conditions);
    return segmentRepository.previewMatching(tree, query.limit);
  },

  /**
   * 校验 + 干跑：编辑器实时显示「估算用户数」时使用。
   * 校验失败抛 ValidationError；成功返回 estimatedUserCount。
   */
  async validate(rawConditions: unknown): Promise<{ valid: true; estimatedUserCount: number }> {
    let tree: SegmentCondition;
    try {
      tree = parseSegmentCondition(rawConditions);
    } catch (err) {
      throw new ValidationError(
        err instanceof Error ? err.message : "Invalid conditions",
      );
    }
    const estimatedUserCount = await segmentRepository.countMatching(tree);
    return { valid: true, estimatedUserCount };
  },
};

/**
 * 包装 countMatching：编译异常时转 ValidationError，避免 5xx。
 */
async function safeCount(tree: SegmentCondition): Promise<number> {
  try {
    return await segmentRepository.countMatching(tree);
  } catch (err) {
    throw new ValidationError(
      err instanceof Error
        ? `Failed to compute userCount: ${err.message}`
        : "Failed to compute userCount",
    );
  }
}

export type SegmentService = typeof segmentService;
