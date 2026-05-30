import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { verifyClickHmac } from "@/lib/modules/campaign/html-transform";

export const runtime = "nodejs";

const log = logger.child("track/click");

function isSafeRedirectTarget(target: string): boolean {
  try {
    const parsed = new URL(target);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const rid = url.searchParams.get("rid");
  const originalUrl = url.searchParams.get("url");
  const hmac = url.searchParams.get("t");

  const fallbackUrl = env().APP_URL ?? "/";

  if (!rid || !originalUrl || !hmac) {
    return NextResponse.redirect(fallbackUrl, 302);
  }

  const secret = env().SESSION_SECRET;
  if (!secret || !verifyClickHmac(rid, originalUrl, secret, hmac)) {
    log.warn("click tracking hmac verification failed", { rid });
    return NextResponse.redirect(fallbackUrl, 302);
  }

  if (!isSafeRedirectTarget(originalUrl)) {
    log.warn("click tracking unsafe redirect target", { rid });
    return NextResponse.redirect(fallbackUrl, 302);
  }

  try {
    const recipient = await prisma.campaignRecipient.findUnique({
      where: { id: rid },
      select: { id: true, campaignId: true, userId: true, status: true },
    });

    if (recipient) {
      const ua = request.headers.get("user-agent") ?? undefined;
      const storeIp = env().STORE_IP_ADDRESSES;
      const xff = request.headers.get("x-forwarded-for");
      const ip = storeIp ? (xff ? xff.split(",")[0]!.trim() : undefined) : undefined;

      await prisma.$transaction([
        prisma.linkClick.create({
          data: {
            campaignRecipientId: recipient.id,
            campaignId: recipient.campaignId,
            userId: recipient.userId,
            url: originalUrl,
            userAgent: ua ?? null,
            ipAddress: ip ?? null,
          },
        }),
        ...((recipient.status === "DELIVERED" || recipient.status === "OPENED")
          ? [
              prisma.campaignRecipient.update({
                where: { id: rid },
                data: { status: "CLICKED", clickedAt: new Date() },
              }),
            ]
          : []),
      ]);
    }
  } catch (err) {
    log.error("click tracking write failed", {
      rid,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return NextResponse.redirect(originalUrl, 302);
}
