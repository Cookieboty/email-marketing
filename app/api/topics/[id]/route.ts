import { NextResponse } from "next/server";
import { withAuth, parseJsonBody } from "@/lib/api-helpers";
import { verifyOrigin } from "@/lib/auth/origin";
import { ForbiddenError } from "@/lib/errors";
import { UpdateTopicSchema } from "@/lib/modules/topic/schema";
import { topicService } from "@/lib/modules/topic/service";
import { withApiClient } from "@/lib/modules/api-client/middleware";

export const runtime = "nodejs";

interface Ctx {
  params: Promise<{ id: string }>;
}

export const GET = withAuth(async (_session, _request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const t = await topicService.getById(id);
  return NextResponse.json(t);
});

const patchWithAdmin = withAuth(async (_session, request: Request, ctx: Ctx) => {
  if (!verifyOrigin(request.headers)) throw new ForbiddenError("Forbidden origin");
  const { id } = await ctx.params;
  const input = await parseJsonBody(request, UpdateTopicSchema);
  const t = await topicService.update(id, input, {
    actorType: "ADMIN",
    req: { headers: request.headers },
  });
  return NextResponse.json(t);
});

const patchWithApiClient = withApiClient(["topic:write"], async (apiCtx, request, rawCtx) => {
  const ctx = rawCtx as Ctx;
  const { id } = await ctx.params;
  const input = await parseJsonBody(request, UpdateTopicSchema);
  const t = await topicService.update(id, input, {
    actorType: "WEBHOOK",
    apiClientId: apiCtx.apiClient.id,
    idempotencyKey: apiCtx.idempotencyKey,
    req: { headers: request.headers },
  });
  return NextResponse.json(t);
});

export function PATCH(request: Request, ctx: Ctx): Promise<NextResponse> {
  if (request.headers.has("authorization")) return patchWithApiClient(request, ctx);
  return patchWithAdmin(request, ctx);
}

const deleteWithAdmin = withAuth(async (_session, request: Request, ctx: Ctx) => {
  if (!verifyOrigin(request.headers)) throw new ForbiddenError("Forbidden origin");
  const { id } = await ctx.params;
  await topicService.delete(id, {
    actorType: "ADMIN",
    req: { headers: request.headers },
  });
  return new NextResponse(null, { status: 204 });
});

const deleteWithApiClient = withApiClient(["topic:write"], async (apiCtx, request, rawCtx) => {
  const ctx = rawCtx as Ctx;
  const { id } = await ctx.params;
  await topicService.delete(id, {
    actorType: "WEBHOOK",
    apiClientId: apiCtx.apiClient.id,
    idempotencyKey: apiCtx.idempotencyKey,
    req: { headers: request.headers },
  });
  return new NextResponse(null, { status: 204 });
});

export function DELETE(request: Request, ctx: Ctx): Promise<NextResponse> {
  if (request.headers.has("authorization")) return deleteWithApiClient(request, ctx);
  return deleteWithAdmin(request, ctx);
}
