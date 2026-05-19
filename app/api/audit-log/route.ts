import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "@/lib/api-helpers";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

const QuerySchema = z.object({
  action: z.string().max(64).optional(),
  entityType: z.string().max(64).optional(),
  entityId: z.string().max(64).optional(),
  actorType: z.enum(["ADMIN", "SYSTEM", "WEBHOOK"]).optional(),
  from: z.string().datetime({ offset: true }).optional().transform((v) => v ? new Date(v) : undefined),
  to: z.string().datetime({ offset: true }).optional().transform((v) => v ? new Date(v) : undefined),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(50),
});

export const GET = withAuth(async (_session, request: Request) => {
  const url = new URL(request.url);
  const q = url.searchParams;
  const parsed = QuerySchema.parse({
    action: q.get("action") ?? undefined,
    entityType: q.get("entityType") ?? undefined,
    entityId: q.get("entityId") ?? undefined,
    actorType: q.get("actorType") ?? undefined,
    from: q.get("from") ?? undefined,
    to: q.get("to") ?? undefined,
    page: q.get("page") ?? undefined,
    pageSize: q.get("pageSize") ?? undefined,
  });

  const where: Record<string, unknown> = {};
  if (parsed.action) where.action = { contains: parsed.action, mode: "insensitive" };
  if (parsed.entityType) where.entityType = parsed.entityType;
  if (parsed.entityId) where.entityId = parsed.entityId;
  if (parsed.actorType) where.actorType = parsed.actorType;
  if (parsed.from || parsed.to) {
    where.createdAt = {
      ...(parsed.from ? { gte: parsed.from } : {}),
      ...(parsed.to ? { lte: parsed.to } : {}),
    };
  }

  const [data, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (parsed.page - 1) * parsed.pageSize,
      take: parsed.pageSize,
    }),
    prisma.auditLog.count({ where }),
  ]);

  return NextResponse.json({
    data,
    total,
    page: parsed.page,
    pageSize: parsed.pageSize,
  });
});
