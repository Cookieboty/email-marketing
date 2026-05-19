/**
 * Phase 10 outbound-importer：secrets / security / mapper / pagination 单元测试。
 *
 * 关联 spec：specs/modules/outbound-importer.md
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  __testing as securityTesting,
  assertSafeRequestUrl,
  validateTargetUrl,
} from "@/lib/modules/import/security";
import {
  validateFieldMapping,
  mapRow,
  getByJsonPath,
  __testing as mapperTesting,
} from "@/lib/modules/import/mapper";
import {
  buildRequestUrl,
  advanceState,
  parseNextFromLinkHeader,
  extractDataArray,
  initialState,
  serializeState,
  deserializeState,
  type ImportSourceLike,
} from "@/lib/modules/import/pagination";

beforeAll(() => {
  process.env.IMPORT_SOURCE_SECRET_KEY = "0123456789abcdef0123456789abcdef";
});

describe("outbound-importer / secrets", () => {
  it("encrypt → decrypt 还原", async () => {
    const { encryptSecret, decryptSecret } = await import("@/lib/modules/import/secrets");
    const enc1 = encryptSecret("super-secret-token");
    expect(enc1.split(":")).toHaveLength(3);
    expect(decryptSecret(enc1)).toBe("super-secret-token");
  });

  it("两次加密同一明文得到不同 ciphertext（随机 IV）", async () => {
    const { encryptSecret } = await import("@/lib/modules/import/secrets");
    const a = encryptSecret("hello");
    const b = encryptSecret("hello");
    expect(a).not.toBe(b);
  });

  it("篡改后解密抛错", async () => {
    const { encryptSecret, decryptSecret } = await import("@/lib/modules/import/secrets");
    const enc = encryptSecret("hello");
    const parts = enc.split(":");
    const tampered = `${parts[0]}:${parts[1]}00:${parts[2]}`;
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("malformed payload 抛错", async () => {
    const { decryptSecret } = await import("@/lib/modules/import/secrets");
    expect(() => decryptSecret("notvalid")).toThrow();
  });
});

describe("outbound-importer / security", () => {
  it("https 公网域名通过", () => {
    const u = validateTargetUrl("https://api.example.com/users");
    expect(u.host).toBe("api.example.com");
  });

  it("http / 其他协议拒绝", () => {
    expect(() => validateTargetUrl("http://api.example.com/u")).toThrow();
    expect(() => validateTargetUrl("ftp://api.example.com/u")).toThrow();
    expect(() => validateTargetUrl("javascript:alert(1)")).toThrow();
  });

  it("localhost / .local / .internal 拒绝", () => {
    expect(() => validateTargetUrl("https://localhost/u")).toThrow();
    expect(() => validateTargetUrl("https://api.local/u")).toThrow();
    expect(() => validateTargetUrl("https://x.internal/u")).toThrow();
  });

  it("私有 IPv4 拒绝", () => {
    expect(() => validateTargetUrl("https://10.0.0.1/u")).toThrow();
    expect(() => validateTargetUrl("https://192.168.1.1/u")).toThrow();
    expect(() => validateTargetUrl("https://127.0.0.1/u")).toThrow();
    expect(() => validateTargetUrl("https://172.16.5.5/u")).toThrow();
  });

  it("CIDR 内部判定", () => {
    expect(securityTesting.isPrivateIPv4("10.255.255.1")).toBe(true);
    expect(securityTesting.isPrivateIPv4("8.8.8.8")).toBe(false);
    expect(securityTesting.isPrivateIPv6("::1")).toBe(true);
    expect(securityTesting.isPrivateIPv6("2001:db8::1")).toBe(false);
    expect(securityTesting.isBlockedHostname("foo.local")).toBe(true);
    expect(securityTesting.isBlockedHostname("example.com")).toBe(false);
  });

  it("assertSafeRequestUrl: 域名解析到私网地址时拒绝", async () => {
    await expect(
      assertSafeRequestUrl("https://api.example.com/users", async () => ["10.0.0.8"]),
    ).rejects.toThrow();
  });
});

describe("outbound-importer / mapper", () => {
  it("validateFieldMapping: 缺 email", () => {
    const errs = validateFieldMapping({ name: "$.n" } as Record<string, string>);
    expect(errs.some((e) => e.field === "email")).toBe(true);
  });

  it("validateFieldMapping: 不允许的目标字段", () => {
    const errs = validateFieldMapping({
      email: "$.email",
      unsubscribed: "$.u",
    });
    expect(errs.some((e) => e.field === "unsubscribed")).toBe(true);
  });

  it("getByJsonPath: 嵌套 / 索引 / wildcard", () => {
    const data = {
      a: { b: { c: 42 } },
      list: [{ name: "x" }, { name: "y" }],
    };
    expect(getByJsonPath(data, "$.a.b.c")).toBe(42);
    expect(getByJsonPath(data, "$.list[0].name")).toBe("x");
    expect(getByJsonPath(data, "$.list[*].name")).toEqual(["x", "y"]);
    expect(getByJsonPath(data, "$.missing.x")).toBeUndefined();
  });

  it("parseJsonPath: invalid 抛错", () => {
    expect(() => mapperTesting.parseJsonPath(".a")).toThrow();
    expect(() => mapperTesting.parseJsonPath("$.a[")).toThrow();
  });

  it("mapRow: 完整成功 + metadata 合并 + tags wildcard", () => {
    const fm = {
      email: "$.email",
      name: "$.full_name",
      externalId: "$.id",
      "metadata.phone": "$.phone",
      "metadata.level": "$.membership.level",
      tags: "$.labels[*].name",
    };
    const r = mapRow(
      {
        email: "a@b.com",
        full_name: "Alice",
        id: "u-1",
        phone: "13800000000",
        membership: { level: "gold" },
        labels: [{ name: "vip" }, { name: "early" }],
      },
      fm,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.mapped.email).toBe("a@b.com");
      expect(r.mapped.externalId).toBe("u-1");
      expect(r.mapped.metadata).toEqual({ phone: "13800000000", level: "gold" });
      expect(r.mapped.tags).toEqual(["vip", "early"]);
    }
  });

  it("mapRow: 非法 email", () => {
    const r = mapRow({ email: "not-an-email" }, { email: "$.email" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]?.field).toBe("email");
    }
  });

  it("mapRow: 缺 email", () => {
    const r = mapRow({ id: 1 }, { email: "$.email" });
    expect(r.ok).toBe(false);
  });

  it("maskRawData: 错误原始数据落库前脱敏敏感字段", async () => {
    const { __testing } = await import("@/lib/modules/import/runner");
    const masked = __testing.maskRawData({
      email: "alice@example.com",
      phone: "13800000000",
      token: "secret-token",
      nested: { apiKey: "key-123", keep: "ok" },
    });
    expect(masked).toEqual({
      email: "al***@example.com",
      phone: "13*******00",
      token: "***",
      nested: { apiKey: "***", keep: "ok" },
    });
  });
});

describe("outbound-importer / pagination", () => {
  const offsetSrc: ImportSourceLike = {
    baseUrl: "https://api.example.com/users",
    paginationType: "offset",
    pageSize: 100,
  };
  const cursorSrc: ImportSourceLike = {
    baseUrl: "https://api.example.com/users",
    paginationType: "cursor",
    pageSize: 50,
    cursorJsonPath: "$.next_cursor",
  };
  const pageSrc: ImportSourceLike = {
    baseUrl: "https://api.example.com/users",
    paginationType: "page",
    pageSize: 25,
  };
  const linkSrc: ImportSourceLike = {
    baseUrl: "https://api.example.com/users",
    paginationType: "link_header",
    pageSize: 10,
    pageSizeParam: "per_page",
  };

  it("offset: 第一页 URL + advance", () => {
    const s = initialState();
    const url = buildRequestUrl(offsetSrc, s);
    expect(url).toContain("offset=0");
    expect(url).toContain("limit=100");
    const adv = advanceState(offsetSrc, s, 100, null, null);
    expect(adv.hasNext).toBe(true);
    expect(adv.next.offset).toBe(100);
  });

  it("offset: 末页停止", () => {
    const s = { ...initialState(), offset: 100 };
    const adv = advanceState(offsetSrc, s, 30, null, null);
    expect(adv.hasNext).toBe(false);
  });

  it("page: 增 page", () => {
    const s = initialState();
    const url = buildRequestUrl(pageSrc, s);
    expect(url).toContain("page=1");
    expect(url).toContain("pageSize=25");
    const adv = advanceState(pageSrc, s, 25, null, null);
    expect(adv.hasNext).toBe(true);
    expect(adv.next.page).toBe(2);
  });

  it("cursor: 提取下一 cursor", () => {
    const s = initialState();
    const url = buildRequestUrl(cursorSrc, s);
    expect(url).toContain("limit=50");
    const adv = advanceState(cursorSrc, s, 50, { next_cursor: "abc123" }, null);
    expect(adv.hasNext).toBe(true);
    expect(adv.next.cursor).toBe("abc123");
    const url2 = buildRequestUrl(cursorSrc, adv.next);
    expect(url2).toContain("cursor=abc123");
    const advEnd = advanceState(cursorSrc, adv.next, 50, { next_cursor: null }, null);
    expect(advEnd.hasNext).toBe(false);
  });

  it("link_header: 第一页加 pageSize 参数", () => {
    const s = initialState();
    const url = buildRequestUrl(linkSrc, s);
    expect(url).toContain("per_page=10");
  });

  it("link_header: 解析 next URL", () => {
    const link = '<https://api.example.com/users?page=2>; rel="next", <https://api.example.com/users?page=10>; rel="last"';
    const next = parseNextFromLinkHeader(link);
    expect(next).toBe("https://api.example.com/users?page=2");
    const adv = advanceState(linkSrc, initialState(), 10, null, link);
    expect(adv.hasNext).toBe(true);
    expect(adv.next.nextLinkUrl).toBe("https://api.example.com/users?page=2");
  });

  it("link_header: 无 next 停止", () => {
    expect(parseNextFromLinkHeader(null)).toBeNull();
    expect(parseNextFromLinkHeader('<x>; rel="last"')).toBeNull();
  });

  it("extractDataArray: 直接数组 / 嵌套 path / 非数组", () => {
    expect(extractDataArray([1, 2, 3], "$")).toEqual([1, 2, 3]);
    expect(extractDataArray({ data: { items: [1, 2] } }, "$.data.items")).toEqual([1, 2]);
    expect(extractDataArray({ data: 42 }, "$.data")).toEqual([]);
  });

  it("serialize / deserialize state 互逆", () => {
    const s: ReturnType<typeof initialState> = { offset: 100, page: 3, cursor: "x", nextLinkUrl: "https://a.com/p2" };
    const round = deserializeState(serializeState(s));
    expect(round).toEqual(s);
    expect(deserializeState(null)).toEqual(initialState());
    expect(deserializeState("not-json")).toEqual(initialState());
  });
});
