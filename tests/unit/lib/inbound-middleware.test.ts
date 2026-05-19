import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { computeRequestSignature, encryptApiSecret, hashToken } from "@/lib/modules/api-client/crypto";
import type { ApiClient } from "@prisma/client";

const findByActiveOrPreviousToken = vi.fn();
const findByKey = vi.fn();
const createLog = vi.fn();
const updateLog = vi.fn();
const touchLastUsedAt = vi.fn();

vi.mock("@/lib/modules/api-client/repository", () => ({
  apiClientRepository: {
    findByActiveOrPreviousToken,
    touchLastUsedAt,
  },
  inboundRequestLogRepository: {
    findByKey,
    create: createLog,
    update: updateLog,
  },
}));

vi.mock("@/lib/rate-limit", () => ({
  getRateLimiter: () => ({
    check: () => ({ allowed: true, retryAfterSec: 0 }),
    recordFailure: vi.fn(),
  }),
}));

function client(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    id: "client_1",
    name: "CRM",
    description: null,
    status: "ACTIVE",
    tokenHash: hashToken("raw-token"),
    tokenPrefix: "raw-toke",
    hmacSecretHash: null,
    hmacSecretEncrypted: null,
    previousTokenHash: null,
    previousTokenExpiresAt: null,
    scopes: ["user:write"],
    ipWhitelist: [],
    rpsLimit: null,
    rphLimit: null,
    metadata: null,
    lastUsedAt: null,
    createdBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as ApiClient;
}

