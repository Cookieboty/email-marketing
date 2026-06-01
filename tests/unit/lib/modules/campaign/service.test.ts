/**
 * Campaign service 单元测试（不连接 DB）。
 *
 * 聚焦本次改动：
 *  - create：发件人解析顺序——显式 fromEmail > 渠道发件人（渠道级 → SMTP 配置级）
 *    > EMAIL_FROM 环境变量；不再无脑回退到环境变量占位地址。
 *  - update：FAILED 状态仅允许修正发送相关字段；切换渠道未填发件人时按新渠道重解析。
 *  - retry：把失败 / 软退信收件人重置为 PENDING 并切回 SENDING；非 FAILED 拒绝；
 *    乐观锁冲突抛 ConflictError。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  recipientUpdateMany: vi.fn(),
  variantCreateMany: vi.fn(),
  campaignUpdateMany: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(),
  auditNow: vi.fn(async () => {}),
  maskDetails: (x: unknown) => x,
}));

vi.mock("@/lib/env", () => ({
  env: vi.fn(() => ({ EMAIL_FROM: "Marketing <news@example.com>" })),
}));

vi.mock("@/lib/modules/campaign/repository", () => ({
  campaignRepository: {
    list: vi.fn(),
    findById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transitionStatus: vi.fn(),
  },
}));

vi.mock("@/lib/modules/campaign/snapshot", () => ({
  snapshotRecipients: vi.fn(),
}));

vi.mock("@/lib/modules/template/service", () => ({
  templateService: {
    getById: vi.fn(),
    assertUsableForNewCampaign: vi.fn(),
  },
  freezeBlocksForSnapshot: vi.fn(async () => ({})),
}));

vi.mock("@/lib/modules/template/snapshot", () => ({
  buildTemplateSnapshot: vi.fn(() => ({})),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    sendingChannel: { findUnique: vi.fn() },
    campaign: { findUnique: vi.fn() },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        campaignRecipient: { updateMany: h.recipientUpdateMany },
        campaignVariant: { createMany: h.variantCreateMany },
        campaign: { updateMany: h.campaignUpdateMany },
      }),
    ),
  },
}));

import { campaignService } from "@/lib/modules/campaign/service";
import { campaignRepository } from "@/lib/modules/campaign/repository";
import { templateService } from "@/lib/modules/template/service";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { ConflictError, ValidationError } from "@/lib/errors";

const repo = vi.mocked(campaignRepository);
const tpl = vi.mocked(templateService);
const channelFindUnique = vi.mocked(prisma.sendingChannel.findUnique) as unknown as ReturnType<typeof vi.fn>;

const ctx = { actorType: "ADMIN" as const };

const fakeTemplate = {
  id: "tpl1",
  defaultLocale: "zh",
  locales: [{ locale: "zh" }, { locale: "en" }],
};

const createInput = (overrides: Record<string, unknown> = {}) =>
  ({
    name: "Camp",
    templateId: "tpl1",
    localeStrategy: "AUTO",
    isAbTest: false,
    ...overrides,
  }) as never;

const fakeCampaign = (overrides: Record<string, unknown> = {}) => ({
  id: "camp1",
  name: "Camp",
  status: "FAILED",
  localeStrategy: "AUTO",
  forcedLocale: null,
  fromEmail: "Marketing <news@example.com>",
  replyTo: null,
  sendingChannelId: "ch1",
  templateId: "tpl1",
  failedCount: 5,
  isAbTest: false,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(env).mockReturnValue({ EMAIL_FROM: "Marketing <news@example.com>" } as never);
  tpl.getById.mockResolvedValue(fakeTemplate as never);
  repo.create.mockResolvedValue({ id: "camp1", name: "Camp", isAbTest: false } as never);
});

describe("campaignService.create — 发件人解析", () => {
  function createdFromEmail(): string {
    const data = repo.create.mock.calls[0]![0] as Record<string, unknown>;
    return data.fromEmail as string;
  }

  it("留空发件人时使用所选渠道的发件人（渠道级 fromEmail/fromName）", async () => {
    channelFindUnique.mockResolvedValue({
      id: "ch1",
      fromEmail: "chan@example.com",
      fromName: "Channel One",
      smtpConfig: null,
    } as never);

    await campaignService.create(
      createInput({ sendingChannelId: "ch1" }),
      ctx,
    );

    expect(channelFindUnique).toHaveBeenCalledTimes(1);
    expect(createdFromEmail()).toBe("Channel One <chan@example.com>");
  });

  it("渠道级发件人为空时回退到 SMTP 配置级发件人", async () => {
    channelFindUnique.mockResolvedValue({
      id: "ch1",
      fromEmail: null,
      fromName: null,
      smtpConfig: { fromEmail: "smtp@example.com", fromName: "SMTP Sender" },
    } as never);

    await campaignService.create(
      createInput({ sendingChannelId: "ch1" }),
      ctx,
    );

    expect(createdFromEmail()).toBe("SMTP Sender <smtp@example.com>");
  });

  it("未选渠道且未填发件人时回退到 EMAIL_FROM 环境变量", async () => {
    await campaignService.create(createInput({}), ctx);

    expect(channelFindUnique).not.toHaveBeenCalled();
    expect(createdFromEmail()).toBe("Marketing <news@example.com>");
  });

  it("显式填写发件人时优先使用且不查询渠道", async () => {
    await campaignService.create(
      createInput({ fromEmail: "Ops <ops@example.com>", sendingChannelId: "ch1" }),
      ctx,
    );

    expect(channelFindUnique).not.toHaveBeenCalled();
    expect(createdFromEmail()).toBe("Ops <ops@example.com>");
  });

  it("既无显式发件人、渠道无发件人、也无 EMAIL_FROM 时抛 ValidationError", async () => {
    vi.mocked(env).mockReturnValue({} as never);
    channelFindUnique.mockResolvedValue({
      id: "ch1",
      fromEmail: null,
      fromName: null,
      smtpConfig: null,
    } as never);

    await expect(
      campaignService.create(createInput({ sendingChannelId: "ch1" }), ctx),
    ).rejects.toThrow(ValidationError);
  });
});

describe("campaignService.update — FAILED 状态编辑限制", () => {
  beforeEach(() => {
    repo.update.mockResolvedValue(fakeCampaign({ status: "FAILED" }) as never);
  });

  it("FAILED 状态允许修改发件人/回复地址/发送渠道", async () => {
    repo.findById.mockResolvedValue(fakeCampaign({ status: "FAILED" }) as never);

    await expect(
      campaignService.update(
        "camp1",
        { fromEmail: "Fixed <fixed@example.com>", replyTo: "reply@example.com" } as never,
        ctx,
      ),
    ).resolves.toBeDefined();

    const data = repo.update.mock.calls[0]![1] as Record<string, unknown>;
    expect(data.fromEmail).toBe("Fixed <fixed@example.com>");
    expect(data.replyTo).toBe("reply@example.com");
  });

  it("FAILED 状态修改不允许的字段（如 name）时抛 ValidationError", async () => {
    repo.findById.mockResolvedValue(fakeCampaign({ status: "FAILED" }) as never);

    await expect(
      campaignService.update("camp1", { name: "新名字" } as never, ctx),
    ).rejects.toThrow(ValidationError);
    expect(repo.update).not.toHaveBeenCalled();
  });

  it("FAILED 状态切换渠道但未填发件人时，按新渠道默认发件人重新解析", async () => {
    repo.findById.mockResolvedValue(fakeCampaign({ status: "FAILED" }) as never);
    channelFindUnique.mockResolvedValue({
      id: "ch2",
      fromEmail: "new@example.com",
      fromName: "New Channel",
      smtpConfig: null,
    } as never);

    await campaignService.update("camp1", { sendingChannelId: "ch2" } as never, ctx);

    const data = repo.update.mock.calls[0]![1] as Record<string, unknown>;
    expect(data.sendingChannelId).toBe("ch2");
    expect(data.fromEmail).toBe("New Channel <new@example.com>");
  });

  it("COMPLETED（已完成但有失败）也允许修改发送设置", async () => {
    repo.findById.mockResolvedValue(fakeCampaign({ status: "COMPLETED" }) as never);

    await expect(
      campaignService.update(
        "camp1",
        { fromEmail: "Fixed <fixed@example.com>" } as never,
        ctx,
      ),
    ).resolves.toBeDefined();
    expect(repo.update).toHaveBeenCalledTimes(1);
  });

  it("SENDING 状态拒绝编辑", async () => {
    repo.findById.mockResolvedValue(fakeCampaign({ status: "SENDING" }) as never);

    await expect(
      campaignService.update("camp1", { fromEmail: "x@example.com" } as never, ctx),
    ).rejects.toThrow(ValidationError);
    expect(repo.update).not.toHaveBeenCalled();
  });
});

describe("campaignService.retry", () => {
  beforeEach(() => {
    h.recipientUpdateMany.mockResolvedValue({ count: 5 });
    h.campaignUpdateMany.mockResolvedValue({ count: 1 });
  });

  it("FAILED 时重置失败/软退信收件人并切回 SENDING", async () => {
    repo.findById
      .mockResolvedValueOnce(fakeCampaign({ status: "FAILED" }) as never)
      .mockResolvedValueOnce(fakeCampaign({ status: "SENDING", failedCount: 0 }) as never);

    const result = await campaignService.retry("camp1", ctx);

    expect(h.recipientUpdateMany).toHaveBeenCalledTimes(1);
    const recipArgs = h.recipientUpdateMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(recipArgs.where).toMatchObject({
      campaignId: "camp1",
      status: { in: ["FAILED", "SOFT_BOUNCED"] },
    });
    expect(recipArgs.data).toMatchObject({ status: "PENDING", retryCount: 0 });

    const campArgs = h.campaignUpdateMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(campArgs.where).toMatchObject({ id: "camp1", status: "FAILED" });
    expect(campArgs.data).toMatchObject({ status: "SENDING", failedCount: 0 });
    expect(result.status).toBe("SENDING");
  });

  it("COMPLETED（已完成但有失败）也可重发失败收件人", async () => {
    repo.findById
      .mockResolvedValueOnce(fakeCampaign({ status: "COMPLETED" }) as never)
      .mockResolvedValueOnce(fakeCampaign({ status: "SENDING", failedCount: 0 }) as never);

    await campaignService.retry("camp1", ctx);

    const campArgs = h.campaignUpdateMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
    };
    expect(campArgs.where).toMatchObject({ id: "camp1", status: "COMPLETED" });
  });

  it("DRAFT 等未发送状态拒绝重试", async () => {
    repo.findById.mockResolvedValue(fakeCampaign({ status: "DRAFT" }) as never);

    await expect(campaignService.retry("camp1", ctx)).rejects.toThrow(ValidationError);
    expect(h.recipientUpdateMany).not.toHaveBeenCalled();
    expect(h.campaignUpdateMany).not.toHaveBeenCalled();
  });

  it("没有可重发的失败收件人时抛 ValidationError 且不改状态", async () => {
    repo.findById.mockResolvedValue(fakeCampaign({ status: "FAILED" }) as never);
    h.recipientUpdateMany.mockResolvedValue({ count: 0 });

    await expect(campaignService.retry("camp1", ctx)).rejects.toThrow(ValidationError);
    expect(h.campaignUpdateMany).not.toHaveBeenCalled();
  });

  it("乐观锁冲突（campaign updateMany count=0）抛 ConflictError", async () => {
    repo.findById.mockResolvedValue(fakeCampaign({ status: "FAILED" }) as never);
    h.campaignUpdateMany.mockResolvedValue({ count: 0 });

    await expect(campaignService.retry("camp1", ctx)).rejects.toThrow(ConflictError);
  });
});
