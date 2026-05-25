import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth, parseJsonBody } from "@/lib/api-helpers";
import { verifyOrigin } from "@/lib/auth/origin";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { encryptResendApiKey, buildApiKeyHint } from "@/lib/modules/smtp/crypto";

export const runtime = "nodejs";

const PatchSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  apiKey: z.string().min(1).max(200).optional(),
  status: z.enum(["ACTIVE", "DISABLED"]).optional(),
});

export const GET = withAuth(async (_session, _request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const config = await prisma.resendConfig.findUnique({
    where: { id },
    select: { id: true, name: true, apiKeyHint: true, status: true, createdAt: true, updatedAt: true },
  });
  if (!config) throw new NotFoundError("ResendConfig not found");
  return NextResponse.json(config);
});

export const PATCH = withAuth(async (_session, request: Request, { params }: { params: Promise<{ id: string }> }) => {
  if (!verifyOrigin(request.headers)) throw new ForbiddenError("Forbidden origin");
  const { id } = await params;
  const input = await parseJsonBody(request, PatchSchema);

  const existing = await prisma.resendConfig.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("ResendConfig not found");

  const data: Record<string, unknown> = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.status !== undefined) data.status = input.status;
  if (input.apiKey !== undefined) {
    data.apiKeyCipher = encryptResendApiKey(input.apiKey);
    data.apiKeyHint = buildApiKeyHint(input.apiKey);
  }

  const updated = await prisma.resendConfig.update({
    where: { id },
    data,
    select: { id: true, name: true, apiKeyHint: true, status: true, createdAt: true, updatedAt: true },
  });
  return NextResponse.json(updated);
});

export const DELETE = withAuth(async (_session, request: Request, { params }: { params: Promise<{ id: string }> }) => {
  if (!verifyOrigin(request.headers)) throw new ForbiddenError("Forbidden origin");
  const { id } = await params;

  const channels = await prisma.sendingChannel.count({ where: { resendConfigId: id } });
  if (channels > 0) {
    return NextResponse.json(
      { error: "Cannot delete: ResendConfig is referenced by sending channels" },
      { status: 409 },
    );
  }

  await prisma.resendConfig.delete({ where: { id } });
  return NextResponse.json({ ok: true });
});
