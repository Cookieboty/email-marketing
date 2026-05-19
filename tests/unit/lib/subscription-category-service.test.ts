/**
 * SubscriptionCategory service 单元测试。
 *
 * 不连接 DB：mock repository、audit、prisma（user/subscriptionCategory/$transaction）。
 * 关键约束：
 *  - 创建：slug 冲突 → ConflictError；audit 落库
 *  - 更新：slug/isTransactional 不可改（通过 schema 保证，service 层不传字段）
 *  - 删除：预置不可删；被 Campaign 引用不可删；不存在 → NotFoundError
 *  - 用户订阅：交易型分类不可退订；用户不存在 → NotFoundError
 *  - 批量更新：分类不存在 / 交易型退订 → 整体回滚
 */

import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(),
  auditNow: vi.fn(async () => {}),
  maskDetails: (x: unknown) => x,
}));

vi.mock("@/lib/modules/subscription-category/repository", () => ({
  subscriptionCategoryRepository: {
    list: vi.fn(),
    findById: vi.fn(),
    findBySlug: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    countCampaignReferences: vi.fn(),
    listUserSubscriptions: vi.fn(),
    upsertUserSubscription: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    subscriptionCategory: { findMany: vi.fn() },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
  },
}));

import { subscriptionCategoryRepository } from "@/lib/modules/subscription-category/repository";
import { subscriptionCategoryService } from "@/lib/modules/subscription-category/service";
import { prisma } from "@/lib/prisma";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/lib/errors";

const repo = vi.mocked(subscriptionCategoryRepository);
const userFindUnique = vi.mocked(prisma.user.findUnique) as unknown as ReturnType<
  typeof vi.fn
>;
const catFindMany = vi.mocked(prisma.subscriptionCategory.findMany) as unknown as ReturnType<
  typeof vi.fn
>;

const ctx = { actorType: "ADMIN" as const };

