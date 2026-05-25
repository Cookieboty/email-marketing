import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth, parseJsonBody } from "@/lib/api-helpers";
import { verifyOrigin } from "@/lib/auth/origin";
import { ForbiddenError } from "@/lib/errors";
import { environmentVariableService } from "@/lib/modules/environment-variable/service";

export const runtime = "nodejs";

const CreateSchema = z.object({
  key: z.string().min(1).max(64),
  value: z.string(),
  description: z.string().max(256).optional(),
});

export const GET = withAuth(async () => {
  const data = await environmentVariableService.list();
  return NextResponse.json({ data });
});

export const POST = withAuth(async (_session, request: Request) => {
  if (!verifyOrigin(request.headers)) throw new ForbiddenError("Forbidden origin");
  const input = await parseJsonBody(request, CreateSchema);
  const record = await environmentVariableService.create(input, {
    actorType: "ADMIN",
    req: { headers: request.headers },
  });
  return NextResponse.json(record, { status: 201 });
});
