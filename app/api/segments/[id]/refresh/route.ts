import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-helpers";
import { verifyOrigin } from "@/lib/auth/origin";
import { ForbiddenError } from "@/lib/errors";
import { segmentService } from "@/lib/modules/segment/service";

export const runtime = "nodejs";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * 手动触发分群计数刷新。命中后立即同步重算并写回。
 * 如果分群非常大，调用方应有耐心；后台 daily cron 也会每天 03:00 重算一次。
 */
export const POST = withAuth(async (_session, request: Request, ctx: Ctx) => {
  if (!verifyOrigin(request.headers)) throw new ForbiddenError("Forbidden origin");
  const { id } = await ctx.params;
  const result = await segmentService.refresh(id, {
    actorType: "ADMIN",
    req: { headers: request.headers },
  });
  return NextResponse.json(result);
});
