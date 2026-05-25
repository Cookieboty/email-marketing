import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-helpers";
import { verifyOrigin } from "@/lib/auth/origin";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export const POST = withAuth(async (_session, request: Request, { params }: { params: Promise<{ id: string }> }) => {
  if (!verifyOrigin(request.headers)) throw new ForbiddenError("Forbidden origin");
  const { id } = await params;

  const channel = await prisma.sendingChannel.findUnique({ where: { id } });
  if (!channel) throw new NotFoundError("SendingChannel not found");

  await prisma.$transaction(async (tx) => {
    await tx.sendingChannel.updateMany({
      where: { isSystemDefault: true },
      data: { isSystemDefault: false },
    });
    await tx.sendingChannel.update({
      where: { id },
      data: { isSystemDefault: true },
    });
  });

  return NextResponse.json({ ok: true });
});
