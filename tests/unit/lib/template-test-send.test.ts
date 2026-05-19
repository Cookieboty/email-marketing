/**
 * 模板 test-send：白名单与限流测试。
 *
 * 不接 DB（用 fake template 对象）、不接真实 Resend（mock @/lib/resend）。
 * 关注：
 *   - ADMIN_TEST_EMAILS 未配置 → 拒绝
 *   - 收件人不在白名单 → 拒绝
 *   - 命中白名单 + EMAIL_FROM 已配置 → 调用 sendSingle 并 audit
 *   - 同一 admin 触发多次 → 越过 RATE_LIMIT_TEST_SEND_MAX 后抛 RateLimitError
 *
 * 注意：
 *   - 必须在 import test-send 模块之前 vi.mock，否则 sendSingle 不会被替换。
 *   - audit 用 fire-and-forget，不影响测试可读性，但需要 mock 避免触发真实 prisma。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/resend", () => ({
  sendSingle: vi.fn(),
}));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(),
  auditNow: vi.fn(async () => {}),
  maskDetails: (x: unknown) => x,
}));

import { sendSingle } from "@/lib/resend";
import {
  __resetTestSendLimiter,
  getAdminTestWhitelist,
  testSendTemplate,
} from "@/lib/modules/template/test-send";
import { __resetEnvCache } from "@/lib/env";
import { ForbiddenError, RateLimitError, ValidationError } from "@/lib/errors";

const FAKE_TEMPLATE = {
  id: "tpl_1",
  name: "Welcome",
  subject: "Hi {{user_name}}",
  htmlContent: "<p>Hello {{user_name}}</p>",
  textContent: null,
  variables: ["user_name"],
  version: 1,
  isArchived: false,
  createdAt: new Date(),
  updatedAt: new Date(),
} as never;

function setEnv(extra: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
    else process.env[k] = v;
  }
  __resetEnvCache();
}

describe("test-send: whitelist", () => {
  beforeEach(() => {
    setEnv({
      ADMIN_TEST_EMAILS: "qa@example.com, dev@example.com",
      EMAIL_FROM: "noreply@example.com",
      RATE_LIMIT_TEST_SEND_MAX: "5",
      RATE_LIMIT_TEST_SEND_WINDOW_SEC: "3600",
    });
    __resetTestSendLimiter();
    vi.mocked(sendSingle).mockReset();
    vi.mocked(sendSingle).mockResolvedValue({ ok: true, id: "msg_1" });
  });
  afterEach(() => {
    setEnv({ ADMIN_TEST_EMAILS: undefined, EMAIL_FROM: undefined });
  });

  it("parses ADMIN_TEST_EMAILS into a normalized Set", () => {
    const wl = getAdminTestWhitelist();
    expect(wl.has("qa@example.com")).toBe(true);
    expect(wl.has("DEV@Example.COM".toLowerCase())).toBe(true);
    expect(wl.size).toBe(2);
  });

  it("throws ForbiddenError when ADMIN_TEST_EMAILS is empty", async () => {
    setEnv({ ADMIN_TEST_EMAILS: "" });
    await expect(
      testSendTemplate({ adminId: "a1", to: "qa@example.com", template: FAKE_TEMPLATE }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("rejects recipients outside the whitelist", async () => {
    await expect(
      testSendTemplate({ adminId: "a1", to: "stranger@x.com", template: FAKE_TEMPLATE }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(sendSingle).not.toHaveBeenCalled();
  });

  it("requires EMAIL_FROM to be configured", async () => {
    setEnv({ EMAIL_FROM: undefined });
    await expect(
      testSendTemplate({ adminId: "a1", to: "qa@example.com", template: FAKE_TEMPLATE }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("invokes sendSingle with [TEST] subject prefix when whitelisted", async () => {
    const r = await testSendTemplate({
      adminId: "a1",
      to: "qa@example.com",
      template: FAKE_TEMPLATE,
    });
    expect(r.ok).toBe(true);
    expect(sendSingle).toHaveBeenCalledTimes(1);
    const call = vi.mocked(sendSingle).mock.calls[0]![0];
    expect(call.from).toBe("noreply@example.com");
    expect(call.to).toBe("qa@example.com");
    expect(call.subject.startsWith("[TEST] ")).toBe(true);
    expect(call.headers?.["X-Email-Test-Send"]).toBe("1");
  });
});

describe("test-send: rate limit per admin", () => {
  beforeEach(() => {
    setEnv({
      ADMIN_TEST_EMAILS: "qa@example.com",
      EMAIL_FROM: "noreply@example.com",
      RATE_LIMIT_TEST_SEND_MAX: "2",
      RATE_LIMIT_TEST_SEND_WINDOW_SEC: "3600",
    });
    __resetTestSendLimiter();
    vi.mocked(sendSingle).mockReset();
    vi.mocked(sendSingle).mockResolvedValue({ ok: true, id: "msg_x" });
  });
  afterEach(() => {
    setEnv({ ADMIN_TEST_EMAILS: undefined, EMAIL_FROM: undefined });
  });

  it("throws RateLimitError after exceeding max attempts", async () => {
    await testSendTemplate({ adminId: "a1", to: "qa@example.com", template: FAKE_TEMPLATE });
    await testSendTemplate({ adminId: "a1", to: "qa@example.com", template: FAKE_TEMPLATE });
    await expect(
      testSendTemplate({ adminId: "a1", to: "qa@example.com", template: FAKE_TEMPLATE }),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it("isolates buckets by adminId", async () => {
    await testSendTemplate({ adminId: "a1", to: "qa@example.com", template: FAKE_TEMPLATE });
    await testSendTemplate({ adminId: "a1", to: "qa@example.com", template: FAKE_TEMPLATE });
    // a2 should not be affected by a1's quota
    await expect(
      testSendTemplate({ adminId: "a2", to: "qa@example.com", template: FAKE_TEMPLATE }),
    ).resolves.toMatchObject({ ok: true });
  });
});