describe("withApiClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef";
    findByActiveOrPreviousToken.mockResolvedValue({ client: client(), viaPrevious: false });
    findByKey.mockResolvedValue(null);
    createLog.mockResolvedValue({ id: "log_1" });
    updateLog.mockResolvedValue({ id: "log_1" });
    touchLastUsedAt.mockResolvedValue(undefined);
  });

  it("POST 缺少 X-Idempotency-Key 时拒绝执行 handler", async () => {
    const { withApiClient } = await import("@/lib/modules/api-client/middleware");
    const handler = vi.fn(async () => NextResponse.json({ ok: true }));
    const route = withApiClient(["user:write"], handler);

    const res = await route(new Request("https://app.test/api/inbound/users", {
      method: "POST",
      headers: { authorization: "Bearer raw-token" },
      body: "{}",
    }));

    expect(res.status).toBe(400);
    expect(handler).not.toHaveBeenCalled();
  });

  it("HMAC client 必须提供有效签名，错误签名不能用 Bearer 绕过", async () => {
    const hmacSecretEncrypted = encryptApiSecret("hmac-secret");
    findByActiveOrPreviousToken.mockResolvedValue({
      client: client({ hmacSecretEncrypted, hmacSecretHash: hashToken("hmac-secret") }),
      viaPrevious: false,
    });
    const { withApiClient } = await import("@/lib/modules/api-client/middleware");
    const handler = vi.fn(async () => NextResponse.json({ ok: true }));
    const route = withApiClient(["user:write"], handler);

    const res = await route(new Request("https://app.test/api/inbound/users", {
      method: "POST",
      headers: {
        authorization: "Bearer raw-token",
        "x-idempotency-key": "idem-1",
        "x-timestamp": String(Math.floor(Date.now() / 1000)),
        "x-signature": "sha256=deadbeef",
      },
      body: "{}",
    }));

    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("HMAC 签名必须带 sha256 前缀且 timestamp 必须是整数秒", async () => {
    const rawBody = "{}";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const hmacSecretEncrypted = encryptApiSecret("hmac-secret");
    findByActiveOrPreviousToken.mockResolvedValue({
      client: client({ hmacSecretEncrypted, hmacSecretHash: hashToken("hmac-secret") }),
      viaPrevious: false,
    });
    const { withApiClient } = await import("@/lib/modules/api-client/middleware");
    const handler = vi.fn(async () => NextResponse.json({ ok: true }));
    const route = withApiClient(["user:write"], handler);

    const noPrefix = await route(new Request("https://app.test/api/inbound/users", {
      method: "POST",
      headers: {
        authorization: "Bearer raw-token",
        "x-idempotency-key": "idem-1",
        "x-timestamp": timestamp,
        "x-signature": computeRequestSignature("hmac-secret", { timestamp, body: rawBody }),
      },
      body: rawBody,
    }));
    const fractionalTimestamp = await route(new Request("https://app.test/api/inbound/users", {
      method: "POST",
      headers: {
        authorization: "Bearer raw-token",
        "x-idempotency-key": "idem-2",
        "x-timestamp": `${timestamp}.1`,
        "x-signature": `sha256=${computeRequestSignature("hmac-secret", {
          timestamp: `${timestamp}.1`,
          body: rawBody,
        })}`,
      },
      body: rawBody,
    }));

    expect(noPrefix.status).toBe(401);
    expect(fractionalTimestamp.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("HMAC hash 存在但 encrypted secret 缺失时不允许 Bearer-only 降级", async () => {
    findByActiveOrPreviousToken.mockResolvedValue({
      client: client({ hmacSecretHash: hashToken("hmac-secret"), hmacSecretEncrypted: null }),
      viaPrevious: false,
    });
    const { withApiClient } = await import("@/lib/modules/api-client/middleware");
    const handler = vi.fn(async () => NextResponse.json({ ok: true }));
    const route = withApiClient(["user:write"], handler);

    const res = await route(new Request("https://app.test/api/inbound/users", {
      method: "POST",
      headers: {
        authorization: "Bearer raw-token",
        "x-idempotency-key": "idem-1",
      },
      body: "{}",
    }));

    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("有效 HMAC 签名执行 handler 并完成幂等日志", async () => {
    const rawBody = '{"email":"a@example.com"}';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const hmacSecretEncrypted = encryptApiSecret("hmac-secret");
    findByActiveOrPreviousToken.mockResolvedValue({
      client: client({ hmacSecretEncrypted, hmacSecretHash: hashToken("hmac-secret") }),
      viaPrevious: false,
    });
    const { withApiClient } = await import("@/lib/modules/api-client/middleware");
    const route = withApiClient(["user:write"], async () => NextResponse.json({ ok: true }));

    const res = await route(new Request("https://app.test/api/inbound/users", {
      method: "POST",
      headers: {
        authorization: "Bearer raw-token",
        "x-idempotency-key": "idem-1",
        "x-timestamp": timestamp,
        "x-signature": `sha256=${computeRequestSignature("hmac-secret", { timestamp, body: rawBody })}`,
      },
      body: rawBody,
    }));

    expect(res.status).toBe(200);
    expect(createLog).toHaveBeenCalledWith(expect.objectContaining({
      apiClientId: "client_1",
      idempotencyKey: "idem-1",
      responseStatus: 409,
    }));
    expect(updateLog).toHaveBeenCalledWith("client_1", "idem-1", expect.objectContaining({
      responseStatus: 200,
      responseBody: { ok: true },
    }));
  });

  it("claim 后 JSON 非法时保存 400 历史响应", async () => {
    const { withApiClient } = await import("@/lib/modules/api-client/middleware");
    const handler = vi.fn(async () => NextResponse.json({ ok: true }));
    const route = withApiClient(["user:write"], handler);

    const res = await route(new Request("https://app.test/api/inbound/users", {
      method: "POST",
      headers: {
        authorization: "Bearer raw-token",
        "x-idempotency-key": "idem-invalid-json",
      },
      body: "{",
    }));

    expect(res.status).toBe(400);
    expect(handler).not.toHaveBeenCalled();
    expect(updateLog).toHaveBeenCalledWith("client_1", "idem-invalid-json", expect.objectContaining({
      responseStatus: 400,
      responseBody: { ok: false, error: "Invalid JSON body", code: "validation_error" },
    }));
  });
});
