import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "@/lib/api-helpers";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

const QuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
  sortBy: z.enum(["domain", "totalSent", "bounceRate", "complaintRate"]).default("totalSent"),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
});

export const GET = withAuth(async (_session, request: Request) => {
  const url = new URL(request.url);
  const q = url.searchParams;
  const parsed = QuerySchema.parse({
    page: q.get("page") ?? undefined,
    pageSize: q.get("pageSize") ?? undefined,
    sortBy: q.get("sortBy") ?? undefined,
    sortDir: q.get("sortDir") ?? undefined,
  });

  const [data, total] = await Promise.all([
    prisma.domainStat.findMany({
      orderBy: { [parsed.sortBy]: parsed.sortDir },
      skip: (parsed.page - 1) * parsed.pageSize,
      take: parsed.pageSize,
    }),
    prisma.domainStat.count(),
  ]);

  return NextResponse.json({
    data,
    total,
    page: parsed.page,
    pageSize: parsed.pageSize,
  });
});
