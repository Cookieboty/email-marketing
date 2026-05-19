/**
 * 分群条件 → Prisma where 编译器单元测试。
 *
 * 不连接数据库，仅断言编译产出的 where 结构与 specs 中的语义一致：
 *  - eq/neq/gt/gte/lt/lte/in/notIn/contains/between
 *  - within_days：把 N 天反推为 since 的 gte
 *  - 行为字段映射到 campaignRecipients.some({ openedAt | clickedAt | sentAt: gte })
 *  - 标签字段映射到 userTags.some/none
 *  - AND/OR 嵌套
 */

import { describe, it, expect } from "vitest";
import {
  compileLeaf,
  compileSegmentCondition,
} from "@/lib/modules/segment/compiler";
import {
  parseSegmentCondition,
  type SegmentCondition,
} from "@/lib/modules/segment/conditions";

const FIXED_NOW = new Date("2026-05-18T12:00:00Z");
const MS_PER_DAY = 24 * 60 * 60 * 1000;

describe("compileLeaf - direct field operators", () => {
  it("eq → { field: { equals } }", () => {
    expect(
      compileLeaf({ field: "userLevel", operator: "eq", value: "vip" }),
    ).toEqual({ userLevel: { equals: "vip" } });
  });

  it("neq → { field: { not: { equals } } }", () => {
    expect(
      compileLeaf({ field: "userLevel", operator: "neq", value: "vip" }),
    ).toEqual({ userLevel: { not: { equals: "vip" } } });
  });

  it("gt/gte/lt/lte map to corresponding prisma operator", () => {
    expect(compileLeaf({ field: "totalSpend", operator: "gt", value: 100 })).toEqual({
      totalSpend: { gt: 100 },
    });
    expect(compileLeaf({ field: "totalSpend", operator: "gte", value: 100 })).toEqual({
      totalSpend: { gte: 100 },
    });
    expect(compileLeaf({ field: "totalSpend", operator: "lt", value: 100 })).toEqual({
      totalSpend: { lt: 100 },
    });
    expect(compileLeaf({ field: "totalSpend", operator: "lte", value: 100 })).toEqual({
      totalSpend: { lte: 100 },
    });
  });

  it("in / notIn", () => {
    expect(
      compileLeaf({ field: "userLevel", operator: "in", value: ["vip", "gold"] }),
    ).toEqual({ userLevel: { in: ["vip", "gold"] } });
    expect(
      compileLeaf({ field: "userLevel", operator: "notIn", value: ["bronze"] }),
    ).toEqual({ userLevel: { notIn: ["bronze"] } });
  });

  it("contains uses case-insensitive search", () => {
    expect(
      compileLeaf({ field: "userLevel", operator: "contains", value: "VIP" }),
    ).toEqual({ userLevel: { contains: "VIP", mode: "insensitive" } });
  });

  it("between expands to gte+lte", () => {
    expect(
      compileLeaf({ field: "totalSpend", operator: "between", value: [100, 1000] }),
    ).toEqual({ totalSpend: { gte: 100, lte: 1000 } });
  });

  it("within_days for datetime field uses (now - N days) gte", () => {
    const out = compileLeaf(
      { field: "createdAt", operator: "within_days", value: 7 },
      { now: FIXED_NOW },
    );
    expect(out).toEqual({
      createdAt: { gte: new Date(FIXED_NOW.getTime() - 7 * MS_PER_DAY) },
    });
  });
});

describe("compileLeaf - tags", () => {
  it("has_tag → userTags.some.tag.name eq", () => {
    expect(
      compileLeaf({ field: "tags", operator: "has_tag", value: "vip" }),
    ).toEqual({ userTags: { some: { tag: { name: "vip" } } } });
  });

  it("not_has_tag → userTags.none", () => {
    expect(
      compileLeaf({ field: "tags", operator: "not_has_tag", value: "spam" }),
    ).toEqual({ userTags: { none: { tag: { name: "spam" } } } });
  });
});

