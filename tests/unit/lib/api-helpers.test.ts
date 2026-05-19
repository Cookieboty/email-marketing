import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

const cookieStore: { value: string | null } = { value: null };

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      cookieStore.value && name === "ems_session" ? { value: cookieStore.value } : undefined,
  }),
}));

import { signSession } from "@/lib/auth/session";
import {
  parseJsonBody,
  getClientIpFromHeaders,
  withAuth,
  requireSession,
} from "@/lib/api-helpers";
import { AuthError } from "@/lib/errors";

const SECRET = "test-secret-1234567890ab";

beforeEach(() => {
  cookieStore.value = null;
  process.env.SESSION_SECRET = SECRET;
});

describe("api-helpers: parseJsonBody", () => {
  it("parses and validates", async () => {
    const req = new Request("http://x", {
      method: "POST",
      body: JSON.stringify({ name: "ok" }),
      headers: { "content-type": "application/json" },
    });
    const out = await parseJsonBody(req, z.object({ name: z.string() }));
    expect(out).toEqual({ name: "ok" });
  });

  it("throws ValidationError on bad JSON", async () => {
    const req = new Request("http://x", {
      method: "POST",
      body: "not json",
      headers: { "content-type": "application/json" },
    });
    await expect(parseJsonBody(req, z.object({}))).rejects.toThrow(/Invalid JSON/);
  });

  it("throws ValidationError on schema failure", async () => {
    const req = new Request("http://x", {
      method: "POST",
      body: JSON.stringify({ name: 1 }),
      headers: { "content-type": "application/json" },
    });
    await expect(parseJsonBody(req, z.object({ name: z.string() }))).rejects.toThrow(
      /Validation failed/,
    );
  });
});

describe("api-helpers: getClientIpFromHeaders", () => {
  it("prefers x-forwarded-for", () => {
    const h = new Headers({ "x-forwarded-for": "1.2.3.4, 9.9.9.9", "x-real-ip": "8.8.8.8" });
    expect(getClientIpFromHeaders(h)).toBe("1.2.3.4");
  });
  it("falls back to x-real-ip", () => {
    expect(getClientIpFromHeaders(new Headers({ "x-real-ip": "8.8.8.8" }))).toBe("8.8.8.8");
  });
  it("returns 'unknown' when none", () => {
    expect(getClientIpFromHeaders(new Headers())).toBe("unknown");
  });
});

describe("api-helpers: withAuth / requireSession", () => {
  it("requireSession throws AuthError without cookie", async () => {
    cookieStore.value = null;
    await expect(requireSession()).rejects.toBeInstanceOf(AuthError);
  });

  it("withAuth returns 401 when not authenticated", async () => {
    cookieStore.value = null;
    const handler = withAuth(async () => {
      throw new Error("should not run");
    });
    const res = await handler();
    expect(res.status).toBe(401);
  });

  it("withAuth invokes handler when authenticated", async () => {
    const token = await signSession(
      {
        sessionId: "sess-1",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      SECRET,
    );
    cookieStore.value = token;
    const handler = withAuth(async (session) => {
      expect(session.sessionId).toBe("sess-1");
      const { NextResponse } = await import("next/server");
      return NextResponse.json({ ok: true });
    });
    const res = await handler();
    expect(res.status).toBe(200);
  });
});
