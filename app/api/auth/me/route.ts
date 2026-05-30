import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME, verifySession } from "@/lib/auth/session";

export const runtime = "nodejs";

export async function GET(): Promise<NextResponse> {
  const store = await cookies();
  const raw = store.get(SESSION_COOKIE_NAME)?.value;
  if (!raw) return NextResponse.json({ ok: false, authenticated: false }, { status: 200 });

  const payload = await verifySession(raw).catch(() => null);
  if (!payload) {
    return NextResponse.json({ ok: false, authenticated: false }, { status: 200 });
  }
  return NextResponse.json({
    ok: true,
    authenticated: true,
    exp: payload.exp,
  });
}
