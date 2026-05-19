/**
 * 登录辅助：
 *  - verifyAdminToken：与 ADMIN_TOKEN 进行 timing-safe 比较
 *  - createSessionPayload：生成 32 字节随机 sessionId + iat/exp
 */

import { timingSafeEqualString, DEFAULT_SESSION_TTL_SECONDS, type SessionPayload } from "./session";

export function verifyAdminToken(input: string | null | undefined): boolean {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected || expected.length < 16) return false;
  if (typeof input !== "string" || input.length === 0) return false;
  return timingSafeEqualString(input, expected);
}

export function createSessionPayload(
  ttlSeconds: number = DEFAULT_SESSION_TTL_SECONDS,
  now: number = Math.floor(Date.now() / 1000),
): SessionPayload {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  let hex = "";
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i]!.toString(16).padStart(2, "0");
  }
  return { sessionId: hex, iat: now, exp: now + ttlSeconds };
}
