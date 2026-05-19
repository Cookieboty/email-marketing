/**
 * 邮件内退订（公开入口）业务封装。
 *
 * 与 service.ts 中的管理员入口刻意分离：
 *  - 这里 ctx.actorType 固定为 "SYSTEM"（来源是收件人点击邮件链接，非管理员操作）
 *  - 不做 origin / session 校验：调用方（route handler）已是公开路由
 *  - rate limit 由 route handler 负责（IP + token），service 只关心业务规则
 *
 * 业务规则（spec/preference-center.md §126-205）：
 *  - 仅按 unsubscribeToken 查找用户；未找到 → not_found
 *  - 不带 category：执行全局退订（user.unsubscribed = true）；幂等
 *  - 带 category：仅退订该分类；isTransactional 分类静默忽略（按 spec 不报错）；分类不存在视为无操作
 *  - 任意分支均写一条 audit log，便于审计退订来源
 */

import type { SubscriptionCategory, User } from "@prisma/client";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";

export type UnsubscribeOutcome =
  | { status: "global_unsubscribed"; alreadyUnsubscribed: boolean; user: User }
  | {
      status: "category_unsubscribed";
      category: SubscriptionCategory;
      user: User;
    }
  | {
      status: "category_ignored_transactional";
      category: SubscriptionCategory;
      user: User;
    }
  | { status: "category_not_found"; user: User; slug: string }
  | { status: "user_not_found" };

export interface UnsubscribeRequest {
  token: string;
  /** 可选分类 slug；提供时仅退订该分类 */
  categorySlug?: string | null;
  req?: { headers: Headers } | null;
}

export const subscriptionUnsubscribeService = {
  /**
   * 按 token 退订。所有失败路径都返回结构化结果，由 route 层翻成 HTTP 状态。
   */
  async byToken(input: UnsubscribeRequest): Promise<UnsubscribeOutcome> {
    const user = await prisma.user.findUnique({
      where: { unsubscribeToken: input.token },
    });
    if (!user) return { status: "user_not_found" };

    // ---- 分类退订 ----
    if (input.categorySlug) {
      const cat = await prisma.subscriptionCategory.findUnique({
        where: { slug: input.categorySlug },
      });
      if (!cat) {
        // 分类已被删除：视为无操作（向后兼容 spec §417）
        audit({
          action: "user_subscription.unsubscribe_via_link",
          entityType: "User",
          entityId: user.id,
          actorType: "SYSTEM",
          details: {
            reason: "category_not_found",
            slug: input.categorySlug,
            email: user.email,
          },
          req: input.req ?? null,
        });
        return { status: "category_not_found", user, slug: input.categorySlug };
      }
      if (cat.isTransactional) {
        // 安全静默：spec §175 "isTransactional 分类：忽略退订请求"
        audit({
          action: "user_subscription.unsubscribe_via_link",
          entityType: "User",
          entityId: user.id,
          actorType: "SYSTEM",
          details: {
            reason: "transactional_ignored",
            slug: cat.slug,
            email: user.email,
          },
          req: input.req ?? null,
        });
        return { status: "category_ignored_transactional", category: cat, user };
      }
      await prisma.userSubscription.upsert({
        where: { userId_categoryId: { userId: user.id, categoryId: cat.id } },
        update: { subscribed: false },
        create: { userId: user.id, categoryId: cat.id, subscribed: false },
      });
      audit({
        action: "user_subscription.unsubscribe_via_link",
        entityType: "User",
        entityId: user.id,
        actorType: "SYSTEM",
        details: { slug: cat.slug, email: user.email },
        req: input.req ?? null,
      });
      return { status: "category_unsubscribed", category: cat, user };
    }

    // ---- 全局退订 ----
    const alreadyUnsubscribed = user.unsubscribed;
    let updated: User = user;
    if (!alreadyUnsubscribed) {
      updated = await prisma.user.update({
        where: { id: user.id },
        data: { unsubscribed: true, unsubscribedAt: new Date() },
      });
    }
    audit({
      action: "user.unsubscribe_via_link",
      entityType: "User",
      entityId: user.id,
      actorType: "SYSTEM",
      details: { email: user.email, already: alreadyUnsubscribed },
      req: input.req ?? null,
    });
    return { status: "global_unsubscribed", alreadyUnsubscribed, user: updated };
  },
};

export type SubscriptionUnsubscribeService = typeof subscriptionUnsubscribeService;
