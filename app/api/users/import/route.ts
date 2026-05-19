import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "@/lib/api-helpers";
import { verifyOrigin } from "@/lib/auth/origin";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import {
  importUsers,
  parseCsv,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_ROWS,
  type ImportRow,
} from "@/lib/modules/import/csv";

export const runtime = "nodejs";

const JsonImportBody = z.object({
  users: z
    .array(
      z.object({
        email: z.string().email().max(255),
        externalId: z.string().max(128).optional(),
        name: z.string().optional(),
        source: z.string().optional(),
        metadata: z.record(z.unknown()).optional(),
        userLevel: z.string().optional(),
        totalSpend: z.union([z.string(), z.number()]).optional(),
        orderCount: z.number().int().nonnegative().optional(),
        lastOrderAt: z.string().optional(),
        birthDate: z.string().optional(),
        tags: z.array(z.string()).optional(),
        subscriptions: z.record(z.string(), z.boolean()).optional(),
      }),
    )
    .max(MAX_IMPORT_ROWS),
});

export const POST = withAuth(async (_session, request: Request) => {
  if (!verifyOrigin(request.headers)) throw new ForbiddenError("Forbidden origin");

  const contentType = request.headers.get("content-type") ?? "";

  let rows: ImportRow[];

  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const file = form.get("file");
    if (!file || !(file instanceof File)) {
      throw new ValidationError("file is required");
    }
    if (file.size > MAX_IMPORT_BYTES) {
      throw new ValidationError(
        `File size exceeds ${MAX_IMPORT_BYTES} bytes (10MB) limit`,
      );
    }
    const text = await file.text();
    const parsed = parseCsv(text);
    if (parsed.rows.length > MAX_IMPORT_ROWS) {
      throw new ValidationError(`CSV exceeds ${MAX_IMPORT_ROWS} rows limit`);
    }
    const result = await importUsers(parsed.rows, {
      actorType: "ADMIN",
      req: { headers: request.headers },
    });
    return NextResponse.json({
      ...result,
      errors: [...parsed.errors, ...result.errors],
    });
  }

  if (contentType.includes("application/json")) {
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      throw new ValidationError("Invalid JSON body");
    }
    const parsed = JsonImportBody.parse(raw);
    rows = parsed.users.map((u) => ({
      email: u.email,
      externalId: u.externalId,
      name: u.name,
      source: u.source,
      metadata: u.metadata,
      userLevel: u.userLevel,
      totalSpend: u.totalSpend,
      orderCount: u.orderCount,
      lastOrderAt: u.lastOrderAt,
      birthDate: u.birthDate,
      tags: u.tags,
      subscriptions: u.subscriptions,
    }));
    const result = await importUsers(rows, {
      actorType: "ADMIN",
      req: { headers: request.headers },
    });
    return NextResponse.json(result);
  }

  throw new ValidationError(
    "Content-Type must be application/json or multipart/form-data",
  );
});
