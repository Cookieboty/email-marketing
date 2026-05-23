import { NextResponse } from "next/server";
import { withAuth, parseJsonBody } from "@/lib/api-helpers";
import { verifyOrigin } from "@/lib/auth/origin";
import { ForbiddenError } from "@/lib/errors";
import {
  CreateSmtpConfigSchema,
  ListSmtpConfigsQuerySchema,
} from "@/lib/modules/smtp/schema";
import {
  createSmtpConfig,
  listSmtpConfigs,
} from "@/lib/modules/smtp/service";

export const runtime = "nodejs";

export const GET = withAuth(async (_session, request: Request) => {
  const url = new URL(request.url);
  const query = ListSmtpConfigsQuerySchema.parse({
    q: url.searchParams.get("q") ?? undefined,
    status: url.searchParams.get("status") ?? undefined,
    page: url.searchParams.get("page") ?? undefined,
    pageSize: url.searchParams.get("pageSize") ?? undefined,
  });
  const list = await listSmtpConfigs(query);
  return NextResponse.json(list);
});

export const POST = withAuth(async (session, request: Request) => {
  if (!verifyOrigin(request.headers)) throw new ForbiddenError("Forbidden origin");
  const input = await parseJsonBody(request, CreateSmtpConfigSchema);
  const created = await createSmtpConfig(input, {
    adminId: session.sessionId,
    req: { headers: request.headers },
  });
  return NextResponse.json(created, { status: 201 });
});
