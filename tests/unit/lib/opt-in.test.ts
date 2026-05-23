/**
 * Double Opt-in 业务单元测试（specs/modules/user-management.md §438-496, phase-4 §4.2）。
 *
 * Mock 策略：
 *   - prisma.user.{findUnique, update}  → vi.fn
 *   - audit / sendSingle / env / rate-limit 注册表均隔离
 *
 * 覆盖：
 *   1. generateOptInToken 输出 URL-safe / 长度 ≥ 40
 *   2. isOptInExpired 边界（null / 47.9h / 48.1h）
 *   3. confirmOptInByToken：not_found / already_confirmed / expired / confirmed
 *   4. resendOptInEmail：DOUBLE_OPT_IN_ENABLED=false → ConflictError
 *                       NOT_REQUIRED → ConflictError
 *                       CONFIRMED → ConflictError
 *                       超过 maxAttempts → RateLimitError
 *   5. sendOptInEmail：写回 optInToken/sentAt/PENDING + 调用 sendSingle
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const envState = {
    DOUBLE_OPT_IN_ENABLED: true,
    EMAIL_FROM: "no-reply@example.com",
    APP_URL: "https://example.com",
    RATE_LIMIT_TEST_SEND_MAX: 3,
    RATE_LIMIT_TEST_SEND_WINDOW_SEC: 3600,
  };
  return {
    auditMock: vi.fn(),
    sendSingleMock: vi.fn(),
    findUniqueMock: vi.fn(),
    updateMock: vi.fn(),
    envState,
  };
});

vi.mock("@/lib/audit", () => ({
  audit: hoisted.auditMock,
  auditNow: vi.fn(async () => { }),
  maskDetails: (x: unknown) => x,
}));

vi.mock("@/lib/env", () => ({
  env: () => hoisted.envState,
}));

vi.mock("@/lib/modules/mail/transport", () => ({
  sendSingle: (...args: unknown[]) => hoisted.sendSingleMock(...args),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: (...args: unknown[]) => hoisted.findUniqueMock(...args),
      update: (...args: unknown[]) => hoisted.updateMock(...args),
    },
  },
}));

import { OptInStatus } from "@prisma/client";
import {
  __resetOptInResendLimiter,
  buildConfirmUrl,
  confirmOptInByToken,
  generateOptInToken,
  isOptInExpired,
  OPT_IN_TOKEN_TTL_MS,
  resendOptInEmail,
  sendOptInEmail,
} from "@/lib/modules/user/opt-in";
import { ConflictError, NotFoundError, RateLimitError, ValidationError } from "@/lib/errors";

const { auditMock, sendSingleMock, findUniqueMock, updateMock, envState } = hoisted;

beforeEach(() => {
  hoisted.envState.DOUBLE_OPT_IN_ENABLED = true;
  hoisted.envState.EMAIL_FROM = "no-reply@example.com";
  hoisted.envState.APP_URL = "https://example.com";
  hoisted.envState.RATE_LIMIT_TEST_SEND_MAX = 3;
  hoisted.envState.RATE_LIMIT_TEST_SEND_WINDOW_SEC = 3600;
  hoisted.auditMock.mockReset();
  hoisted.sendSingleMock.mockReset();
  hoisted.findUniqueMock.mockReset();
  hoisted.updateMock.mockReset();
  __resetOptInResendLimiter();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("generateOptInToken", () => {
  it("returns URL-safe base64 (no '+' '/' '=' chars), length ~43", () => {
    const t = generateOptInToken();
    expect(t.length).toBeGreaterThanOrEqual(40);
    expect(t).not.toContain("+");
    expect(t).not.toContain("/");
    expect(t).not.toContain("=");
  });

  it("produces unique tokens across calls", () => {
    const a = generateOptInToken();
    const b = generateOptInToken();
    expect(a).not.toBe(b);
  });
});

describe("isOptInExpired", () => {
  it("returns false for null sentAt", () => {
    expect(isOptInExpired(null)).toBe(false);
  });

  it("returns false within 48h", () => {
    const sent = new Date(Date.now() - (OPT_IN_TOKEN_TTL_MS - 60_000));
    expect(isOptInExpired(sent, new Date())).toBe(false);
  });

  it("returns true after 48h", () => {
    const sent = new Date(Date.now() - (OPT_IN_TOKEN_TTL_MS + 60_000));
    expect(isOptInExpired(sent, new Date())).toBe(true);
  });
});

describe("buildConfirmUrl", () => {
  it("appends url-encoded token to APP_URL", () => {
    const url = buildConfirmUrl("ab/cd+ef=");
    expect(url).toBe("https://example.com/api/confirm?token=ab%2Fcd%2Bef%3D");
  });

  it("throws when APP_URL missing", () => {
    envState.APP_URL = "" as unknown as string;
    expect(() => buildConfirmUrl("x")).toThrow(ValidationError);
  });
});

describe("confirmOptInByToken", () => {
  it("returns not_found when no user matches token", async () => {
    findUniqueMock.mockResolvedValueOnce(null);
    const r = await confirmOptInByToken("nonexistent");
    expect(r.status).toBe("not_found");
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("returns already_confirmed when user is CONFIRMED (idempotent)", async () => {
    const user = {
      id: "u1",
      email: "a@b.com",
      optInStatus: OptInStatus.CONFIRMED,
      optInSentAt: new Date(),
    };
    findUniqueMock.mockResolvedValueOnce(user);
    const r = await confirmOptInByToken("tk");
    expect(r.status).toBe("already_confirmed");
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("returns expired and writes EXPIRED + clears token when sentAt > 48h", async () => {
    const sent = new Date(Date.now() - (OPT_IN_TOKEN_TTL_MS + 60_000));
    findUniqueMock.mockResolvedValueOnce({
      id: "u1",
      email: "a@b.com",
      optInStatus: OptInStatus.PENDING,
      optInSentAt: sent,
    });
    updateMock.mockResolvedValueOnce({});
    const r = await confirmOptInByToken("tk");
    expect(r.status).toBe("expired");
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: { optInStatus: OptInStatus.EXPIRED, optInToken: null },
    });
  });

  it("returns confirmed and writes CONFIRMED + clears token", async () => {
    const sent = new Date(Date.now() - 60_000);
    findUniqueMock.mockResolvedValueOnce({
      id: "u1",
      email: "a@b.com",
      optInStatus: OptInStatus.PENDING,
      optInSentAt: sent,
    });
    updateMock.mockResolvedValueOnce({
      id: "u1",
      email: "a@b.com",
      optInStatus: OptInStatus.CONFIRMED,
      optInToken: null,
    });
    const r = await confirmOptInByToken("tk");
    expect(r.status).toBe("confirmed");
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: { optInStatus: OptInStatus.CONFIRMED, optInToken: null },
    });
  });

  it("throws ValidationError on empty token", async () => {
    await expect(confirmOptInByToken("")).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("sendOptInEmail", () => {
  it("writes token+sentAt+PENDING then calls sendSingle and returns ok", async () => {
    updateMock.mockResolvedValueOnce({ id: "u1", email: "a@b.com" });
    sendSingleMock.mockResolvedValueOnce({ ok: true, id: "msg-1" });
    const r = await sendOptInEmail("u1");
    expect(r.ok).toBe(true);
    expect(r.messageId).toBe("msg-1");
    expect(updateMock).toHaveBeenCalledTimes(1);
    const updArgs = updateMock.mock.calls[0]![0];
    expect(updArgs.where).toEqual({ id: "u1" });
    expect(updArgs.data.optInStatus).toBe(OptInStatus.PENDING);
    expect(typeof updArgs.data.optInToken).toBe("string");
    expect(updArgs.data.optInSentAt).toBeInstanceOf(Date);
    const sendArgs = sendSingleMock.mock.calls[0]![0];
    expect(sendArgs.to).toBe("a@b.com");
    expect(sendArgs.from).toBe("no-reply@example.com");
    expect(sendArgs.subject).toBe("请确认您的订阅");
    expect(sendArgs.html).toContain("a@b.com");
    expect(sendArgs.html).toContain("https://example.com/api/confirm?token=");
  });

  it("returns ok=false when sendSingle reports failure", async () => {
    updateMock.mockResolvedValueOnce({ id: "u1", email: "a@b.com" });
    sendSingleMock.mockResolvedValueOnce({ ok: false, error: "boom" });
    const r = await sendOptInEmail("u1");
    expect(r.ok).toBe(false);
    expect(r.error).toBe("boom");
  });

  it("throws ValidationError if EMAIL_FROM missing", async () => {
    envState.EMAIL_FROM = "" as unknown as string;
    await expect(sendOptInEmail("u1")).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("resendOptInEmail", () => {
  it("throws ConflictError when DOUBLE_OPT_IN_ENABLED=false", async () => {
    envState.DOUBLE_OPT_IN_ENABLED = false;
    await expect(resendOptInEmail("u1")).rejects.toBeInstanceOf(ConflictError);
  });

  it("throws NotFoundError when user does not exist", async () => {
    findUniqueMock.mockResolvedValueOnce(null);
    await expect(resendOptInEmail("u1")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws ConflictError when status NOT_REQUIRED", async () => {
    findUniqueMock.mockResolvedValueOnce({
      id: "u1",
      email: "a@b.com",
      optInStatus: OptInStatus.NOT_REQUIRED,
    });
    await expect(resendOptInEmail("u1")).rejects.toBeInstanceOf(ConflictError);
  });

  it("throws ConflictError when status CONFIRMED", async () => {
    findUniqueMock.mockResolvedValueOnce({
      id: "u1",
      email: "a@b.com",
      optInStatus: OptInStatus.CONFIRMED,
    });
    await expect(resendOptInEmail("u1")).rejects.toBeInstanceOf(ConflictError);
  });

  it("rate-limits after RATE_LIMIT_TEST_SEND_MAX consecutive resends", async () => {
    const baseUser = {
      id: "u1",
      email: "a@b.com",
      optInStatus: OptInStatus.PENDING,
    };
    // 每次 resend 都触发：1) findUnique 取用户 + 2) sendOptInEmail 内部 update
    findUniqueMock.mockResolvedValue(baseUser);
    updateMock.mockResolvedValue({ id: "u1", email: "a@b.com" });
    sendSingleMock.mockResolvedValue({ ok: true, id: "m" });

    for (let i = 0; i < envState.RATE_LIMIT_TEST_SEND_MAX - 1; i++) {
      const r = await resendOptInEmail("u1");
      expect(r.ok).toBe(true);
    }
    // 第 N 次后命中 lock；第 N+1 次将抛 RateLimitError
    await resendOptInEmail("u1"); // attempt = max → 锁定
    await expect(resendOptInEmail("u1")).rejects.toBeInstanceOf(RateLimitError);
  });
});
