import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-helpers";
import { verifyOrigin } from "@/lib/auth/origin";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { audit } from "@/lib/audit";
import { importRepository } from "@/lib/modules/import/repository";
import { runImportTest } from "@/lib/modules/import/runner";

export const runtime = "nodejs";

interface Ctx {
  params: Promise<{ id: string }>;
}

export const POST = withAuth(async (_session, request: Request, ctx: Ctx) => {
  if (!verifyOrigin(request.headers)) throw new ForbiddenError("Forbidden origin");
  const { id } = await ctx.params;
  const src = await importRepository.getSource(id);
  if (!src) throw new NotFoundError("ImportSource not found");
  const result = await runImportTest(src, 5);
  audit({
    action: "import_source.test",
    entityType: "ImportSource",
    entityId: id,
    actorType: "ADMIN",
    details: { fetched: result.fetched, errorCount: result.errors.length },
    req: { headers: request.headers },
  });
  return NextResponse.json(result);
});
