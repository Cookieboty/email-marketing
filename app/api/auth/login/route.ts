import { NextResponse } from "next/server";
import { z } from "zod";
import { buildSessionCookie, signSession, DEFAULT_SESSION_TTL_SECONDS } from "@/lib/auth/session";
import { createSessionPayload, verifyAdminToken } from "@/lib/auth/login";
import { loginRateLimiter, getClientIp } from "@/lib/auth/rate-limit";
import { verifyOrigin } from "@/lib/auth/origin";

export const runtime = "nodejs";

const Body = z.object({
  token: z.string().min(1).max(512),
});

function sleep(ms: number) {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

function genericFailure(retryAfterSec = 0): NextResponse {
  const res = NextResponse.json({ ok: false, error: "invalid_credentials" }, { status: 401 });
  if (retryAfterSec > 0) res.headers.set("Retry-After", String(retryAfterSec));
  return res;
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!verifyOrigin(request.headers)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }

  const ip = getClientIp(request.headers);

  const pre = loginRateLimiter.check(ip);
  if (!pre.allowed) {
    return NextResponse.json(
      { ok: false, error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(pre.retryAfterSec) } },
    );
  }
  await sleep(pre.delayMs);

  let parsed: z.infer<typeof Body>;
  try {
    const json = await request.json();
    parsed = Body.parse(json);
  } catch {
    const decision = loginRateLimiter.recordFailure(ip);
    return genericFailure(decision.retryAfterSec);
  }

  if (!verifyAdminToken(parsed.token)) {
    const decision = loginRateLimiter.recordFailure(ip);
    return genericFailure(decision.retryAfterSec);
  }

  loginRateLimiter.reset(ip);

  const payload = createSessionPayload(DEFAULT_SESSION_TTL_SECONDS);
  const cookieValue = await signSession(payload);
  const res = NextResponse.json({ ok: true, exp: payload.exp });
  res.headers.append("Set-Cookie", buildSessionCookie(cookieValue, DEFAULT_SESSION_TTL_SECONDS));
  return res;
}
