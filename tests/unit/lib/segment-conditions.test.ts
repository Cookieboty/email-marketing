/**
 * 分群条件 schema：边界与字段-算子兼容性。
 *
 * 不接 DB；纯静态结构校验。覆盖 specs/modules/segmentation-engine.md 中
 * 「条件树最大深度 5、叶子条件 ≤ 20、字段-算子兼容矩阵、value 形态」等约束。
 */

import { describe, it, expect } from "vitest";
import {
  SEGMENT_FIELDS,
  SEGMENT_OPERATORS,
  SegmentConditionSchema,
  assertTreeLimits,
  countLeafConditions,
  getConditionDepth,
  parseSegmentCondition,
  type SegmentCondition,
} from "@/lib/modules/segment/conditions";

describe("SEGMENT_FIELDS / SEGMENT_OPERATORS", () => {
  it("export the documented field set", () => {
    expect(SEGMENT_FIELDS).toEqual(
      expect.arrayContaining([
        "userLevel",
        "totalSpend",
        "orderCount",
        "lastOrderAt",
        "engagementScore",
        "unsubscribed",
        "totalBounceCount",
        "source",
        "createdAt",
        "tags",
        "lastOpenedWithinDays",
        "lastClickedWithinDays",
        "totalOpens",
        "totalClicks",
        "emailSentWithinDays",
      ]),
    );
  });

  it("expose the documented operator set", () => {
    expect(SEGMENT_OPERATORS).toEqual(
      expect.arrayContaining([
        "eq",
        "neq",
        "gt",
        "gte",
        "lt",
        "lte",
        "in",
        "notIn",
        "contains",
        "between",
        "within_days",
        "has_tag",
        "not_has_tag",
      ]),
    );
  });
});

describe("LeafConditionSchema field-operator compatibility", () => {
  it("accepts userLevel eq with string value", () => {
    expect(() =>
      SegmentConditionSchema.parse({
        field: "userLevel",
        operator: "eq",
        value: "vip",
      }),
    ).not.toThrow();
  });

  it("rejects userLevel gt (string field cannot use range op)", () => {
    expect(() =>
      SegmentConditionSchema.parse({
        field: "userLevel",
        operator: "gt",
        value: "vip",
      }),
    ).toThrow();
  });

  it("accepts totalSpend gt with number", () => {
    expect(() =>
      SegmentConditionSchema.parse({
        field: "totalSpend",
        operator: "gt",
        value: 1000,
      }),
    ).not.toThrow();
  });

  it("rejects totalSpend gt with string", () => {
    expect(() =>
      SegmentConditionSchema.parse({
        field: "totalSpend",
        operator: "gt",
        value: "1000",
      }),
    ).toThrow();
  });

  it("accepts unsubscribed eq with boolean", () => {
    expect(() =>
      SegmentConditionSchema.parse({
        field: "unsubscribed",
        operator: "eq",
        value: false,
      }),
    ).not.toThrow();
  });

  it("rejects unsubscribed eq with non-boolean", () => {
    expect(() =>
      SegmentConditionSchema.parse({
        field: "unsubscribed",
        operator: "eq",
        value: "false",
      }),
    ).toThrow();
  });

  it("accepts tags has_tag with string", () => {
    expect(() =>
      SegmentConditionSchema.parse({
        field: "tags",
        operator: "has_tag",
        value: "vip",
      }),
    ).not.toThrow();
  });

  it("rejects tags eq (only has_tag/not_has_tag allowed)", () => {
    expect(() =>
      SegmentConditionSchema.parse({
        field: "tags",
        operator: "eq",
        value: "vip",
      }),
    ).toThrow();
  });

  it("rejects has_tag for non-tag field", () => {
    expect(() =>
      SegmentConditionSchema.parse({
        field: "userLevel",
        operator: "has_tag",
        value: "vip",
      }),
    ).toThrow();
  });

  it("accepts userLevel in with string array", () => {
    const out = SegmentConditionSchema.parse({
      field: "userLevel",
      operator: "in",
      value: ["vip", "gold"],
    });
    expect(out).toBeDefined();
  });

  it("rejects in with non-array value", () => {
    expect(() =>
      SegmentConditionSchema.parse({
        field: "userLevel",
        operator: "in",
        value: "vip",
      }),
    ).toThrow();
  });

  it("rejects in with empty array", () => {
    expect(() =>
      SegmentConditionSchema.parse({
        field: "userLevel",
        operator: "in",
        value: [],
      }),
    ).toThrow();
  });

  it("rejects in for number field", () => {
    expect(() =>
      SegmentConditionSchema.parse({
        field: "totalSpend",
        operator: "in",
        value: [1, 2, 3],
      }),
    ).toThrow();
  });

  it("accepts contains for string field", () => {
    expect(() =>
      SegmentConditionSchema.parse({
        field: "source",
        operator: "contains",
        value: "import",
      }),
    ).not.toThrow();
  });

  it("rejects contains for number field", () => {
    expect(() =>
      SegmentConditionSchema.parse({
        field: "totalSpend",
        operator: "contains",
        value: "100",
      }),
    ).toThrow();
  });

  it("accepts between with number tuple", () => {
    expect(() =>
      SegmentConditionSchema.parse({
        field: "totalSpend",
        operator: "between",
        value: [100, 1000],
      }),
    ).not.toThrow();
  });

  it("rejects between when min > max", () => {
    expect(() =>
      SegmentConditionSchema.parse({
        field: "totalSpend",
        operator: "between",
        value: [1000, 100],
      }),
    ).toThrow();
  });

  it("rejects between with single value", () => {
    expect(() =>
      SegmentConditionSchema.parse({
        field: "totalSpend",
        operator: "between",
        value: [100],
      }),
    ).toThrow();
  });

  it("accepts datetime between with iso strings", () => {
    const out = SegmentConditionSchema.parse({
      field: "createdAt",
      operator: "between",
      value: ["2025-01-01T00:00:00Z", "2025-12-31T23:59:59Z"],
    });
    if ("logic" in out) throw new Error("should be leaf");
    // schema 仅做校验，不主动转换为 Date；保留原始字符串透传给 Prisma。
    const v = out.value as [string, string];
    expect(typeof v[0]).toBe("string");
    expect(typeof v[1]).toBe("string");
    expect(new Date(v[0]).toString()).not.toBe("Invalid Date");
  });

  it("accepts within_days for datetime field with positive int", () => {
    expect(() =>
      SegmentConditionSchema.parse({
        field: "createdAt",
        operator: "within_days",
        value: 30,
      }),
    ).not.toThrow();
  });

  it("rejects within_days with zero or negative", () => {
    for (const v of [0, -1, 1.5]) {
      expect(() =>
        SegmentConditionSchema.parse({
          field: "createdAt",
          operator: "within_days",
          value: v,
        }),
      ).toThrow();
    }
  });

  it("accepts within_days for behavior fields", () => {
    for (const field of [
      "lastOpenedWithinDays",
      "lastClickedWithinDays",
      "emailSentWithinDays",
    ] as const) {
      expect(() =>
        SegmentConditionSchema.parse({
          field,
          operator: "within_days",
          value: 7,
        }),
      ).not.toThrow();
    }
  });

  it("rejects behavior field with non-within_days op", () => {
    expect(() =>
      SegmentConditionSchema.parse({
        field: "lastOpenedWithinDays",
        operator: "eq",
        value: 7,
      }),
    ).toThrow();
  });
});

