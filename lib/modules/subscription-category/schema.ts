/**
 * 订阅分类模块 zod 校验。
 *
 * 设计要点（对齐 specs/modules/preference-center.md）：
 *  - slug 仅允许小写字母/数字/连字符；创建后不可修改 → 不出现在 UpdateSchema
 *  - isTransactional 一旦为 true 即冻结：UpdateSchema 不暴露此字段，禁止前端切换
 *  - sortOrder 用于 UI 排序（拖拽落库），允许任意整数
 *  - BatchUpdateSubscriptionsSchema 单批最多 1000 条（spec §415 边界 10）
 */

import { z } from "zod";

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export const CreateSubscriptionCategorySchema = z
  .object({
    name: z.string().trim().min(1).max(64),
    description: z.string().trim().max(500).nullish(),
    slug: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(SLUG_RE, "slug must be lowercase letters, digits, or hyphens"),
    isDefault: z.boolean().optional().default(false),
    isTransactional: z.boolean().optional().default(false),
    sortOrder: z.number().int().min(0).max(9999).optional().default(0),
  })
  .strict();
export type CreateSubscriptionCategoryInput = z.infer<typeof CreateSubscriptionCategorySchema>;

/**
 * 不可更新字段：
 *  - slug（避免已发出邮件中的退订链接失效）
 *  - isTransactional（防止误把交易通知改成普通分类导致用户误退订）
 *  - isPreset（仅 seed 决定）
 */
export const UpdateSubscriptionCategorySchema = z
  .object({
    name: z.string().trim().min(1).max(64).optional(),
    description: z.string().trim().max(500).nullish(),
    isDefault: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(9999).optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "must provide at least one field",
  });
export type UpdateSubscriptionCategoryInput = z.infer<typeof UpdateSubscriptionCategorySchema>;

export const ListSubscriptionCategoriesQuerySchema = z.object({
  q: z.string().trim().max(64).optional(),
});
export type ListSubscriptionCategoriesQuery = z.infer<
  typeof ListSubscriptionCategoriesQuerySchema
>;

/**
 * 用户订阅状态批量更新（管理员从用户详情页提交）。
 * 一次更新一个用户的多个分类，便于做事务一致性。
 */
export const UpdateUserSubscriptionsSchema = z
  .object({
    subscriptions: z
      .array(
        z
          .object({
            categoryId: z.string().min(1),
            subscribed: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export type UpdateUserSubscriptionsInput = z.infer<typeof UpdateUserSubscriptionsSchema>;

/**
 * 跨用户的订阅批量更新（运营批量退订 / 导入辅助接口）。
 * 单批 ≤ 1000，超过应分批。
 */
export const BatchUpdateSubscriptionsSchema = z
  .object({
    updates: z
      .array(
        z
          .object({
            userId: z.string().min(1),
            categoryId: z.string().min(1),
            subscribed: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(1000),
  })
  .strict();
export type BatchUpdateSubscriptionsInput = z.infer<typeof BatchUpdateSubscriptionsSchema>;
