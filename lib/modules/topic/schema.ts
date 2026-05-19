/**
 * Topic（主题）模块 zod 校验。
 *
 * 关联 spec：specs/modules/unsubscribe-topic-level.md
 *
 * 设计要点：
 *  - slug 仅允许小写字母/数字/连字符；创建后不可修改 → 不出现在 UpdateSchema
 *    （已有营销邮件中的退订链接通过 slug 引用，修改会令历史链接失效）
 *  - externalRef 用于关联外部系统（CRM / 业务平台）；可选、唯一
 */

import { z } from "zod";

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export const CreateTopicSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    slug: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(SLUG_RE, "slug must be lowercase letters, digits, or hyphens"),
    description: z.string().trim().max(500).nullish(),
    externalRef: z.string().trim().min(1).max(120).nullish(),
  })
  .strict();
export type CreateTopicInput = z.infer<typeof CreateTopicSchema>;

export const UpdateTopicSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(500).nullish(),
    externalRef: z.string().trim().min(1).max(120).nullish(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "must provide at least one field",
  });
export type UpdateTopicInput = z.infer<typeof UpdateTopicSchema>;

export const ListTopicsQuerySchema = z.object({
  q: z.string().trim().max(64).optional(),
});
export type ListTopicsQuery = z.infer<typeof ListTopicsQuerySchema>;
