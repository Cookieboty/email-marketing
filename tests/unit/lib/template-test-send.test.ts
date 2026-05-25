/**
 * 模板 test-send：限流测试。
 *
 * 不接 DB（用 fake template 对象）、不接真实 transport（mock sendSingle）。
 * 关注：
 *   - EMAIL_FROM 未配置 → 拒绝
 *   - 正常调用 → 调用 sendSingle 并 audit
 *   - 同一 admin 触发多次 → 越过 RATE_LIMIT_TEST_SEND_MAX 后抛 RateLimitError
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/modules/mail/transport", () => ({
  sendSingle: vi.fn(),
}));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(),
  auditNow: vi.fn(async () => {}),
  maskDetails: (x: unknown) => x,
}));

import { sendSingle } from "@/lib/modules/mail/transport";
import {
  __resetTestSendLimiter,
  testSendTemplate,
} from "@/lib/modules/template/test-send";
import { __resetEnvCache } from "@/lib/env";
import { RateLimitError, ValidationError } from "@/lib/errors";

const FAKE_TEMPLATE = {
  id: "tpl_1",
  name: "Welcome",
  defaultLocale: "zh",
  variables: ["user_name"],
  version: 1,
  locales: [
    {
      locale: "zh",
      subject: "Hi {{user_name}}",
      htmlContent: "<p>Hello {{user_name}}</p>",
      textContent: null,
    },
    {
      locale: "en",
      subject: "Hello {{user_name}}",
      htmlContent: "<p>English {{user_name}}</p>",
      textContent: null,
    },
  ],
} as never;

function setEnv(extra: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
    else process.env[k] = v;
  }
  __resetEnvCache();
}

describe("test-send", () => {
  beforeEach(() => {
    setEnv({
      EMAIL_FROM: "noreply@example.com",
      RATE_LIMIT_TEST_SEND_MAX: "5",
      RATE_LIMIT_TEST_SEND_WINDOW_SEC: "3600",
    });
    __resetTestSendLimiter();
    vi.mocked(sendSingle).mockReset();
    vi.mocked(sendSingle).mockResolvedValue({ ok: true, id: "msg_1" });
  });
  afterEach(() => {
    setEnv({ EMAIL_FROM: undefined });
  });

  it("requires EMAIL_FROM to be configured", async () => {
    setEnv({ EMAIL_FROM: undefined });
    await expect(
      testSendTemplate({ adminId: "a1", to: "qa@example.com", template: FAKE_TEMPLATE }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("invokes sendSingle with [TEST] subject prefix", async () => {
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

  it("renders the requested locale when provided", async () => {
    await testSendTemplate({
      adminId: "a1",
      to: "qa@example.com",
      template: FAKE_TEMPLATE,
      locale: "en",
      variables: { user_name: "Alice" },
    });
    const call = vi.mocked(sendSingle).mock.calls[0]![0];
    expect(call.subject).toBe("[TEST] Hello Alice");
    expect(call.html).toContain("English Alice");
  });

  it("uses subject override for requested locale", async () => {
    await testSendTemplate({
      adminId: "a1",
      to: "qa@example.com",
      template: FAKE_TEMPLATE,
      locale: "en",
      subjects: { en: "Override {{user_name}}" },
      variables: { user_name: "Alice" },
    });
    const call = vi.mocked(sendSingle).mock.calls[0]![0];
    expect(call.subject).toBe("[TEST] Override Alice");
  });
});

describe("test-send: rate limit per admin", () => {
  beforeEach(() => {
    setEnv({
      EMAIL_FROM: "noreply@example.com",
      RATE_LIMIT_TEST_SEND_MAX: "2",
      RATE_LIMIT_TEST_SEND_WINDOW_SEC: "3600",
    });
    __resetTestSendLimiter();
    vi.mocked(sendSingle).mockReset();
    vi.mocked(sendSingle).mockResolvedValue({ ok: true, id: "msg_x" });
  });
  afterEach(() => {
    setEnv({ EMAIL_FROM: undefined });
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
    await expect(
      testSendTemplate({ adminId: "a2", to: "qa@example.com", template: FAKE_TEMPLATE }),
    ).resolves.toMatchObject({ ok: true });
  });
});
