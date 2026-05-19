/**
 * CSV 导入：注入防护 + 解析 + 行级校验。
 *
 * 这里只覆盖纯函数路径（不接 DB），DB 集成测试放到 tests/integration。
 */

import { describe, it, expect } from "vitest";
import {
  parseCsv,
  parseSubscriptionsCell,
  sanitizeCsvField,
} from "@/lib/modules/import/csv";

describe("sanitizeCsvField", () => {
  it("returns undefined for null/undefined/empty", () => {
    expect(sanitizeCsvField(null)).toBeUndefined();
    expect(sanitizeCsvField(undefined)).toBeUndefined();
    expect(sanitizeCsvField("")).toBeUndefined();
  });

  it("prefixes single quote for formula triggers", () => {
    expect(sanitizeCsvField("=SUM(A1:A2)")).toBe("'=SUM(A1:A2)");
    expect(sanitizeCsvField("+1+1")).toBe("'+1+1");
    expect(sanitizeCsvField("-2")).toBe("'-2");
    expect(sanitizeCsvField("@cmd")).toBe("'@cmd");
    expect(sanitizeCsvField("\tHELLO")).toBe("'\tHELLO");
    expect(sanitizeCsvField("\rHELLO")).toBe("'\rHELLO");
  });

  it("leaves benign strings untouched", () => {
    expect(sanitizeCsvField("hello")).toBe("hello");
    expect(sanitizeCsvField("zhangsan")).toBe("zhangsan");
    expect(sanitizeCsvField("VIP")).toBe("VIP");
  });

  it("coerces non-string values to string", () => {
    expect(sanitizeCsvField(42)).toBe("42");
  });
});

describe("parseCsv", () => {
  it("parses standard CSV with header row", () => {
    const csv = ["email,name,tags", "a@x.com,Alice,\"vip,active\"", "b@y.com,Bob,"].join("\n");
    const { rows, errors } = parseCsv(csv);
    expect(errors).toEqual([]);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows[0]?.email).toBe("a@x.com");
    expect(rows[0]?.name).toBe("Alice");
    expect(rows[0]?.tags).toEqual(["vip", "active"]);
    expect(rows[1]?.email).toBe("b@y.com");
  });

  it("trims headers", () => {
    const csv = [" email , name ", " a@x.com , Alice "].join("\n");
    const { rows } = parseCsv(csv);
    expect(rows[0]?.email).toBe("a@x.com");
    expect(rows[0]?.name).toBe("Alice");
  });

  it("splits comma-separated tags into an array", () => {
    const csv = ["email,tags", "a@x.com,\"vip, top, hot\""].join("\n");
    const { rows } = parseCsv(csv);
    expect(rows[0]?.tags).toEqual(["vip", "top", "hot"]);
  });

  it("preserves potentially-injected values for downstream sanitization", () => {
    // parseCsv 不做注入防护；它把读到的内容透传给 importUsers，
    // 在那里 sanitizeCsvField 介入。
    const csv = ["email,name", "a@x.com,=cmd|'/c calc'!A0"].join("\n");
    const { rows } = parseCsv(csv);
    expect(rows[0]?.name).toBe("=cmd|'/c calc'!A0");
    expect(sanitizeCsvField(rows[0]?.name)).toBe("'=cmd|'/c calc'!A0");
  });

  it("parses subscriptions column into a slug→bool map", () => {
    const csv = [
      "email,subscriptions",
      "a@x.com,marketing:true;newsletter:false",
    ].join("\n");
    const { rows } = parseCsv(csv);
    expect(rows[0]?.subscriptions).toEqual({
      marketing: true,
      newsletter: false,
    });
  });
});

describe("parseSubscriptionsCell", () => {
  it("returns undefined for empty / whitespace input", () => {
    expect(parseSubscriptionsCell(undefined)).toBeUndefined();
    expect(parseSubscriptionsCell("")).toBeUndefined();
    expect(parseSubscriptionsCell("   ")).toBeUndefined();
  });

  it("supports both ';' and ',' as separators", () => {
    expect(parseSubscriptionsCell("a:true;b:false")).toEqual({ a: true, b: false });
    expect(parseSubscriptionsCell("a:true,b:false")).toEqual({ a: true, b: false });
  });

  it("accepts true/false/1/0/yes/no as values (case-insensitive)", () => {
    expect(parseSubscriptionsCell("a:TRUE;b:0;c:Yes;d:NO")).toEqual({
      a: true,
      b: false,
      c: true,
      d: false,
    });
  });

  it("drops malformed segments silently", () => {
    expect(parseSubscriptionsCell("a:true;noop;b:not-a-bool;c:false")).toEqual({
      a: true,
      c: false,
    });
  });

  it("normalizes case but rejects slugs with invalid characters", () => {
    // 大写自动小写化；下划线 / 空格不符合 slug 规则 → 丢弃
    expect(parseSubscriptionsCell("Marketing:true;news_letter:true;a b:true")).toEqual({
      marketing: true,
    });
  });
});
