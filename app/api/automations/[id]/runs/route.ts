import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-helpers";
import { ListRunsQuerySchema } from "@/lib/modules/automation/schema";
import { automationService } from "@/lib/modules/automation/service";

export const runtime = "nodejs";

interface Ctx {
  params: Promise<{ id: string }>;
}

export const GET = withAuth(async (_session, request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const url = new URL(request.url);
  const q = url.searchParams;
  const parsed = ListRunsQuerySchema.parse({
    status: q.get("status") ?? undefined,
    page: q.get("page") ?? undefined,
    pageSize: q.get("pageSize") ?? undefined,
  });
  const result = await automationService.listRuns(id, parsed);
  return NextResponse.json(result);
});
