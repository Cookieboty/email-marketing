import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "crypto";

const APP_URL = "https://app.test";
const SECRET = "test-secret-key-1234";

vi.mock("@/lib/env", () => ({
  env: () => ({ APP_URL, SESSION_SECRET: SECRET, STORE_IP_ADDRESSES: false }),
}));

vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    campaignRecipient: { findUnique: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn(),
  },
}));

import { GET } from "@/app/api/track/click/route";

function fullHmac(rid: string, url: string): string {
  return createHmac("sha256", SECRET).update(`${rid}:${url}`).digest("hex");
}

function buildReq(params: Record<string, string>): Request {
  const u = new URL("https://app.test/api/track/click");
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return new Request(u.toString());
}

describe("track/click redirect safety", () => {
  beforeEach(() => vi.clearAllMocks());

  it("missing params → redirect to APP_URL", async () => {
    const res = await GET(buildReq({ rid: "r1" }));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${APP_URL}/`);
  });

  it("invalid HMAC → redirect to APP_URL, not the user url", async () => {
    const target = "https://evil.example.com/phish";
    const res = await GET(buildReq({ rid: "r1", url: target, t: "deadbeef" }));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${APP_URL}/`);
  });

  it("valid HMAC but non-http scheme → redirect to APP_URL", async () => {
    const target = "javascript:alert(1)";
    const res = await GET(buildReq({ rid: "r1", url: target, t: fullHmac("r1", target) }));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${APP_URL}/`);
  });

  it("valid HMAC + http(s) target → redirect to original url", async () => {
    const target = "https://example.com/page?a=1";
    const res = await GET(buildReq({ rid: "r1", url: target, t: fullHmac("r1", target) }));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(target);
  });
});
