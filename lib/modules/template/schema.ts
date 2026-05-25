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

const optionalText = z
  .union([z.string().max(HTML_MAX_BYTES, "textContent exceeds 1MB limit"), z.null()])
  .optional()
  .transform((v): string | undefined =>
    v === null || v === undefined ? undefined : v,
  );

const LocaleSchema = z.enum(["zh", "en"]);

const LocaleContentCreateSchema = z.object({
  subject: z.string().trim().min(1).max(512),
  htmlContent: requiredHtml,
  textContent: optionalText,
});

const LocaleContentUpdateSchema = z.object({
  subject: z.string().trim().min(1).max(512),
  htmlContent: requiredHtml,
  textContent: z
    .union([z.string().max(HTML_MAX_BYTES, "textContent exceeds 1MB limit"), z.null()])
    .optional(),
});

const LocalesCreateSchema = z
  .object({
    zh: LocaleContentCreateSchema.optional(),
    en: LocaleContentCreateSchema.optional(),
  })
  .strict()
  .refine((v) => v.zh !== undefined || v.en !== undefined, {
    message: "at least one locale is required",
  });

const LocalesUpdateSchema = z
  .object({
    zh: LocaleContentUpdateSchema.optional(),
    en: LocaleContentUpdateSchema.optional(),
  })
  .strict()
  .refine((v) => v.zh !== undefined || v.en !== undefined, {
    message: "at least one locale is required",
  });

export const CreateTemplateSchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    defaultLocale: LocaleSchema,
    locales: LocalesCreateSchema,
  })
  .strict()
  .refine((v) => v.locales[v.defaultLocale] !== undefined, {
    message: "defaultLocale must exist in locales",
    path: ["defaultLocale"],
  });
export type CreateTemplateInput = z.infer<typeof CreateTemplateSchema>;

export const UpdateTemplateSchema = z
  .object({
    name: z.string().trim().min(1).max(128).optional(),
    defaultLocale: LocaleSchema.optional(),
    locales: LocalesUpdateSchema.optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.name !== undefined ||
      v.defaultLocale !== undefined ||
      v.locales !== undefined,
    { message: "must provide at least one field" },
  );
export type UpdateTemplateInput = z.infer<typeof UpdateTemplateSchema>;

export const TemplateLocaleFilterSchema = z
  .enum(["all", "zh", "en", "bilingual", "single"])
  .default("all");
export type TemplateLocaleFilter = z.infer<typeof TemplateLocaleFilterSchema>;

export const ListTemplatesQuerySchema = z.object({
  q: z.string().trim().max(128).optional(),
  includeArchived: z.coerce.boolean().default(false),
  localeFilter: TemplateLocaleFilterSchema,
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(50),
});
export type ListTemplatesQuery = z.infer<typeof ListTemplatesQuerySchema>;

export const PreviewTemplateSchema = z.object({
  locale: LocaleSchema.default("zh"),
  subject: z.string().max(512).optional(),
  htmlContent: z.string().max(HTML_MAX_BYTES).optional(),
  textContent: z.string().max(HTML_MAX_BYTES).optional(),
  variables: z.record(z.string(), z.string()).optional(),
  unsubscribeUrl: z.string().url().optional(),
  unsubscribeTopicUrl: z.string().url().optional(),
  missingStrategy: z.enum(["empty", "keep", "throw"]).default("empty"),
});
export type PreviewTemplateInput = z.infer<typeof PreviewTemplateSchema>;

export const TestSendSchema = z.object({
  to: z.string().trim().email("invalid email"),
  locale: LocaleSchema.optional(),
  variables: z.record(z.string(), z.string()).optional(),
  channelId: z.string().optional(),
});
export type TestSendInput = z.infer<typeof TestSendSchema>;
