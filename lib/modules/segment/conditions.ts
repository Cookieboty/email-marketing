/**
 * 分群条件树类型与 zod 校验。
 *
 * 对齐 specs/modules/segmentation-engine.md：
 *  - 叶子条件：{ field, operator, value }
 *  - 组合条件：{ logic: 'AND' | 'OR', conditions: [...] }
 *  - 嵌套深度上限 5；叶子条件总数上限 20；组节点 conditions 非空
 *  - 字段→操作符→value 形态严格校验（按字段类型分组）
 *
 * 仅做静态结构校验，不接 DB；DB 侧的实际语义由 compiler.ts 完成。
 */

import { z } from "zod";

// ===== 字段类型分组 =====

/** 字符串字段：支持等值/不等/包含/contains/in/notIn */
const STRING_FIELDS = ["userLevel", "source"] as const;

/** 数值字段：支持等值/范围比较/between */
const NUMBER_FIELDS = [
  "totalSpend",
  "orderCount",
  "engagementScore",
  "totalBounceCount",
  "totalOpens",
  "totalClicks",
  "balance",
  "usedQuota",
  "requestCount",
] as const;

/** 日期字段：支持等值/范围比较/between/within_days */
const DATETIME_FIELDS = ["lastOrderAt", "createdAt"] as const;

/** 布尔字段 */
const BOOLEAN_FIELDS = ["unsubscribed"] as const;

/** 标签字段（多值，需要专用算子） */
const TAG_FIELDS = ["tags"] as const;

/** 行为字段：N 天内打开/点击/收到邮件，仅支持 within_days（隐式 lte） */
const BEHAVIOR_WITHIN_DAYS_FIELDS = [
  "lastOpenedWithinDays",
  "lastClickedWithinDays",
  "emailSentWithinDays",
] as const;

export const SEGMENT_FIELDS = [
  ...STRING_FIELDS,
  ...NUMBER_FIELDS,
  ...DATETIME_FIELDS,
  ...BOOLEAN_FIELDS,
  ...TAG_FIELDS,
  ...BEHAVIOR_WITHIN_DAYS_FIELDS,
] as const;

export type SegmentField = (typeof SEGMENT_FIELDS)[number];

// ===== 算子集合 =====

export const SEGMENT_OPERATORS = [
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
] as const;

export type SegmentOperator = (typeof SEGMENT_OPERATORS)[number];

// ===== 字段 → 允许的算子 =====

export const SEGMENT_FIELD_OPERATORS: Record<SegmentField, readonly SegmentOperator[]> = {
  userLevel: ["eq", "neq", "in", "notIn", "contains"],
  source: ["eq", "neq", "in", "notIn", "contains"],

  totalSpend: ["eq", "neq", "gt", "gte", "lt", "lte", "between"],
  orderCount: ["eq", "neq", "gt", "gte", "lt", "lte", "between"],
  engagementScore: ["eq", "neq", "gt", "gte", "lt", "lte", "between"],
  totalBounceCount: ["eq", "neq", "gt", "gte", "lt", "lte", "between"],
  totalOpens: ["eq", "neq", "gt", "gte", "lt", "lte", "between"],
  totalClicks: ["eq", "neq", "gt", "gte", "lt", "lte", "between"],
  balance: ["eq", "neq", "gt", "gte", "lt", "lte", "between"],
  usedQuota: ["eq", "neq", "gt", "gte", "lt", "lte", "between"],
  requestCount: ["eq", "neq", "gt", "gte", "lt", "lte", "between"],

  lastOrderAt: ["eq", "gt", "gte", "lt", "lte", "between", "within_days"],
  createdAt: ["eq", "gt", "gte", "lt", "lte", "between", "within_days"],

  unsubscribed: ["eq", "neq"],

  tags: ["has_tag", "not_has_tag"],

  lastOpenedWithinDays: ["within_days"],
  lastClickedWithinDays: ["within_days"],
  emailSentWithinDays: ["within_days"],
};

// ===== 限制常量 =====

export const SEGMENT_MAX_DEPTH = 5;
export const SEGMENT_MAX_LEAF_CONDITIONS = 20;

// ===== 类型 =====

export type LeafCondition = {
  field: SegmentField;
  operator: SegmentOperator;
  value: unknown;
};

