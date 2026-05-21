/**
 * userService.upsertByExternalIdOrEmail：Phase 9 / 10 共用的高级 Upsert 函数。
 *
 * 关联 spec：specs/modules/inbound-connector.md / import-spec
 *
 * 决策表（input.externalId / input.email）：
 *   1. externalId 存在 → byExternalId
 *   2. byEmail 存在
 *   3. byExternalId && byEmail 命中不同用户 → ConflictError(email_conflict)
 *   4. 命中同一用户 → 走 update
 *   5. 都没命中 → create
 *
 * Tags：
 *   - 默认 mode = "merge"，与现有 tag 合并
 *   - mode = "replace" → setTags
 *   - mode = "skip"    → 不动 tag
 *   - 不存在的 name 自动创建
 *
 * 调用方应包在事务里以确保 tag/user 一致性，本函数会启动内部 transaction。
 */

import type { Prisma } from "@prisma/client";
import { OptInStatus, Prisma as PrismaNS } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { audit } from "@/lib/audit";
import { isValidEmail, normalizeEmail } from "@/lib/email-utils";
import { ValidationError, AppError } from "@/lib/errors";
import {
  userRepository,
  type PrismaTx,
  type UserWithTags,
} from "./repository";
import { resolveTagIds, isUniqueViolation } from "./service";

const log = logger.child("user-upsert");

function emailConflict(message: string): AppError {
  return new AppError(message, { status: 409, code: "email_conflict" });
}

export type UpsertTagMode = "merge" | "replace" | "skip";

export interface UpsertByExternalIdOrEmailInput {
  email: string;
  externalId?: string | null;
  name?: string | null;
  metadata?: Record<string, unknown> | null;
  locale?: "zh" | "en" | null;
  /** 标签名列表；不存在的自动创建。 */
  tags?: string[];
  /** 标签合并模式，默认 merge。 */
  tagMode?: UpsertTagMode;
  source?: string | null;
  userLevel?: string | null;
  /** Prisma Decimal: pass as string "123.45" */
  totalSpend?: string | null;
  orderCount?: number | null;
  balance?: number | null;
  usedQuota?: number | null;
  requestCount?: number | null;
}

export interface UpsertActor {
  actorType: "ADMIN" | "SYSTEM" | "WEBHOOK";
  req?: { headers: Headers } | null;
  /** 审计 action 前缀，例如 "inbound" → action="inbound.user_upsert" */
  auditPrefix?: string;
  apiClientId?: string;
  idempotencyKey?: string | null;
}

export interface UpsertResult {
  user: UserWithTags;
  created: boolean;
  /** 命中的标签 id 集（最终用户拥有的）。 */
  tagIds: string[];
}

async function applyTags(
  userId: string,
  resolvedTagIds: string[],
  mode: UpsertTagMode,
  tx: PrismaTx,
): Promise<void> {
  if (mode === "skip" || resolvedTagIds.length === 0 && mode !== "replace") return;
  if (mode === "replace") {
    await userRepository.setTags(userId, resolvedTagIds, tx);
    return;
  }
  // merge
  await userRepository.addTags(userId, resolvedTagIds, tx);
}

