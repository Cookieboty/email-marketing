/**
 * 公开偏好中心 API（specs/modules/preference-center.md）。
 *
 * 路由：
 *   GET   /api/preferences/[token]  → 当前用户全部分类视图 + 全局退订状态
 *   PATCH /api/preferences/[token]  → 批量更新分类订阅 / 一键全局重新订阅
 *
 * 安全：
 *   - 公开路由（middleware 放行 /api/preferences/）
 *   - 仅依赖 unsubscribeToken 严格校验：长度 1..128 字符；查无即 404
 *   - 不暴露任何用户列表 / 邮箱列表；仅返回 token 对应单个用户的最小必要字段
 *   - 限流：IP 维度 60s/30 次（防扫描 token）
 *   - 不再依赖 cookie / origin
 *
 * 与 /api/unsubscribe 的差异：
 *   - 这里支持「重新订阅」（unsubscribed=true → false），而 /api/unsubscribe 只能退订
 *   - 这里以 categoryId 为粒度（而 /api/unsubscribe 以 slug 为粒度）
 */

import { NextResponse } from "next/server";
import { z, ZodError } from "zod";
import { audit } from "@/lib/audit";
import {
  ForbiddenError,
  NotFoundError,
  RateLimitError,
  ValidationError,
  handleApiError,
} from "@/lib/errors";
import { getClientIp, getRateLimiter } from "@/lib/rate-limit";
import { prisma } from "@/lib/prisma";
import { subscriptionCategoryRepository } from "@/lib/modules/subscription-category/repository";

export const runtime = "nodejs";

const TokenSchema = z.string().min(1).max(128);

const PatchSchema = z
  .object({
    /**
     * 分类级订阅变更：[{ categoryId, subscribed }]
     * - 不含的分类保持原状（不需要全量提交）
     * - subscribed=false 不允许应用于 isTransactional 分类
     */
    subscriptions: z
      .array(
        z.object({
          categoryId: z.string().min(1),
          subscribed: z.boolean(),
        }),
      )
      .max(100)
      .optional(),
    /**
     * 全局重新订阅开关：true 时把 user.unsubscribed 置为 false 并清空 unsubscribedAt
     * （为了防滥用，未提供此字段时不动 user.unsubscribed；提供 false 视为不变）
     */
    resubscribeAll: z.boolean().optional(),
  })
  .strict();

function preferencesRateLimiter() {
  return getRateLimiter("preferences", {
    maxAttempts: 30,
    windowSec: 60,
    lockSec: 120,
  });
}

function checkRateLimit(headers: Headers): void {
  const rl = preferencesRateLimiter();
  const ip = getClientIp(headers);
  const decision = rl.check(ip);
  if (!decision.allowed) {
    throw new RateLimitError(decision.retryAfterSec);
  }
  rl.recordFailure(ip);
}

function maskEmail(email: string): string {
  const [name, domain] = email.split("@");
  if (!domain) return "***";
  const head = name.slice(0, Math.min(2, name.length));
  return `${head}${"*".repeat(Math.max(1, name.length - head.length))}@${domain}`;
}

async function findUserByToken(token: string) {
  return prisma.user.findUnique({
    where: { unsubscribeToken: token },
    select: {
      id: true,
      email: true,
      unsubscribed: true,
      unsubscribedAt: true,
    },
  });
}

export async function GET(
  request: Request,
  ctx: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  try {
    checkRateLimit(request.headers);
    const { token: raw } = await ctx.params;
    const token = TokenSchema.parse(raw);
    const user = await findUserByToken(token);
    if (!user) throw new NotFoundError("Preferences token invalid");

    const subscriptions = await subscriptionCategoryRepository.listUserSubscriptions(user.id);
    return NextResponse.json({
      ok: true,
      user: {
        id: user.id,
        emailMasked: maskEmail(user.email),
        unsubscribed: user.unsubscribed,
        unsubscribedAt: user.unsubscribedAt,
      },
      subscriptions,
    });
  } catch (err) {
    if (err instanceof ZodError) {
      return handleApiError(new ValidationError("Invalid token", err.issues));
    }
    return handleApiError(err);
  }
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  try {
    checkRateLimit(request.headers);
    const { token: raw } = await ctx.params;
    const token = TokenSchema.parse(raw);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new ValidationError("Body must be valid JSON");
    }
    const input = PatchSchema.parse(body);

    const user = await findUserByToken(token);
    if (!user) throw new NotFoundError("Preferences token invalid");

    // ---- 校验分类（提前一次查全） ----
    const subs = input.subscriptions ?? [];
    if (subs.length > 0) {
      const ids = Array.from(new Set(subs.map((s) => s.categoryId)));
      if (ids.length !== subs.length) {
        throw new ValidationError("Duplicate categoryId in subscriptions");
      }
      const cats = await prisma.subscriptionCategory.findMany({
        where: { id: { in: ids } },
      });
      if (cats.length !== ids.length) {
        throw new NotFoundError("One or more subscription categories not found");
      }
      const byId = new Map(cats.map((c) => [c.id, c]));
      for (const s of subs) {
        const cat = byId.get(s.categoryId)!;
        if (cat.isTransactional && s.subscribed === false) {
          throw new ForbiddenError(
            `Transactional category "${cat.slug}" cannot be unsubscribed`,
          );
        }
      }
    }

    await prisma.$transaction(async (tx) => {
      if (input.resubscribeAll === true && user.unsubscribed) {
        await tx.user.update({
          where: { id: user.id },
          data: { unsubscribed: false, unsubscribedAt: null },
        });
      }
      for (const s of subs) {
        await subscriptionCategoryRepository.upsertUserSubscription(
          user.id,
          s.categoryId,
          s.subscribed,
          tx,
        );
      }
    });

    audit({
      action: "user_subscription.update_via_token",
      entityType: "User",
      entityId: user.id,
      actorType: "SYSTEM",
      details: {
        emailMasked: maskEmail(user.email),
        resubscribeAll: input.resubscribeAll === true,
        changes: subs.length,
      },
      req: { headers: request.headers },
    });

    const subscriptions = await subscriptionCategoryRepository.listUserSubscriptions(user.id);
    const refreshed = await prisma.user.findUnique({
      where: { id: user.id },
      select: { unsubscribed: true, unsubscribedAt: true },
    });
    return NextResponse.json({
      ok: true,
      user: {
        id: user.id,
        emailMasked: maskEmail(user.email),
        unsubscribed: refreshed?.unsubscribed ?? user.unsubscribed,
        unsubscribedAt: refreshed?.unsubscribedAt ?? user.unsubscribedAt,
      },
      subscriptions,
    });
  } catch (err) {
    if (err instanceof ZodError) {
      return handleApiError(new ValidationError("Validation failed", err.issues));
    }
    return handleApiError(err);
  }
}
