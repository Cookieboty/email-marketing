import { describe, expect, it } from "vitest";
import { RateLimiter, getClientIp } from "@/lib/auth/rate-limit";

const cfg = {
  maxAttempts: 3,
  windowSec: 60,
  lockSec: 30,
  backoffsMs: [0, 100, 500, 1000, 5000, 10000],
};

describe("auth/rate-limit", () => {
  it("allows when no record exists", () => {
    const rl = new RateLimiter(cfg);
    expect(rl.check("ip-a", 1_000)).toMatchObject({ allowed: true, attempt: 0, delayMs: 0 });
  });

  it("locks after maxAttempts and reports retryAfterSec", () => {
    const rl = new RateLimiter(cfg);
    const t0 = 1_000;
    rl.recordFailure("ip-a", t0);
    rl.recordFailure("ip-a", t0 + 10);
    const third = rl.recordFailure("ip-a", t0 + 20);
    expect(third.allowed).toBe(false);
    expect(third.attempt).toBe(3);
    expect(third.retryAfterSec).toBeGreaterThan(0);

    const stillLocked = rl.check("ip-a", t0 + 1_000);
    expect(stillLocked.allowed).toBe(false);

    // 解锁需越过 lockedUntil（最后一次 recordFailure 的时间 + lockSec）。
    const afterUnlock = rl.check("ip-a", t0 + 20 + cfg.lockSec * 1000 + 1);
    expect(afterUnlock.allowed).toBe(true);
  });

  it("returns escalating backoff delays", () => {
    const rl = new RateLimiter(cfg);
    const r1 = rl.recordFailure("ip-b", 0);
    const r2 = rl.recordFailure("ip-b", 1);
    expect(r2.delayMs).toBeGreaterThan(r1.delayMs);
  });

  it("expires the window and starts fresh", () => {
    const rl = new RateLimiter(cfg);
    rl.recordFailure("ip-c", 0);
    rl.recordFailure("ip-c", 1);
    const fresh = rl.check("ip-c", cfg.windowSec * 1000 + 100);
    expect(fresh.allowed).toBe(true);
    expect(fresh.attempt).toBe(0);
  });

  it("reset() clears a key", () => {
    const rl = new RateLimiter(cfg);
    rl.recordFailure("ip-d", 0);
    rl.reset("ip-d");
    expect(rl.check("ip-d", 100).attempt).toBe(0);
  });

  it("getClientIp prefers x-forwarded-for, then x-real-ip", () => {
    const h1 = new Headers({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" });
    expect(getClientIp(h1)).toBe("1.2.3.4");
    const h2 = new Headers({ "x-real-ip": "10.0.0.1" });
    expect(getClientIp(h2)).toBe("10.0.0.1");
    expect(getClientIp(new Headers())).toBe("unknown");
  });
});
