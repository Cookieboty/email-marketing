import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-helpers";
import { verifyOrigin } from "@/lib/auth/origin";
import { ForbiddenError } from "@/lib/errors";
import { userService } from "@/lib/modules/user/service";

export const runtime = "nodejs";

interface Ctx {
  params: Promise<{ id: string }>;
}

export const POST = withAuth(async (_session, request: Request, ctx: Ctx) => {
  if (!verifyOrigin(request.headers)) throw new ForbiddenError("Forbidden origin");
  const { id } = await ctx.params;
  const result = await userService.resendOptIn(id, {
    actorType: "ADMIN",
    req: { headers: request.headers },
  });
  return NextResponse.json({ ok: result.ok, ...(result.messageId ? { messageId: result.messageId } : {}) });
});
