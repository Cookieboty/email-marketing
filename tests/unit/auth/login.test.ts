import { beforeEach, describe, expect, it } from "vitest";
import { verifyAdminToken, createSessionPayload } from "@/lib/auth/login";

beforeEach(() => {
  process.env.ADMIN_TOKEN = "a".repeat(32);
});

describe("auth/login", () => {
  it("accepts the exact admin token", () => {
    expect(verifyAdminToken("a".repeat(32))).toBe(true);
  });

  it("rejects mismatched, empty, missing, or too-short ADMIN_TOKEN", () => {
    expect(verifyAdminToken("a".repeat(31) + "b")).toBe(false);
    expect(verifyAdminToken("")).toBe(false);
    expect(verifyAdminToken(null)).toBe(false);
    expect(verifyAdminToken(undefined)).toBe(false);
    process.env.ADMIN_TOKEN = "";
    expect(verifyAdminToken("a".repeat(32))).toBe(false);
    process.env.ADMIN_TOKEN = "short";
    expect(verifyAdminToken("short")).toBe(false);
  });

  it("createSessionPayload returns 64-hex sessionId, valid iat/exp", () => {
    const now = 1_700_000_000;
    const p = createSessionPayload(3600, now);
    expect(p.sessionId).toMatch(/^[0-9a-f]{64}$/);
    expect(p.iat).toBe(now);
    expect(p.exp).toBe(now + 3600);
  });

  it("createSessionPayload yields unique sessionIds across calls", () => {
    const a = createSessionPayload();
    const b = createSessionPayload();
    expect(a.sessionId).not.toBe(b.sessionId);
  });
});
