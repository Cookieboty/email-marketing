/**
 * 用户业务服务。
 *
 * 职责：
 *  - 校验输入（结合 zod schema 与 DB 唯一性）
 *  - 归一化 email
 *  - 解析 tagIds/tagNames（自动创建不存在的标签）
 *  - 写入 AuditLog（fire-and-forget）
 *  - 抛出语义化 AppError
 */

import type { Prisma } from "@prisma/client";
import { OptInStatus, Prisma as PrismaNS } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { normalizeEmail, isValidEmail } from "@/lib/email-utils";
import { audit } from "@/lib/audit";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import type { CreateUserInput, ListUsersQuery, UpdateUserInput } from "./schema";
import { userRepository, type PrismaTx, type UserWithTags } from "./repository";
import { resendOptInEmail, sendOptInEmail } from "./opt-in";
import { onUserCreated, onTagChanged } from "@/lib/modules/automation/service";

interface ActorContext {
  actorType: "ADMIN" | "SYSTEM" | "WEBHOOK";
  req?: { headers: Headers } | null;
}

function isUniqueViolation(err: unknown, target: string): boolean {
  if (err instanceof PrismaNS.PrismaClientKnownRequestError && err.code === "P2002") {
    const meta = err.meta as { target?: string[] | string } | undefined;
    const t = meta?.target;
    if (Array.isArray(t)) return t.some((x) => x.includes(target));
    if (typeof t === "string") return t.includes(target);
  }
  return false;
}

async function resolveTagIds(
  input: { tagIds?: string[]; tagNames?: string[] },
  db: PrismaTx = prisma,
): Promise<string[]> {
  const ids = new Set<string>(input.tagIds ?? []);

  if (input.tagNames && input.tagNames.length > 0) {
    const names = Array.from(new Set(input.tagNames.map((n) => n.trim()).filter(Boolean)));
    const existing = await db.tag.findMany({ where: { name: { in: names } } });
    const existingByName = new Map(existing.map((t) => [t.name, t.id]));
    for (const name of names) {
      const found = existingByName.get(name);
      if (found) {
        ids.add(found);
      } else {
        const created = await db.tag.create({ data: { name } });
        ids.add(created.id);
      }
    }
  }

  if (ids.size === 0) return [];

  // 校验 tagIds 都存在（避免外键失败）
  const all = Array.from(ids);
  const found = await db.tag.findMany({ where: { id: { in: all } }, select: { id: true } });
  if (found.length !== all.length) {
    const foundSet = new Set(found.map((t) => t.id));
    const missing = all.filter((id) => !foundSet.has(id));
    throw new NotFoundError(`Tag(s) not found: ${missing.join(", ")}`);
  }
  return all;
}

function buildCreateData(
  input: CreateUserInput,
  email: string,
): Prisma.UserUncheckedCreateInput {
  const data: Prisma.UserUncheckedCreateInput = {
    email,
    externalId: input.externalId ?? null,
    name: input.name ?? null,
    source: input.source ?? null,
    metadata:
      input.metadata === undefined
        ? undefined
        : (input.metadata as Prisma.InputJsonValue),
    userLevel: input.userLevel ?? null,
    orderCount: input.orderCount,
    lastOrderAt: input.lastOrderAt ?? null,
    birthDate: input.birthDate ?? null,
  };
  if (input.totalSpend !== undefined) {
    data.totalSpend = new PrismaNS.Decimal(String(input.totalSpend));
  }
  // Double Opt-in：启用时新用户初始 PENDING；token/sentAt 由后续 sendOptInEmail 落库
  if (env().DOUBLE_OPT_IN_ENABLED) {
    data.optInStatus = OptInStatus.PENDING;
  }
  return data;
}

