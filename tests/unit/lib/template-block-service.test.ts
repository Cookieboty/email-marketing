/**
 * 模板片段 service 单元测试。
 *
 * 不接 DB：通过 vi.mock 替换 repository 与 audit/prisma，验证 service 的：
 *   - create：sanitize + extractVariables 写库 + audit
 *   - update：isSystem 拒绝；htmlContent 修改时 variables 同步更新
 *   - delete：isSystem 拒绝；NotFound 抛出
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(),
  auditNow: vi.fn(async () => {}),
  maskDetails: (x: unknown) => x,
}));
vi.mock("@/lib/modules/template-block/repository", () => ({
  templateBlockRepository: {
    list: vi.fn(),
    findById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

import { templateBlockService } from "@/lib/modules/template-block/service";
import { templateBlockRepository } from "@/lib/modules/template-block/repository";
import { ConflictError, ForbiddenError, NotFoundError } from "@/lib/errors";

const repo = vi.mocked(templateBlockRepository);

const ctx = { actorType: "ADMIN" as const };

const fakeBlock = (overrides: Partial<{ isSystem: boolean }> = {}) => ({
  id: "b1",
  name: "Footer",
  category: null,
  locale: "zh",
  htmlContent: "<footer>{{x}}</footer>",
  variables: ["x"],
  isSystem: overrides.isSystem ?? false,
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe("templateBlockService.create", () => {
  beforeEach(() => {
    repo.create.mockReset();
    repo.create.mockResolvedValue(fakeBlock() as never);
  });
  it("sanitizes HTML and extracts variables before persisting", async () => {
    await templateBlockService.create(
      {
        name: "Footer",
        category: null,
        locale: "en",
        htmlContent: `<footer><script>x</script>Hi {{user_name}}</footer>`,
      },
      ctx,
    );
    expect(repo.create).toHaveBeenCalledTimes(1);
    const data = repo.create.mock.calls[0]![0];
    expect(data.htmlContent).not.toMatch(/<script/i);
    expect(data.variables).toEqual(["user_name"]);
    expect(data.isSystem).toBe(false);
    expect(data.locale).toBe("en");
  });
});

describe("templateBlockService.update", () => {
  afterEach(() => vi.clearAllMocks());
  it("throws NotFoundError when missing", async () => {
    repo.findById.mockResolvedValue(null);
    await expect(
      templateBlockService.update("missing", { name: "x" }, ctx),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
  it("throws ConflictError when block is system", async () => {
    repo.findById.mockResolvedValue(fakeBlock({ isSystem: true }) as never);
    await expect(
      templateBlockService.update("b1", { name: "x" }, ctx),
    ).rejects.toBeInstanceOf(ConflictError);
  });
  it("recomputes variables when htmlContent changes", async () => {
    repo.findById.mockResolvedValue(fakeBlock() as never);
    repo.update.mockResolvedValue(fakeBlock() as never);
    await templateBlockService.update(
      "b1",
      { htmlContent: "<p>{{a}} {{b}}</p>" },
      ctx,
    );
    const data = repo.update.mock.calls[0]![1];
    expect(data.variables).toEqual({ set: ["a", "b"] });
  });

  it("passes locale updates to repository", async () => {
    repo.findById.mockResolvedValue(fakeBlock() as never);
    repo.update.mockResolvedValue(fakeBlock() as never);
    await templateBlockService.update("b1", { locale: "en" }, ctx);
    const data = repo.update.mock.calls[0]![1];
    expect(data.locale).toBe("en");
  });
});

describe("templateBlockService.delete", () => {
  afterEach(() => vi.clearAllMocks());
  it("throws NotFoundError when missing", async () => {
    repo.findById.mockResolvedValue(null);
    await expect(templateBlockService.delete("x", ctx)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
  it("throws ForbiddenError when block is system", async () => {
    repo.findById.mockResolvedValue(fakeBlock({ isSystem: true }) as never);
    await expect(
      templateBlockService.delete("b1", ctx),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(repo.delete).not.toHaveBeenCalled();
  });
  it("delegates to repository for non-system blocks", async () => {
    repo.findById.mockResolvedValue(fakeBlock() as never);
    repo.delete.mockResolvedValue();
    await templateBlockService.delete("b1", ctx);
    expect(repo.delete).toHaveBeenCalledWith("b1");
  });
});
