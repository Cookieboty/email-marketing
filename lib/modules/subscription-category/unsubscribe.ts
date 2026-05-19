/**
 * 邮件内退订（公开入口）业务封装。
 *
 * 与 service.ts 中的管理员入口刻意分离：
 *  - 这里 ctx.actorType 固定为 "SYSTEM"（来源是收件人点击邮件链接，非管理员操作）
 *  - 不做 origin / session 校验：调用方（route handler）已是公开路由
 *  - rate limit 由 route handler 负责（IP + token），service 只关心业务规则
 *
 * 业务规则（spec/preference-center.md §126-205 + spec/unsubscribe-topic-level.md）：
 *  - 仅按 unsubscribeToken 查找用户；未找到 → not_found
 *  - 不带 category / topic：执行全局退订（user.unsubscribed = true）；幂等
 *  - 带 topic：仅退订该主题；幂等（复合主键 upsert）
 *  - 带 category：仅退订该分类；isTransactional 分类静默忽略
 *  - 同时带 topic + category 时由 route 层决定优先级（topic 优先）
 *  - 任意分支均写一条 audit log，便于审计退订来源
 *
 * evaluateDeliverability：
 *  发送前的统一可达性判定函数（三级短路：全局 → 分类 → 主题）。
 *  所有发送链路（snapshotRecipients、automationRunProcessor、未来 inbound）均应调用。
 */

import type { SubscriptionCategory, Topic, User } from "@prisma/client";
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

export type TopicUnsubscribeOutcome =
  | {
    status: "topic_unsubscribed";
    topic: Topic;
    user: User;
    alreadyUnsubscribed: boolean;
  }
  | { status: "topic_not_found"; slug: string; user: User }
  | { status: "user_not_found" };

export type TopicResubscribeOutcome =
  | { status: "topic_resubscribed"; topic: Topic; user: User; alreadySubscribed: boolean }
  | { status: "topic_not_found"; slug: string; user: User }
  | { status: "user_not_found" };

export interface UnsubscribeRequest {
  token: string;
  /** 可选分类 slug；提供时仅退订该分类 */
  categorySlug?: string | null;
  req?: { headers: Headers } | null;
}

export interface TopicUnsubscribeRequest {
  token: string;
  topicSlug: string;
  req?: { headers: Headers } | null;
}

/**
 * 发送可达性判定（统一短路逻辑）。
 *
 * 三级短路：
 *  1. 全局退订（user.unsubscribed = true） → 拒绝
 *  2. 分类退订（UserSubscription.subscribed = false 或 无记录且 !isDefault） → 拒绝
 *  3. 主题退订（UserTopicUnsubscribe 存在） → 拒绝
 *
 * 注意：批量发送场景（如 snapshotRecipients）应先做 SQL 级别的粗筛（避免 N+1），
 * 本函数主要用于：
 *  - 发送前最后一次单点确认（automationRunProcessor、inbound 触发等）
 *  - 单元测试与诊断
 */
export async function evaluateDeliverability(
  userId: string,
  opts: { categorySlug?: string | null; topicId?: string | null } = {},
): Promise<{ allowed: boolean; reason?: string }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { unsubscribed: true },
  });
  if (!user) return { allowed: false, reason: "user_not_found" };
  if (user.unsubscribed) return { allowed: false, reason: "global_unsubscribed" };

  if (opts.categorySlug) {
    const category = await prisma.subscriptionCategory.findUnique({
      where: { slug: opts.categorySlug },
      select: { id: true, isDefault: true, isTransactional: true },
    });
    if (category && !category.isTransactional) {
      const sub = await prisma.userSubscription.findUnique({
        where: {
          userId_categoryId: { userId, categoryId: category.id },
        },
        select: { subscribed: true },
      });
      // 有明确记录且 subscribed=false → 退订
      // 无记录 + isDefault → 视为已订阅
      // 无记录 + !isDefault → 视为未订阅
      if (sub && !sub.subscribed) {
        return { allowed: false, reason: "category_unsubscribed" };
      }
      if (!sub && !category.isDefault) {
        return { allowed: false, reason: "category_unsubscribed" };
      }
    }
  }

  if (opts.topicId) {
    const unsub = await prisma.userTopicUnsubscribe.findUnique({
      where: { userId_topicId: { userId, topicId: opts.topicId } },
      select: { userId: true },
    });
    if (unsub) return { allowed: false, reason: "topic_unsubscribed" };
  }

  return { allowed: true };
}

export const subscriptionUnsubscribeService = {
  /**
   * 按 token 退订（全局或分类）。所有失败路径都返回结构化结果，由 route 层翻成 HTTP 状态。
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

  /**
   * 按 token + topicSlug 退订主题。复合主键天然幂等。
   */
  async unsubscribeByTopic(
    input: TopicUnsubscribeRequest,
  ): Promise<TopicUnsubscribeOutcome> {
    const user = await prisma.user.findUnique({
      where: { unsubscribeToken: input.token },
    });
    if (!user) return { status: "user_not_found" };

    const topic = await prisma.topic.findUnique({
      where: { slug: input.topicSlug },
    });
    if (!topic) {
      audit({
        action: "user_topic.unsubscribe_via_link",
        entityType: "User",
        entityId: user.id,
        actorType: "SYSTEM",
        details: {
          reason: "topic_not_found",
          slug: input.topicSlug,
          email: user.email,
        },
        req: input.req ?? null,
      });
      return { status: "topic_not_found", slug: input.topicSlug, user };
    }

    const existing = await prisma.userTopicUnsubscribe.findUnique({
      where: { userId_topicId: { userId: user.id, topicId: topic.id } },
      select: { userId: true },
    });
    const alreadyUnsubscribed = Boolean(existing);
    if (!alreadyUnsubscribed) {
      // upsert 避免并发写冲突
      await prisma.userTopicUnsubscribe.upsert({
        where: { userId_topicId: { userId: user.id, topicId: topic.id } },
        update: {},
        create: { userId: user.id, topicId: topic.id },
      });
    }

    audit({
      action: "user_topic.unsubscribe_via_link",
      entityType: "User",
      entityId: user.id,
      actorType: "SYSTEM",
      details: {
        slug: topic.slug,
        topicId: topic.id,
        email: user.email,
        already: alreadyUnsubscribed,
      },
      req: input.req ?? null,
    });
    return { status: "topic_unsubscribed", topic, user, alreadyUnsubscribed };
  },

  /**
   * 用户在偏好中心重新订阅某主题：删除 UserTopicUnsubscribe 记录。
   */
  async resubscribeByTopic(
    input: TopicUnsubscribeRequest,
  ): Promise<TopicResubscribeOutcome> {
    const user = await prisma.user.findUnique({
      where: { unsubscribeToken: input.token },
    });
    if (!user) return { status: "user_not_found" };

    const topic = await prisma.topic.findUnique({
      where: { slug: input.topicSlug },
    });
    if (!topic) {
      return { status: "topic_not_found", slug: input.topicSlug, user };
    }

    const result = await prisma.userTopicUnsubscribe.deleteMany({
      where: { userId: user.id, topicId: topic.id },
    });
    const alreadySubscribed = result.count === 0;

    audit({
      action: "user_topic.resubscribe_via_link",
      entityType: "User",
      entityId: user.id,
      actorType: "SYSTEM",
      details: {
        slug: topic.slug,
        topicId: topic.id,
        email: user.email,
        already: alreadySubscribed,
      },
      req: input.req ?? null,
    });
    return { status: "topic_resubscribed", topic, user, alreadySubscribed };
  },
};

export type SubscriptionUnsubscribeService = typeof subscriptionUnsubscribeService;
