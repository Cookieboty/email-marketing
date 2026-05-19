/**
 * 分群（Segment）模块的 zod 校验。
 *
 * 设计：
 *  - 复用 `lib/modules/segment/conditions.ts` 的条件树校验，避免重复定义算子矩阵。
 *  - name 唯一性由 service 层捕获 P2002 转 ConflictError；schema 仅做 trim + 长度。
 *  - 列表/分页参数与 tag 模块保持一致（page/pageSize），便于前端通用 hooks。
 */

import { z } from "zod";
import {
  SegmentConditionSchema,
  assertTreeLimits,
} from "./conditions";

const NameSchema = z.string().trim().min(1).max(80);
const DescriptionSchema = z
  .union([z.string().trim().max(500), z.null()])
  .optional()
  .transform((v): string | null | undefined => (v === undefined ? undefined : v));

/** 校验条件树：先做结构/字段-算子兼容性，再做整树深度+叶子数量上限。 */
const ConditionsSchema = SegmentConditionSchema.superRefine((tree, ctx) => {
  try {
    assertTreeLimits(tree);
  } catch (e) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: e instanceof Error ? e.message : "tree limits exceeded",
    });
  }
});

export const CreateSegmentSchema = z.object({
  name: NameSchema,
  description: DescriptionSchema,
  conditions: ConditionsSchema,
});
export type CreateSegmentInput = z.infer<typeof CreateSegmentSchema>;

export const UpdateSegmentSchema = z
  .object({
    name: NameSchema.optional(),
    description: DescriptionSchema,
    conditions: ConditionsSchema.optional(),
  })
  .strict()
  .refine(
    (v) => v.name !== undefined || v.description !== undefined || v.conditions !== undefined,
    { message: "must provide at least one field" },
  );
export type UpdateSegmentInput = z.infer<typeof UpdateSegmentSchema>;

export const ListSegmentsQuerySchema = z.object({
  q: z.string().trim().max(80).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(50),
});
export type ListSegmentsQuery = z.infer<typeof ListSegmentsQuerySchema>;

export const SegmentPreviewQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).default(20),
});
export type SegmentPreviewQuery = z.infer<typeof SegmentPreviewQuerySchema>;
