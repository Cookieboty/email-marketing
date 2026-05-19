/**
 * Inbound 鉴权中间件：Bearer + HMAC + scope/IP/grace/限流/幂等。
 *
 * 关联 spec：specs/modules/inbound-connector.md
 *
 * 使用：
 *   export const POST = withApiClient(["user:write"], async (ctx, request) => { ... });
 *
 * ctx 提供：
 *   - apiClient: ApiClient 实例
 *   - body: 已 read 的原始请求体（HMAC 签名需要原文）
 *   - parsedBody: 解析后的 JSON（若 body 为空则为 null）
 *   - idempotencyKey?: string
 *   - replayResponse?: NextResponse  幂等重放（caller 直接 return 即可）
 *   - finalize: (response, status) => Promise<void>  写入 InboundRequestLog
 */

import { NextResponse } from "next/server";
import type { ApiClient } from "@prisma/client";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { handleApiError } from "@/lib/errors";
import { getRateLimiter } from "@/lib/rate-limit";
import { getClientIpFromHeaders } from "@/lib/api-helpers";
import {
  computeRequestSignature,
  decryptApiSecret,
  hashToken,
  isIpAllowed,
  timingSafeEqualHex,
} from "./crypto";
import { apiClientRepository, inboundRequestLogRepository } from "./repository";
import type { ApiClientScope } from "./schema";

const log = logger.child("inbound-auth");

export interface ApiClientContext {
  apiClient: ApiClient;
  ip: string;
  rawBody: string;
  parsedBody: unknown;
  idempotencyKey: string | null;
  /** 调用方在返回响应前应调用，用于写入幂等日志（非阻塞失败）。 */
  finalize: (status: number, body: unknown) => Promise<void>;
}

export type InboundHandler = (
  ctx: ApiClientContext,
  request: Request,
  ...rest: unknown[]
) => Promise<NextResponse>;

interface AuthFailure {
  status: number;
  body: { ok: false; error: string; code: string; details?: unknown };
}

function unauthorized(message: string, code = "unauthorized"): AuthFailure {
  return { status: 401, body: { ok: false, error: message, code } };
}

function forbidden(message: string, code = "forbidden"): AuthFailure {
  return { status: 403, body: { ok: false, error: message, code } };
}

function authFailureResponse(failure: AuthFailure): NextResponse {
  return NextResponse.json(failure.body, { status: failure.status });
}

function rateLimitResponse(retryAfterSec: number): NextResponse {
  const res = NextResponse.json(
    { ok: false, error: "Too many requests", code: "rate_limited" },
    { status: 429 },
  );
  res.headers.set("Retry-After", String(retryAfterSec));
  return res;
}

interface ParsedBearer {
  token: string;
}

function parseAuthorization(headers: Headers): ParsedBearer | AuthFailure | null {
  const auth = headers.get("authorization");
  if (!auth) return null;
  if (!auth.toLowerCase().startsWith("bearer ")) {
    return unauthorized("Authorization scheme must be Bearer", "invalid_auth_scheme");
  }
  const token = auth.slice("bearer ".length).trim();
  if (!token) return unauthorized("Empty bearer token", "invalid_token");
  return { token };
}

interface HmacInputs {
  signature: string;
  timestamp: string;
}

function parseHmacHeaders(headers: Headers): HmacInputs | null {
  const signature = headers.get("x-signature");
  const timestamp = headers.get("x-timestamp");
  if (!signature && !timestamp) return null;
  if (!signature || !timestamp) return null;
  return { signature, timestamp };
}

/**
 * 将请求体读为字符串（一次）。Next.js Request 仅可消费一次。
 */
async function readBody(request: Request): Promise<string> {
  if (request.method === "GET" || request.method === "HEAD") return "";
  try {
    return await request.text();
  } catch {
    return "";
  }
}

function getRequestPath(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    return "";
  }
}

function checkScopes(client: ApiClient, required: ApiClientScope[]): AuthFailure | null {
  if (required.length === 0) return null;
  const set = new Set(client.scopes);
  const missing = required.filter((s) => !set.has(s));
  if (missing.length > 0) {
    return forbidden(`Missing scope(s): ${missing.join(", ")}`, "scope_required");
  }
  return null;
}

function checkStatus(client: ApiClient): AuthFailure | null {
  if (client.status === "REVOKED") return unauthorized("Token revoked", "token_revoked");
  if (client.status === "DISABLED") return forbidden("ApiClient disabled", "client_disabled");
  return null;
}

