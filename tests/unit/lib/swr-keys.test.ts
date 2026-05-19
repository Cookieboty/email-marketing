import { describe, it, expect } from "vitest";
import { swrKeys } from "@/lib/swr-keys";

describe("swr-keys", () => {
  it("users 无参数返回根路径", () => {
    expect(swrKeys.users()).toBe("/api/users");
  });

  it("users 过滤 undefined / 空串", () => {
    expect(swrKeys.users({ q: "abc", page: 1, tagId: undefined, foo: "" })).toBe(
      "/api/users?q=abc&page=1",
    );
  });

  it("templates 拼接 status + cursor", () => {
    expect(swrKeys.templates({ status: "ARCHIVED", cursor: "c1" })).toBe(
      "/api/templates?status=ARCHIVED&cursor=c1",
    );
  });

  it("media 不带参数", () => {
    expect(swrKeys.media()).toBe("/api/media");
  });

  it("详情 key 含 id", () => {
    expect(swrKeys.user("u1")).toBe("/api/users/u1");
    expect(swrKeys.template("t1")).toBe("/api/templates/t1");
    expect(swrKeys.tagUsers("g1")).toBe("/api/tags/g1/users");
  });
});
