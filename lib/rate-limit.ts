/**
 * 通用 IP 限流封装：底层复用 lib/auth/rate-limit.ts 的 RateLimiter，
 * 但提供命名空间化的工厂，避免不同业务（webhook / unsubscribe / event）
 * 共享同一个内存 Map 而互相干扰。
 */

import {
  RateLimiter,
  type RateLimitConfig,
  type RateLimitDecision,
  getClientIp,
} from "./auth/rate-limit";

const DEFAULT_BACKOFFS_MS = [0, 100, 500, 1000, 5000, 10000];

const registry = new Map<string, RateLimiter>();

export interface NamedRateLimiterOptions {
  maxAttempts: number;
  windowSec: number;
  lockSec?: number;
  backoffsMs?: number[];
}

export function getRateLimiter(name: string, opts: NamedRateLimiterOptions): RateLimiter {
  const existing = registry.get(name);
  if (existing) return existing;
  const cfg: RateLimitConfig = {
    maxAttempts: opts.maxAttempts,
    windowSec: opts.windowSec,
    lockSec: opts.lockSec ?? 60,
    backoffsMs: opts.backoffsMs ?? DEFAULT_BACKOFFS_MS,
  };
  const rl = new RateLimiter(cfg);
  registry.set(name, rl);
  return rl;
}

/** 测试用：清空所有命名限流器。 */
export function __resetRateLimiters(): void {
  for (const rl of registry.values()) rl.clear();
  registry.clear();
}

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
if (process.env.NODE_ENV !== "test" && !process.env.VITEST) {
  setInterval(() => {
    for (const rl of registry.values()) rl.sweep();
  }, SWEEP_INTERVAL_MS).unref?.();
}

export type { RateLimiter, RateLimitConfig, RateLimitDecision };
export { getClientIp };
