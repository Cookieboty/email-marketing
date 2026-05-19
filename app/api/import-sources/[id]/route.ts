import { NextResponse } from "next/server";
import { withAuth, parseJsonBody } from "@/lib/api-helpers";
import { verifyOrigin } from "@/lib/auth/origin";
import { ForbiddenError } from "@/lib/errors";
import { importSourceService } from "@/lib/modules/import/service";
import { UpdateImportSourceSchema } from "@/lib/modules/import/schema";

export const runtime = "nodejs";

interface Ctx {
  params: Promise<{ id: string }>;
}

export const GET = withAuth(async (_session, _request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const src = await importSourceService.getById(id);
  return NextResponse.json(src);
});

export const PATCH = withAuth(async (_session, request: Request, ctx: Ctx) => {
  if (!verifyOrigin(request.headers)) throw new ForbiddenError("Forbidden origin");
  const { id } = await ctx.params;
  const input = await parseJsonBody(request, UpdateImportSourceSchema);
  const updated = await importSourceService.update(id, input, {
    req: { headers: request.headers },
  });
  return NextResponse.json(updated);
});

export const DELETE = withAuth(async (_session, request: Request, ctx: Ctx) => {
  if (!verifyOrigin(request.headers)) throw new ForbiddenError("Forbidden origin");
  const { id } = await ctx.params;
  await importSourceService.remove(id, { req: { headers: request.headers } });
  return new NextResponse(null, { status: 204 });
});
