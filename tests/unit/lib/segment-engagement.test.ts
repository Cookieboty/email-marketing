/**
 * engagementScore 单元测试。
 *
 * 公式来自 specs/modules/user-management.md §498-526：
 *   raw   = openedLast30d*2 + clickedLast30d*5 + totalOpens*0.1 + totalClicks*0.3
 *   decay = max(0, 1 - lastActivityDays / 180)
 *   score = clamp(0,100, round(round(raw*decay,1)))   // 我们存 Int
 *
 * 这里只测纯函数 computeEngagementScore + recomputeAllUsers 的分页/错误聚合，
 * DB 层（aggregateUserActivity / recomputeForUser）通过 mock prisma 验证关键 where 条件。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    campaignRecipient: {
      count: vi.fn(),
    },
    emailEvent: {
      count: vi.fn(),
    },
  },
}));

import { prisma } from "@/lib/prisma";
import {
  aggregateUserActivity,
  computeEngagementScore,
  recomputeAllUsers,
  recomputeForUser,
} from "@/lib/modules/segment/engagement";

const userFindMany = vi.mocked(prisma.user.findMany) as unknown as ReturnType<typeof vi.fn>;
const userFindUnique = vi.mocked(prisma.user.findUnique) as unknown as ReturnType<typeof vi.fn>;
const userUpdateMany = vi.mocked(prisma.user.updateMany) as unknown as ReturnType<typeof vi.fn>;
const recipientCount = vi.mocked(prisma.campaignRecipient.count) as unknown as ReturnType<
  typeof vi.fn
>;
const eventCount = vi.mocked(prisma.emailEvent.count) as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("computeEngagementScore", () => {
  it("returns 0 when no activity ever (lastActivityDays=null)", () => {
    expect(
      computeEngagementScore({
        openedLast30d: 5,
        clickedLast30d: 5,
        totalOpens: 100,
        totalClicks: 100,
        lastActivityDays: null,
      }),
    ).toBe(0);
  });

  it("decays linearly to 0 at 180 days", () => {
    const score = computeEngagementScore({
      openedLast30d: 0,
      clickedLast30d: 0,
      totalOpens: 100,
      totalClicks: 100,
      lastActivityDays: 180,
    });
    expect(score).toBe(0);
  });

  it("recent opens dominate when lastActivityDays=0", () => {
    // raw = 5*2 + 0 + 0 + 0 = 10, decay=1, score=10
    expect(
      computeEngagementScore({
        openedLast30d: 5,
        clickedLast30d: 0,
        totalOpens: 5,
        totalClicks: 0,
        lastActivityDays: 0,
      }),
    ).toBeGreaterThanOrEqual(10);
  });

  it("clamps to 100 for extreme inputs", () => {
    expect(
      computeEngagementScore({
        openedLast30d: 1000,
        clickedLast30d: 1000,
        totalOpens: 10000,
        totalClicks: 10000,
        lastActivityDays: 0,
      }),
    ).toBe(100);
  });

  it("applies 50% decay at 90 days", () => {
    // raw = 0 + 5*5 + 0 + 0 = 25, decay=0.5 → 12.5 → round 13
    const score = computeEngagementScore({
      openedLast30d: 0,
      clickedLast30d: 5,
      totalOpens: 0,
      totalClicks: 0,
      lastActivityDays: 90,
    });
    expect(score).toBe(13);
  });

  it("never returns negative for absurd inputs", () => {
    expect(
      computeEngagementScore({
        openedLast30d: 0,
        clickedLast30d: 0,
        totalOpens: 0,
        totalClicks: 0,
        lastActivityDays: 9999,
      }),
    ).toBe(0);
  });
});

describe("aggregateUserActivity", () => {
  it("returns null when user not found", async () => {
    userFindUnique.mockResolvedValueOnce(null);
    const out = await aggregateUserActivity("missing");
    expect(out).toBeNull();
  });

  it("uses CampaignRecipient counts for last 30 days and EmailEvent for totals", async () => {
    const now = new Date("2026-05-18T00:00:00.000Z");
    userFindUnique.mockResolvedValueOnce({
      id: "u1",
      lastEmailOpenedAt: new Date("2026-05-17T00:00:00.000Z"), // 1 day ago
      lastEmailClickedAt: null,
    });
    recipientCount.mockResolvedValueOnce(3); // openedLast30d
    recipientCount.mockResolvedValueOnce(1); // clickedLast30d
    eventCount.mockResolvedValueOnce(50); // totalOpens
    eventCount.mockResolvedValueOnce(10); // totalClicks

    const out = await aggregateUserActivity("u1", now);
    expect(out).toEqual({
      openedLast30d: 3,
      clickedLast30d: 1,
      totalOpens: 50,
      totalClicks: 10,
      lastActivityDays: 1,
    });

    // 校验 30d 边界传给 prisma 的 where
    const recipientWhere = recipientCount.mock.calls[0][0]?.where;
    expect(recipientWhere.userId).toBe("u1");
    expect(recipientWhere.openedAt.gte).toBeInstanceOf(Date);
    // 校验 emailEvent 的 type 与 user 关联
    expect(eventCount.mock.calls[0][0]?.where).toEqual({
      type: "opened",
      campaignRecipient: { userId: "u1" },
    });
  });

  it("treats no last-activity timestamps as null (full decay)", async () => {
    userFindUnique.mockResolvedValueOnce({
      id: "u2",
      lastEmailOpenedAt: null,
      lastEmailClickedAt: null,
    });
    recipientCount.mockResolvedValueOnce(0);
    recipientCount.mockResolvedValueOnce(0);
    eventCount.mockResolvedValueOnce(0);
    eventCount.mockResolvedValueOnce(0);

    const out = await aggregateUserActivity("u2", new Date());
    expect(out?.lastActivityDays).toBeNull();
  });
});

describe("recomputeForUser", () => {
  it("only writes when score actually changes (uses updateMany guard)", async () => {
    userFindUnique.mockResolvedValueOnce({
      id: "u3",
      lastEmailOpenedAt: new Date(),
      lastEmailClickedAt: null,
    });
    recipientCount.mockResolvedValue(0);
    eventCount.mockResolvedValue(0);
    userUpdateMany.mockResolvedValue({ count: 0 });

    const score = await recomputeForUser("u3");
    expect(score).toBe(0);
    // updateMany 调用且 where 含 not 等于当前分值（数据库层避免无变化写入）
    expect(userUpdateMany).toHaveBeenCalledTimes(1);
    const arg = userUpdateMany.mock.calls[0][0];
    expect(arg.where.id).toBe("u3");
    expect(arg.where.engagementScore).toEqual({ not: 0 });
    expect(arg.data).toEqual({ engagementScore: 0 });
  });

  it("returns null when user does not exist", async () => {
    userFindUnique.mockResolvedValueOnce(null);
    const score = await recomputeForUser("missing");
    expect(score).toBeNull();
    expect(userUpdateMany).not.toHaveBeenCalled();
  });
});

describe("recomputeAllUsers", () => {
  it("paginates by id cursor and counts processed/updated/failed", async () => {
    // 第一页 2 条，第二页 1 条，第三页空
    userFindMany
      .mockResolvedValueOnce([{ id: "a" }, { id: "b" }])
      .mockResolvedValueOnce([{ id: "c" }])
      .mockResolvedValueOnce([]);

    // 每个 user 评分流程：
    //   1) findUnique({select: engagementScore})  → before
    //   2) recomputeForUser → 内部再 findUnique(...lastEmail*) + 4 个 count + updateMany
    // 我们简化 mock 顺序：
    userFindUnique.mockImplementation(async ({ select }) => {
      // before snapshot
      if (select && (select as { engagementScore?: boolean }).engagementScore) {
        return { engagementScore: 0 };
      }
      return {
        id: "x",
        lastEmailOpenedAt: null,
        lastEmailClickedAt: null,
      };
    });
    recipientCount.mockResolvedValue(0);
    eventCount.mockResolvedValue(0);
    userUpdateMany.mockResolvedValue({ count: 0 });

    const result = await recomputeAllUsers({ pageSize: 2 });
    expect(result.processed).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.updated).toBe(0);
    expect(userFindMany).toHaveBeenCalledTimes(3);
    // 第二次调用使用 cursor 分页
    expect(userFindMany.mock.calls[1][0]).toMatchObject({
      take: 2,
      skip: 1,
      cursor: { id: "b" },
    });
  });

  it("isolates per-user errors and increments failed count", async () => {
    userFindMany
      .mockResolvedValueOnce([{ id: "a" }, { id: "b" }])
      .mockResolvedValueOnce([]);
    // 第一个 user before 拿到，但 recomputeForUser 内 findUnique 抛错
    let call = 0;
    userFindUnique.mockImplementation(async () => {
      call += 1;
      if (call === 2) throw new Error("boom");
      return { engagementScore: 0 };
    });
    recipientCount.mockResolvedValue(0);
    eventCount.mockResolvedValue(0);
    userUpdateMany.mockResolvedValue({ count: 0 });

    const onError = vi.fn();
    const result = await recomputeAllUsers({ pageSize: 2, onError });
    expect(result.processed + result.failed).toBe(2);
    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(onError).toHaveBeenCalled();
  });
});
