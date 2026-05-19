/**
 * 登录限流：进程内 Map + 滑动窗口 + 指数退避延迟。
 *
 * 维度：以请求 key（默认 IP）为粒度，专门用于 /api/auth/login。
 *
 * 算法：
 *   1. 每次失败 attempt 自增；命中阈值后 lockedUntil = now + LOCK_MS
 *   2. 即使未达阈值，每次 check 仍会按当前 attempt 数返回一个 delayMs
 *      （指数退避：100/500/1000/5000/10000 ms，封顶 10s），
 *      由 caller 在响应前 await sleep(delayMs)，对 brute-force 形成节流。
 *   3. 成功登录后 reset 该 key。
 *   4. WINDOW_SEC 内无活动则记录被惰性清理。
 *
 * 部署边界（specs §1011）：单实例方案；多实例需替换为 Redis 或表存储。
 */

export interface RateLimitConfig {
  maxAttempts: number;
  windowSec: number;
  lockSec: number;
  backoffsMs: number[];
}

export interface RateLimitDecision {
  allowed: boolean;
  attempt: number;
  delayMs: number;
  retryAfterSec: number;
}

interface Bucket {
  attempt: number;
  firstAttemptAt: number;
  lockedUntil: number;
}

const DEFAULT_BACKOFFS_MS = [0, 100, 500, 1000, 5000, 10000];

export function loadLoginRateLimitConfig(): RateLimitConfig {
  const max = Number(process.env.RATE_LIMIT_LOGIN_MAX ?? 5);
  const window = Number(process.env.RATE_LIMIT_LOGIN_WINDOW_SEC ?? 900);
  return {
    maxAttempts: Number.isFinite(max) && max > 0 ? max : 5,
    windowSec: Number.isFinite(window) && window > 0 ? window : 900,
    lockSec: 300,
    backoffsMs: DEFAULT_BACKOFFS_MS,
  };
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  constructor(private readonly cfg: RateLimitConfig) {}

  /** 检查 key 当前是否被允许；不修改计数。 */
  check(key: string, now: number = Date.now()): RateLimitDecision {
    const b = this.buckets.get(key);
    if (!b) return { allowed: true, attempt: 0, delayMs: 0, retryAfterSec: 0 };
    if (b.lockedUntil > now) {
      return {
        allowed: false,
        attempt: b.attempt,
        delayMs: 0,
        retryAfterSec: Math.ceil((b.lockedUntil - now) / 1000),
      };
    }
    if (now - b.firstAttemptAt > this.cfg.windowSec * 1000) {
      this.buckets.delete(key);
      return { allowed: true, attempt: 0, delayMs: 0, retryAfterSec: 0 };
    }
    return {
      allowed: true,
      attempt: b.attempt,
      delayMs: this.backoffFor(b.attempt),
      retryAfterSec: 0,
    };
  }

  /** 记录一次失败；如果命中阈值则锁定。返回更新后的决策（含 delayMs）。 */
  recordFailure(key: string, now: number = Date.now()): RateLimitDecision {
    let b = this.buckets.get(key);
    if (!b || now - b.firstAttemptAt > this.cfg.windowSec * 1000) {
      b = { attempt: 0, firstAttemptAt: now, lockedUntil: 0 };
    }
    b.attempt += 1;
    if (b.attempt >= this.cfg.maxAttempts) {
      b.lockedUntil = now + this.cfg.lockSec * 1000;
    }
    this.buckets.set(key, b);
    return {
      allowed: b.lockedUntil <= now,
      attempt: b.attempt,
      delayMs: this.backoffFor(b.attempt),
      retryAfterSec:
        b.lockedUntil > now ? Math.ceil((b.lockedUntil - now) / 1000) : 0,
    };
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }

  /** 测试用：完全清空。 */
  clear(): void {
    this.buckets.clear();
  }

  private backoffFor(attempt: number): number {
    const idx = Math.min(attempt, this.cfg.backoffsMs.length - 1);
    return this.cfg.backoffsMs[idx] ?? 0;
  }
}

/**
 * 进程级单例：仅供 /api/auth/login 使用。
 * 测试中可通过 `loginRateLimiter.clear()` 重置状态。
 */
export const loginRateLimiter = new RateLimiter(loadLoginRateLimitConfig());

export function getClientIp(headers: Headers): string {
  const xff = headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  const real = headers.get("x-real-ip");
  if (real) return real.trim();
  return "unknown";
}
