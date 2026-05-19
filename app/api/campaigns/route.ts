import { NextResponse } from "next/server";
import { withAuth, parseJsonBody } from "@/lib/api-helpers";
import { verifyOrigin } from "@/lib/auth/origin";
import { ForbiddenError } from "@/lib/errors";
import { CreateCampaignSchema, ListCampaignsQuerySchema } from "@/lib/modules/campaign/schema";
import { campaignService } from "@/lib/modules/campaign/service";

export const runtime = "nodejs";

export const GET = withAuth(async (_session, request: Request) => {
  const url = new URL(request.url);
  const q = url.searchParams;
  const parsed = ListCampaignsQuerySchema.parse({
    q: q.get("q") ?? undefined,
    status: q.get("status") ?? undefined,
    page: q.get("page") ?? undefined,
    pageSize: q.get("pageSize") ?? undefined,
  });
  const result = await campaignService.list(parsed);
  return NextResponse.json(result);
});

export const POST = withAuth(async (_session, request: Request) => {
  if (!verifyOrigin(request.headers)) throw new ForbiddenError("Forbidden origin");
  const input = await parseJsonBody(request, CreateCampaignSchema);
  const campaign = await campaignService.create(input, {
    actorType: "ADMIN",
    req: { headers: request.headers },
  });
  return NextResponse.json(campaign, { status: 201 });
});
