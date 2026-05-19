import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-helpers";
import { verifyOrigin } from "@/lib/auth/origin";
import { ForbiddenError } from "@/lib/errors";
import {
  importSourceService,
  serializeImportJob,
} from "@/lib/modules/import/service";

export const runtime = "nodejs";

interface Ctx {
  params: Promise<{ id: string; jobId: string }>;
}

export const POST = withAuth(async (_session, request: Request, ctx: Ctx) => {
  if (!verifyOrigin(request.headers)) throw new ForbiddenError("Forbidden origin");
  const { jobId } = await ctx.params;
  const updated = await importSourceService.cancelJob(jobId, {
    req: { headers: request.headers },
  });
  return NextResponse.json(serializeImportJob(updated));
});
