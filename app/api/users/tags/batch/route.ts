import { NextResponse } from "next/server";
import { withAuth, parseJsonBody } from "@/lib/api-helpers";
import { verifyOrigin } from "@/lib/auth/origin";
import { ForbiddenError } from "@/lib/errors";
import { BatchTagsSchema } from "@/lib/modules/user/schema";
import { userService } from "@/lib/modules/user/service";

export const POST = withAuth(async (session, request: Request) => {
  if (!verifyOrigin(request.headers)) throw new ForbiddenError("Forbidden origin");
  const input = await parseJsonBody(request, BatchTagsSchema);
  const result = await userService.batchTags(input, {
    actorType: "ADMIN",
    req: { headers: new Headers(request.headers) },
  });
  return NextResponse.json(result);
});
