import { NextResponse } from "next/server";
import { withAuth, parseJsonBody } from "@/lib/api-helpers";
import { verifyOrigin } from "@/lib/auth/origin";
import { ForbiddenError } from "@/lib/errors";
import { ActivateProviderSchema } from "@/lib/modules/smtp/schema";
import {
  activateProvider,
  getMailProviderSetting,
} from "@/lib/modules/smtp/service";

export const runtime = "nodejs";

export const GET = withAuth(async () => {
  const setting = await getMailProviderSetting();
  return NextResponse.json(setting);
});

export const POST = withAuth(async (session, request: Request) => {
  if (!verifyOrigin(request.headers)) throw new ForbiddenError("Forbidden origin");
  const input = await parseJsonBody(request, ActivateProviderSchema);
  const result = await activateProvider(input, {
    adminId: session.sessionId,
    req: { headers: request.headers },
  });
  return NextResponse.json(result);
});
