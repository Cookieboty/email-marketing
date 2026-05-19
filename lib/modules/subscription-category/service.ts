/**
 * 订阅分类 / 用户订阅业务服务。
 *
 * 关键约束（对齐 specs/modules/preference-center.md）：
 *  - slug 唯一；slug 不可更新（从 UpdateSchema 中已剔除）
 *  - isTransactional 只能在创建时设置；不允许通过 update 切换
 *  - isPreset = true 的分类不可删除（系统预置）
 *  - 被 Campaign（按 slug）引用的分类不可删除
 *  - 不允许把 isTransactional 分类的某用户订阅状态置为 false（前端/API 双重拒绝）
 *
 * 安全/性能：
 *  - listUserSubscriptions 合并视图（未落库分类按 isDefault 推导，不写库 → 惰性初始化）
 *  - 批量更新走单事务，错误整体回滚；出错时返回详细行级失败（已交予调用方）
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
  subscriptionCategoryRepository,
  type SubscriptionCategoryWithCount,
  type UserSubscriptionView,
} from "./repository";
import type {
  BatchUpdateSubscriptionsInput,
  CreateSubscriptionCategoryInput,
  ListSubscriptionCategoriesQuery,
  UpdateSubscriptionCategoryInput,
  UpdateUserSubscriptionsInput,
} from "./schema";

interface ActorContext {
  actorType: "ADMIN" | "SYSTEM" | "WEBHOOK";
  req?: { headers: Headers } | null;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

function isForeignKeyViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003";
}

export const subscriptionCategoryService = {
  list(query: ListSubscriptionCategoriesQuery): Promise<SubscriptionCategoryWithCount[]> {
    return subscriptionCategoryRepository.list(query);
  },

  async getById(id: string) {
    const c = await subscriptionCategoryRepository.findById(id);
    if (!c) throw new NotFoundError("Subscription category not found");
    return c;
  },

  async create(input: CreateSubscriptionCategoryInput, ctx: ActorContext) {
    try {
      const cat = await subscriptionCategoryRepository.create({
        name: input.name,
        description: input.description ?? null,
        slug: input.slug,
        isDefault: input.isDefault,
        isTransactional: input.isTransactional,
        sortOrder: input.sortOrder,
        // 用户创建的分类永远不是预置
        isPreset: false,
      });
      audit({
        action: "subscription_category.create",
        entityType: "SubscriptionCategory",
        entityId: cat.id,
        actorType: ctx.actorType,
        details: {
          slug: cat.slug,
          name: cat.name,
          isTransactional: cat.isTransactional,
        },
        req: ctx.req ?? null,
      });
      return cat;
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError("Subscription slug already exists");
      throw err;
    }
  },

  async update(id: string, input: UpdateSubscriptionCategoryInput, ctx: ActorContext) {
    const existing = await subscriptionCategoryRepository.findById(id);
    if (!existing) throw new NotFoundError("Subscription category not found");

    const data: Prisma.SubscriptionCategoryUncheckedUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.description !== undefined) data.description = input.description ?? null;
    if (input.isDefault !== undefined) data.isDefault = input.isDefault;
    if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;

    const cat = await subscriptionCategoryRepository.update(id, data);
    audit({
      action: "subscription_category.update",
      entityType: "SubscriptionCategory",
      entityId: id,
      actorType: ctx.actorType,
      details: { slug: cat.slug, fields: Object.keys(input) },
      req: ctx.req ?? null,
    });
    return cat;
  },

  async delete(id: string, ctx: ActorContext) {
    const existing = await subscriptionCategoryRepository.findById(id);
    if (!existing) throw new NotFoundError("Subscription category not found");
    if (existing.isPreset) {
      throw new ForbiddenError("Preset subscription category cannot be deleted");
    }
    const referenced = await subscriptionCategoryRepository.countCampaignReferences(
      existing.slug,
    );
    if (referenced > 0) {
      throw new ConflictError(
        `Subscription category is referenced by ${referenced} campaign(s) and cannot be deleted`,
      );
    }
    await subscriptionCategoryRepository.delete(id);
    audit({
      action: "subscription_category.delete",
      entityType: "SubscriptionCategory",
      entityId: id,
      actorType: ctx.actorType,
      details: { slug: existing.slug, name: existing.name },
      req: ctx.req ?? null,
    });
  },

  /** 返回用户全分类视图（含未落库分类的默认推导值） */
  async listUserSubscriptions(userId: string): Promise<UserSubscriptionView[]> {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!u) throw new NotFoundError("User not found");
    return subscriptionCategoryRepository.listUserSubscriptions(userId);
  },

  /**
   * 单用户多分类原子更新。
   * 校验：
   *  - 全部 categoryId 必须存在
   *  - isTransactional=true 的分类不允许设置 subscribed=false
   *  - 整体事务：任一失败回滚
   */
  async updateUserSubscriptions(
    userId: string,
    input: UpdateUserSubscriptionsInput,
    ctx: ActorContext,
  ): Promise<UserSubscriptionView[]> {
    const userExists = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!userExists) throw new NotFoundError("User not found");

    const ids = Array.from(new Set(input.subscriptions.map((s) => s.categoryId)));
    if (ids.length !== input.subscriptions.length) {
      throw new ValidationError("Duplicate categoryId in subscriptions");
    }
    const cats = await prisma.subscriptionCategory.findMany({
      where: { id: { in: ids } },
    });
    if (cats.length !== ids.length) {
      throw new NotFoundError("One or more subscription categories not found");
    }
    const byId = new Map(cats.map((c) => [c.id, c]));

    for (const sub of input.subscriptions) {
      const cat = byId.get(sub.categoryId)!;
      if (cat.isTransactional && sub.subscribed === false) {
        throw new ValidationError(
          `Transactional category "${cat.slug}" cannot be unsubscribed`,
        );
      }
    }

    await prisma.$transaction(async (tx) => {
      for (const sub of input.subscriptions) {
        await subscriptionCategoryRepository.upsertUserSubscription(
          userId,
          sub.categoryId,
          sub.subscribed,
          tx,
        );
      }
    });

    audit({
      action: "user_subscription.update",
      entityType: "User",
      entityId: userId,
      actorType: ctx.actorType,
      details: {
        changes: input.subscriptions.map((s) => ({
          slug: byId.get(s.categoryId)?.slug,
          subscribed: s.subscribed,
        })),
      },
      req: ctx.req ?? null,
    });
    return subscriptionCategoryRepository.listUserSubscriptions(userId);
  },

  /**
   * 跨用户批量更新订阅状态。
   * 与单用户版相同的安全约束，但允许部分行报错时整体回滚。
   * 返回成功更新数量。
   */
  async batchUpdate(
    input: BatchUpdateSubscriptionsInput,
    ctx: ActorContext,
  ): Promise<{ updated: number }> {
    const categoryIds = Array.from(new Set(input.updates.map((u) => u.categoryId)));
    const cats = await prisma.subscriptionCategory.findMany({
      where: { id: { in: categoryIds } },
    });
    if (cats.length !== categoryIds.length) {
      throw new NotFoundError("One or more subscription categories not found");
    }
    const byId = new Map(cats.map((c) => [c.id, c]));
    for (const u of input.updates) {
      const cat = byId.get(u.categoryId);
      if (!cat) {
        throw new NotFoundError(`Subscription category ${u.categoryId} not found`);
      }
      if (cat.isTransactional && u.subscribed === false) {
        throw new ValidationError(
          `Transactional category "${cat.slug}" cannot be unsubscribed`,
        );
      }
    }
    let updated = 0;
    try {
      await prisma.$transaction(async (tx) => {
        for (const u of input.updates) {
          await subscriptionCategoryRepository.upsertUserSubscription(
            u.userId,
            u.categoryId,
            u.subscribed,
            tx,
          );
          updated += 1;
        }
      });
    } catch (err) {
      if (isForeignKeyViolation(err)) {
        // 某条 userId 不存在：整批回滚，提示前端
        throw new NotFoundError("One or more users not found");
      }
      throw err;
    }
    audit({
      action: "user_subscription.batch_update",
      entityType: "UserSubscription",
      entityId: "batch",
      actorType: ctx.actorType,
      details: { count: updated },
      req: ctx.req ?? null,
    });
    return { updated };
  },
};

export type SubscriptionCategoryService = typeof subscriptionCategoryService;
