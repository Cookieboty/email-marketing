/**
 * POST /api/inbound/users
 *
 * 关联 spec：specs/modules/inbound-connector.md §94-130
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { ValidationError } from "@/lib/errors";
import { withApiClient } from "@/lib/modules/api-client/middleware";
import {
  upsertByExternalIdOrEmail,
  type UpsertTagMode,
} from "@/lib/modules/user/upsert";

export const runtime = "nodejs";

const Body = z.object({
  email: z.string().email(),
  externalId: z.string().min(1).optional(),
  name: z.string().trim().max(120).nullable().optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
  tagMode: z.enum(["merge", "replace", "skip"]).optional(),
  source: z.string().trim().max(120).nullable().optional(),
});

export const POST = withApiClient(["user:write"], async (ctx, request) => {
  const parsed = Body.safeParse(ctx.parsedBody);
  if (!parsed.success) {
    throw new ValidationError("Validation failed", parsed.error.issues);
  }
  const input = parsed.data;
  const result = await upsertByExternalIdOrEmail(
    {
      email: input.email,
      externalId: input.externalId,
      name: input.name ?? undefined,
      metadata: input.metadata ?? undefined,
      tags: input.tags,
      tagMode: input.tagMode as UpsertTagMode | undefined,
      source: input.source ?? undefined,
    },
    {
      actorType: "WEBHOOK",
      auditPrefix: "inbound",
      apiClientId: ctx.apiClient.id,
      idempotencyKey: ctx.idempotencyKey,
      req: { headers: request.headers },
    },
  );

  const status = result.created ? 201 : 200;
  const body = {
    ok: true as const,
    user: {
      id: result.user.id,
      email: result.user.email,
      externalId: result.user.externalId,
      name: result.user.name,
      tags: result.user.tags.map((t) => t.name),
    },
    created: result.created,
  };
  await ctx.finalize(status, body);
  return NextResponse.json(body, { status });
});
