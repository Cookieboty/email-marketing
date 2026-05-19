import { beforeEach, describe, expect, it } from "vitest";
import {
  signSession,
  verifySession,
  timingSafeEqual,
  timingSafeEqualString,
  buildSessionCookie,
  buildClearedSessionCookie,
  SESSION_COOKIE_NAME,
} from "@/lib/auth/session";

const SECRET = "x".repeat(48);

function setNodeEnv(v: string) {
  (process.env as Record<string, string | undefined>).NODE_ENV = v;
}

beforeEach(() => {
  process.env.SESSION_SECRET = SECRET;
  setNodeEnv("test");
});

describe("auth/session", () => {
  it("signs and verifies a fresh session", async () => {
    const now = Math.floor(Date.now() / 1000);
    const payload = { sessionId: "sid-1", iat: now, exp: now + 60 };
    const token = await signSession(payload);
    const out = await verifySession(token, { now });
    expect(out).toEqual(payload);
  });

  it("rejects tampered body", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signSession({ sessionId: "sid", iat: now, exp: now + 60 });
    const [body, sig] = token.split(".");
    const tamperedBody = body!.replace(/.$/, (c) => (c === "A" ? "B" : "A"));
    const result = await verifySession(`${tamperedBody}.${sig}`, { now });
    expect(result).toBeNull();
  });

  it("rejects tampered signature", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signSession({ sessionId: "sid", iat: now, exp: now + 60 });
    const result = await verifySession(`${token}xx`, { now });
    expect(result).toBeNull();
  });

  it("rejects token signed with a different secret", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signSession(
      { sessionId: "sid", iat: now, exp: now + 60 },
      "y".repeat(48),
    );
    const result = await verifySession(token, { now });
    expect(result).toBeNull();
  });

  it("rejects an expired token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signSession({ sessionId: "sid", iat: now - 120, exp: now - 1 });
    const result = await verifySession(token, { now });
    expect(result).toBeNull();
  });

  it("rejects malformed input", async () => {
    expect(await verifySession("not-a-token")).toBeNull();
    expect(await verifySession(".sig")).toBeNull();
    expect(await verifySession("body.")).toBeNull();
  });

  it("throws when SESSION_SECRET is missing or too short", async () => {
    process.env.SESSION_SECRET = "";
    await expect(
      signSession({ sessionId: "x", iat: 1, exp: 2 }),
    ).rejects.toThrow(/SESSION_SECRET/);
    process.env.SESSION_SECRET = "short";
    await expect(
      signSession({ sessionId: "x", iat: 1, exp: 2 }),
    ).rejects.toThrow(/SESSION_SECRET/);
  });

  it("timingSafeEqual returns true for equal and false for unequal of any length", () => {
    expect(timingSafeEqualString("abc", "abc")).toBe(true);
    expect(timingSafeEqualString("abc", "abd")).toBe(false);
    expect(timingSafeEqualString("abc", "abcd")).toBe(false);
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
  });

  it("buildSessionCookie attaches Secure only in production", () => {
    setNodeEnv("production");
    const c1 = buildSessionCookie("v", 60);
    expect(c1).toMatch(/Secure/);
    expect(c1).toMatch(new RegExp(`^${SESSION_COOKIE_NAME}=v;`));
    setNodeEnv("development");
    expect(buildSessionCookie("v", 60)).not.toMatch(/Secure/);
  });

  it("buildClearedSessionCookie has Max-Age=0", () => {
    expect(buildClearedSessionCookie()).toMatch(/Max-Age=0/);
  });
});
