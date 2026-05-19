import { NextResponse } from "next/server";
import { withAuth, parseJsonBody } from "@/lib/api-helpers";
import { verifyOrigin } from "@/lib/auth/origin";
import { ForbiddenError } from "@/lib/errors";
import { UpdateSubscriptionCategorySchema } from "@/lib/modules/subscription-category/schema";
import { subscriptionCategoryService } from "@/lib/modules/subscription-category/service";

export const runtime = "nodejs";

interface Ctx {
  params: Promise<{ id: string }>;
}

export const GET = withAuth(async (_session, _request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const cat = await subscriptionCategoryService.getById(id);
  return NextResponse.json(cat);
});

export const PATCH = withAuth(async (_session, request: Request, ctx: Ctx) => {
  if (!verifyOrigin(request.headers)) throw new ForbiddenError("Forbidden origin");
  const { id } = await ctx.params;
  const input = await parseJsonBody(request, UpdateSubscriptionCategorySchema);
  const cat = await subscriptionCategoryService.update(id, input, {
    actorType: "ADMIN",
    req: { headers: request.headers },
  });
  return NextResponse.json(cat);
});

export const DELETE = withAuth(async (_session, request: Request, ctx: Ctx) => {
  if (!verifyOrigin(request.headers)) throw new ForbiddenError("Forbidden origin");
  const { id } = await ctx.params;
  await subscriptionCategoryService.delete(id, {
    actorType: "ADMIN",
    req: { headers: request.headers },
  });
  return new NextResponse(null, { status: 204 });
});
