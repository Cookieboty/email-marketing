import { NextResponse } from "next/server";
import { withAuth, parseJsonBody } from "@/lib/api-helpers";
import { verifyOrigin } from "@/lib/auth/origin";
import { ForbiddenError } from "@/lib/errors";
import { ImportSuppressionSchema } from "@/lib/modules/suppression/schema";
import { suppressionService } from "@/lib/modules/suppression/service";

export const runtime = "nodejs";

export const POST = withAuth(async (_session, request: Request) => {
  if (!verifyOrigin(request.headers)) throw new ForbiddenError("Forbidden origin");
  const input = await parseJsonBody(request, ImportSuppressionSchema);
  const result = await suppressionService.import(input, {
    actorType: "ADMIN",
    req: { headers: request.headers },
  });
  return NextResponse.json(result, { status: 200 });
});
