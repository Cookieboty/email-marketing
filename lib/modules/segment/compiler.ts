/**
 * 分群条件编译器：把 SegmentCondition 编译成 Prisma `User.where`。
 *
 * 设计要点：
 *  - 本模块只生成 where 对象，不直接读 DB；调用方传入 `now()` 注入「相对时间」的基准
 *    时间戳，使行为字段（lastOpenedWithinDays 等）在测试中可重放。
 *  - 行为字段映射到 `campaignRecipients.some({...})`（schema.prisma 中的关系名）。
 *  - 标签字段映射到 `userTags.some/none({ tag: { name: ... } })`。
 *  - 隐式规则（unsubscribed/totalBounceCount）由调用方在 Campaign 发送阶段单独 AND，
 *    本编译器不替用户加规则，保持「分群定义即用户定义」。
 *  - 对未知字段/算子组合，应在 conditions.parseSegmentCondition 时被拦截；
 *    防御性地这里再返回一个永不匹配的 where（保证安全 fallback）。
 */

import type { Prisma } from "@prisma/client";
import {
  isGroupCondition,
  type LeafCondition,
  type SegmentCondition,
  type SegmentField,
  type SegmentOperator,
} from "./conditions";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface CompileOptions {
  /** 用于 within_days 的「现在」基准；测试可注入固定时间。 */
  now?: Date;
}

const NEVER_MATCH: Prisma.UserWhereInput = { id: { equals: "__SEGMENT_NEVER_MATCH__" } };

/**
 * 把单个叶子条件编译成 UserWhereInput 片段。
 */
export function compileLeaf(
  leaf: LeafCondition,
  options: CompileOptions = {},
): Prisma.UserWhereInput {
  const now = options.now ?? new Date();
  const { field, operator, value } = leaf;

  // 行为字段：lastOpenedWithinDays / lastClickedWithinDays / emailSentWithinDays
  if (field === "lastOpenedWithinDays") {
    return behaviorWithinDays("openedAt", value, now);
  }
  if (field === "lastClickedWithinDays") {
    return behaviorWithinDays("clickedAt", value, now);
  }
  if (field === "emailSentWithinDays") {
    return behaviorWithinDays("sentAt", value, now);
  }

  // 标签字段
  if (field === "tags") {
    if (operator === "has_tag") {
      return { userTags: { some: { tag: { name: String(value) } } } };
    }
    if (operator === "not_has_tag") {
      return { userTags: { none: { tag: { name: String(value) } } } };
    }
    return NEVER_MATCH;
  }

  // 普通直字段映射
  return mapDirectFieldOperator(field, operator, value, now);
}

/**
 * 行为字段共用的子查询：CampaignRecipient.{openedAt|clickedAt|sentAt} >= now - days*MS_PER_DAY
 */
function behaviorWithinDays(
  recipientField: "openedAt" | "clickedAt" | "sentAt",
  value: unknown,
  now: Date,
): Prisma.UserWhereInput {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return NEVER_MATCH;
  }
  const since = new Date(now.getTime() - value * MS_PER_DAY);
  return {
    campaignRecipients: {
      some: { [recipientField]: { gte: since } } as Prisma.CampaignRecipientWhereInput,
    },
  };
}

function mapDirectFieldOperator(
  field: SegmentField,
  operator: SegmentOperator,
  value: unknown,
  now: Date,
): Prisma.UserWhereInput {
  // datetime fields 单独处理 within_days
  if (operator === "within_days") {
    if (typeof value !== "number" || value <= 0) return NEVER_MATCH;
    const since = new Date(now.getTime() - value * MS_PER_DAY);
    return { [field]: { gte: since } } as Prisma.UserWhereInput;
  }

  switch (operator) {
    case "eq":
      return { [field]: { equals: value as never } } as Prisma.UserWhereInput;
    case "neq":
      return { [field]: { not: { equals: value as never } } } as Prisma.UserWhereInput;
    case "gt":
      return { [field]: { gt: value as never } } as Prisma.UserWhereInput;
    case "gte":
      return { [field]: { gte: value as never } } as Prisma.UserWhereInput;
    case "lt":
      return { [field]: { lt: value as never } } as Prisma.UserWhereInput;
    case "lte":
      return { [field]: { lte: value as never } } as Prisma.UserWhereInput;
    case "in":
      return { [field]: { in: value as never } } as Prisma.UserWhereInput;
    case "notIn":
      return { [field]: { notIn: value as never } } as Prisma.UserWhereInput;
    case "contains":
      return {
        [field]: { contains: String(value), mode: "insensitive" },
      } as Prisma.UserWhereInput;
    case "between": {
      if (!Array.isArray(value) || value.length !== 2) return NEVER_MATCH;
      const [a, b] = value as [unknown, unknown];
      // 数值/日期都依赖 Prisma 的 gte/lte 运算符
      return { [field]: { gte: a as never, lte: b as never } } as Prisma.UserWhereInput;
    }
    default:
      void now;
      return NEVER_MATCH;
  }
}

/**
 * 把整棵条件树编译为 UserWhereInput。
 *
 * 空 group（极端情况，校验阶段已拦截）映射为「不附加任何条件」（{}），
 * 与「全部用户」语义一致——这与系统内置 Segment「全部用户」预期一致。
 */
export function compileSegmentCondition(
  condition: SegmentCondition,
  options: CompileOptions = {},
): Prisma.UserWhereInput {
  if (isGroupCondition(condition)) {
    if (condition.conditions.length === 0) return {};
    const children = condition.conditions.map((c) =>
      compileSegmentCondition(c, options),
    );
    return condition.logic === "AND" ? { AND: children } : { OR: children };
  }
  return compileLeaf(condition, options);
}