export async function upsertByExternalIdOrEmail(
  input: UpsertByExternalIdOrEmailInput,
  ctx: UpsertActor,
): Promise<UpsertResult> {
  if (!isValidEmail(input.email)) {
    throw new ValidationError("Invalid email format", [
      { path: ["email"], message: "invalid" },
    ]);
  }
  const email = normalizeEmail(input.email);
  const externalId = input.externalId?.trim() || null;
  const tagMode: UpsertTagMode = input.tagMode ?? "merge";

  return await prisma.$transaction(async (tx) => {
    const byExternalId = externalId
      ? await userRepository.findByExternalId(externalId, tx)
      : null;
    const byEmail = await userRepository.findByEmail(email, tx);

    if (byExternalId && byEmail && byExternalId.id !== byEmail.id) {
      throw emailConflict("externalId and email map to different users");
    }

    const resolvedTagIds =
      input.tags && input.tags.length > 0
        ? await resolveTagIds({ tagNames: input.tags }, tx)
        : [];

    const target = byExternalId ?? byEmail;

    if (target) {
      const data: Prisma.UserUncheckedUpdateInput = {};
      if (input.name !== undefined) data.name = input.name ?? null;
      if (input.source !== undefined) data.source = input.source ?? null;
      if (input.locale !== undefined) data.locale = input.locale;
      if (input.metadata !== undefined) {
        data.metadata =
          input.metadata === null
            ? PrismaNS.JsonNull
            : (input.metadata as Prisma.InputJsonValue);
      }
      if (input.userLevel !== undefined && target.userLevel !== "business") {
        data.userLevel = input.userLevel;
      }
      if (input.totalSpend !== undefined) data.totalSpend = input.totalSpend;
      if (input.orderCount !== undefined) data.orderCount = input.orderCount;
      if (input.balance !== undefined) data.balance = input.balance;
      if (input.usedQuota !== undefined) data.usedQuota = input.usedQuota;
      if (input.requestCount !== undefined) data.requestCount = input.requestCount;

      if (externalId && !target.externalId) data.externalId = externalId;

      let updated = target;
      if (Object.keys(data).length > 0) {
        try {
          updated = await userRepository.update(target.id, data, tx);
        } catch (err) {
          if (isUniqueViolation(err, "externalId")) {
            throw emailConflict("externalId already exists");
          }
          throw err;
        }
      }

      await applyTags(target.id, resolvedTagIds, tagMode, tx);
      const finalUser = (await userRepository.findById(target.id, tx)) ?? updated;

      audit({
        action: `${ctx.auditPrefix ?? "user"}.user_upsert`,
        entityType: "User",
        entityId: finalUser.id,
        actorType: ctx.actorType,
        details: {
          mode: "update",
          email: finalUser.email,
          externalId: finalUser.externalId,
          tagMode,
          tagCount: resolvedTagIds.length,
          apiClientId: ctx.apiClientId,
          idempotencyKey: ctx.idempotencyKey ?? undefined,
        },
        req: ctx.req ?? null,
      });

      return {
        user: finalUser,
        created: false,
        tagIds: finalUser.tags.map((t) => t.id),
      };
    }

    // create
    const createData: Prisma.UserUncheckedCreateInput = {
      email,
      externalId,
      name: input.name ?? null,
      source: input.source ?? null,
      locale: input.locale ?? null,
      metadata:
        input.metadata === undefined || input.metadata === null
          ? undefined
          : (input.metadata as Prisma.InputJsonValue),
      userLevel: input.userLevel ?? undefined,
      totalSpend: input.totalSpend ?? undefined,
      orderCount: input.orderCount ?? undefined,
      balance: input.balance ?? undefined,
      usedQuota: input.usedQuota ?? undefined,
      requestCount: input.requestCount ?? undefined,
    };
    if (env().DOUBLE_OPT_IN_ENABLED) {
      createData.optInStatus = OptInStatus.PENDING;
    }

    let created: UserWithTags;
    try {
      created = await userRepository.create(createData, tx);
    } catch (err) {
      if (isUniqueViolation(err, "email")) {
        throw emailConflict("Email already exists");
      }
      if (isUniqueViolation(err, "externalId")) {
        throw emailConflict("externalId already exists");
      }
      throw err;
    }

    if (resolvedTagIds.length > 0 && tagMode !== "skip") {
      await applyTags(created.id, resolvedTagIds, tagMode, tx);
    }
    const finalUser = (await userRepository.findById(created.id, tx)) ?? created;

    audit({
      action: `${ctx.auditPrefix ?? "user"}.user_upsert`,
      entityType: "User",
      entityId: finalUser.id,
      actorType: ctx.actorType,
      details: {
        mode: "create",
        email: finalUser.email,
        externalId: finalUser.externalId,
        tagMode,
        tagCount: resolvedTagIds.length,
        apiClientId: ctx.apiClientId,
        idempotencyKey: ctx.idempotencyKey ?? undefined,
      },
      req: ctx.req ?? null,
    });

    if (env().DOUBLE_OPT_IN_ENABLED) {
      log.info("opt-in pending after upsert", { userId: finalUser.id });
    }

    return {
      user: finalUser,
      created: true,
      tagIds: finalUser.tags.map((t) => t.id),
    };
  });
}
