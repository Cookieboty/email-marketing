/**
 * 订阅分类数据访问层。
 *
 * 提供：
 *  - 分类 CRUD
 *  - subscriberCount 聚合（subscribed=true 的 UserSubscription 计数）
 *  - 用户订阅状态查询（merge 了未落库分类的默认值）
 *  - 跨用户批量 upsert（单事务，subscribed 行为按 spec 表）
 */

import type { Prisma, SubscriptionCategory, UserSubscription } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { PrismaTx } from "../user/repository";
import type { ListSubscriptionCategoriesQuery } from "./schema";

export interface SubscriptionCategoryWithCount extends SubscriptionCategory {
  subscriberCount: number;
}

export interface UserSubscriptionView {
  category: Pick<
    SubscriptionCategory,
    "id" | "name" | "slug" | "description" | "isDefault" | "isTransactional"
  >;
  subscribed: boolean;
  /** 是否已落库（false 表示返回的是 isDefault 推导值） */
  persisted: boolean;
}

export const subscriptionCategoryRepository = {
  /**
   * 列表 + subscriberCount。
   *
   * 注意：subscriberCount 仅统计 subscribed=true 的记录数，
   * 由于 spec §惰性初始化策略，未落库用户不计入分子，但实际"潜在订阅人数"包括默认订阅的全体用户。
   * 这里返回的是「显式订阅」数，UI 层若要展示"含默认订阅的总数"，应另查 user 总数 - 显式退订数。
   */
  async list(
    query: ListSubscriptionCategoriesQuery,
    db: PrismaTx = prisma,
  ): Promise<SubscriptionCategoryWithCount[]> {
    const where: Prisma.SubscriptionCategoryWhereInput = query.q
      ? {
          OR: [
            { name: { contains: query.q, mode: "insensitive" } },
            { slug: { contains: query.q, mode: "insensitive" } },
          ],
        }
      : {};
    const rows = await db.subscriptionCategory.findMany({
      where,
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      include: {
        _count: {
          select: { subscriptions: { where: { subscribed: true } } },
        },
      },
    });
    return rows.map((r) => {
      const { _count, ...rest } = r as typeof r & {
        _count: { subscriptions: number };
      };
      return {
        ...(rest as SubscriptionCategory),
        subscriberCount: _count.subscriptions,
      };
    });
  },

  findById(id: string, db: PrismaTx = prisma): Promise<SubscriptionCategory | null> {
    return db.subscriptionCategory.findUnique({ where: { id } });
  },

  findBySlug(slug: string, db: PrismaTx = prisma): Promise<SubscriptionCategory | null> {
    return db.subscriptionCategory.findUnique({ where: { slug } });
  },

  create(
    data: Prisma.SubscriptionCategoryUncheckedCreateInput,
    db: PrismaTx = prisma,
  ): Promise<SubscriptionCategory> {
    return db.subscriptionCategory.create({ data });
  },

  update(
    id: string,
    data: Prisma.SubscriptionCategoryUncheckedUpdateInput,
    db: PrismaTx = prisma,
  ): Promise<SubscriptionCategory> {
    return db.subscriptionCategory.update({ where: { id }, data });
  },

  async delete(id: string, db: PrismaTx = prisma): Promise<void> {
    await db.subscriptionCategory.delete({ where: { id } });
  },

  /**
   * 该分类被多少 Campaign 引用（按 slug 关联）。
   * 由于 Campaign.subscriptionCategory 是 slug 字符串而非外键，必须按 slug 查。
   */
  async countCampaignReferences(slug: string, db: PrismaTx = prisma): Promise<number> {
    return db.campaign.count({ where: { subscriptionCategory: slug } });
  },

  /**
   * 获取用户的订阅状态视图：合并所有分类，未落库的按 isDefault 推导。
   */
  async listUserSubscriptions(
    userId: string,
    db: PrismaTx = prisma,
  ): Promise<UserSubscriptionView[]> {
    const [cats, subs] = await Promise.all([
      db.subscriptionCategory.findMany({
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      }),
      db.userSubscription.findMany({ where: { userId } }),
    ]);
    const byCategory = new Map<string, UserSubscription>(
      subs.map((s) => [s.categoryId, s]),
    );
    return cats.map((cat) => {
      const persisted = byCategory.get(cat.id);
      return {
        category: {
          id: cat.id,
          name: cat.name,
          slug: cat.slug,
          description: cat.description,
          isDefault: cat.isDefault,
          isTransactional: cat.isTransactional,
        },
        subscribed: persisted ? persisted.subscribed : cat.isDefault,
        persisted: Boolean(persisted),
      };
    });
  },

  upsertUserSubscription(
    userId: string,
    categoryId: string,
    subscribed: boolean,
    db: PrismaTx = prisma,
  ) {
    return db.userSubscription.upsert({
      where: { userId_categoryId: { userId, categoryId } },
      update: { subscribed },
      create: { userId, categoryId, subscribed },
    });
  },
};

export type SubscriptionCategoryRepository = typeof subscriptionCategoryRepository;
