import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "@/lib/api-helpers";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

interface Ctx {
  params: Promise<{ id: string }>;
}

const QuerySchema = z.object({
  status: z
    .enum([
      "PENDING", "SENDING", "SENT", "DELIVERED", "OPENED", "CLICKED",
      "BOUNCED", "SOFT_BOUNCED", "COMPLAINED", "UNSUBSCRIBED", "FAILED",
    ])
    .optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});

export const GET = withAuth(async (_session, request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const url = new URL(request.url);
  const q = url.searchParams;
  const parsed = QuerySchema.parse({
    status: q.get("status") ?? undefined,
    page: q.get("page") ?? undefined,
    pageSize: q.get("pageSize") ?? undefined,
  });

  const where: Record<string, unknown> = { campaignId: id };
  if (parsed.status) where.status = parsed.status;

  const [data, total] = await Promise.all([
    prisma.campaignRecipient.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (parsed.page - 1) * parsed.pageSize,
      take: parsed.pageSize,
      include: { user: { select: { id: true, email: true, name: true } } },
    }),
    prisma.campaignRecipient.count({ where }),
  ]);

  return NextResponse.json({
    data,
    total,
    page: parsed.page,
    pageSize: parsed.pageSize,
  });
});
