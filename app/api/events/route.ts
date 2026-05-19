import { NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import { handleApiError, ForbiddenError, RateLimitError, ValidationError } from "@/lib/errors";
import { getRateLimiter } from "@/lib/rate-limit";
import { prisma } from "@/lib/prisma";
import { onCustomEvent } from "@/lib/modules/automation/service";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

const log = logger.child("events-api");

/**
 * @deprecated 使用 /api/inbound/events（基于 ApiClient 凭证 + scope 鉴权）。
 * 本路由保留以兼容旧客户端，自 2026-05-19 起返回 `Deprecation: true` header
 * 并记录采样 warning（每 100 次取 1 条）。
 */
const DEPRECATION_LOG_SAMPLING = 100;
let deprecationCallCount = 0;

function withDeprecationHeaders(res: NextResponse): NextResponse {
  res.headers.set("Deprecation", "true");
  res.headers.set("Sunset", "Wed, 31 Dec 2026 23:59:59 GMT");
  res.headers.set(
    "Link",
    '</api/inbound/events>; rel="successor-version"',
  );
  return res;
}

const EventSchema = z.object({
  eventName: z.string().trim().min(1).max(120),
  userId: z.string().min(1).optional(),
  email: z.string().email().optional(),
  data: z.record(z.unknown()).optional(),
}).refine((v) => v.userId || v.email, {
  message: "userId or email is required",
});

function eventRateLimiter() {
  const e = env();
  return getRateLimiter("event-api", {
    maxAttempts: e.RATE_LIMIT_EVENT_MAX,
    windowSec: e.RATE_LIMIT_EVENT_WINDOW_SEC,
    lockSec: 120,
  });
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    deprecationCallCount += 1;
    if (deprecationCallCount % DEPRECATION_LOG_SAMPLING === 1) {
      log.warn("/api/events is deprecated; migrate to /api/inbound/events", {
        callCount: deprecationCallCount,
      });
    }

    const token = env().EVENT_API_TOKEN;
    if (!token) {
      return withDeprecationHeaders(
        NextResponse.json(
          { ok: false, error: "Event API not configured" },
          { status: 503 },
        ),
      );
    }

    const provided = request.headers.get("x-event-token") ?? "";
    if (!provided || !timingSafeEqual(provided, token)) {
      throw new ForbiddenError("Invalid event token");
    }

    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      throw new ValidationError("Invalid JSON body");
    }

    const input = EventSchema.parse(raw);

    let userId = input.userId;
    if (!userId && input.email) {
      const user = await prisma.user.findUnique({
        where: { email: input.email.toLowerCase() },
        select: { id: true },
      });
      if (!user) {
        return withDeprecationHeaders(
          NextResponse.json(
            { ok: false, error: "User not found" },
            { status: 404 },
          ),
        );
      }
      userId = user.id;
    }

    const rl = eventRateLimiter();
    const key = `event:${userId}`;
    const decision = rl.check(key);
    if (!decision.allowed) {
      throw new RateLimitError(decision.retryAfterSec);
    }
    rl.recordFailure(key);

    onCustomEvent(userId!, input.eventName).catch((err) => {
      log.error("custom event trigger failed", {
        userId,
        eventName: input.eventName,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return withDeprecationHeaders(
      NextResponse.json({ ok: true, userId, eventName: input.eventName }),
    );
  } catch (err) {
    return withDeprecationHeaders(handleApiError(err));
  }
}
