/**
 * 用户/标签 zod schema 边界测试。
 *
 * 不接 DB，仅校验输入规范化与拒绝路径，确保 service 拿到的输入是干净的。
 */

import { describe, it, expect } from "vitest";
import {
  CreateUserSchema,
  UpdateUserSchema,
  ListUsersQuerySchema,
  AddTagsSchema,
  SetTagsSchema,
} from "@/lib/modules/user/schema";
import {
  CreateTagSchema,
  UpdateTagSchema,
  ListTagsQuerySchema,
} from "@/lib/modules/tag/schema";

describe("CreateUserSchema", () => {
  it("requires a valid email", () => {
    expect(() => CreateUserSchema.parse({ email: "not-an-email" })).toThrow();
  });

  it("accepts minimal valid input", () => {
    const out = CreateUserSchema.parse({ email: "a@example.com" });
    expect(out.email).toBe("a@example.com");
  });

  it("accepts zh/en locale", () => {
    expect(CreateUserSchema.parse({ email: "a@example.com", locale: "zh" }).locale).toBe("zh");
    expect(CreateUserSchema.parse({ email: "a@example.com", locale: "en" }).locale).toBe("en");
  });

  it("rejects region locale aliases", () => {
    expect(() =>
      CreateUserSchema.parse({ email: "a@example.com", locale: "zh-CN" }),
    ).toThrow();
  });

  it("rejects negative totalSpend", () => {
    expect(() =>
      CreateUserSchema.parse({ email: "a@example.com", totalSpend: -1 }),
    ).toThrow();
  });

  it("accepts string-form totalSpend (decimal-friendly)", () => {
    const out = CreateUserSchema.parse({ email: "a@example.com", totalSpend: "12.5" });
    expect(out.totalSpend).toBe("12.5");
  });

  it("rejects externalId longer than 128", () => {
    expect(() =>
      CreateUserSchema.parse({ email: "a@example.com", externalId: "x".repeat(129) }),
    ).toThrow();
  });

  it("accepts ISO datetime for lastOrderAt", () => {
    const out = CreateUserSchema.parse({
      email: "a@example.com",
      lastOrderAt: "2026-05-17T08:00:00.000Z",
    });
    expect(out.lastOrderAt).toBeInstanceOf(Date);
  });
});

describe("UpdateUserSchema", () => {
  it("rejects unknown keys (strict)", () => {
    expect(() =>
      UpdateUserSchema.parse({ name: "x", evil: 1 } as unknown as Record<string, unknown>),
    ).toThrow();
  });

  it("rejects negative orderCount", () => {
    expect(() => UpdateUserSchema.parse({ orderCount: -1 })).toThrow();
  });

  it("allows clearing locale", () => {
    const out = UpdateUserSchema.parse({ locale: null });
    expect(out.locale).toBeNull();
  });
});

describe("ListUsersQuerySchema", () => {
  it("applies sane defaults", () => {
    const q = ListUsersQuerySchema.parse({});
    expect(q.page).toBe(1);
    expect(q.pageSize).toBe(20);
    expect(q.sortBy).toBe("createdAt");
    expect(q.sortDir).toBe("desc");
    expect(q.tagFilterMode).toBe("all");
  });

  it("coerces string numbers", () => {
    const q = ListUsersQuerySchema.parse({ page: "2", pageSize: "50" });
    expect(q.page).toBe(2);
    expect(q.pageSize).toBe(50);
  });

  it("clamps pageSize at 200", () => {
    expect(() => ListUsersQuerySchema.parse({ pageSize: "201" })).toThrow();
  });

  it("transforms unsubscribed to boolean", () => {
    const a = ListUsersQuerySchema.parse({ unsubscribed: "true" });
    const b = ListUsersQuerySchema.parse({ unsubscribed: "false" });
    expect(a.unsubscribed).toBe(true);
    expect(b.unsubscribed).toBe(false);
  });
});

describe("AddTagsSchema / SetTagsSchema", () => {
  it("AddTagsSchema requires at least one id", () => {
    expect(() => AddTagsSchema.parse({ tagIds: [] })).toThrow();
  });

  it("SetTagsSchema accepts empty array (clears tags)", () => {
    const out = SetTagsSchema.parse({ tagIds: [] });
    expect(out.tagIds).toEqual([]);
  });

  it("rejects more than 100 ids", () => {
    const tagIds = Array.from({ length: 101 }, (_, i) => `id-${i}`);
    expect(() => SetTagsSchema.parse({ tagIds })).toThrow();
  });
});

describe("CreateTagSchema", () => {
  it("trims name", () => {
    const out = CreateTagSchema.parse({ name: "  vip  " });
    expect(out.name).toBe("vip");
  });

  it("rejects empty name", () => {
    expect(() => CreateTagSchema.parse({ name: "   " })).toThrow();
  });

  it("rejects too-long name", () => {
    expect(() => CreateTagSchema.parse({ name: "x".repeat(65) })).toThrow();
  });

  it("accepts #RGB / #RRGGBB color, rejects invalid color", () => {
    expect(CreateTagSchema.parse({ name: "x", color: "#fff" }).color).toBe("#fff");
    expect(CreateTagSchema.parse({ name: "x", color: "#aabbcc" }).color).toBe("#aabbcc");
    expect(() => CreateTagSchema.parse({ name: "x", color: "red" })).toThrow();
  });

  it("treats null color as undefined", () => {
    const out = CreateTagSchema.parse({ name: "x", color: null });
    expect(out.color).toBeUndefined();
  });
});

describe("UpdateTagSchema", () => {
  it("requires at least one field", () => {
    expect(() => UpdateTagSchema.parse({})).toThrow();
  });

  it("rejects unknown keys (strict)", () => {
    expect(() =>
      UpdateTagSchema.parse({ name: "x", evil: true } as unknown as Record<string, unknown>),
    ).toThrow();
  });
});

describe("ListTagsQuerySchema", () => {
  it("applies defaults", () => {
    const q = ListTagsQuerySchema.parse({});
    expect(q.page).toBe(1);
    expect(q.pageSize).toBe(50);
  });

  it("coerces string numbers", () => {
    const q = ListTagsQuerySchema.parse({ page: "3", pageSize: "10" });
    expect(q.page).toBe(3);
    expect(q.pageSize).toBe(10);
  });
});
