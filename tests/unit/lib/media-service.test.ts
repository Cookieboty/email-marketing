/**
 * 媒体 service 单元测试。
 *
 * Mock：repository / audit / storage 写盘 - 读盘 - 删盘 / env(UPLOAD_DIR)。
 * 覆盖：
 *   - upload：去重命中（不写盘）/ 新建（落盘 + 回填 url）/ 落盘失败 → 撤销 DB 记录
 *   - update：仅 alt / 仅 tags / NotFound
 *   - delete：DB delete + 物理删除（ENOENT 容忍）
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(),
  auditNow: vi.fn(async () => { }),
  maskDetails: (x: unknown) => x,
}));

vi.mock("@/lib/env", () => ({
  env: () => ({ UPLOAD_DIR: "/tmp/email-test-uploads" }),
}));

vi.mock("@/lib/modules/media/repository", () => ({
  mediaRepository: {
    list: vi.fn(),
    findById: vi.fn(),
    findBySha256: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("@/lib/modules/media/storage", async () => {
  const actual = await vi.importActual<typeof import("@/lib/modules/media/storage")>(
    "@/lib/modules/media/storage",
  );
  return {
    ...actual,
    writeUpload: vi.fn(async () => "/tmp/x.png"),
    deleteUpload: vi.fn(async () => { }),
    readUpload: vi.fn(async () => Buffer.from([0])),
  };
});

import { mediaService } from "@/lib/modules/media/service";
import { mediaRepository } from "@/lib/modules/media/repository";
import * as storage from "@/lib/modules/media/storage";
import { NotFoundError, ValidationError } from "@/lib/errors";

const repo = vi.mocked(mediaRepository);
const writeUpload = vi.mocked(storage.writeUpload);
const deleteUpload = vi.mocked(storage.deleteUpload);

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=",
  "base64",
);

const ctx = { actorType: "ADMIN" as const, adminId: "admin-1" };

const fakeAsset = (overrides: Partial<{ id: string; mimeType: string; sha256: string; url: string }> = {}) => ({
  id: overrides.id ?? "m1",
  filename: "logo.png",
  mimeType: overrides.mimeType ?? "image/png",
  size: PNG_1x1.length,
  url: overrides.url ?? "",
  width: 1,
  height: 1,
  alt: null,
  tags: [],
  sha256: overrides.sha256 ?? "abc",
  createdBy: "admin-1",
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe("mediaService.upload", () => {
  beforeEach(() => {
    repo.findBySha256.mockReset();
    repo.create.mockReset();
    repo.update.mockReset();
    repo.delete.mockReset();
    writeUpload.mockReset();
    writeUpload.mockResolvedValue("/tmp/x.png");
  });

  it("非法格式抛 ValidationError", async () => {
    await expect(
      mediaService.upload(
        { filename: "a.txt", buffer: Buffer.from("hello world plain text") },
        { tags: [] },
        ctx,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("sha256 命中 → 返回旧记录，不写盘", async () => {
    const old = fakeAsset({ id: "m-old", url: "/api/media/m-old/file" });
    repo.findBySha256.mockResolvedValue(old as never);
    const res = await mediaService.upload(
      { filename: "logo.png", declaredMime: "image/png", buffer: PNG_1x1 },
      { tags: [] },
      ctx,
    );
    expect(res.deduped).toBe(true);
    expect(res.asset.id).toBe("m-old");
    expect(repo.create).not.toHaveBeenCalled();
    expect(writeUpload).not.toHaveBeenCalled();
  });

  it("新建：DB create → writeUpload → 回填 url", async () => {
    repo.findBySha256.mockResolvedValue(null);
    repo.create.mockResolvedValue(fakeAsset({ id: "m-new" }) as never);
    repo.update.mockImplementation(async (_id, data) =>
      ({ ...fakeAsset({ id: "m-new" }), url: (data as { url: string }).url }) as never,
    );
    const res = await mediaService.upload(
      { filename: "logo.png", declaredMime: "image/png", buffer: PNG_1x1 },
      { tags: ["a", "A", "b"] },
      ctx,
    );
    expect(res.deduped).toBe(false);
    expect(res.asset.url).toBe("/api/media/m-new/file");
    expect(writeUpload).toHaveBeenCalledTimes(1);
    const created = repo.create.mock.calls[0]![0]!;
    expect(created.tags).toEqual(["a", "b"]);
    expect(created.createdBy).toBe("admin-1");
    expect(created.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("落盘失败 → 撤销 DB 记录并冒泡", async () => {
    repo.findBySha256.mockResolvedValue(null);
    repo.create.mockResolvedValue(fakeAsset({ id: "m-broken" }) as never);
    repo.delete.mockResolvedValue();
    writeUpload.mockRejectedValue(new Error("disk full"));
    await expect(
      mediaService.upload(
        { filename: "logo.png", declaredMime: "image/png", buffer: PNG_1x1 },
        { tags: [] },
        ctx,
      ),
    ).rejects.toThrow(/disk full/);
    expect(repo.delete).toHaveBeenCalledWith("m-broken");
  });
});

describe("mediaService.update", () => {
  beforeEach(() => {
    repo.findById.mockReset();
    repo.update.mockReset();
  });

  it("NotFound 抛错", async () => {
    repo.findById.mockResolvedValue(null);
    await expect(mediaService.update("x", { alt: "y" }, ctx)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("alt 单独更新", async () => {
    repo.findById.mockResolvedValue(fakeAsset() as never);
    repo.update.mockResolvedValue(fakeAsset() as never);
    await mediaService.update("m1", { alt: "logo" }, ctx);
    const data = repo.update.mock.calls[0]![1] as { alt?: string; tags?: { set: string[] } };
    expect(data.alt).toBe("logo");
    expect(data.tags).toBeUndefined();
  });

  it("tags 归一化（trim + 去重保留首次大小写）", async () => {
    repo.findById.mockResolvedValue(fakeAsset() as never);
    repo.update.mockResolvedValue(fakeAsset() as never);
    await mediaService.update("m1", { tags: [" a", "A", "b ", "b"] }, ctx);
    const data = repo.update.mock.calls[0]![1] as { tags: { set: string[] } };
    expect(data.tags.set).toEqual(["a", "b"]);
  });

  it("alt=null 表示清空", async () => {
    repo.findById.mockResolvedValue(fakeAsset() as never);
    repo.update.mockResolvedValue(fakeAsset() as never);
    await mediaService.update("m1", { alt: null }, ctx);
    const data = repo.update.mock.calls[0]![1] as { alt: unknown };
    expect(data.alt).toBeNull();
  });
});

describe("mediaService.delete", () => {
  beforeEach(() => {
    repo.findById.mockReset();
    repo.delete.mockReset();
    deleteUpload.mockReset();
  });

  it("NotFound 抛错", async () => {
    repo.findById.mockResolvedValue(null);
    await expect(mediaService.delete("x", ctx)).rejects.toBeInstanceOf(NotFoundError);
    expect(repo.delete).not.toHaveBeenCalled();
    expect(deleteUpload).not.toHaveBeenCalled();
  });

  it("DB delete + 物理删除", async () => {
    repo.findById.mockResolvedValue(fakeAsset() as never);
    repo.delete.mockResolvedValue();
    deleteUpload.mockResolvedValue();
    await mediaService.delete("m1", ctx);
    expect(repo.delete).toHaveBeenCalledWith("m1");
    expect(deleteUpload).toHaveBeenCalledTimes(1);
  });

  it("物理删除失败仅记日志，不冒泡", async () => {
    repo.findById.mockResolvedValue(fakeAsset() as never);
    repo.delete.mockResolvedValue();
    deleteUpload.mockRejectedValue(new Error("io error"));
    await expect(mediaService.delete("m1", ctx)).resolves.toBeUndefined();
  });
});

afterEach(() => {
  vi.clearAllMocks();
});