describe("compileLeaf - behavior fields (subquery on campaignRecipients)", () => {
  it("lastOpenedWithinDays maps to recipients.some.openedAt gte", () => {
    const out = compileLeaf(
      { field: "lastOpenedWithinDays", operator: "within_days", value: 30 },
      { now: FIXED_NOW },
    );
    expect(out).toEqual({
      campaignRecipients: {
        some: { openedAt: { gte: new Date(FIXED_NOW.getTime() - 30 * MS_PER_DAY) } },
      },
    });
  });

  it("lastClickedWithinDays maps to clickedAt", () => {
    const out = compileLeaf(
      { field: "lastClickedWithinDays", operator: "within_days", value: 14 },
      { now: FIXED_NOW },
    );
    expect(out).toEqual({
      campaignRecipients: {
        some: { clickedAt: { gte: new Date(FIXED_NOW.getTime() - 14 * MS_PER_DAY) } },
      },
    });
  });

  it("emailSentWithinDays maps to sentAt", () => {
    const out = compileLeaf(
      { field: "emailSentWithinDays", operator: "within_days", value: 1 },
      { now: FIXED_NOW },
    );
    expect(out).toEqual({
      campaignRecipients: {
        some: { sentAt: { gte: new Date(FIXED_NOW.getTime() - 1 * MS_PER_DAY) } },
      },
    });
  });
});

describe("compileSegmentCondition - composite", () => {
  it("AND maps to { AND: [...] }", () => {
    const tree: SegmentCondition = {
      logic: "AND",
      conditions: [
        { field: "userLevel", operator: "eq", value: "vip" },
        { field: "totalSpend", operator: "gt", value: 1000 },
      ],
    };
    expect(compileSegmentCondition(tree)).toEqual({
      AND: [{ userLevel: { equals: "vip" } }, { totalSpend: { gt: 1000 } }],
    });
  });

  it("OR maps to { OR: [...] }", () => {
    const tree: SegmentCondition = {
      logic: "OR",
      conditions: [
        { field: "userLevel", operator: "eq", value: "vip" },
        { field: "userLevel", operator: "eq", value: "gold" },
      ],
    };
    expect(compileSegmentCondition(tree)).toEqual({
      OR: [{ userLevel: { equals: "vip" } }, { userLevel: { equals: "gold" } }],
    });
  });

  it("nested AND/OR is preserved structurally", () => {
    const tree: SegmentCondition = {
      logic: "AND",
      conditions: [
        { field: "userLevel", operator: "eq", value: "vip" },
        {
          logic: "OR",
          conditions: [
            { field: "engagementScore", operator: "gte", value: 50 },
            { field: "lastOpenedWithinDays", operator: "within_days", value: 30 },
          ],
        },
      ],
    };
    const out = compileSegmentCondition(tree, { now: FIXED_NOW });
    expect(out).toEqual({
      AND: [
        { userLevel: { equals: "vip" } },
        {
          OR: [
            { engagementScore: { gte: 50 } },
            {
              campaignRecipients: {
                some: { openedAt: { gte: new Date(FIXED_NOW.getTime() - 30 * MS_PER_DAY) } },
              },
            },
          ],
        },
      ],
    });
  });

  it("works after parseSegmentCondition (end-to-end normalization)", () => {
    const tree = parseSegmentCondition({
      logic: "AND",
      conditions: [
        { field: "userLevel", operator: "in", value: ["vip", "gold"] },
        { field: "tags", operator: "has_tag", value: "newsletter" },
        { field: "createdAt", operator: "within_days", value: 90 },
      ],
    });
    const out = compileSegmentCondition(tree, { now: FIXED_NOW });
    expect(out).toEqual({
      AND: [
        { userLevel: { in: ["vip", "gold"] } },
        { userTags: { some: { tag: { name: "newsletter" } } } },
        { createdAt: { gte: new Date(FIXED_NOW.getTime() - 90 * MS_PER_DAY) } },
      ],
    });
  });
});

describe("compileSegmentCondition - safety fallbacks", () => {
  it("within_days with non-positive value falls back to never-match", () => {
    const out = compileLeaf(
      { field: "lastOpenedWithinDays", operator: "within_days", value: 0 },
      { now: FIXED_NOW },
    );
    // 不应当返回 some.openedAt={ gte: now }，而是 NEVER_MATCH 哨兵
    expect(out).toEqual({ id: { equals: "__SEGMENT_NEVER_MATCH__" } });
  });

  it("between with malformed value falls back to never-match", () => {
    const out = compileLeaf({
      field: "totalSpend",
      operator: "between",
      // 非法 tuple；编译器应安全降级
      value: [100] as unknown as [number, number],
    });
    expect(out).toEqual({ id: { equals: "__SEGMENT_NEVER_MATCH__" } });
  });
});
