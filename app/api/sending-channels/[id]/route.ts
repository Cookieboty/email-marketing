import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth, parseJsonBody } from "@/lib/api-helpers";
import { verifyOrigin } from "@/lib/auth/origin";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

const PatchSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  fromEmail: z.string().email().optional(),
  fromName: z.string().max(100).nullable().optional(),
  replyTo: z.string().email().nullable().optional(),
  status: z.enum(["ACTIVE", "DISABLED"]).optional(),
});

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

export const GET = withAuth(async (_session, _request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const channel = await prisma.sendingChannel.findUnique({
    where: { id },
    select: CHANNEL_SELECT,
  });
  if (!channel) throw new NotFoundError("SendingChannel not found");
  return NextResponse.json(channel);
});

export const PATCH = withAuth(async (_session, request: Request, { params }: { params: Promise<{ id: string }> }) => {
  if (!verifyOrigin(request.headers)) throw new ForbiddenError("Forbidden origin");
  const { id } = await params;
  const input = await parseJsonBody(request, PatchSchema);

  const existing = await prisma.sendingChannel.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("SendingChannel not found");

  const updated = await prisma.sendingChannel.update({
    where: { id },
    data: input,
    select: CHANNEL_SELECT,
  });
  return NextResponse.json(updated);
});

export const DELETE = withAuth(async (_session, request: Request, { params }: { params: Promise<{ id: string }> }) => {
  if (!verifyOrigin(request.headers)) throw new ForbiddenError("Forbidden origin");
  const { id } = await params;

  const campaigns = await prisma.campaign.count({ where: { sendingChannelId: id } });
  if (campaigns > 0) {
    return NextResponse.json(
      { error: "Cannot delete: channel is referenced by campaigns" },
      { status: 409 },
    );
  }

  await prisma.sendingChannel.delete({ where: { id } });
  return NextResponse.json({ ok: true });
});
