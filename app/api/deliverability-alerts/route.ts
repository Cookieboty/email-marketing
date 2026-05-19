import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth, parseJsonBody } from "@/lib/api-helpers";
import { verifyOrigin } from "@/lib/auth/origin";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

const QuerySchema = z.object({
  resolved: z.enum(["true", "false"]).optional().transform((v) => v === "true" ? true : v === "false" ? false : undefined),
  type: z.enum(["HIGH_BOUNCE_RATE", "HIGH_COMPLAINT_RATE"]).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});

const PatchSchema = z.object({
  resolved: z.literal(true),
});

export const GET = withAuth(async (_session, request: Request) => {
  const url = new URL(request.url);
  const q = url.searchParams;
  const parsed = QuerySchema.parse({
    resolved: q.get("resolved") ?? undefined,
    type: q.get("type") ?? undefined,
    page: q.get("page") ?? undefined,
    pageSize: q.get("pageSize") ?? undefined,
  });

  const where: Record<string, unknown> = {};
  if (parsed.resolved !== undefined) where.resolved = parsed.resolved;
  if (parsed.type) where.type = parsed.type;

  const [data, total] = await Promise.all([
    prisma.deliverabilityAlert.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (parsed.page - 1) * parsed.pageSize,
      take: parsed.pageSize,
      include: { campaign: { select: { id: true, name: true } } },
    }),
    prisma.deliverabilityAlert.count({ where }),
  ]);

  return NextResponse.json({
    data,
    total,
    page: parsed.page,
    pageSize: parsed.pageSize,
  });
});

export const PATCH = withAuth(async (_session, request: Request) => {
  if (!verifyOrigin(request.headers)) throw new ForbiddenError("Forbidden origin");

  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) throw new NotFoundError("Alert id required");

  await parseJsonBody(request, PatchSchema);

  const existing = await prisma.deliverabilityAlert.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError("Alert not found");

  const updated = await prisma.deliverabilityAlert.update({
    where: { id },
    data: { resolved: true, resolvedAt: new Date() },
  });

  audit({
    action: "alert.resolve",
    entityType: "DeliverabilityAlert",
    entityId: id,
    actorType: "ADMIN",
    details: { type: existing.type, domain: existing.domain },
    req: { headers: request.headers },
  });

  return NextResponse.json(updated);
});
