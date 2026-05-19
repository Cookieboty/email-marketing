/**
 * 标签模块 zod 校验。
 *
 * 设计：
 *  - name 唯一，统一 trim 后写入；不强制大小写归一化（与 specs §357 一致）
 *  - color 可选，要求 #RRGGBB 或 #RGB 形式；无颜色时存 null
 *  - 列表/CRUD/查询 size 上限收敛在此层，避免 service 散落 magic number
 */

import { z } from "zod";

const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const colorSchema = z
  .union([z.string().regex(HEX_COLOR_RE, "color must be #RGB or #RRGGBB"), z.null()])
  .optional()
  .transform((v): string | undefined =>
    v === null || v === undefined ? undefined : v,
  );

export const CreateTagSchema = z.object({
  name: z.string().trim().min(1).max(64),
  color: colorSchema,
});
export type CreateTagInput = z.infer<typeof CreateTagSchema>;

export const UpdateTagSchema = z
  .object({
    name: z.string().trim().min(1).max(64).optional(),
    color: colorSchema,
  })
  .strict()
  .refine((v) => v.name !== undefined || v.color !== undefined, {
    message: "must provide at least one field",
  });
export type UpdateTagInput = z.infer<typeof UpdateTagSchema>;

export const ListTagsQuerySchema = z.object({
  q: z.string().trim().max(64).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(50),
});
export type ListTagsQuery = z.infer<typeof ListTagsQuerySchema>;

export const TagUsersQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(20),
});
export type TagUsersQuery = z.infer<typeof TagUsersQuerySchema>;
