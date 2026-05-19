import { NextResponse } from "next/server";
import { withAuth, parseJsonBody } from "@/lib/api-helpers";
import { verifyOrigin } from "@/lib/auth/origin";
import { ForbiddenError } from "@/lib/errors";
import {
  apiClientService,
  serializeApiClient,
} from "@/lib/modules/api-client/service";
import { UpdateApiClientSchema } from "@/lib/modules/api-client/schema";

export const runtime = "nodejs";

interface Ctx {
  params: Promise<{ id: string }>;
}

export const GET = withAuth(async (_session, _request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const client = await apiClientService.getById(id);
  return NextResponse.json(serializeApiClient(client));
});

export const PATCH = withAuth(async (_session, request: Request, ctx: Ctx) => {
  if (!verifyOrigin(request.headers)) throw new ForbiddenError("Forbidden origin");
  const { id } = await ctx.params;
  const input = await parseJsonBody(request, UpdateApiClientSchema);
  const updated = await apiClientService.update(id, input, {
    actorType: "ADMIN",
    req: { headers: request.headers },
  });
  return NextResponse.json(serializeApiClient(updated));
});

export const DELETE = withAuth(async (_session, request: Request, ctx: Ctx) => {
  if (!verifyOrigin(request.headers)) throw new ForbiddenError("Forbidden origin");
  const { id } = await ctx.params;
  await apiClientService.revoke(id, {
    actorType: "ADMIN",
    req: { headers: request.headers },
  });
  return new NextResponse(null, { status: 204 });
});
