/**
 * Topic 级退订与 evaluateDeliverability 单元测试。
 *
 * 不连接 DB：mock prisma & audit。
 * 覆盖：
 *  - evaluateDeliverability 三级短路
 *  - unsubscribeByTopic 幂等 / topic 不存在 / 用户不存在
 *  - resubscribeByTopic 删除记录 / 已订阅 idempotent
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    subscriptionCategory: { findUnique: vi.fn() },
    userSubscription: { findUnique: vi.fn() },
    topic: { findUnique: vi.fn() },
    userTopicUnsubscribe: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

import { audit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import {
  evaluateDeliverability,
  subscriptionUnsubscribeService,
} from "@/lib/modules/subscription-category/unsubscribe";

const userFindUnique = vi.mocked(prisma.user.findUnique) as unknown as ReturnType<typeof vi.fn>;
const catFindUnique = vi.mocked(prisma.subscriptionCategory.findUnique) as unknown as ReturnType<
  typeof vi.fn
>;
const subFindUnique = vi.mocked(prisma.userSubscription.findUnique) as unknown as ReturnType<
  typeof vi.fn
>;
const topicFindUnique = vi.mocked(prisma.topic.findUnique) as unknown as ReturnType<typeof vi.fn>;
const utuFindUnique = vi.mocked(
  prisma.userTopicUnsubscribe.findUnique,
) as unknown as ReturnType<typeof vi.fn>;
const utuUpsert = vi.mocked(prisma.userTopicUnsubscribe.upsert) as unknown as ReturnType<
  typeof vi.fn
>;
const utuDeleteMany = vi.mocked(
  prisma.userTopicUnsubscribe.deleteMany,
) as unknown as ReturnType<typeof vi.fn>;
const auditMock = vi.mocked(audit);

const baseUser = {
  id: "u1",
  email: "a@b.com",
  unsubscribed: false,
  unsubscribedAt: null,
  unsubscribeToken: "tok",
};

const baseTopic = {
  id: "t1",
  slug: "campaign-2026",
  name: "Campaign 2026",
  description: null,
  externalRef: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("evaluateDeliverability", () => {
  it("user 不存在 → user_not_found", async () => {
    userFindUnique.mockResolvedValueOnce(null);
    const out = await evaluateDeliverability("missing");
    expect(out).toEqual({ allowed: false, reason: "user_not_found" });
  });

  it("全局退订 → 短路返回 global_unsubscribed", async () => {
    userFindUnique.mockResolvedValueOnce({ unsubscribed: true });
    const out = await evaluateDeliverability("u1", { topicId: "t1" });
    expect(out).toEqual({ allowed: false, reason: "global_unsubscribed" });
    // 不应继续查询 topic
    expect(utuFindUnique).not.toHaveBeenCalled();
  });

  it("分类退订（明确 subscribed=false） → category_unsubscribed", async () => {
    userFindUnique.mockResolvedValueOnce({ unsubscribed: false });
    catFindUnique.mockResolvedValueOnce({
      id: "c1",
      isDefault: true,
      isTransactional: false,
    });
    subFindUnique.mockResolvedValueOnce({ subscribed: false });
    const out = await evaluateDeliverability("u1", { categorySlug: "marketing" });
    expect(out).toEqual({ allowed: false, reason: "category_unsubscribed" });
  });

  it("非默认分类无记录 → 视为未订阅 category_unsubscribed", async () => {
    userFindUnique.mockResolvedValueOnce({ unsubscribed: false });
    catFindUnique.mockResolvedValueOnce({
      id: "c1",
      isDefault: false,
      isTransactional: false,
    });
    subFindUnique.mockResolvedValueOnce(null);
    const out = await evaluateDeliverability("u1", { categorySlug: "promo" });
    expect(out).toEqual({ allowed: false, reason: "category_unsubscribed" });
  });

  it("Transactional 分类绕过分类校验，仍走 topic 检查", async () => {
    userFindUnique.mockResolvedValueOnce({ unsubscribed: false });
    catFindUnique.mockResolvedValueOnce({
      id: "c1",
      isDefault: false,
      isTransactional: true,
    });
    utuFindUnique.mockResolvedValueOnce(null);
    const out = await evaluateDeliverability("u1", {
      categorySlug: "tx",
      topicId: "t1",
    });
    expect(out).toEqual({ allowed: true });
    expect(subFindUnique).not.toHaveBeenCalled();
  });

  it("主题退订 → topic_unsubscribed", async () => {
    userFindUnique.mockResolvedValueOnce({ unsubscribed: false });
    utuFindUnique.mockResolvedValueOnce({ userId: "u1" });
    const out = await evaluateDeliverability("u1", { topicId: "t1" });
    expect(out).toEqual({ allowed: false, reason: "topic_unsubscribed" });
  });

  it("全部通过 → allowed=true", async () => {
    userFindUnique.mockResolvedValueOnce({ unsubscribed: false });
    catFindUnique.mockResolvedValueOnce({
      id: "c1",
      isDefault: true,
      isTransactional: false,
    });
    subFindUnique.mockResolvedValueOnce({ subscribed: true });
    utuFindUnique.mockResolvedValueOnce(null);
    const out = await evaluateDeliverability("u1", {
      categorySlug: "marketing",
      topicId: "t1",
    });
    expect(out).toEqual({ allowed: true });
  });

  it("无 opts 时仅做全局检查", async () => {
    userFindUnique.mockResolvedValueOnce({ unsubscribed: false });
    const out = await evaluateDeliverability("u1");
    expect(out).toEqual({ allowed: true });
    expect(catFindUnique).not.toHaveBeenCalled();
    expect(utuFindUnique).not.toHaveBeenCalled();
  });
});

describe("subscriptionUnsubscribeService.unsubscribeByTopic", () => {
  it("token 不存在 → user_not_found", async () => {
    userFindUnique.mockResolvedValueOnce(null);
    const out = await subscriptionUnsubscribeService.unsubscribeByTopic({
      token: "missing",
      topicSlug: "x",
    });
    expect(out.status).toBe("user_not_found");
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("topic 不存在 → topic_not_found 并写 audit", async () => {
    userFindUnique.mockResolvedValueOnce({ ...baseUser });
    topicFindUnique.mockResolvedValueOnce(null);
    const out = await subscriptionUnsubscribeService.unsubscribeByTopic({
      token: "tok",
      topicSlug: "ghost",
    });
    expect(out.status).toBe("topic_not_found");
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0]![0].details).toMatchObject({
      reason: "topic_not_found",
      slug: "ghost",
    });
  });

  it("首次退订：upsert 创建记录，alreadyUnsubscribed=false", async () => {
    userFindUnique.mockResolvedValueOnce({ ...baseUser });
    topicFindUnique.mockResolvedValueOnce({ ...baseTopic });
    utuFindUnique.mockResolvedValueOnce(null);
    utuUpsert.mockResolvedValueOnce({} as never);

    const out = await subscriptionUnsubscribeService.unsubscribeByTopic({
      token: "tok",
      topicSlug: "campaign-2026",
    });
    expect(out.status).toBe("topic_unsubscribed");
    if (out.status === "topic_unsubscribed") {
      expect(out.alreadyUnsubscribed).toBe(false);
    }
    expect(utuUpsert).toHaveBeenCalledOnce();
    expect(auditMock).toHaveBeenCalledOnce();
  });

  it("重复退订幂等：alreadyUnsubscribed=true 且不再 upsert", async () => {
    userFindUnique.mockResolvedValueOnce({ ...baseUser });
    topicFindUnique.mockResolvedValueOnce({ ...baseTopic });
    utuFindUnique.mockResolvedValueOnce({ userId: "u1" });

    const out = await subscriptionUnsubscribeService.unsubscribeByTopic({
      token: "tok",
      topicSlug: "campaign-2026",
    });
    expect(out.status).toBe("topic_unsubscribed");
    if (out.status === "topic_unsubscribed") {
      expect(out.alreadyUnsubscribed).toBe(true);
    }
    expect(utuUpsert).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledOnce();
  });
});

describe("subscriptionUnsubscribeService.resubscribeByTopic", () => {
  it("user 不存在 → user_not_found", async () => {
    userFindUnique.mockResolvedValueOnce(null);
    const out = await subscriptionUnsubscribeService.resubscribeByTopic({
      token: "missing",
      topicSlug: "x",
    });
    expect(out.status).toBe("user_not_found");
  });

  it("topic 不存在 → topic_not_found", async () => {
    userFindUnique.mockResolvedValueOnce({ ...baseUser });
    topicFindUnique.mockResolvedValueOnce(null);
    const out = await subscriptionUnsubscribeService.resubscribeByTopic({
      token: "tok",
      topicSlug: "ghost",
    });
    expect(out.status).toBe("topic_not_found");
  });

  it("已退订 → 删除记录，alreadySubscribed=false", async () => {
    userFindUnique.mockResolvedValueOnce({ ...baseUser });
    topicFindUnique.mockResolvedValueOnce({ ...baseTopic });
    utuDeleteMany.mockResolvedValueOnce({ count: 1 });
    const out = await subscriptionUnsubscribeService.resubscribeByTopic({
      token: "tok",
      topicSlug: "campaign-2026",
    });
    expect(out.status).toBe("topic_resubscribed");
    if (out.status === "topic_resubscribed") {
      expect(out.alreadySubscribed).toBe(false);
    }
  });

  it("从未退订 → 删除 0 条，alreadySubscribed=true", async () => {
    userFindUnique.mockResolvedValueOnce({ ...baseUser });
    topicFindUnique.mockResolvedValueOnce({ ...baseTopic });
    utuDeleteMany.mockResolvedValueOnce({ count: 0 });
    const out = await subscriptionUnsubscribeService.resubscribeByTopic({
      token: "tok",
      topicSlug: "campaign-2026",
    });
    expect(out.status).toBe("topic_resubscribed");
    if (out.status === "topic_resubscribed") {
      expect(out.alreadySubscribed).toBe(true);
    }
  });
});
