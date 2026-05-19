import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-helpers";
import { verifyOrigin } from "@/lib/auth/origin";
import { ForbiddenError } from "@/lib/errors";
import {
  apiClientService,
  serializeApiClient,
} from "@/lib/modules/api-client/service";

export const runtime = "nodejs";

interface Ctx {
  params: Promise<{ id: string }>;
}

export const POST = withAuth(async (_session, request: Request, ctx: Ctx) => {
  if (!verifyOrigin(request.headers)) throw new ForbiddenError("Forbidden origin");
  const { id } = await ctx.params;
  const { client, token, previousTokenExpiresAt } = await apiClientService.rotate(
    id,
    {
      actorType: "ADMIN",
      req: { headers: request.headers },
    },
  );
  return NextResponse.json({
    ...serializeApiClient(client),
    token,
    previousTokenExpiresAt: previousTokenExpiresAt.toISOString(),
  });
});
