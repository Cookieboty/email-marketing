import { NextResponse } from "next/server";
import { withAuth, parseJsonBody } from "@/lib/api-helpers";
import { verifyOrigin } from "@/lib/auth/origin";
import { ForbiddenError } from "@/lib/errors";
import {
  CreateTopicSchema,
  ListTopicsQuerySchema,
} from "@/lib/modules/topic/schema";
import { topicService } from "@/lib/modules/topic/service";
import { withApiClient } from "@/lib/modules/api-client/middleware";

export const runtime = "nodejs";

export const GET = withAuth(async (_session, request: Request) => {
  const url = new URL(request.url);
  const parsed = ListTopicsQuerySchema.parse({
    q: url.searchParams.get("q") ?? undefined,
  });
  const data = await topicService.list(parsed);
  return NextResponse.json(data);
});

const postWithAdmin = withAuth(async (_session, request: Request) => {
  if (!verifyOrigin(request.headers)) throw new ForbiddenError("Forbidden origin");
  const input = await parseJsonBody(request, CreateTopicSchema);
  const t = await topicService.create(input, {
    actorType: "ADMIN",
    req: { headers: request.headers },
  });
  return NextResponse.json(t, { status: 201 });
});

const postWithApiClient = withApiClient(["topic:write"], async (ctx, request) => {
  const input = await parseJsonBody(request, CreateTopicSchema);
  const t = await topicService.create(input, {
    actorType: "WEBHOOK",
    apiClientId: ctx.apiClient.id,
    idempotencyKey: ctx.idempotencyKey,
    req: { headers: request.headers },
  });
  return NextResponse.json(t, { status: 201 });
});

export function POST(request: Request): Promise<NextResponse> {
  if (request.headers.has("authorization")) return postWithApiClient(request);
  return postWithAdmin(request);
}