export const userService = {
  async list(query: ListUsersQuery) {
    return userRepository.list(query);
  },

  async getById(id: string): Promise<UserWithTags> {
    const u = await userRepository.findById(id);
    if (!u) throw new NotFoundError("User not found");
    return u;
  },

  async create(input: CreateUserInput, ctx: ActorContext): Promise<UserWithTags> {
    if (!isValidEmail(input.email)) {
      throw new ValidationError("Invalid email format", [{ path: ["email"], message: "invalid" }]);
    }
    const email = normalizeEmail(input.email);

    return await prisma.$transaction(async (tx) => {
      const tagIds = await resolveTagIds(input, tx);
      let user: UserWithTags;
      try {
        user = await userRepository.create(buildCreateData(input, email), tx);
      } catch (err) {
        if (isUniqueViolation(err, "email")) throw new ConflictError("Email already exists");
        if (isUniqueViolation(err, "externalId"))
          throw new ConflictError("externalId already exists");
        throw err;
      }
      if (tagIds.length > 0) {
        await userRepository.setTags(user.id, tagIds, tx);
        user = (await userRepository.findById(user.id, tx)) ?? user;
      }
      audit({
        action: "user.create",
        entityType: "User",
        entityId: user.id,
        actorType: ctx.actorType,
        details: { email: user.email, externalId: user.externalId, tagCount: tagIds.length },
        req: ctx.req ?? null,
      });
      // Double Opt-in：fire-and-forget 发送确认邮件；失败仅记录日志，不阻塞创建响应
      if (env().DOUBLE_OPT_IN_ENABLED) {
        const userId = user.id;
        sendOptInEmail(userId).catch((err) => {
          logger.warn("opt-in email kick-off failed", {
            userId,
            message: err instanceof Error ? err.message : String(err),
          });
        });
      }
      onUserCreated(user.id);
      return user;
    });
  },

  async update(
    id: string,
    input: UpdateUserInput,
    ctx: ActorContext,
  ): Promise<UserWithTags> {
    const existing = await userRepository.findById(id);
    if (!existing) throw new NotFoundError("User not found");

    const data: Prisma.UserUncheckedUpdateInput = {};
    if (input.name !== undefined) data.name = input.name ?? null;
    if (input.source !== undefined) data.source = input.source ?? null;
    if (input.metadata !== undefined) data.metadata = input.metadata as Prisma.InputJsonValue;
    if (input.userLevel !== undefined) data.userLevel = input.userLevel ?? null;
    if (input.orderCount !== undefined) data.orderCount = input.orderCount;
    if (input.lastOrderAt !== undefined) data.lastOrderAt = input.lastOrderAt;
    if (input.birthDate !== undefined) data.birthDate = input.birthDate;
    if (input.totalSpend !== undefined) {
      data.totalSpend = new PrismaNS.Decimal(String(input.totalSpend));
    }

    const updated = await userRepository.update(id, data);

    audit({
      action: "user.update",
      entityType: "User",
      entityId: id,
      actorType: ctx.actorType,
      details: { email: updated.email, fields: Object.keys(input) },
      req: ctx.req ?? null,
    });
    return updated;
  },

  async delete(id: string, ctx: ActorContext): Promise<void> {
    const existing = await userRepository.findById(id);
    if (!existing) throw new NotFoundError("User not found");
    await userRepository.delete(id);
    audit({
      action: "user.delete",
      entityType: "User",
      entityId: id,
      actorType: ctx.actorType,
      details: { email: existing.email },
      req: ctx.req ?? null,
    });
  },

  async setTags(id: string, tagIds: string[], ctx: ActorContext): Promise<UserWithTags> {
    const existing = await userRepository.findById(id);
    if (!existing) throw new NotFoundError("User not found");
    await prisma.$transaction(async (tx) => {
      const resolved = await resolveTagIds({ tagIds }, tx);
      await userRepository.setTags(id, resolved, tx);
    });
    const updated = await userRepository.findById(id);
    audit({
      action: "user.set_tags",
      entityType: "User",
      entityId: id,
      actorType: ctx.actorType,
      details: { email: existing.email, tagIds },
      req: ctx.req ?? null,
    });
    const tagNames = updated!.tags.map((t) => t.name);
    onTagChanged(id, tagNames);
    return updated!;
  },

  async addTags(id: string, tagIds: string[], ctx: ActorContext): Promise<UserWithTags> {
    const existing = await userRepository.findById(id);
    if (!existing) throw new NotFoundError("User not found");
    await prisma.$transaction(async (tx) => {
      const resolved = await resolveTagIds({ tagIds }, tx);
      await userRepository.addTags(id, resolved, tx);
    });
    const updated = await userRepository.findById(id);
    audit({
      action: "user.add_tags",
      entityType: "User",
      entityId: id,
      actorType: ctx.actorType,
      details: { email: existing.email, tagIds },
      req: ctx.req ?? null,
    });
    const tagNames = updated!.tags.map((t) => t.name);
    onTagChanged(id, tagNames);
    return updated!;
  },

  async removeTag(id: string, tagId: string, ctx: ActorContext): Promise<void> {
    const existing = await userRepository.findById(id);
    if (!existing) throw new NotFoundError("User not found");
    await userRepository.removeTag(id, tagId);
    audit({
      action: "user.remove_tag",
      entityType: "User",
      entityId: id,
      actorType: ctx.actorType,
      details: { email: existing.email, tagId },
      req: ctx.req ?? null,
    });
  },

  async resendOptIn(id: string, ctx: ActorContext) {
    return resendOptInEmail(id, { req: ctx.req ?? null });
  },
};

export { resolveTagIds, isUniqueViolation };
export type UserService = typeof userService;
