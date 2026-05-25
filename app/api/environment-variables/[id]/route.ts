import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth, parseJsonBody } from "@/lib/api-helpers";
import { verifyOrigin } from "@/lib/auth/origin";
import { ForbiddenError } from "@/lib/errors";
import { environmentVariableService } from "@/lib/modules/environment-variable/service";

export const runtime = "nodejs";

const UpdateSchema = z.object({
  value: z.string().optional(),
  description: z.string().max(256).optional(),
});

interface Ctx {
  params: Promise<{ id: string }>;
}

export const PATCH = withAuth(async (_session, request: Request, ctx: Ctx) => {
  if (!verifyOrigin(request.headers)) throw new ForbiddenError("Forbidden origin");
  const { id } = await ctx.params;
  const input = await parseJsonBody(request, UpdateSchema);
  const record = await environmentVariableService.update(id, input, {
    actorType: "ADMIN",
    req: { headers: request.headers },
  });
  return NextResponse.json(record);
});

export const DELETE = withAuth(async (_session, request: Request, ctx: Ctx) => {
  if (!verifyOrigin(request.headers)) throw new ForbiddenError("Forbidden origin");
  const { id } = await ctx.params;
  await environmentVariableService.remove(id, {
    actorType: "ADMIN",
    req: { headers: request.headers },
  });
  return new NextResponse(null, { status: 204 });
});
