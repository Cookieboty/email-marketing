import { NextResponse } from "next/server";
import { withAuth, parseJsonBody } from "@/lib/api-helpers";
import { verifyOrigin } from "@/lib/auth/origin";
import { ForbiddenError } from "@/lib/errors";
import {
  CreateTemplateBlockSchema,
  ListTemplateBlocksQuerySchema,
} from "@/lib/modules/template-block/schema";
import { templateBlockService } from "@/lib/modules/template-block/service";

export const runtime = "nodejs";

export const GET = withAuth(async (_session, request: Request) => {
  const url = new URL(request.url);
  const parsed = ListTemplateBlocksQuerySchema.parse({
    q: url.searchParams.get("q") ?? undefined,
    category: url.searchParams.get("category") ?? undefined,
    locale: url.searchParams.get("locale") ?? undefined,
    page: url.searchParams.get("page") ?? undefined,
    pageSize: url.searchParams.get("pageSize") ?? undefined,
  });
  const result = await templateBlockService.list(parsed);
  return NextResponse.json(result);
});

export const POST = withAuth(async (_session, request: Request) => {
  if (!verifyOrigin(request.headers)) throw new ForbiddenError("Forbidden origin");
  const input = await parseJsonBody(request, CreateTemplateBlockSchema);
  const block = await templateBlockService.create(input, {
    actorType: "ADMIN",
    req: { headers: request.headers },
  });
  return NextResponse.json(block, { status: 201 });
});
