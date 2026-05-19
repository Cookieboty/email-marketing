/**
 * 频次控制（FrequencyCap）模块 zod 校验。
 *
 * 设计：
 *  - 全局至多一条 isActive=true（DB partial unique index 保证）；service 层
 *    捕获 P2002 转 ConflictError。
 *  - maxEmails ∈ [1, 1000]；periodDays ∈ [1, 90]，避免极端值。
 *  - 默认值在 service 层从 env 读取（FREQUENCY_CAP_DEFAULT_MAX/DAYS）。
 */

import { z } from "zod";

const MaxEmailsSchema = z.coerce.number().int().min(1).max(1000);
const PeriodDaysSchema = z.coerce.number().int().min(1).max(90);

export const CreateFrequencyCapSchema = z.object({
  maxEmails: MaxEmailsSchema,
  periodDays: PeriodDaysSchema,
  isActive: z.boolean().optional().default(true),
});
export type CreateFrequencyCapInput = z.infer<typeof CreateFrequencyCapSchema>;

export const UpdateFrequencyCapSchema = z
  .object({
    maxEmails: MaxEmailsSchema.optional(),
    periodDays: PeriodDaysSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.maxEmails !== undefined ||
      v.periodDays !== undefined ||
      v.isActive !== undefined,
    { message: "must provide at least one field" },
  );
export type UpdateFrequencyCapInput = z.infer<typeof UpdateFrequencyCapSchema>;

export const ListFrequencyCapsQuerySchema = z.object({
  isActive: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
});
export type ListFrequencyCapsQuery = z.infer<typeof ListFrequencyCapsQuerySchema>;

export const CheckFrequencyQuerySchema = z.object({
  userId: z.string().min(1),
});
export type CheckFrequencyQuery = z.infer<typeof CheckFrequencyQuerySchema>;
