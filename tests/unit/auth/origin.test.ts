import { beforeEach, describe, expect, it } from "vitest";
import { verifyOrigin, getAllowedOrigin } from "@/lib/auth/origin";

beforeEach(() => {
  process.env.APP_URL = "https://app.example.com";
});

function h(record: Record<string, string>): Headers {
  const out = new Headers();
  for (const [k, v] of Object.entries(record)) out.set(k, v);
  return out;
}

describe("auth/origin", () => {
  it("getAllowedOrigin returns origin without path", () => {
    process.env.APP_URL = "https://app.example.com/admin";
    expect(getAllowedOrigin()).toBe("https://app.example.com");
  });

  it("returns false when APP_URL is missing or invalid", () => {
    process.env.APP_URL = "";
    expect(verifyOrigin(h({ origin: "https://app.example.com" }))).toBe(false);
    process.env.APP_URL = "not a url";
    expect(verifyOrigin(h({ origin: "https://app.example.com" }))).toBe(false);
  });

  it("accepts matching Origin", () => {
    expect(verifyOrigin(h({ origin: "https://app.example.com" }))).toBe(true);
  });

  it("rejects mismatched Origin", () => {
    expect(verifyOrigin(h({ origin: "https://evil.example.com" }))).toBe(false);
  });

  it("falls back to Referer when Origin is absent", () => {
    expect(verifyOrigin(h({ referer: "https://app.example.com/login" }))).toBe(true);
    expect(verifyOrigin(h({ referer: "https://evil.example.com/x" }))).toBe(false);
  });

  it("rejects when neither Origin nor Referer is present", () => {
    expect(verifyOrigin(h({}))).toBe(false);
  });
});
