import { NextResponse } from "next/server";
import { buildClearedSessionCookie } from "@/lib/auth/session";
import { verifyOrigin } from "@/lib/auth/origin";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse> {
  if (!verifyOrigin(request.headers)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  const res = NextResponse.json({ ok: true });
  res.headers.append("Set-Cookie", buildClearedSessionCookie());
  return res;
}