describe("GroupConditionSchema", () => {
  it("accepts AND group of leaves", () => {
    const out = SegmentConditionSchema.parse({
      logic: "AND",
      conditions: [
        { field: "userLevel", operator: "eq", value: "vip" },
        { field: "totalSpend", operator: "gt", value: 1000 },
      ],
    });
    if (!("logic" in out)) throw new Error("should be group");
    expect(out.logic).toBe("AND");
  });

  it("rejects empty group", () => {
    expect(() =>
      SegmentConditionSchema.parse({ logic: "AND", conditions: [] }),
    ).toThrow();
  });

  it("rejects unknown logic", () => {
    expect(() =>
      SegmentConditionSchema.parse({
        logic: "XOR",
        conditions: [{ field: "userLevel", operator: "eq", value: "vip" }],
      }),
    ).toThrow();
  });

  it("supports nested groups", () => {
    const tree: SegmentCondition = {
      logic: "AND",
      conditions: [
        { field: "userLevel", operator: "eq", value: "vip" },
        {
          logic: "OR",
          conditions: [
            { field: "lastOpenedWithinDays", operator: "within_days", value: 30 },
            { field: "engagementScore", operator: "gte", value: 50 },
          ],
        },
      ],
    };
    expect(() => SegmentConditionSchema.parse(tree)).not.toThrow();
  });
});

describe("tree limits (depth, leaf count)", () => {
  it("depth 5 passes; depth 6 fails", () => {
    function build(depth: number): SegmentCondition {
      if (depth === 1) return { field: "userLevel", operator: "eq", value: "vip" };
      return { logic: "AND", conditions: [build(depth - 1)] };
    }
    expect(() => assertTreeLimits(build(5))).not.toThrow();
    expect(() => assertTreeLimits(build(6))).toThrow(/depth/i);
  });

  it("20 leaves OK; 21 leaves throws", () => {
    const leaves: SegmentCondition[] = Array.from({ length: 20 }, (_, i) => ({
      field: "userLevel",
      operator: "eq",
      value: `lv${i}`,
    }));
    const ok: SegmentCondition = { logic: "AND", conditions: leaves };
    expect(() => assertTreeLimits(ok)).not.toThrow();

    // 嵌套两层放下 21 个叶子
    const tooMany: SegmentCondition = {
      logic: "AND",
      conditions: [
        ...leaves,
        { logic: "AND", conditions: [{ field: "userLevel", operator: "eq", value: "x" }] },
      ],
    };
    expect(() => assertTreeLimits(tooMany)).toThrow(/leaf/i);
  });

  it("countLeafConditions / getConditionDepth produce expected metrics", () => {
    const tree: SegmentCondition = {
      logic: "OR",
      conditions: [
        { field: "userLevel", operator: "eq", value: "vip" },
        {
          logic: "AND",
          conditions: [
            { field: "totalSpend", operator: "gt", value: 100 },
            { field: "orderCount", operator: "gte", value: 1 },
          ],
        },
      ],
    };
    expect(countLeafConditions(tree)).toBe(3);
    expect(getConditionDepth(tree)).toBe(3);
  });
});

describe("parseSegmentCondition", () => {
  it("returns the parsed tree on valid input", () => {
    const out = parseSegmentCondition({
      logic: "AND",
      conditions: [{ field: "userLevel", operator: "eq", value: "vip" }],
    });
    expect("logic" in out && out.logic === "AND").toBe(true);
  });

  it("throws on too-deep tree", () => {
    function build(depth: number): SegmentCondition {
      if (depth === 1) return { field: "userLevel", operator: "eq", value: "vip" };
      return { logic: "AND", conditions: [build(depth - 1)] };
    }
    expect(() => parseSegmentCondition(build(6))).toThrow();
  });
});
