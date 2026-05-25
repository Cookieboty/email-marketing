import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth, parseJsonBody } from "@/lib/api-helpers";
import { verifyOrigin } from "@/lib/auth/origin";
import { ForbiddenError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { encryptResendApiKey, buildApiKeyHint } from "@/lib/modules/smtp/crypto";

export const runtime = "nodejs";

const CreateSchema = z.object({
  name: z.string().min(1).max(100),
  apiKey: z.string().min(1).max(200),
});

export const GET = withAuth(async () => {
  const configs = await prisma.resendConfig.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      apiKeyHint: true,
      status: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return NextResponse.json({ data: configs });
});

export const POST = withAuth(async (_session, request: Request) => {
  if (!verifyOrigin(request.headers)) throw new ForbiddenError("Forbidden origin");
  const input = await parseJsonBody(request, CreateSchema);

  const cipher = encryptResendApiKey(input.apiKey);
  const hint = buildApiKeyHint(input.apiKey);

  const created = await prisma.resendConfig.create({
    data: {
      name: input.name,
      apiKeyCipher: cipher,
      apiKeyHint: hint,
    },
    select: {
      id: true,
      name: true,
      apiKeyHint: true,
      status: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return NextResponse.json(created, { status: 201 });
});
