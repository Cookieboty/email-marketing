import { NextResponse } from "next/server";
import { withAuth, parseJsonBody } from "@/lib/api-helpers";
import { verifyOrigin } from "@/lib/auth/origin";
import { ForbiddenError } from "@/lib/errors";
import {
  CreateFrequencyCapSchema,
  ListFrequencyCapsQuerySchema,
} from "@/lib/modules/frequency/schema";
import { frequencyService } from "@/lib/modules/frequency/service";

export const runtime = "nodejs";

export const GET = withAuth(async (_session, request: Request) => {
  const url = new URL(request.url);
  const parsed = ListFrequencyCapsQuerySchema.parse({
    isActive: url.searchParams.get("isActive") ?? undefined,
  });
  const [items, defaults, active] = await Promise.all([
    frequencyService.list(parsed),
    Promise.resolve(frequencyService.getDefaults()),
    frequencyService.getActive(),
  ]);
  return NextResponse.json({ items, active, defaults });
});

export const POST = withAuth(async (_session, request: Request) => {
  if (!verifyOrigin(request.headers)) throw new ForbiddenError("Forbidden origin");
  const input = await parseJsonBody(request, CreateFrequencyCapSchema);
  const cap = await frequencyService.create(input, {
    actorType: "ADMIN",
    req: { headers: request.headers },
  });
  return NextResponse.json(cap, { status: 201 });
});