function checkIp(client: ApiClient, ip: string): AuthFailure | null {
  if (!isIpAllowed(ip, client.ipWhitelist)) {
    return forbidden("IP not allowed", "ip_not_allowed");
  }
  return null;
}

function inboundRateLimiter(client: ApiClient): {
  decision: { allowed: boolean; retryAfterSec: number };
} {
  const e = env();
  const rps = client.rpsLimit ?? e.INBOUND_DEFAULT_RPS;
  const rph = client.rphLimit ?? e.INBOUND_DEFAULT_RPH;
  const rlSec = getRateLimiter(`inbound-rps:${client.id}`, {
    maxAttempts: rps,
    windowSec: 1,
    lockSec: 1,
  });
  const rlHour = getRateLimiter(`inbound-rph:${client.id}`, {
    maxAttempts: rph,
    windowSec: 3600,
    lockSec: 60,
  });
  const k = `client:${client.id}`;
  const d1 = rlSec.check(k);
  if (!d1.allowed) return { decision: { allowed: false, retryAfterSec: d1.retryAfterSec } };
  const d2 = rlHour.check(k);
  if (!d2.allowed) return { decision: { allowed: false, retryAfterSec: d2.retryAfterSec } };
  rlSec.recordFailure(k);
  rlHour.recordFailure(k);
  return { decision: { allowed: true, retryAfterSec: 0 } };
}

async function authenticate(
  request: Request,
  rawBody: string,
): Promise<
  | { ok: true; client: ApiClient; viaPrevious: boolean }
  | { ok: false; failure: AuthFailure }
> {
  const headers = request.headers;

  const bearer = parseAuthorization(headers);
  if (bearer && "status" in bearer) return { ok: false, failure: bearer };

  const hmac = parseHmacHeaders(headers);

  if (!bearer && !hmac) {
    return {
      ok: false,
      failure: unauthorized("Missing Authorization or HMAC headers", "auth_required"),
    };
  }

  if (!bearer) {
    return { ok: false, failure: unauthorized("Missing bearer token", "auth_required") };
  }

  const tokenHash = hashToken(bearer.token);
  const found = await apiClientRepository.findByActiveOrPreviousToken(tokenHash);
  if (!found) {
    return { ok: false, failure: unauthorized("Invalid token", "invalid_token") };
  }

  const client = found.client;
  const encryptedSecret = (client as ApiClient & { hmacSecretEncrypted?: string | null })
    .hmacSecretEncrypted;
  if (!encryptedSecret) {
    if (client.hmacSecretHash) {
      return {
        ok: false,
        failure: unauthorized("HMAC secret is not available", "hmac_misconfigured"),
      };
    }
    if (hmac) {
      return {
        ok: false,
        failure: forbidden("HMAC not enabled for this client", "hmac_not_enabled"),
      };
    }
    return { ok: true, client, viaPrevious: found.viaPrevious };
  }

  if (!hmac) {
    return { ok: false, failure: unauthorized("Missing HMAC headers", "hmac_required") };
  }

  if (!hmac.signature.startsWith("sha256=")) {
    return { ok: false, failure: unauthorized("Invalid signature scheme", "invalid_signature") };
  }
  const provided = hmac.signature.slice("sha256=".length);
  if (!/^[0-9a-fA-F]{64}$/.test(provided)) {
    return { ok: false, failure: unauthorized("Invalid signature", "invalid_signature") };
  }
  if (!/^\d+$/.test(hmac.timestamp)) {
    return { ok: false, failure: unauthorized("Invalid timestamp", "invalid_timestamp") };
  }
  const tsSec = Number(hmac.timestamp);
  if (!Number.isSafeInteger(tsSec)) {
    return { ok: false, failure: unauthorized("Invalid timestamp", "invalid_timestamp") };
  }
  const toleranceSec = env().INBOUND_TIMESTAMP_TOLERANCE_SEC;
  if (Math.abs(Math.floor(Date.now() / 1000) - tsSec) > toleranceSec) {
    return { ok: false, failure: unauthorized("Timestamp out of window", "timestamp_skew") };
  }

  const expected = computeRequestSignature(decryptApiSecret(encryptedSecret), {
    timestamp: hmac.timestamp,
    body: rawBody,
  });
  if (!timingSafeEqualHex(expected, provided)) {
    return { ok: false, failure: unauthorized("Invalid signature", "invalid_signature") };
  }
  return { ok: true, client, viaPrevious: found.viaPrevious };
}

function tryParseJson(raw: string): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function requiresIdempotency(method: string): boolean {
  return method === "POST" || method === "PUT";
}

function isUniqueConstraintError(err: unknown): boolean {
  return Boolean(
    err &&
    typeof err === "object" &&
    "code" in err &&
    (err as { code?: string }).code === "P2002",
  );
}

