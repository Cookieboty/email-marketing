import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-helpers";
import { checkFrequency } from "@/lib/modules/frequency/check";
import { CheckFrequencyQuerySchema } from "@/lib/modules/frequency/schema";

export const runtime = "nodejs";

export const GET = withAuth(async (_session, request: Request) => {
  const url = new URL(request.url);
  const { userId } = CheckFrequencyQuerySchema.parse({
    userId: url.searchParams.get("userId") ?? undefined,
  });
  const result = await checkFrequency(userId);
  return NextResponse.json(result);
});
