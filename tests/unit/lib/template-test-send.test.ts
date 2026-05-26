/**
 * 模板 test-send：限流测试。
 *
 * 不接 DB（mock prisma）、不接真实 transport（mock getTransportForChannel）。
 * 关注：
 *   - 优先使用渠道自身的 fromEmail/fromName（修复 Resend "domain not authorized"）
 *   - 渠道未配 fromEmail 时回退 EMAIL_FROM
 *   - 渠道+EMAIL_FROM 都缺 → ValidationError
 *   - 同一 admin 触发多次 → 越过 RATE_LIMIT_TEST_SEND_MAX 后抛 RateLimitError
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  sendSingleMock,
  closeMock,
  getTransportForChannelMock,
  channelFindUnique,
  channelFindFirst,
  envVarFindMany,
  userFindUnique,
  templateBlockFindMany,
} = vi.hoisted(() => ({
  sendSingleMock: vi.fn(),
  closeMock: vi.fn(async () => { }),
  getTransportForChannelMock: vi.fn(),
  channelFindUnique: vi.fn(),
  channelFindFirst: vi.fn(),
  envVarFindMany: vi.fn(async () => []),
  userFindUnique: vi.fn(),
  templateBlockFindMany: vi.fn(async () => [] as unknown[]),
}));

vi.mock("@/lib/modules/mail/transport", () => ({
  getTransportForChannel: getTransportForChannelMock,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    sendingChannel: {
      findUnique: channelFindUnique,
      findFirst: channelFindFirst,
    },
    environmentVariable: {
      findMany: envVarFindMany,
    },
    user: {
      findUnique: userFindUnique,
    },
    templateBlock: {
      findMany: templateBlockFindMany,
    },
  },
}));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(),
  auditNow: vi.fn(async () => { }),
  maskDetails: (x: unknown) => x,
}));

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

function setSystemDefaultChannel(channel: {
  id: string;
  fromEmail: string | null;
  fromName: string | null;
}) {
  channelFindFirst.mockResolvedValue(channel);
}

function setChannelById(channel: {
  id: string;
  fromEmail: string | null;
  fromName: string | null;
  status?: string;
}) {
  channelFindUnique.mockResolvedValue({ status: "ACTIVE", ...channel });
}

describe("test-send", () => {
  beforeEach(() => {
    setEnv({
      EMAIL_FROM: "noreply@example.com",
      RATE_LIMIT_TEST_SEND_MAX: "5",
      RATE_LIMIT_TEST_SEND_WINDOW_SEC: "3600",
    });
    __resetTestSendLimiter();
    sendSingleMock.mockReset();
    sendSingleMock.mockResolvedValue({ ok: true, id: "msg_1" });
    closeMock.mockClear();
    getTransportForChannelMock.mockReset();
    getTransportForChannelMock.mockImplementation(async () => ({
      provider: "RESEND",
      channelId: "ch_default",
      sendSingle: sendSingleMock,
      sendBatch: vi.fn(),
      close: closeMock,
    }));
    channelFindUnique.mockReset();
    channelFindFirst.mockReset();
    setSystemDefaultChannel({
      id: "ch_default",
      fromEmail: "verified@mydomain.com",
      fromName: "My App",
    });
    userFindUnique.mockReset();
    userFindUnique.mockResolvedValue(null);
    templateBlockFindMany.mockReset();
    templateBlockFindMany.mockResolvedValue([]);
  });
  afterEach(() => {
    setEnv({ EMAIL_FROM: undefined });
  });

  it("prefers channel.fromEmail over EMAIL_FROM env (Resend domain authorization)", async () => {
    const r = await testSendTemplate({
      adminId: "a1",
      to: "qa@example.com",
      template: FAKE_TEMPLATE,
    });
    expect(r.ok).toBe(true);
    expect(getTransportForChannelMock).toHaveBeenCalledWith("ch_default");
    const call = sendSingleMock.mock.calls[0]![0];
    expect(call.from).toBe("My App <verified@mydomain.com>");
  });

  it("falls back to EMAIL_FROM when channel has no fromEmail configured", async () => {
    setSystemDefaultChannel({ id: "ch_x", fromEmail: null, fromName: null });
    await testSendTemplate({
      adminId: "a1",
      to: "qa@example.com",
      template: FAKE_TEMPLATE,
    });
    const call = sendSingleMock.mock.calls[0]![0];
    expect(call.from).toBe("noreply@example.com");
  });

  it("rejects when neither channel.fromEmail nor EMAIL_FROM is configured", async () => {
    setEnv({ EMAIL_FROM: undefined });
    setSystemDefaultChannel({ id: "ch_x", fromEmail: null, fromName: null });
    await expect(
      testSendTemplate({ adminId: "a1", to: "qa@example.com", template: FAKE_TEMPLATE }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects when no system default channel exists and no channelId provided", async () => {
    channelFindFirst.mockResolvedValue(null);
    await expect(
      testSendTemplate({ adminId: "a1", to: "qa@example.com", template: FAKE_TEMPLATE }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("uses provided channelId and its fromEmail", async () => {
    setChannelById({
      id: "ch_picked",
      fromEmail: "picked@yourdomain.com",
      fromName: null,
    });
    await testSendTemplate({
      adminId: "a1",
      to: "qa@example.com",
      template: FAKE_TEMPLATE,
      channelId: "ch_picked",
    });
    expect(getTransportForChannelMock).toHaveBeenCalledWith("ch_picked");
    const call = sendSingleMock.mock.calls[0]![0];
    expect(call.from).toBe("picked@yourdomain.com");
  });

  it("invokes transport with [TEST] subject prefix", async () => {
    const r = await testSendTemplate({
      adminId: "a1",
      to: "qa@example.com",
      template: FAKE_TEMPLATE,
    });
    expect(r.ok).toBe(true);
    expect(sendSingleMock).toHaveBeenCalledTimes(1);
    const call = sendSingleMock.mock.calls[0]![0];
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
    const call = sendSingleMock.mock.calls[0]![0];
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
    const call = sendSingleMock.mock.calls[0]![0];
    expect(call.subject).toBe("[TEST] Override Alice");
  });

  it("renders {{user_name}} with the recipient's real name from User table", async () => {
    userFindUnique.mockResolvedValue({ name: "Bob Real" });
    await testSendTemplate({
      adminId: "a1",
      to: "bob@example.com",
      template: FAKE_TEMPLATE,
    });
    expect(userFindUnique).toHaveBeenCalledWith({
      where: { email: "bob@example.com" },
      select: { name: true },
    });
    const call = sendSingleMock.mock.calls[0]![0];
    expect(call.subject).toBe("[TEST] Hi Bob Real");
    expect(call.html).toContain("Hello Bob Real");
  });

  it("explicit variables.user_name takes precedence over recipient.name", async () => {
    userFindUnique.mockResolvedValue({ name: "Bob Real" });
    await testSendTemplate({
      adminId: "a1",
      to: "bob@example.com",
      template: FAKE_TEMPLATE,
      variables: { user_name: "Override Name" },
    });
    const call = sendSingleMock.mock.calls[0]![0];
    expect(call.subject).toBe("[TEST] Hi Override Name");
  });

  it("falls back to '测试用户' when recipient is not in User table", async () => {
    userFindUnique.mockResolvedValue(null);
    await testSendTemplate({
      adminId: "a1",
      to: "stranger@example.com",
      template: FAKE_TEMPLATE,
    });
    const call = sendSingleMock.mock.calls[0]![0];
    expect(call.subject).toBe("[TEST] Hi 测试用户");
  });

  it("falls back to '测试用户' when recipient.name is empty/whitespace", async () => {
    userFindUnique.mockResolvedValue({ name: "   " });
    await testSendTemplate({
      adminId: "a1",
      to: "blank@example.com",
      template: FAKE_TEMPLATE,
    });
    const call = sendSingleMock.mock.calls[0]![0];
    expect(call.subject).toBe("[TEST] Hi 测试用户");
  });

  it("expands template block refs by fetching fresh content for resolvedLocale", async () => {
    const tplWithBlock = {
      id: "tpl_1",
      name: "Welcome",
      defaultLocale: "zh",
      variables: ["user_name"],
      version: 1,
      locales: [
        {
          locale: "zh",
          subject: "Hi {{user_name}}",
          htmlContent: "<p>Hello {{user_name}}</p>{{> footer }}",
          textContent: null,
        },
        {
          locale: "en",
          subject: "Hello {{user_name}}",
          htmlContent: "<p>English {{user_name}}</p>{{> footer }}",
          textContent: null,
        },
      ],
    } as never;
    templateBlockFindMany.mockImplementation(((args: unknown) => {
      const a = args as { where: { OR: { locale: string; name: string }[] } };
      const hit = a.where.OR.some((p) => p.locale === "zh" && p.name === "footer");
      return Promise.resolve(
        hit
          ? [
            {
              id: "blk_1",
              name: "footer",
              locale: "zh",
              htmlContent: "<footer>署名 {{user_name}}</footer>",
              updatedAt: new Date(),
            },
          ]
          : [],
      );
    }) as never);
    await testSendTemplate({
      adminId: "a1",
      to: "qa@example.com",
      template: tplWithBlock,
      variables: { user_name: "Alice" },
    });
    expect(templateBlockFindMany).toHaveBeenCalledTimes(1);
    const calls = templateBlockFindMany.mock.calls as unknown as Array<
      [{ where: { OR: { locale: string; name: string }[] } }]
    >;
    expect(calls[0]![0].where.OR).toEqual([{ locale: "zh", name: "footer" }]);
    const call = sendSingleMock.mock.calls[0]![0];
    expect(call.html).toContain("<p>Hello Alice</p>");
    expect(call.html).toContain("<footer>署名 Alice</footer>");
  });

  it("rejects with ValidationError when referenced block is missing (missingBlock=throw)", async () => {
    const tplWithMissingBlock = {
      id: "tpl_1",
      name: "Welcome",
      defaultLocale: "zh",
      variables: [],
      version: 1,
      locales: [
        {
          locale: "zh",
          subject: "Hi",
          htmlContent: "<p>{{> not_exist }}</p>",
          textContent: null,
        },
      ],
    } as never;
    templateBlockFindMany.mockResolvedValue([]);
    await expect(
      testSendTemplate({
        adminId: "a1",
        to: "qa@example.com",
        template: tplWithMissingBlock,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(sendSingleMock).not.toHaveBeenCalled();
  });

  it("translates BlockExpansionError code/blockName/trace into ValidationError message", async () => {
    const tplCycle = {
      id: "tpl_1",
      name: "Welcome",
      defaultLocale: "zh",
      variables: [],
      version: 1,
      locales: [
        {
          locale: "zh",
          subject: "Hi",
          htmlContent: "<p>{{> a }}</p>",
          textContent: null,
        },
      ],
    } as never;
    templateBlockFindMany.mockResolvedValue([
      {
        id: "blk_a",
        name: "a",
        locale: "zh",
        htmlContent: "{{> b }}",
        updatedAt: new Date(),
      },
      {
        id: "blk_b",
        name: "b",
        locale: "zh",
        htmlContent: "{{> a }}",
        updatedAt: new Date(),
      },
    ]);
    let err: unknown = null;
    try {
      await testSendTemplate({
        adminId: "a1",
        to: "qa@example.com",
        template: tplCycle,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toContain("Template block expansion failed");
    expect((err as Error).message).toContain("CYCLE");
    expect((err as Error).message).toContain("trace=");
  });

  it("does NOT query templateBlock when template has no block refs", async () => {
    await testSendTemplate({
      adminId: "a1",
      to: "qa@example.com",
      template: FAKE_TEMPLATE,
    });
    expect(templateBlockFindMany).not.toHaveBeenCalled();
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
    sendSingleMock.mockReset();
    sendSingleMock.mockResolvedValue({ ok: true, id: "msg_x" });
    closeMock.mockClear();
    getTransportForChannelMock.mockReset();
    getTransportForChannelMock.mockImplementation(async () => ({
      provider: "RESEND",
      channelId: "ch_default",
      sendSingle: sendSingleMock,
      sendBatch: vi.fn(),
      close: closeMock,
    }));
    channelFindUnique.mockReset();
    channelFindFirst.mockReset();
    channelFindFirst.mockResolvedValue({
      id: "ch_default",
      fromEmail: "verified@mydomain.com",
      fromName: null,
    });
    userFindUnique.mockReset();
    userFindUnique.mockResolvedValue(null);
    templateBlockFindMany.mockReset();
    templateBlockFindMany.mockResolvedValue([]);
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
