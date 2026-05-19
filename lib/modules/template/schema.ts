/**
 * 模板模块 zod 校验。
 *
 * 设计：
 *  - name 唯一（DB 层 @unique），创建/更新去 trim
 *  - htmlContent 上限 1MB（specs §324/§331）；script 标签剥离在 service 层做
 *  - PATCH 至少需 1 个字段；version 自增由 service 控制
 *  - preview 单独 schema，不持久化
 */

import { z } from "zod";

export const HTML_MAX_BYTES = 1024 * 1024;

const requiredHtml = z
  .string()
  .min(1, "htmlContent is required")
  .refine((s) => Buffer.byteLength(s, "utf8") <= HTML_MAX_BYTES, {
    message: "htmlContent exceeds 1MB limit",
  });

const optionalHtml = z
  .string()
  .min(1, "htmlContent must not be empty")
  .refine((s) => Buffer.byteLength(s, "utf8") <= HTML_MAX_BYTES, {
    message: "htmlContent exceeds 1MB limit",
  })
  .optional();

const optionalText = z
  .union([z.string().max(HTML_MAX_BYTES, "textContent exceeds 1MB limit"), z.null()])
  .optional()
  .transform((v): string | undefined =>
    v === null || v === undefined ? undefined : v,
  );

export const CreateTemplateSchema = z.object({
  name: z.string().trim().min(1).max(128),
  subject: z.string().trim().min(1).max(512),
  htmlContent: requiredHtml,
  textContent: optionalText,
});
export type CreateTemplateInput = z.infer<typeof CreateTemplateSchema>;

export const UpdateTemplateSchema = z
  .object({
    name: z.string().trim().min(1).max(128).optional(),
    subject: z.string().trim().min(1).max(512).optional(),
    htmlContent: optionalHtml,
    textContent: optionalText,
  })
  .strict()
  .refine(
    (v) =>
      v.name !== undefined ||
      v.subject !== undefined ||
      v.htmlContent !== undefined ||
      v.textContent !== undefined,
    { message: "must provide at least one field" },
  );
export type UpdateTemplateInput = z.infer<typeof UpdateTemplateSchema>;

export const ListTemplatesQuerySchema = z.object({
  q: z.string().trim().max(128).optional(),
  includeArchived: z.coerce.boolean().default(false),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(50),
});
export type ListTemplatesQuery = z.infer<typeof ListTemplatesQuerySchema>;

export const PreviewTemplateSchema = z.object({
  subject: z.string().max(512).optional(),
  htmlContent: z.string().max(HTML_MAX_BYTES).optional(),
  textContent: z.string().max(HTML_MAX_BYTES).optional(),
  variables: z.record(z.string(), z.string()).optional(),
  missingStrategy: z.enum(["empty", "keep", "throw"]).default("empty"),
});
export type PreviewTemplateInput = z.infer<typeof PreviewTemplateSchema>;

export const TestSendSchema = z.object({
  to: z.string().trim().email("invalid email"),
  variables: z.record(z.string(), z.string()).optional(),
});
export type TestSendInput = z.infer<typeof TestSendSchema>;
