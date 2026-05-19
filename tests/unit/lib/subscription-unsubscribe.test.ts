/**
 * SubscriptionUnsubscribeService 单元测试。
 *
 * 不连接 DB：mock prisma & audit。
 * 覆盖路径：
 *  - token 找不到 → user_not_found
 *  - 全局退订 + 幂等
 *  - 分类退订正常分支
 *  - 交易类静默忽略
 *  - 分类不存在
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn() },
    subscriptionCategory: { findUnique: vi.fn() },
    userSubscription: { upsert: vi.fn() },
  },
}));

import { audit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { subscriptionUnsubscribeService } from "@/lib/modules/subscription-category/unsubscribe";

const userFindUnique = vi.mocked(prisma.user.findUnique) as unknown as ReturnType<typeof vi.fn>;
const userUpdate = vi.mocked(prisma.user.update) as unknown as ReturnType<typeof vi.fn>;
const catFindUnique = vi.mocked(prisma.subscriptionCategory.findUnique) as unknown as ReturnType<
  typeof vi.fn
>;
const subUpsert = vi.mocked(prisma.userSubscription.upsert) as unknown as ReturnType<typeof vi.fn>;
const auditMock = vi.mocked(audit);

const baseUser = {
  id: "u1",
  email: "a@b.com",
  unsubscribed: false,
  unsubscribedAt: null,
  unsubscribeToken: "tok",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("subscriptionUnsubscribeService.byToken", () => {
  it("token 不存在 → user_not_found", async () => {
    userFindUnique.mockResolvedValueOnce(null);
    const out = await subscriptionUnsubscribeService.byToken({ token: "missing" });
    expect(out.status).toBe("user_not_found");
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("全局退订：第一次写入 unsubscribed=true，写 audit", async () => {
    userFindUnique.mockResolvedValueOnce({ ...baseUser });
    userUpdate.mockResolvedValueOnce({ ...baseUser, unsubscribed: true });
    const out = await subscriptionUnsubscribeService.byToken({ token: "tok" });
    expect(out.status).toBe("global_unsubscribed");
    if (out.status === "global_unsubscribed") {
      expect(out.alreadyUnsubscribed).toBe(false);
    }
    expect(userUpdate).toHaveBeenCalledOnce();
    expect(auditMock).toHaveBeenCalledOnce();
  });

  it("全局退订幂等：已退订时不再 update，但仍记录 audit", async () => {
    userFindUnique.mockResolvedValueOnce({
      ...baseUser,
      unsubscribed: true,
      unsubscribedAt: new Date(),
    });
    const out = await subscriptionUnsubscribeService.byToken({ token: "tok" });
    expect(out.status).toBe("global_unsubscribed");
    if (out.status === "global_unsubscribed") {
      expect(out.alreadyUnsubscribed).toBe(true);
    }
    expect(userUpdate).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledOnce();
  });

  it("分类退订：写入 UserSubscription.subscribed=false", async () => {
    userFindUnique.mockResolvedValueOnce({ ...baseUser });
    catFindUnique.mockResolvedValueOnce({
      id: "c1",
      slug: "marketing",
      isTransactional: false,
    });
    subUpsert.mockResolvedValueOnce({});
    const out = await subscriptionUnsubscribeService.byToken({
      token: "tok",
      categorySlug: "marketing",
    });
    expect(out.status).toBe("category_unsubscribed");
    expect(subUpsert).toHaveBeenCalledOnce();
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("交易类分类：静默忽略，不写 UserSubscription", async () => {
    userFindUnique.mockResolvedValueOnce({ ...baseUser });
    catFindUnique.mockResolvedValueOnce({
      id: "c2",
      slug: "transactional",
      isTransactional: true,
    });
    const out = await subscriptionUnsubscribeService.byToken({
      token: "tok",
      categorySlug: "transactional",
    });
    expect(out.status).toBe("category_ignored_transactional");
    expect(subUpsert).not.toHaveBeenCalled();
  });

  it("分类 slug 不存在 → category_not_found，不影响全局状态", async () => {
    userFindUnique.mockResolvedValueOnce({ ...baseUser });
    catFindUnique.mockResolvedValueOnce(null);
    const out = await subscriptionUnsubscribeService.byToken({
      token: "tok",
      categorySlug: "ghost",
    });
    expect(out.status).toBe("category_not_found");
    expect(userUpdate).not.toHaveBeenCalled();
    expect(subUpsert).not.toHaveBeenCalled();
  });
});
