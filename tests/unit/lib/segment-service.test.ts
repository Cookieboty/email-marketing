/**
 * Segment service 单元测试。
 *
 * 不连接 DB：mock repository、audit、prisma.campaign。
 * 重点验证：
 *  - create / update：成功路径会同步重算 userCount + 写 lastCalculatedAt + 写 audit
 *  - 名称冲突 → ConflictError
 *  - 系统分群保护：不可删除；不可更新 conditions/name
 *  - 引用保护：被 Campaign 引用时删除返回 ConflictError
 *  - refresh：刷新单个分群并落库
 *  - validate：返回 estimatedUserCount；非法树抛 ValidationError
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(),
  auditNow: vi.fn(async () => { }),
  maskDetails: (x: unknown) => x,
}));

vi.mock("@/lib/modules/segment/repository", () => ({
  segmentRepository: {
    list: vi.fn(),
    findById: vi.fn(),
    findByName: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    countMatching: vi.fn(),
    previewMatching: vi.fn(),
  },
  parseStoredConditions: (x: unknown) => x,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    campaign: { count: vi.fn() },
  },
}));

import type { SegmentCondition } from "@/lib/modules/segment/conditions";
import { segmentService, recomputeSegmentCount } from "@/lib/modules/segment/service";
import { segmentRepository } from "@/lib/modules/segment/repository";
import { prisma } from "@/lib/prisma";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/lib/errors";

const repo = vi.mocked(segmentRepository);
const campaignCount = vi.mocked(prisma.campaign.count) as unknown as ReturnType<typeof vi.fn>;

const ctx = { actorType: "ADMIN" as const };

const validTree: SegmentCondition = {
  logic: "AND",
  conditions: [{ field: "userLevel", operator: "eq", value: "vip" }],
};

const fakeSegment = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: "s1",
  name: "VIP",
  description: null,
  conditions: validTree,
  isSystem: false,
  userCount: 0,
  lastCalculatedAt: new Date("2026-05-18T00:00:00Z"),
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("segmentService.create", () => {
  it("computes userCount, persists, and returns segment", async () => {
    repo.findByName.mockResolvedValue(null);
    repo.countMatching.mockResolvedValue(42);
    repo.create.mockResolvedValue(fakeSegment({ userCount: 42 }) as never);

    const out = await segmentService.create(
      { name: "VIP", description: null, conditions: validTree },
      ctx,
    );
    expect(repo.countMatching).toHaveBeenCalledTimes(1);
    expect(repo.create).toHaveBeenCalledTimes(1);
    const data = repo.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(data.userCount).toBe(42);
    expect(data.isSystem).toBe(false);
    expect(data.lastCalculatedAt).toBeInstanceOf(Date);
    expect(out.userCount).toBe(42);
  });

  it("throws ConflictError when name exists", async () => {
    repo.findByName.mockResolvedValue(fakeSegment({ id: "other" }) as never);
    await expect(
      segmentService.create(
        { name: "VIP", description: null, conditions: validTree },
        ctx,
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(repo.create).not.toHaveBeenCalled();
  });
});

describe("segmentService.update", () => {
  it("rejects updating conditions on system segment", async () => {
    repo.findById.mockResolvedValue(fakeSegment({ isSystem: true }) as never);
    await expect(
      segmentService.update("s1", { conditions: validTree }, ctx),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("allows updating description on system segment", async () => {
    repo.findById.mockResolvedValue(fakeSegment({ isSystem: true }) as never);
    repo.update.mockResolvedValue(
      fakeSegment({ isSystem: true, description: "x" }) as never,
    );
    const out = await segmentService.update("s1", { description: "x" }, ctx);
    expect(repo.update).toHaveBeenCalledTimes(1);
    expect(out.description).toBe("x");
  });

  it("recomputes count when conditions change", async () => {
    repo.findById.mockResolvedValue(fakeSegment() as never);
    repo.findByName.mockResolvedValue(null);
    repo.countMatching.mockResolvedValue(7);
    repo.update.mockResolvedValue(fakeSegment({ userCount: 7 }) as never);

    await segmentService.update("s1", { conditions: validTree }, ctx);
    const data = repo.update.mock.calls[0]![1] as Record<string, unknown>;
    expect(data.userCount).toBe(7);
    expect(data.lastCalculatedAt).toBeInstanceOf(Date);
  });

  it("does not recompute count when only name changes", async () => {
    repo.findById.mockResolvedValue(fakeSegment() as never);
    repo.findByName.mockResolvedValue(null);
    repo.update.mockResolvedValue(fakeSegment({ name: "VIP2" }) as never);

    await segmentService.update("s1", { name: "VIP2" }, ctx);
    expect(repo.countMatching).not.toHaveBeenCalled();
  });

  it("rejects renaming to an existing name owned by another segment", async () => {
    repo.findById.mockResolvedValue(fakeSegment() as never);
    repo.findByName.mockResolvedValue(fakeSegment({ id: "other", name: "Other" }) as never);
    await expect(
      segmentService.update("s1", { name: "Other" }, ctx),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("segmentService.delete", () => {
  it("throws NotFoundError when missing", async () => {
    repo.findById.mockResolvedValue(null);
    await expect(segmentService.delete("missing", ctx)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("throws ForbiddenError for system segment", async () => {
    repo.findById.mockResolvedValue(fakeSegment({ isSystem: true }) as never);
    await expect(segmentService.delete("s1", ctx)).rejects.toBeInstanceOf(ForbiddenError);
    expect(repo.delete).not.toHaveBeenCalled();
  });

  it("throws ConflictError when referenced by campaigns", async () => {
    repo.findById.mockResolvedValue(fakeSegment() as never);
    campaignCount.mockResolvedValue(2);
    await expect(segmentService.delete("s1", ctx)).rejects.toBeInstanceOf(ConflictError);
    expect(repo.delete).not.toHaveBeenCalled();
  });

  it("deletes when not referenced", async () => {
    repo.findById.mockResolvedValue(fakeSegment() as never);
    campaignCount.mockResolvedValue(0);
    repo.delete.mockResolvedValue();
    await segmentService.delete("s1", ctx);
    expect(repo.delete).toHaveBeenCalledWith("s1");
  });
});

describe("segmentService.refresh / recomputeSegmentCount", () => {
  it("computes count and writes lastCalculatedAt", async () => {
    repo.findById.mockResolvedValue(fakeSegment() as never);
    repo.countMatching.mockResolvedValue(13);
    const updated = fakeSegment({
      userCount: 13,
      lastCalculatedAt: new Date("2026-06-01T00:00:00Z"),
    });
    repo.update.mockResolvedValue(updated as never);

    const out = await recomputeSegmentCount("s1");
    expect(out.userCount).toBe(13);
    expect(out.lastCalculatedAt).toEqual(new Date("2026-06-01T00:00:00Z"));
    const data = repo.update.mock.calls[0]![1] as Record<string, unknown>;
    expect(data.userCount).toBe(13);
    expect(data.lastCalculatedAt).toBeInstanceOf(Date);
  });

  it("refresh writes audit entry", async () => {
    repo.findById.mockResolvedValue(fakeSegment() as never);
    repo.countMatching.mockResolvedValue(5);
    repo.update.mockResolvedValue(
      fakeSegment({ userCount: 5, lastCalculatedAt: new Date() }) as never,
    );
    const result = await segmentService.refresh("s1", ctx);
    expect(result.userCount).toBe(5);
  });
});

describe("segmentService.validate", () => {
  it("returns estimatedUserCount on valid tree", async () => {
    repo.countMatching.mockResolvedValue(99);
    const out = await segmentService.validate(validTree);
    expect(out).toEqual({ valid: true, estimatedUserCount: 99 });
  });

  it("throws ValidationError on malformed tree", async () => {
    await expect(
      segmentService.validate({ logic: "AND", conditions: [] }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(repo.countMatching).not.toHaveBeenCalled();
  });
});
