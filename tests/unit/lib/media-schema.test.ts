/**
 * 媒体 schema 校验：聚焦 list 查询、PATCH 元数据、上传 multipart 字段。
 */

import { describe, expect, it } from "vitest";
import {
  ListMediaQuerySchema,
  UpdateMediaSchema,
  UploadMediaMetadataSchema,
} from "@/lib/modules/media/schema";

describe("ListMediaQuerySchema", () => {
  it("默认 page=1 / pageSize=20", () => {
    const r = ListMediaQuerySchema.parse({});
    expect(r.page).toBe(1);
    expect(r.pageSize).toBe(20);
  });

  it("接受字符串数字并 coerce", () => {
    const r = ListMediaQuerySchema.parse({ page: "3", pageSize: "50" });
    expect(r.page).toBe(3);
    expect(r.pageSize).toBe(50);
  });

  it("pageSize > 200 拒绝", () => {
    expect(() => ListMediaQuerySchema.parse({ pageSize: "300" })).toThrow();
  });
});

describe("UpdateMediaSchema", () => {
  it("空对象拒绝（至少一个字段）", () => {
    expect(() => UpdateMediaSchema.parse({})).toThrow();
  });

  it("alt + tags 同时给出", () => {
    const r = UpdateMediaSchema.parse({ alt: "logo", tags: ["a", "b"] });
    expect(r.alt).toBe("logo");
    expect(r.tags).toEqual(["a", "b"]);
  });

  it("alt 可为 null（清空语义）", () => {
    const r = UpdateMediaSchema.parse({ alt: null });
    expect(r.alt).toBeNull();
  });

  it("拒绝多余字段", () => {
    expect(() => UpdateMediaSchema.parse({ alt: "x", extra: 1 } as never)).toThrow();
  });
});

describe("UploadMediaMetadataSchema", () => {
  it("tags 字符串拆分为数组并 trim/去空", () => {
    const r = UploadMediaMetadataSchema.parse({ tags: "a, b ,, c" });
    expect(r.tags).toEqual(["a", "b", "c"]);
  });

  it("tags 缺省 / null / 空串 → 空数组", () => {
    expect(UploadMediaMetadataSchema.parse({}).tags).toEqual([]);
    expect(UploadMediaMetadataSchema.parse({ tags: null }).tags).toEqual([]);
    expect(UploadMediaMetadataSchema.parse({ tags: "" }).tags).toEqual([]);
  });

  it("alt null → undefined", () => {
    const r = UploadMediaMetadataSchema.parse({ alt: null });
    expect(r.alt).toBeUndefined();
  });
});
