import { NextResponse } from "next/server";
import { withAuth, parseJsonBody } from "@/lib/api-helpers";
import { verifyOrigin } from "@/lib/auth/origin";
import { ForbiddenError } from "@/lib/errors";
import { UpdateSmtpConfigSchema } from "@/lib/modules/smtp/schema";
import {
  getSmtpConfig,
  revokeSmtpConfig,
  updateSmtpConfig,
} from "@/lib/modules/smtp/service";

export const runtime = "nodejs";

interface Ctx {
  params: Promise<{ id: string }>;
}

export const GET = withAuth(async (_session, _request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const view = await getSmtpConfig(id);
  return NextResponse.json(view);
});

export const PATCH = withAuth(async (session, request: Request, ctx: Ctx) => {
  if (!verifyOrigin(request.headers)) throw new ForbiddenError("Forbidden origin");
  const { id } = await ctx.params;
  const input = await parseJsonBody(request, UpdateSmtpConfigSchema);
  const updated = await updateSmtpConfig(id, input, {
    adminId: session.sessionId,
    req: { headers: request.headers },
  });
  return NextResponse.json(updated);
});

export const DELETE = withAuth(async (session, request: Request, ctx: Ctx) => {
  if (!verifyOrigin(request.headers)) throw new ForbiddenError("Forbidden origin");
  const { id } = await ctx.params;
  await revokeSmtpConfig(id, {
    adminId: session.sessionId,
    req: { headers: request.headers },
  });
  return new NextResponse(null, { status: 204 });
});