export type GroupCondition = {
  logic: "AND" | "OR";
  conditions: SegmentCondition[];
};

export type SegmentCondition = LeafCondition | GroupCondition;

export function isGroupCondition(c: SegmentCondition): c is GroupCondition {
  return typeof (c as GroupCondition).logic === "string";
}

// ===== zod 基础 schema =====

const isoDateLike = z
  .union([z.string().datetime({ offset: true }), z.date()])
  .transform((v) => (v instanceof Date ? v : new Date(v)))
  .refine((d) => !Number.isNaN(d.getTime()), { message: "invalid date" });

const fieldSchema = z.enum(SEGMENT_FIELDS);
const operatorSchema = z.enum(SEGMENT_OPERATORS);

const positiveIntDays = z
  .number()
  .int()
  .positive()
  .max(3650, { message: "within_days must be <= 3650" });

/**
 * 按 (field, operator) 校验 value 的形态。
 * 这里返回的是经过解析/规范化后的 value（如 Date 对象）。
 */
function validateLeafValue(
  field: SegmentField,
  operator: SegmentOperator,
  value: unknown,
  ctx: z.RefinementCtx,
): unknown {
  // 检查字段-算子兼容
  if (!SEGMENT_FIELD_OPERATORS[field].includes(operator)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `operator "${operator}" is not allowed for field "${field}"`,
    });
    return value;
  }

  const isNumberField = (NUMBER_FIELDS as readonly string[]).includes(field);
  const isDatetimeField = (DATETIME_FIELDS as readonly string[]).includes(field);
  const isStringField = (STRING_FIELDS as readonly string[]).includes(field);
  const isBooleanField = (BOOLEAN_FIELDS as readonly string[]).includes(field);
  const isTagField = (TAG_FIELDS as readonly string[]).includes(field);
  const isBehavior = (BEHAVIOR_WITHIN_DAYS_FIELDS as readonly string[]).includes(field);

  switch (operator) {
    case "eq":
    case "neq": {
      if (isBooleanField) {
        if (typeof value !== "boolean") {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "value must be boolean" });
        }
        return value;
      }
      if (isNumberField) {
        const r = z.number().safeParse(value);
        if (!r.success) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "value must be number" });
        return r.success ? r.data : value;
      }
      if (isDatetimeField) {
        const r = isoDateLike.safeParse(value);
        if (!r.success) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "value must be date" });
        return r.success ? r.data : value;
      }
      if (isStringField) {
        const r = z.string().min(1).max(255).safeParse(value);
        if (!r.success) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "value must be non-empty string" });
        return r.success ? r.data : value;
      }
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `eq/neq not supported for ${field}` });
      return value;
    }

    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      if (isNumberField) {
        const r = z.number().safeParse(value);
        if (!r.success) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "value must be number" });
        return r.success ? r.data : value;
      }
      if (isDatetimeField) {
        const r = isoDateLike.safeParse(value);
        if (!r.success) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "value must be date" });
        return r.success ? r.data : value;
      }
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `range op not supported for ${field}` });
      return value;
    }

    case "in":
    case "notIn": {
      if (!isStringField) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${operator} only for string fields` });
        return value;
      }
      const r = z.array(z.string().min(1).max(255)).min(1).max(100).safeParse(value);
      if (!r.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "value must be string[] of length 1..100",
        });
      }
      return r.success ? r.data : value;
    }

    case "contains": {
      if (!isStringField) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "contains only for string fields" });
        return value;
      }
      const r = z.string().min(1).max(255).safeParse(value);
      if (!r.success) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "value must be non-empty string" });
      return r.success ? r.data : value;
    }

    case "between": {
      if (isNumberField) {
        const tuple = z.tuple([z.number(), z.number()]).safeParse(value);
        if (!tuple.success) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "value must be [min, max] numbers" });
          return value;
        }
        const [a, b] = tuple.data;
        if (a > b) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "between: min must be <= max" });
        }
        return tuple.data;
      }
      if (isDatetimeField) {
        const tuple = z.tuple([isoDateLike, isoDateLike]).safeParse(value);
        if (!tuple.success) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "value must be [from, to] dates" });
          return value;
        }
        const [a, b] = tuple.data;
        if (a.getTime() > b.getTime()) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "between: from must be <= to" });
        }
        return tuple.data;
      }
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `between not supported for ${field}` });
      return value;
    }

    case "within_days": {
      if (!isDatetimeField && !isBehavior) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `within_days not supported for ${field}`,
        });
        return value;
      }
      const r = positiveIntDays.safeParse(value);
      if (!r.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "value must be a positive integer (days)",
        });
      }
      return r.success ? r.data : value;
    }

    case "has_tag":
    case "not_has_tag": {
      if (!isTagField) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${operator} only for tags field`,
        });
        return value;
      }
      const r = z.string().min(1).max(64).safeParse(value);
      if (!r.success) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "value must be tag name" });
      return r.success ? r.data : value;
    }

    default: {
      const _exhaustive: never = operator;
      void _exhaustive;
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "unknown operator" });
      return value;
    }
  }
}

