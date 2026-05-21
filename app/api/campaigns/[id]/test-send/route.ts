import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth, parseJsonBody } from "@/lib/api-helpers";
import { verifyOrigin } from "@/lib/auth/origin";
import { ForbiddenError } from "@/lib/errors";
import { campaignService } from "@/lib/modules/campaign/service";
import {
  snapshotToTemplateForTestSend,
  type TemplateSnapshot,
} from "@/lib/modules/template/snapshot";
import { testSendTemplate } from "@/lib/modules/template/test-send";

export const runtime = "nodejs";

interface Ctx {
  params: Promise<{ id: string }>;
}

const TestSendSchema = z.object({
  to: z.string().email(),
  locale: z.enum(["zh", "en"]).optional(),
  variables: z.record(z.string()).optional(),
});

export const POST = withAuth(async (session, request: Request, ctx: Ctx) => {
  if (!verifyOrigin(request.headers)) throw new ForbiddenError("Forbidden origin");
  const { id } = await ctx.params;
  const input = await parseJsonBody(request, TestSendSchema);
  const campaign = await campaignService.getById(id);
  const snapshot = campaign.templateSnapshot as unknown as TemplateSnapshot;

  const result = await testSendTemplate({
    adminId: session.sessionId,
    to: input.to,
    locale: input.locale,
    subjects: campaign.subjects as Record<"zh" | "en", string> | undefined,
    variables: input.variables,
    template: snapshotToTemplateForTestSend(snapshot, {
      id: campaign.templateId,
      name: campaign.name,
    }),
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
