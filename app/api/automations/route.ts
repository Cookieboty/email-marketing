import { NextResponse } from "next/server";
import { withAuth, parseJsonBody } from "@/lib/api-helpers";
import { verifyOrigin } from "@/lib/auth/origin";
import { ForbiddenError } from "@/lib/errors";
import {
  CreateAutomationSchema,
  ListAutomationsQuerySchema,
} from "@/lib/modules/automation/schema";
import { automationService } from "@/lib/modules/automation/service";

export const runtime = "nodejs";

export const GET = withAuth(async (_session, request: Request) => {
  const url = new URL(request.url);
  const q = url.searchParams;
  const parsed = ListAutomationsQuerySchema.parse({
    status: q.get("status") ?? undefined,
    triggerType: q.get("triggerType") ?? undefined,
    page: q.get("page") ?? undefined,
    pageSize: q.get("pageSize") ?? undefined,
  });
  const result = await automationService.list(parsed);
  return NextResponse.json(result);
});

export const POST = withAuth(async (_session, request: Request) => {
  if (!verifyOrigin(request.headers)) throw new ForbiddenError("Forbidden origin");
  const input = await parseJsonBody(request, CreateAutomationSchema);
  const automation = await automationService.create(input, {
    actorType: "ADMIN",
    req: { headers: request.headers },
  });
  return NextResponse.json(automation, { status: 201 });
});
