/**
 * 模板片段（TemplateBlock）zod 校验。
 *
 * 设计：
 *  - name 不要求唯一（同名不同 category 可共存，依 specs §278-289 仅在分类内组织）
 *  - htmlContent ≤ 256KB（片段尺寸应远小于完整模板）
 *  - isSystem 仅供初始化数据，API 写入忽略；DELETE 时由 service 拦截
 *  - category 自由文本（建议页头/页脚/CTA 等），最长 64
 */

import { z } from "zod";

export const BLOCK_HTML_MAX_BYTES = 256 * 1024;
const LocaleSchema = z.enum(["zh", "en"]);

const requiredHtml = z
  .string()
  .min(1)
  .refine((s) => Buffer.byteLength(s, "utf8") <= BLOCK_HTML_MAX_BYTES, {
    message: "htmlContent exceeds 256KB limit",
  });

const optionalHtml = z
  .string()
  .min(1)
  .refine((s) => Buffer.byteLength(s, "utf8") <= BLOCK_HTML_MAX_BYTES, {
    message: "htmlContent exceeds 256KB limit",
  })
  .optional();

const categorySchema = z
  .union([z.string().trim().min(1).max(64), z.null()])
  .optional()
  .transform((v): string | null | undefined =>
    v === null || v === undefined ? v : v,
  );

export const CreateTemplateBlockSchema = z.object({
  name: z.string().trim().min(1).max(128),
  category: categorySchema,
  locale: LocaleSchema.default("zh"),
  htmlContent: requiredHtml,
});
export type CreateTemplateBlockInput = z.infer<typeof CreateTemplateBlockSchema>;

export const UpdateTemplateBlockSchema = z
  .object({
    name: z.string().trim().min(1).max(128).optional(),
    category: categorySchema,
    locale: LocaleSchema.optional(),
    htmlContent: optionalHtml,
  })
  .strict()
  .refine(
    (v) =>
      v.name !== undefined ||
      v.category !== undefined ||
      v.locale !== undefined ||
      v.htmlContent !== undefined,
    { message: "must provide at least one field" },
  );
export type UpdateTemplateBlockInput = z.infer<typeof UpdateTemplateBlockSchema>;

export const ListTemplateBlocksQuerySchema = z.object({
  q: z.string().trim().max(128).optional(),
  category: z.string().trim().max(64).optional(),
  locale: LocaleSchema.optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(50),
});
export type ListTemplateBlocksQuery = z.infer<typeof ListTemplateBlocksQuerySchema>;