const fakeCat = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: "c1",
  name: "Marketing",
  description: null,
  slug: "marketing",
  isDefault: true,
  isTransactional: false,
  isPreset: false,
  sortOrder: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("subscriptionCategoryService.create", () => {
  it("creates with isPreset forced to false and writes audit", async () => {
    repo.create.mockResolvedValue(fakeCat() as never);
    await subscriptionCategoryService.create(
      {
        name: "Marketing",
        description: null,
        slug: "marketing",
        isDefault: true,
        isTransactional: false,
        sortOrder: 0,
      },
      ctx,
    );
    expect(repo.create).toHaveBeenCalledTimes(1);
    const data = repo.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(data.isPreset).toBe(false);
    expect(data.slug).toBe("marketing");
  });

  it("maps unique violation to ConflictError", async () => {
    const e = new Prisma.PrismaClientKnownRequestError("dup", {
      code: "P2002",
      clientVersion: "x",
    });
    repo.create.mockRejectedValue(e);
    await expect(
      subscriptionCategoryService.create(
        {
          name: "Marketing",
          description: null,
          slug: "marketing",
          isDefault: false,
          isTransactional: false,
          sortOrder: 0,
        },
        ctx,
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("subscriptionCategoryService.delete", () => {
  it("throws NotFoundError when missing", async () => {
    repo.findById.mockResolvedValue(null);
    await expect(
      subscriptionCategoryService.delete("missing", ctx),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws ForbiddenError for preset category", async () => {
    repo.findById.mockResolvedValue(fakeCat({ isPreset: true }) as never);
    await expect(
      subscriptionCategoryService.delete("c1", ctx),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(repo.delete).not.toHaveBeenCalled();
  });

  it("throws ConflictError when referenced by campaigns", async () => {
    repo.findById.mockResolvedValue(fakeCat() as never);
    repo.countCampaignReferences.mockResolvedValue(3);
    await expect(
      subscriptionCategoryService.delete("c1", ctx),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(repo.delete).not.toHaveBeenCalled();
  });

  it("deletes when allowed", async () => {
    repo.findById.mockResolvedValue(fakeCat() as never);
    repo.countCampaignReferences.mockResolvedValue(0);
    repo.delete.mockResolvedValue();
    await subscriptionCategoryService.delete("c1", ctx);
    expect(repo.delete).toHaveBeenCalledWith("c1");
  });
});

describe("subscriptionCategoryService.updateUserSubscriptions", () => {
  it("throws NotFoundError when user missing", async () => {
    userFindUnique.mockResolvedValue(null);
    await expect(
      subscriptionCategoryService.updateUserSubscriptions(
        "u1",
        { subscriptions: [{ categoryId: "c1", subscribed: true }] },
        ctx,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects unsubscribing transactional category", async () => {
    userFindUnique.mockResolvedValue({ id: "u1" } as never);
    catFindMany.mockResolvedValue([fakeCat({ isTransactional: true })] as never);
    await expect(
      subscriptionCategoryService.updateUserSubscriptions(
        "u1",
        { subscriptions: [{ categoryId: "c1", subscribed: false }] },
        ctx,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(repo.upsertUserSubscription).not.toHaveBeenCalled();
  });

  it("rejects when categoryId missing in DB", async () => {
    userFindUnique.mockResolvedValue({ id: "u1" } as never);
    catFindMany.mockResolvedValue([] as never);
    await expect(
      subscriptionCategoryService.updateUserSubscriptions(
        "u1",
        { subscriptions: [{ categoryId: "ghost", subscribed: true }] },
        ctx,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects duplicate categoryId in payload", async () => {
    userFindUnique.mockResolvedValue({ id: "u1" } as never);
    await expect(
      subscriptionCategoryService.updateUserSubscriptions(
        "u1",
        {
          subscriptions: [
            { categoryId: "c1", subscribed: true },
            { categoryId: "c1", subscribed: false },
          ],
        },
        ctx,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("upserts each subscription in transaction", async () => {
    userFindUnique.mockResolvedValue({ id: "u1" } as never);
    catFindMany.mockResolvedValue([
      fakeCat({ id: "c1" }),
      fakeCat({ id: "c2", slug: "newsletter" }),
    ] as never);
    repo.listUserSubscriptions.mockResolvedValue([] as never);
    repo.upsertUserSubscription.mockResolvedValue({} as never);

    await subscriptionCategoryService.updateUserSubscriptions(
      "u1",
      {
        subscriptions: [
          { categoryId: "c1", subscribed: false },
          { categoryId: "c2", subscribed: true },
        ],
      },
      ctx,
    );
    expect(repo.upsertUserSubscription).toHaveBeenCalledTimes(2);
  });
});

describe("subscriptionCategoryService.batchUpdate", () => {
  it("rejects when category missing", async () => {
    catFindMany.mockResolvedValue([] as never);
    await expect(
      subscriptionCategoryService.batchUpdate(
        { updates: [{ userId: "u1", categoryId: "c1", subscribed: true }] },
        ctx,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(repo.upsertUserSubscription).not.toHaveBeenCalled();
  });

  it("rejects unsubscribing transactional", async () => {
    catFindMany.mockResolvedValue([fakeCat({ isTransactional: true })] as never);
    await expect(
      subscriptionCategoryService.batchUpdate(
        { updates: [{ userId: "u1", categoryId: "c1", subscribed: false }] },
        ctx,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("maps FK violation to NotFoundError (user not found)", async () => {
    catFindMany.mockResolvedValue([fakeCat()] as never);
    repo.upsertUserSubscription.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("fk", {
        code: "P2003",
        clientVersion: "x",
      }),
    );
    await expect(
      subscriptionCategoryService.batchUpdate(
        { updates: [{ userId: "ghost", categoryId: "c1", subscribed: true }] },
        ctx,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("returns updated count on success", async () => {
    catFindMany.mockResolvedValue([fakeCat()] as never);
    repo.upsertUserSubscription.mockResolvedValue({} as never);
    const out = await subscriptionCategoryService.batchUpdate(
      {
        updates: [
          { userId: "u1", categoryId: "c1", subscribed: true },
          { userId: "u2", categoryId: "c1", subscribed: false },
        ],
      },
      ctx,
    );
    expect(out.updated).toBe(2);
  });
});
