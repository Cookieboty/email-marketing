/**
 * POST /api/inbound/unsubscribe
 *
 * 三级退订委托：
 *   - level=global   → User.unsubscribed = true
 *   - level=category → 写 UserSubscription.subscribed=false
 *   - level=topic    → 写 UserTopicUnsubscribe（复用 Phase 8 unsubscribeByTopic 但接受 userId）
 *
 * 关联 spec：specs/modules/inbound-connector.md §162-205
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { ValidationError, NotFoundError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { withApiClient } from "@/lib/modules/api-client/middleware";
import {
  UserLocatorShape,
  locateUser,
} from "@/lib/modules/api-client/locator";

export const runtime = "nodejs";

const GlobalBody = z.object({
  ...UserLocatorShape,
  level: z.literal("global"),
});

const CategoryBody = z.object({
  ...UserLocatorShape,
  level: z.literal("category"),
  categorySlug: z.string().min(1),
});

const TopicBody = z.object({
  ...UserLocatorShape,
  level: z.literal("topic"),
  topicSlug: z.string().min(1),
});

const Body = z
  .union([GlobalBody, CategoryBody, TopicBody])
  .superRefine((v, c) => {
    if (!v.userId && !v.email && !v.externalId) {
      c.addIssue({
        code: z.ZodIssueCode.custom,
        message: "userId, email or externalId is required",
        path: ["userId"],
      });
    }
  });

export const POST = withApiClient(["unsubscribe:write"], async (ctx, request) => {
  const parsed = Body.safeParse(ctx.parsedBody);
  if (!parsed.success) {
    throw new ValidationError("Validation failed", parsed.error.issues);
  }
  const data = parsed.data;
  const user = await locateUser({
    userId: data.userId,
    email: data.email,
    externalId: data.externalId,
  });

  let result: Record<string, unknown> = { ok: true, level: data.level };

  if (data.level === "global") {
    const before = await prisma.user.findUnique({
      where: { id: user.id },
      select: { unsubscribed: true },
    });
    if (!before?.unsubscribed) {
      await prisma.user.update({
        where: { id: user.id },
        data: { unsubscribed: true, unsubscribedAt: new Date() },
      });
    }
    result = {
      ok: true,
      level: "global",
      userId: user.id,
      alreadyUnsubscribed: Boolean(before?.unsubscribed),
    };
    audit({
      action: "inbound.unsubscribe",
      entityType: "User",
      entityId: user.id,
      actorType: "WEBHOOK",
      details: {
        email: user.email,
        level: "global",
        apiClientId: ctx.apiClient.id,
        idempotencyKey: ctx.idempotencyKey,
      },
      req: { headers: request.headers },
    });
  } else if (data.level === "category") {
    const cat = await prisma.subscriptionCategory.findUnique({
      where: { slug: data.categorySlug },
    });
    if (!cat) throw new NotFoundError("Subscription category not found");
    if (cat.isTransactional) {
      result = {
        ok: true,
        level: "category",
        userId: user.id,
        categorySlug: cat.slug,
        ignored: "transactional",
      };
    } else {
      await prisma.userSubscription.upsert({
        where: { userId_categoryId: { userId: user.id, categoryId: cat.id } },
        update: { subscribed: false },
        create: { userId: user.id, categoryId: cat.id, subscribed: false },
      });
      result = {
        ok: true,
        level: "category",
        userId: user.id,
        categorySlug: cat.slug,
      };
    }
    audit({
      action: "inbound.unsubscribe",
      entityType: "User",
      entityId: user.id,
      actorType: "WEBHOOK",
      details: {
        email: user.email,
        level: "category",
        categorySlug: cat.slug,
        ignored: cat.isTransactional ? "transactional" : null,
        apiClientId: ctx.apiClient.id,
        idempotencyKey: ctx.idempotencyKey,
      },
      req: { headers: request.headers },
    });
  } else {
    const topic = await prisma.topic.findUnique({
      where: { slug: data.topicSlug },
    });
    if (!topic) throw new NotFoundError("Topic not found");
    const existing = await prisma.userTopicUnsubscribe.findUnique({
      where: { userId_topicId: { userId: user.id, topicId: topic.id } },
      select: { userId: true },
    });
    const already = Boolean(existing);
    if (!already) {
      await prisma.userTopicUnsubscribe.upsert({
        where: { userId_topicId: { userId: user.id, topicId: topic.id } },
        update: {},
        create: { userId: user.id, topicId: topic.id },
      });
    }
    result = {
      ok: true,
      level: "topic",
      userId: user.id,
      topicSlug: topic.slug,
      alreadyUnsubscribed: already,
    };
    audit({
      action: "inbound.unsubscribe",
      entityType: "User",
      entityId: user.id,
      actorType: "WEBHOOK",
      details: {
        email: user.email,
        level: "topic",
        topicSlug: topic.slug,
        already,
        apiClientId: ctx.apiClient.id,
        idempotencyKey: ctx.idempotencyKey,
      },
      req: { headers: request.headers },
    });
  }

  await ctx.finalize(200, result);
  return NextResponse.json(result, { status: 200 });
});
