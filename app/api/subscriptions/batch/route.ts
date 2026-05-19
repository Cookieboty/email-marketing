import { NextResponse } from "next/server";
import { withAuth, parseJsonBody } from "@/lib/api-helpers";
import { verifyOrigin } from "@/lib/auth/origin";
import { ForbiddenError } from "@/lib/errors";
import { BatchUpdateSubscriptionsSchema } from "@/lib/modules/subscription-category/schema";
import { subscriptionCategoryService } from "@/lib/modules/subscription-category/service";

export const runtime = "nodejs";

/**
 * 跨用户批量更新订阅状态。spec §批量更新订阅。
 * 单批最多 1000 条，由 schema 收敛。
 */
export const POST = withAuth(async (_session, request: Request) => {
  if (!verifyOrigin(request.headers)) throw new ForbiddenError("Forbidden origin");
  const input = await parseJsonBody(request, BatchUpdateSubscriptionsSchema);
  const result = await subscriptionCategoryService.batchUpdate(input, {
    actorType: "ADMIN",
    req: { headers: request.headers },
  });
  return NextResponse.json(result);
});
