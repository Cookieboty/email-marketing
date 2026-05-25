import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth, parseJsonBody } from "@/lib/api-helpers";
import { verifyOrigin } from "@/lib/auth/origin";
import { ForbiddenError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

const CreateSchema = z.object({
  name: z.string().min(1).max(100),
  providerType: z.enum(["RESEND", "SMTP"]),
  smtpConfigId: z.string().optional(),
  resendConfigId: z.string().optional(),
  fromEmail: z.string().email().optional(),
  fromName: z.string().max(100).optional(),
  replyTo: z.string().email().optional(),
  isSystemDefault: z.boolean().optional(),
}).refine(
  (d) => (d.providerType === "SMTP" ? !!d.smtpConfigId : !!d.resendConfigId),
  { message: "smtpConfigId required for SMTP, resendConfigId required for RESEND" },
).refine(
  (d) => (d.providerType === "SMTP" ? !!d.fromEmail : true),
  { message: "fromEmail is required for SMTP channels" },
);

const CHANNEL_SELECT = {
  id: true,
  name: true,
  providerType: true,
  smtpConfigId: true,
  resendConfigId: true,
  fromEmail: true,
  fromName: true,
  replyTo: true,
  isSystemDefault: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  smtpConfig: { select: { id: true, name: true, host: true, port: true, status: true } },
  resendConfig: { select: { id: true, name: true, apiKeyHint: true, status: true } },
} as const;

export const GET = withAuth(async () => {
  const channels = await prisma.sendingChannel.findMany({
    orderBy: { createdAt: "desc" },
    select: CHANNEL_SELECT,
  });
  return NextResponse.json({ data: channels });
});

export const POST = withAuth(async (_session, request: Request) => {
  if (!verifyOrigin(request.headers)) throw new ForbiddenError("Forbidden origin");
  const input = await parseJsonBody(request, CreateSchema);

  const created = await prisma.$transaction(async (tx) => {
    if (input.isSystemDefault) {
      await tx.sendingChannel.updateMany({
        where: { isSystemDefault: true },
        data: { isSystemDefault: false },
      });
    }
    return tx.sendingChannel.create({
      data: {
        name: input.name,
        providerType: input.providerType,
        smtpConfigId: input.providerType === "SMTP" ? input.smtpConfigId : null,
        resendConfigId: input.providerType === "RESEND" ? input.resendConfigId : null,
        fromEmail: input.fromEmail ?? null,
        fromName: input.fromName ?? null,
        replyTo: input.replyTo ?? null,
        isSystemDefault: input.isSystemDefault ?? false,
      },
      select: CHANNEL_SELECT,
    });
  });
  return NextResponse.json(created, { status: 201 });
});
