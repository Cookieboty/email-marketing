import { NextResponse } from "next/server";
import { withAuth, parseJsonBody } from "@/lib/api-helpers";
import { verifyOrigin } from "@/lib/auth/origin";
import { ForbiddenError } from "@/lib/errors";
import { ScheduleCampaignSchema } from "@/lib/modules/campaign/schema";
import { campaignService } from "@/lib/modules/campaign/service";

export const runtime = "nodejs";

interface Ctx {
  params: Promise<{ id: string }>;
}

export const POST = withAuth(async (_session, request: Request, ctx: Ctx) => {
  if (!verifyOrigin(request.headers)) throw new ForbiddenError("Forbidden origin");
  const { id } = await ctx.params;
  const input = await parseJsonBody(request, ScheduleCampaignSchema);
  const campaign = await campaignService.schedule(id, input, {
    actorType: "ADMIN",
    req: { headers: request.headers },
  });
  return NextResponse.json(campaign);
});
