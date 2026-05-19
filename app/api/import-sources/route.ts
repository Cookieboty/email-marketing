import { NextResponse } from "next/server";
import { withAuth, parseJsonBody } from "@/lib/api-helpers";
import { verifyOrigin } from "@/lib/auth/origin";
import { ForbiddenError } from "@/lib/errors";
import { importSourceService } from "@/lib/modules/import/service";
import { CreateImportSourceSchema } from "@/lib/modules/import/schema";

export const runtime = "nodejs";

export const GET = withAuth(async () => {
  const list = await importSourceService.list();
  return NextResponse.json({ data: list });
});

export const POST = withAuth(async (session, request: Request) => {
  if (!verifyOrigin(request.headers)) throw new ForbiddenError("Forbidden origin");
  const input = await parseJsonBody(request, CreateImportSourceSchema);
  const created = await importSourceService.create(input, {
    actorId: session.sessionId,
    req: { headers: request.headers },
  });
  return NextResponse.json(created, { status: 201 });
});
