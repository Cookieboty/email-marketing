import { NextResponse } from "next/server";
import { withAuth, parseJsonBody } from "@/lib/api-helpers";
import { verifyOrigin } from "@/lib/auth/origin";
import { ForbiddenError } from "@/lib/errors";
import { TestSendSchema } from "@/lib/modules/template/schema";
import { templateService } from "@/lib/modules/template/service";
import { testSendTemplate } from "@/lib/modules/template/test-send";

export const runtime = "nodejs";

interface Ctx {
  params: Promise<{ id: string }>;
}

export const POST = withAuth(async (session, request: Request, ctx: Ctx) => {
  if (!verifyOrigin(request.headers)) throw new ForbiddenError("Forbidden origin");
  const { id } = await ctx.params;
  const input = await parseJsonBody(request, TestSendSchema);
  const tpl = await templateService.getById(id);
  const result = await testSendTemplate({
    adminId: session.sessionId,
    to: input.to,
    variables: input.variables,
    template: tpl,
    req: { headers: request.headers },
  });
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error, code: "send_failed" },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true, messageId: result.id });
});
