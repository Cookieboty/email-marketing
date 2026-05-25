import { NextResponse } from "next/server";
import { withAuth, parseJsonBody } from "@/lib/api-helpers";
import { BatchTagsSchema } from "@/lib/modules/user/schema";
import { userService } from "@/lib/modules/user/service";

export const POST = withAuth(async (session, request: Request) => {
  const input = await parseJsonBody(request, BatchTagsSchema);
  const result = await userService.batchTags(input, {
    actorType: "ADMIN",
    req: { headers: new Headers(request.headers) },
  });
  return NextResponse.json(result);
});
