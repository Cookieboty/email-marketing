import { NextResponse } from "next/server";
import { withAuth, parseJsonBody } from "@/lib/api-helpers";
import { verifyOrigin } from "@/lib/auth/origin";
import { ForbiddenError } from "@/lib/errors";
import { importRepository } from "@/lib/modules/import/repository";
import {
  importSourceService,
  serializeImportJob,
} from "@/lib/modules/import/service";
import { TriggerJobSchema } from "@/lib/modules/import/schema";

export const runtime = "nodejs";

interface Ctx {
  params: Promise<{ id: string }>;
}

export const GET = withAuth(async (_session, request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const url = new URL(request.url);
  const take = Math.min(Number(url.searchParams.get("pageSize") ?? "50"), 200);
  const page = Math.max(Number(url.searchParams.get("page") ?? "1"), 1);
  const skip = (page - 1) * take;
  const jobs = await importRepository.listJobs(id, take, skip);
  return NextResponse.json({ data: jobs.map(serializeImportJob), page, pageSize: take });
});

export const POST = withAuth(async (session, request: Request, ctx: Ctx) => {
  if (!verifyOrigin(request.headers)) throw new ForbiddenError("Forbidden origin");
  const { id } = await ctx.params;
  const input = await parseJsonBody(request, TriggerJobSchema);
  const job = await importSourceService.triggerJob(id, input, {
    actorId: session.sessionId,
    req: { headers: request.headers },
  });
  return NextResponse.json(serializeImportJob(job), { status: 201 });
});
