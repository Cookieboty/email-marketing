/**
 * 抑制名单（SuppressionEntry）模块 zod 校验。
 *
 * 设计：
 *  - 三种 type：EMAIL（精确匹配）/ DOMAIN（后缀匹配）/ PATTERN（SQL LIKE 通配）
 *  - PATTERN 语法限制（specs §3.2 / phase-1 §3.2）：
 *      * 必须含至少 1 个非通配字面量字符
 *      * 不允许仅 `%` / `%%` / `_` / `__` 等纯通配
 *  - EMAIL 类型自动 normalizeEmail（lowercase + trim），写库时统一格式
 *  - DOMAIN 类型 lowercase + trim，禁止前导点/通配
 */

import { z } from "zod";
import { isValidEmail, normalizeEmail } from "@/lib/email-utils";

const ReasonSchema = z
  .union([z.string().trim().max(500), z.null()])
  .optional()
  .transform((v): string | null | undefined => (v === undefined ? undefined : v));

const SourceSchema = z
  .union([z.string().trim().max(80), z.null()])
  .optional()
  .transform((v): string | null | undefined => (v === undefined ? undefined : v));

const DomainRegex = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** 检查 PATTERN 是否包含足够字面量（避免全表通配）。 */
export function isPatternSafe(value: string): boolean {
  // 转义后的字面量字符（即非 `%`/`_` 且非紧跟反斜杠的字符）需 ≥1
  let i = 0;
  let literals = 0;
  while (i < value.length) {
    const ch = value[i]!;
    if (ch === "\\" && i + 1 < value.length) {
      literals += 1;
      i += 2;
      continue;
    }
    if (ch !== "%" && ch !== "_") literals += 1;
    i += 1;
  }
  return literals >= 1;
}

const TypeSchema = z.enum(["EMAIL", "DOMAIN", "PATTERN"]);

/** 共用值校验：根据 type 做不同归一化与校验。 */
const ValueByTypeSchema = z
  .object({
    type: TypeSchema,
    value: z.string().trim().min(1).max(255),
  })
  .superRefine(({ type, value }, ctx) => {
    if (type === "EMAIL") {
      if (!isValidEmail(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["value"],
          message: "Invalid email address",
        });
      }
    } else if (type === "DOMAIN") {
      const lower = value.toLowerCase();
      if (lower.startsWith(".") || lower.includes("%") || lower.includes("_")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["value"],
          message: "Domain must not start with '.' or contain wildcards",
        });
      } else if (!DomainRegex.test(lower)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["value"],
          message: "Invalid domain syntax",
        });
      }
    } else {
      // PATTERN
      if (!isPatternSafe(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["value"],
          message: "Pattern must contain at least one literal character (non-wildcard)",
        });
      }
    }
  });

/**
 * 把值按 type 归一化（lowercase 等）。
 * EMAIL/DOMAIN 转小写；PATTERN 不强制小写（因调用方使用 ILIKE，但保留原始字符以便审计）。
 */
export function normalizeSuppressionValue(type: "EMAIL" | "DOMAIN" | "PATTERN", raw: string): string {
  const trimmed = raw.trim();
  if (type === "EMAIL") return normalizeEmail(trimmed);
  if (type === "DOMAIN") return trimmed.toLowerCase();
  return trimmed;
}

export const CreateSuppressionSchema = ValueByTypeSchema.and(
  z.object({
    reason: ReasonSchema,
    source: SourceSchema,
  }),
);
export type CreateSuppressionInput = z.infer<typeof CreateSuppressionSchema>;

export const UpdateSuppressionSchema = z
  .object({
    reason: ReasonSchema,
    source: SourceSchema,
  })
  .strict()
  .refine((v) => v.reason !== undefined || v.source !== undefined, {
    message: "must provide at least one field",
  });
export type UpdateSuppressionInput = z.infer<typeof UpdateSuppressionSchema>;

export const ListSuppressionQuerySchema = z.object({
  q: z.string().trim().max(255).optional(),
  type: TypeSchema.optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(50),
});
export type ListSuppressionQuery = z.infer<typeof ListSuppressionQuerySchema>;

/** 批量导入：每行可独立校验、错误行汇报。 */
export const ImportSuppressionRowSchema = ValueByTypeSchema.and(
  z.object({
    reason: ReasonSchema,
    source: SourceSchema,
  }),
);
export type ImportSuppressionRow = z.infer<typeof ImportSuppressionRowSchema>;

export const ImportSuppressionSchema = z.object({
  entries: z.array(ImportSuppressionRowSchema).min(1).max(10000),
});
export type ImportSuppressionInput = z.infer<typeof ImportSuppressionSchema>;
