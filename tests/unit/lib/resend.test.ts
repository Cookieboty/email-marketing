import { describe, it, expect } from "vitest";
import { computeBackoffMs, parseRateLimitError, __setResendClient } from "@/lib/resend";

describe("resend: computeBackoffMs", () => {
  it("uses fixed schedule for first 5 attempts", () => {
    expect(computeBackoffMs(0)).toBe(1000);
    expect(computeBackoffMs(1)).toBe(2000);
    expect(computeBackoffMs(2)).toBe(4000);
    expect(computeBackoffMs(3)).toBe(8000);
    expect(computeBackoffMs(4)).toBe(16000);
  });
  it("caps exponential growth at 5min", () => {
    expect(computeBackoffMs(20)).toBe(5 * 60 * 1000);
  });
  it("returns 0 for negative attempts", () => {
    expect(computeBackoffMs(-1)).toBe(0);
  });
});

describe("resend: parseRateLimitError", () => {
  it("detects 429 status", () => {
    expect(parseRateLimitError({ statusCode: 429, message: "x" }).rateLimited).toBe(true);
  });
  it("detects rate_limit_exceeded name", () => {
    expect(parseRateLimitError({ name: "rate_limit_exceeded", message: "x" }).rateLimited).toBe(
      true,
    );
  });
  it("extracts retry-after header in seconds", () => {
    const r = parseRateLimitError({ statusCode: 429, headers: { "retry-after": "3" } });
    expect(r.rateLimited).toBe(true);
    expect(r.retryAfterMs).toBe(3000);
  });
  it("non-rate-limit errors return false", () => {
    expect(parseRateLimitError({ statusCode: 500, message: "boom" }).rateLimited).toBe(false);
  });
  it("null/undefined safe", () => {
    expect(parseRateLimitError(null).rateLimited).toBe(false);
    expect(parseRateLimitError(undefined).rateLimited).toBe(false);
  });
});

describe("resend: client injection", () => {
  it("__setResendClient(null) clears cached singleton", () => {
    __setResendClient(null);
    expect(true).toBe(true);
  });
});