// ===== 递归 schema =====

const LeafConditionSchema = z
  .object({
    field: fieldSchema,
    operator: operatorSchema,
    // value 形态依赖 field+operator，先用 z.any() 收口，再由 superRefine 严格校验。
    value: z.any(),
  })
  .superRefine((leaf, ctx) => {
    validateLeafValue(leaf.field, leaf.operator, leaf.value, ctx);
  })
  .transform((leaf) => leaf as LeafCondition) as unknown as z.ZodType<LeafCondition>;

// 因 GroupCondition 自引用，使用 z.lazy
export const SegmentConditionSchema: z.ZodType<SegmentCondition> = z.lazy(() =>
  z.union([GroupConditionSchema, LeafConditionSchema]),
);

const GroupConditionSchema: z.ZodType<GroupCondition> = z.lazy(() =>
  z.object({
    logic: z.enum(["AND", "OR"]),
    conditions: z
      .array(SegmentConditionSchema)
      .min(1, { message: "group conditions must not be empty" })
      .max(SEGMENT_MAX_LEAF_CONDITIONS, {
        message: `group can have at most ${SEGMENT_MAX_LEAF_CONDITIONS} children`,
      }),
  }),
);

/**
 * 全树校验：深度上限 + 叶子条件总数上限。
 * 这两条规则是「全局」约束，无法在 zod 内通过 superRefine 自然递归推断，
 * 因此通过 walk 二次校验。
 */
export function assertTreeLimits(condition: SegmentCondition): void {
  let leafCount = 0;
  function walk(node: SegmentCondition, depth: number) {
    if (depth > SEGMENT_MAX_DEPTH) {
      throw new Error(`condition tree depth exceeds ${SEGMENT_MAX_DEPTH}`);
    }
    if (isGroupCondition(node)) {
      for (const child of node.conditions) walk(child, depth + 1);
    } else {
      leafCount += 1;
      if (leafCount > SEGMENT_MAX_LEAF_CONDITIONS) {
        throw new Error(`leaf condition count exceeds ${SEGMENT_MAX_LEAF_CONDITIONS}`);
      }
    }
  }
  walk(condition, 1);
}

/**
 * 解析 + 全树规则校验。返回规范化后的条件树（如 Date 已为 Date 对象）。
 *
 * 调用方（API/repository）应使用本函数而非裸 SegmentConditionSchema.parse，
 * 以保证 depth/leaf 数量的硬上限。
 */
export function parseSegmentCondition(input: unknown): SegmentCondition {
  const parsed = SegmentConditionSchema.parse(input);
  assertTreeLimits(parsed);
  return parsed;
}

/**
 * 统计叶子条件数量（用于 UI 显示和测试）。
 */
export function countLeafConditions(condition: SegmentCondition): number {
  let count = 0;
  function walk(node: SegmentCondition) {
    if (isGroupCondition(node)) for (const c of node.conditions) walk(c);
    else count += 1;
  }
  walk(condition);
  return count;
}

/**
 * 计算条件树最大深度（根为 1）。
 */
export function getConditionDepth(condition: SegmentCondition): number {
  function walk(node: SegmentCondition): number {
    if (!isGroupCondition(node)) return 1;
    if (node.conditions.length === 0) return 1;
    return 1 + Math.max(...node.conditions.map(walk));
  }
  return walk(condition);
}
