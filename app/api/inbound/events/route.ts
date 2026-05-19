/**
 * POST /api/inbound/events
 *
 * 取代 /api/events，统一走 ApiClient 鉴权。
 *
 * 关联 spec：specs/modules/inbound-connector.md §207-240
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { ValidationError } from "@/lib/errors";
import { withApiClient } from "@/lib/modules/api-client/middleware";
import { onCustomEvent } from "@/lib/modules/automation/service";
import {
  UserLocatorShape,
  locateUser,
} from "@/lib/modules/api-client/locator";

export const runtime = "nodejs";

const log = logger.child("inbound-events");

const Body = z
  .object({
    ...UserLocatorShape,
    eventName: z.string().trim().min(1).max(120),
    data: z.record(z.unknown()).optional(),
  })
  .refine((v) => v.userId || v.email || v.externalId, {
    message: "userId, email or externalId is required",
  });

export const POST = withApiClient(["event:write"], async (ctx, request) => {
  const parsed = Body.safeParse(ctx.parsedBody);
  if (!parsed.success) {
    throw new ValidationError("Validation failed", parsed.error.issues);
  }
  const input = parsed.data;
  const user = await locateUser({
    userId: input.userId,
    email: input.email,
    externalId: input.externalId,
  });

  audit({
    action: "inbound.event",
    entityType: "User",
    entityId: user.id,
    actorType: "WEBHOOK",
    details: {
      email: user.email,
      eventName: input.eventName,
      apiClientId: ctx.apiClient.id,
      idempotencyKey: ctx.idempotencyKey,
    },
    req: { headers: request.headers },
  });

  onCustomEvent(user.id, input.eventName).catch((err) => {
    log.error("custom event trigger failed", {
      userId: user.id,
      eventName: input.eventName,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  const body = {
    ok: true as const,
    userId: user.id,
    eventName: input.eventName,
  };
  await ctx.finalize(200, body);
  return NextResponse.json(body, { status: 200 });
});
