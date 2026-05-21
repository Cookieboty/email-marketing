import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-helpers";
import { campaignService } from "@/lib/modules/campaign/service";

export const runtime = "nodejs";

interface Ctx {
  params: Promise<{ id: string }>;
}

export const GET = withAuth(async (_session, _request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const coverage = await campaignService.getLocaleCoverage(id);
  return NextResponse.json(coverage);
});