export function withApiClient(
  requiredScopes: ApiClientScope[],
  handler: InboundHandler,
): (request: Request, ...rest: unknown[]) => Promise<NextResponse> {
  return async (request: Request, ...rest: unknown[]) => {
    const rawBody = await readBody(request);
    try {
      const auth = await authenticate(request, rawBody);
      if (!auth.ok) return authFailureResponse(auth.failure);
      const client = auth.client;

      const statusFailure = checkStatus(client);
      if (statusFailure) return authFailureResponse(statusFailure);

      const ip = getClientIpFromHeaders(request.headers);
      const ipFailure = checkIp(client, ip);
      if (ipFailure) return authFailureResponse(ipFailure);

      const scopeFailure = checkScopes(client, requiredScopes);
      if (scopeFailure) return authFailureResponse(scopeFailure);

      const rl = inboundRateLimiter(client);
      if (!rl.decision.allowed) return rateLimitResponse(rl.decision.retryAfterSec);

      // 幂等：先查重放
      const idempotencyKey =
        request.headers.get("x-idempotency-key")?.trim() || null;
      if (requiresIdempotency(request.method) && !idempotencyKey) {
        return NextResponse.json(
          { ok: false, error: "X-Idempotency-Key is required", code: "validation_error" },
          { status: 400 },
        );
      }
      if (idempotencyKey && (idempotencyKey.length < 1 || idempotencyKey.length > 128)) {
        return NextResponse.json(
          { ok: false, error: "X-Idempotency-Key must be 1..128 chars", code: "validation_error" },
          { status: 400 },
        );
      }
      const ttlMs = env().INBOUND_REQUEST_LOG_TTL_DAYS * 24 * 3600 * 1000;
      if (idempotencyKey) {
        try {
          await inboundRequestLogRepository.create({
            apiClientId: client.id,
            idempotencyKey,
            endpoint: getRequestPath(request),
            method: request.method,
            responseStatus: 409,
            responseBody: {
              ok: false,
              error: "Request is still processing",
              code: "idempotency_in_progress",
            },
            expiresAt: new Date(Date.now() + ttlMs),
          });
        } catch (err) {
          if (!isUniqueConstraintError(err)) throw err;
          const replay = await inboundRequestLogRepository.findByKey(client.id, idempotencyKey);
          if (replay) {
            const res = NextResponse.json(replay.responseBody as object, {
              status: replay.responseStatus,
            });
            res.headers.set("X-Idempotent-Replay", "true");
            return res;
          }
          return NextResponse.json(
            { ok: false, error: "Duplicate idempotency key", code: "idempotency_conflict" },
            { status: 409 },
          );
        }
      }

      const parsedBody = tryParseJson(rawBody);
      if (parsedBody === undefined && rawBody.length > 0) {
        const body = { ok: false, error: "Invalid JSON body", code: "validation_error" };
        if (idempotencyKey) {
          await inboundRequestLogRepository.update(client.id, idempotencyKey, {
            responseStatus: 400,
            responseBody: body,
            expiresAt: new Date(Date.now() + ttlMs),
          });
        }
        return NextResponse.json(body, { status: 400 });
      }

      let finalized = false;
      const finalize = async (status: number, body: unknown): Promise<void> => {
        if (finalized || !idempotencyKey) return;
        finalized = true;
        try {
          await inboundRequestLogRepository.update(client.id, idempotencyKey, {
            responseStatus: status,
            responseBody: body as object,
            expiresAt: new Date(Date.now() + ttlMs),
          });
        } catch (err) {
          log.warn("idempotency log write failed", {
            apiClientId: client.id,
            idempotencyKey,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      };

      const ctx: ApiClientContext = {
        apiClient: client,
        ip,
        rawBody,
        parsedBody,
        idempotencyKey,
        finalize,
      };

      // 异步刷新 lastUsedAt
      apiClientRepository.touchLastUsedAt(client.id).catch(() => {});

      let response: NextResponse;
      try {
        response = await handler(ctx, request, ...rest);
      } catch (err) {
        response = handleApiError(err);
      }

      // 写入幂等日志（仅当 ctx.finalize 未被调用时由中间件兜底）
      if (idempotencyKey && !finalized) {
        try {
          const cloned = response.clone();
          const text = await cloned.text();
          const body = text ? JSON.parse(text) : null;
          await finalize(response.status, body);
        } catch (err) {
          log.warn("idempotency log auto-finalize failed", {
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return response;
    } catch (err) {
      return handleApiError(err);
    }
  };
}
