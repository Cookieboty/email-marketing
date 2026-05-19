import { NextResponse } from "next/server";
import { withAuth, parseJsonBody } from "@/lib/api-helpers";
import { verifyOrigin } from "@/lib/auth/origin";
import { ForbiddenError } from "@/lib/errors";
import {
  CreateSubscriptionCategorySchema,
  ListSubscriptionCategoriesQuerySchema,
} from "@/lib/modules/subscription-category/schema";
import { subscriptionCategoryService } from "@/lib/modules/subscription-category/service";

export const runtime = "nodejs";

export const GET = withAuth(async (_session, request: Request) => {
  const url = new URL(request.url);
  const parsed = ListSubscriptionCategoriesQuerySchema.parse({
    q: url.searchParams.get("q") ?? undefined,
  });
  const data = await subscriptionCategoryService.list(parsed);
  return NextResponse.json(data);
});

export const POST = withAuth(async (_session, request: Request) => {
  if (!verifyOrigin(request.headers)) throw new ForbiddenError("Forbidden origin");
  const input = await parseJsonBody(request, CreateSubscriptionCategorySchema);
  const cat = await subscriptionCategoryService.create(input, {
    actorType: "ADMIN",
    req: { headers: request.headers },
  });
  return NextResponse.json(cat, { status: 201 });
});
