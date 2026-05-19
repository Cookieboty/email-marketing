import { NextResponse } from "next/server";
import { withAuth, parseJsonBody } from "@/lib/api-helpers";
import { verifyOrigin } from "@/lib/auth/origin";
import { ForbiddenError } from "@/lib/errors";
import {
  CreateTemplateSchema,
  ListTemplatesQuerySchema,
} from "@/lib/modules/template/schema";
import { templateService } from "@/lib/modules/template/service";

export const runtime = "nodejs";

export const GET = withAuth(async (_session, request: Request) => {
  const url = new URL(request.url);
  const parsed = ListTemplatesQuerySchema.parse({
    q: url.searchParams.get("q") ?? undefined,
    includeArchived: url.searchParams.get("includeArchived") ?? undefined,
    page: url.searchParams.get("page") ?? undefined,
    pageSize: url.searchParams.get("pageSize") ?? undefined,
  });
  const result = await templateService.list(parsed);
  return NextResponse.json(result);
});

export const POST = withAuth(async (_session, request: Request) => {
  if (!verifyOrigin(request.headers)) throw new ForbiddenError("Forbidden origin");
  const input = await parseJsonBody(request, CreateTemplateSchema);
  const tpl = await templateService.create(input, {
    actorType: "ADMIN",
    req: { headers: request.headers },
  });
  return NextResponse.json(tpl, { status: 201 });
});
