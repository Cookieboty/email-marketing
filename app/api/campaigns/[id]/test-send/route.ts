import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth, parseJsonBody } from "@/lib/api-helpers";
import { verifyOrigin } from "@/lib/auth/origin";
import { ForbiddenError } from "@/lib/errors";
import { campaignService } from "@/lib/modules/campaign/service";
import { testSendTemplate } from "@/lib/modules/template/test-send";

export const runtime = "nodejs";

interface Ctx {
  params: Promise<{ id: string }>;
}

const TestSendSchema = z.object({
  to: z.string().email(),
  variables: z.record(z.string()).optional(),
});

export const POST = withAuth(async (session, request: Request, ctx: Ctx) => {
  if (!verifyOrigin(request.headers)) throw new ForbiddenError("Forbidden origin");
  const { id } = await ctx.params;
  const input = await parseJsonBody(request, TestSendSchema);
  const campaign = await campaignService.getById(id);

  const snapshot = campaign.templateSnapshot as {
    subject: string;
    htmlContent: string;
    textContent: string | null;
    version: number;
  };

  const result = await testSendTemplate({
    adminId: session.sessionId,
    to: input.to,
    variables: input.variables,
    template: {
      id: campaign.templateId,
      name: campaign.name,
      subject: campaign.subject ?? snapshot.subject,
      htmlContent: snapshot.htmlContent,
      textContent: snapshot.textContent,
      version: snapshot.version,
    } as Parameters<typeof testSendTemplate>[0]["template"],
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
