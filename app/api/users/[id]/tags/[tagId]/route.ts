import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-helpers";
import { verifyOrigin } from "@/lib/auth/origin";
import { ForbiddenError } from "@/lib/errors";
import { userService } from "@/lib/modules/user/service";

export const runtime = "nodejs";

interface Ctx {
  params: Promise<{ id: string; tagId: string }>;
}

export const DELETE = withAuth(async (_session, request: Request, ctx: Ctx) => {
  if (!verifyOrigin(request.headers)) throw new ForbiddenError("Forbidden origin");
  const { id, tagId } = await ctx.params;
  await userService.removeTag(id, tagId, {
    actorType: "ADMIN",
    req: { headers: request.headers },
  });
  return new NextResponse(null, { status: 204 });
});
