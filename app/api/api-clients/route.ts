import { NextResponse } from "next/server";
import { withAuth, parseJsonBody } from "@/lib/api-helpers";
import { verifyOrigin } from "@/lib/auth/origin";
import { ForbiddenError } from "@/lib/errors";
import {
  apiClientService,
  serializeApiClient,
} from "@/lib/modules/api-client/service";
import {
  CreateApiClientSchema,
  ListApiClientsQuerySchema,
} from "@/lib/modules/api-client/schema";

export const runtime = "nodejs";

export const GET = withAuth(async (_session, request: Request) => {
  const url = new URL(request.url);
  const query = ListApiClientsQuerySchema.parse({
    q: url.searchParams.get("q") ?? undefined,
    status: url.searchParams.get("status") ?? undefined,
    page: url.searchParams.get("page") ?? undefined,
    pageSize: url.searchParams.get("pageSize") ?? undefined,
  });
  const list = await apiClientService.list(query);
  return NextResponse.json({
    ...list,
    data: list.data.map(serializeApiClient),
  });
});

export const POST = withAuth(async (session, request: Request) => {
  if (!verifyOrigin(request.headers)) throw new ForbiddenError("Forbidden origin");
  const input = await parseJsonBody(request, CreateApiClientSchema);
  const { client, token, hmacSecret } = await apiClientService.create(input, {
    actorType: "ADMIN",
    actorId: session.sessionId,
    req: { headers: request.headers },
  });
  return NextResponse.json(
    {
      ...serializeApiClient(client),
      token,
      hmacSecret,
    },
    { status: 201 },
  );
});
