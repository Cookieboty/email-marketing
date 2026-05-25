/**
 * 自实现的 HMAC-SHA256 签名 cookie session。
 *
 * 设计要点（与 specs §293-358 对齐）：
 * 1. 完全使用 Web Crypto API（globalThis.crypto.subtle），兼容 Next.js 15 middleware Edge Runtime
 * 2. payload 使用 base64url（无填充），避免 cookie 中出现需要转义的字符
 * 3. 比较时使用 timing-safe（逐字节异或后聚合），防止短路型时序攻击
 * 4. 过期判定用 numeric `exp`（Unix 秒），便于 JSON 序列化
 * 5. SESSION_SECRET 缺失时直接抛错，避免回退到弱密钥
 */

export const SESSION_COOKIE_NAME = "ems_session";
export const DEFAULT_SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

export interface SessionPayload {
  sessionId: string;
  iat: number;
  exp: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function getSecret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) {
    throw new Error(
      "SESSION_SECRET is not configured (>=16 chars required); refusing to sign sessions",
    );
  }
  return s;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]!);
  const b64 = typeof btoa === "function" ? btoa(bin) : Buffer.from(bin, "binary").toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((input.length + 3) % 4);
  const bin =
    typeof atob === "function" ? atob(padded) : Buffer.from(padded, "base64").toString("binary");
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

async function importKey(secret: string): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await importKey(secret);
  const sig = await globalThis.crypto.subtle.sign("HMAC", key, enc.encode(data));
  return new Uint8Array(sig);
}

/**
 * timing-safe equal：长度不等先归一化（仍走完所有字节再返回 false），
 * 然后逐字节异或聚合，避免短路对比泄漏前缀长度。
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < len; i += 1) {
    const av = i < a.length ? a[i]! : 0;
    const bv = i < b.length ? b[i]! : 0;
    diff |= av ^ bv;
  }
  return diff === 0;
}

export function timingSafeEqualString(a: string, b: string): boolean {
  return timingSafeEqual(enc.encode(a), enc.encode(b));
}

export async function signSession(
  payload: SessionPayload,
  secret: string = getSecret(),
): Promise<string> {
  const json = JSON.stringify(payload);
  const body = base64UrlEncode(enc.encode(json));
  const sigBytes = await hmac(secret, body);
  const sig = base64UrlEncode(sigBytes);
  return `${body}.${sig}`;
}

export async function verifySession(
  cookieValue: string,
  options: { now?: number; secret?: string } = {},
): Promise<SessionPayload | null> {
  const secret = options.secret ?? getSecret();
  const now = options.now ?? Math.floor(Date.now() / 1000);

  const dot = cookieValue.indexOf(".");
  if (dot <= 0 || dot === cookieValue.length - 1) return null;
  const body = cookieValue.slice(0, dot);
  const sig = cookieValue.slice(dot + 1);

  let providedSig: Uint8Array;
  try {
    providedSig = base64UrlDecode(sig);
  } catch {
    return null;
  }

  let expectedSig: Uint8Array;
  try {
    expectedSig = await hmac(secret, body);
  } catch {
    return null;
  }
  if (!timingSafeEqual(providedSig, expectedSig)) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(dec.decode(base64UrlDecode(body))) as SessionPayload;
  } catch {
    return null;
  }
  if (
    typeof payload?.sessionId !== "string" ||
    typeof payload?.iat !== "number" ||
    typeof payload?.exp !== "number"
  ) {
    return null;
  }
  if (payload.exp <= now) return null;
  return payload;
}

export function buildSessionCookie(value: string, ttlSeconds: number): string {
  const attrs = [
    `${SESSION_COOKIE_NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${ttlSeconds}`,
  ];
  if (process.env.NODE_ENV === "production") attrs.push("Secure");
  return attrs.join("; ");
}

export function buildClearedSessionCookie(): string {
  const attrs = [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (process.env.NODE_ENV === "production") attrs.push("Secure");
  return attrs.join("; ");
}
