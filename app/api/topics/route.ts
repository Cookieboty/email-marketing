import { NextResponse } from "next/server";
import { withAuth, parseJsonBody } from "@/lib/api-helpers";
import { verifyOrigin } from "@/lib/auth/origin";
import { ForbiddenError } from "@/lib/errors";
import {
  CreateTopicSchema,
  ListTopicsQuerySchema,
} from "@/lib/modules/topic/schema";
import { topicService } from "@/lib/modules/topic/service";

export const runtime = "nodejs";

export const GET = withAuth(async (_session, request: Request) => {
  const url = new URL(request.url);
  const parsed = ListTopicsQuerySchema.parse({
    q: url.searchParams.get("q") ?? undefined,
  });
  const data = await topicService.list(parsed);
  return NextResponse.json(data);
});

// 仅保留 session（管理员）路径：ApiClient 分支依赖 Authorization header，
// 但 /api/topics 不在 middleware 公开前缀内，凭 Bearer token 的请求会被
// middleware 提前 401，故该分支不可达。如需对外开放，应新增 /api/inbound/topics。
export const POST = withAuth(async (_session, request: Request) => {
  if (!verifyOrigin(request.headers)) throw new ForbiddenError("Forbidden origin");
  const input = await parseJsonBody(request, CreateTopicSchema);
  const t = await topicService.create(input, {
    actorType: "ADMIN",
    req: { headers: request.headers },
  });
  return NextResponse.json(t, { status: 201 });
});
