/**
 * 频次控制业务服务。
 *
 * 关键约束：
 *  - 任意时刻仅允许一条 isActive=true（DB partial unique index）。
 *  - 创建 active 配置时若已存在另一条 active，DB 抛 P2002 → ConflictError。
 *  - 切换 isActive=true 通过 update 也由同样的索引保护。
 *  - delete 限制：禁止删除唯一仅剩的 active 配置（避免误删后无配置）。
 *  - getDefaults 从 env 读取，作为 UI 占位值（未实际写库）。
 */

import { Prisma } from "@prisma/client";
import { audit } from "@/lib/audit";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { frequencyRepository } from "./repository";
import type {
  CreateFrequencyCapInput,
  ListFrequencyCapsQuery,
  UpdateFrequencyCapInput,
} from "./schema";

interface ActorContext {
  actorType: "ADMIN" | "SYSTEM" | "WEBHOOK";
  req?: { headers: Headers } | null;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const frequencyService = {
  list(query: ListFrequencyCapsQuery) {
    return frequencyRepository.list(
      query.isActive === undefined ? {} : { isActive: query.isActive },
    );
  },

  getDefaults() {
    return {
      maxEmails: intFromEnv("FREQUENCY_CAP_DEFAULT_MAX", 10),
      periodDays: intFromEnv("FREQUENCY_CAP_DEFAULT_DAYS", 7),
    };
  },

  async getActive() {
    return frequencyRepository.findActive();
  },

  async getById(id: string) {
    const cap = await frequencyRepository.findById(id);
    if (!cap) throw new NotFoundError("Frequency cap not found");
    return cap;
  },

  async create(input: CreateFrequencyCapInput, ctx: ActorContext) {
    try {
      const cap = await frequencyRepository.create({
        maxEmails: input.maxEmails,
        periodDays: input.periodDays,
        isActive: input.isActive ?? true,
      });
      audit({
        action: "frequency_cap.create",
        entityType: "FrequencyCap",
        entityId: cap.id,
        actorType: ctx.actorType,
        details: {
          maxEmails: cap.maxEmails,
          periodDays: cap.periodDays,
          isActive: cap.isActive,
        },
        req: ctx.req ?? null,
      });
      return cap;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictError("Another active frequency cap already exists");
      }
      throw err;
    }
  },

  async update(id: string, input: UpdateFrequencyCapInput, ctx: ActorContext) {
    const existing = await frequencyRepository.findById(id);
    if (!existing) throw new NotFoundError("Frequency cap not found");
    try {
      const cap = await frequencyRepository.update(id, {
        ...(input.maxEmails !== undefined && { maxEmails: input.maxEmails }),
        ...(input.periodDays !== undefined && { periodDays: input.periodDays }),
        ...(input.isActive !== undefined && { isActive: input.isActive }),
      });
      audit({
        action: "frequency_cap.update",
        entityType: "FrequencyCap",
        entityId: id,
        actorType: ctx.actorType,
        details: { fields: Object.keys(input) },
        req: ctx.req ?? null,
      });
      return cap;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictError("Another active frequency cap already exists");
      }
      throw err;
    }
  },

  async delete(id: string, ctx: ActorContext) {
    const existing = await frequencyRepository.findById(id);
    if (!existing) throw new NotFoundError("Frequency cap not found");
    if (existing.isActive) {
      throw new ValidationError(
        "Active frequency cap cannot be deleted directly; deactivate first",
      );
    }
    await frequencyRepository.delete(id);
    audit({
      action: "frequency_cap.delete",
      entityType: "FrequencyCap",
      entityId: id,
      actorType: ctx.actorType,
      details: {
        maxEmails: existing.maxEmails,
        periodDays: existing.periodDays,
      },
      req: ctx.req ?? null,
    });
  },
};

export type FrequencyService = typeof frequencyService;
