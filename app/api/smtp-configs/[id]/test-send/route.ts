import { NextResponse } from "next/server";
import { withAuth, parseJsonBody } from "@/lib/api-helpers";
import { verifyOrigin } from "@/lib/auth/origin";
import { ForbiddenError } from "@/lib/errors";
import { TestSendSchema } from "@/lib/modules/smtp/schema";
import { testSmtpSend } from "@/lib/modules/smtp/service";

export const runtime = "nodejs";

interface Ctx {
  params: Promise<{ id: string }>;
}

export const POST = withAuth(async (session, request: Request, ctx: Ctx) => {
  if (!verifyOrigin(request.headers)) throw new ForbiddenError("Forbidden origin");
  const { id } = await ctx.params;
  const input = await parseJsonBody(request, TestSendSchema);
  const result = await testSmtpSend(id, input, {
    adminId: session.sessionId,
    req: { headers: request.headers },
  });
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
});
