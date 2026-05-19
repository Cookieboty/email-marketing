/**
 * 抑制名单业务服务。
 *
 * 关键约束：
 *  - (type, value) 唯一；create 捕获 P2002 转 ConflictError
 *  - EMAIL/DOMAIN 存储前归一化（lowercase）；PATTERN 保留原样
 *  - 写入/更新/删除后必须使任何相关缓存失效（由 check.ts 监听）
 *  - import 全部走 $transaction，整批回滚；逐行汇报错误由路由处理
 */

import { Prisma } from "@prisma/client";
import { audit } from "@/lib/audit";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { invalidateSuppressionCache } from "./check";
import { suppressionRepository, type ListSuppressionResult } from "./repository";
import {
  normalizeSuppressionValue,
  type CreateSuppressionInput,
  type ImportSuppressionInput,
  type ListSuppressionQuery,
  type UpdateSuppressionInput,
} from "./schema";

interface ActorContext {
  actorType: "ADMIN" | "SYSTEM" | "WEBHOOK";
  req?: { headers: Headers } | null;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

export const suppressionService = {
  list(query: ListSuppressionQuery): Promise<ListSuppressionResult> {
    return suppressionRepository.list(query);
  },

  async getById(id: string) {
    const e = await suppressionRepository.findById(id);
    if (!e) throw new NotFoundError("Suppression entry not found");
    return e;
  },

  async create(input: CreateSuppressionInput, ctx: ActorContext) {
    const value = normalizeSuppressionValue(input.type, input.value);
    try {
      const entry = await suppressionRepository.create({
        type: input.type,
        value,
        reason: input.reason ?? null,
        source: input.source ?? null,
      });
      invalidateSuppressionCache();
      audit({
        action: "suppression.create",
        entityType: "SuppressionEntry",
        entityId: entry.id,
        actorType: ctx.actorType,
        details: { type: entry.type, value: entry.value, source: entry.source },
        req: ctx.req ?? null,
      });
      return entry;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictError("Suppression entry already exists for given type/value");
      }
      throw err;
    }
  },

  async update(id: string, input: UpdateSuppressionInput, ctx: ActorContext) {
    const existing = await suppressionRepository.findById(id);
    if (!existing) throw new NotFoundError("Suppression entry not found");
    const data: Prisma.SuppressionEntryUncheckedUpdateInput = {};
    if (input.reason !== undefined) data.reason = input.reason ?? null;
    if (input.source !== undefined) data.source = input.source ?? null;
    const entry = await suppressionRepository.update(id, data);
    invalidateSuppressionCache();
    audit({
      action: "suppression.update",
      entityType: "SuppressionEntry",
      entityId: id,
      actorType: ctx.actorType,
      details: { type: entry.type, fields: Object.keys(input) },
      req: ctx.req ?? null,
    });
    return entry;
  },

  async delete(id: string, ctx: ActorContext) {
    const existing = await suppressionRepository.findById(id);
    if (!existing) throw new NotFoundError("Suppression entry not found");
    await suppressionRepository.delete(id);
    invalidateSuppressionCache();
    audit({
      action: "suppression.delete",
      entityType: "SuppressionEntry",
      entityId: id,
      actorType: ctx.actorType,
      details: { type: existing.type, value: existing.value },
      req: ctx.req ?? null,
    });
  },

  /**
   * 批量导入：每行各自归一化，整批 $transaction。
   * 同 (type,value) 已存在则 update reason/source（可选）；新增行 create。
   */
  async import(
    input: ImportSuppressionInput,
    ctx: ActorContext,
  ): Promise<{ created: number; updated: number }> {
    const normalized = input.entries.map((e) => ({
      type: e.type,
      value: normalizeSuppressionValue(e.type, e.value),
      reason: e.reason ?? null,
      source: e.source ?? null,
    }));
    const result = await prisma.$transaction((tx) =>
      suppressionRepository.upsertMany(normalized, tx),
    );
    invalidateSuppressionCache();
    audit({
      action: "suppression.import",
      entityType: "SuppressionEntry",
      entityId: "batch",
      actorType: ctx.actorType,
      details: { created: result.created, updated: result.updated },
      req: ctx.req ?? null,
    });
    return result;
  },
};

export type SuppressionService = typeof suppressionService;
