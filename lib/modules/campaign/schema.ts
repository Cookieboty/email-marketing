/**
 * Campaign 模块 zod 校验。
 *
 * 重点：
 *  - subject 默认从 template.subject 继承（service 层处理）；schema 仅做长度校验。
 *  - tagFilter 数组、tagFilterMode ∈ {ANY,ALL}（与现有 schema.prisma 字段对齐：
 *    虽然 specs 写 AND/OR，但当前 prisma schema.tagFilterMode 为 String?@default("ANY")，
 *    保留兼容；同时接受 AND/OR 别名做 normalize）。
 *  - utmParams 限制为字符串映射（不支持嵌套对象，避免 URL 注入）。
 *  - 隐式更新规则字段过滤：仅 DRAFT/SCHEDULED 允许全字段更新；service 层强制。
 */

import { z } from "zod";
import { isValidFromHeader } from "@/lib/email-utils";

const NameSchema = z.string().trim().min(1).max(120);
const SubjectSchema = z.string().trim().min(1).max(255);
const SubjectOverrideSchema = z.string().trim().max(255);
const LocaleSchema = z.enum(["zh", "en"]);
const LocaleTextMapSchema = z
  .object({
    zh: SubjectSchema.optional(),
    en: SubjectSchema.optional(),
  })
  .strict()
  .refine((v) => v.zh !== undefined || v.en !== undefined, {
    message: "at least one locale is required",
  });
const LocaleSubjectOverrideMapSchema = z
  .object({
    zh: SubjectOverrideSchema.optional(),
    en: SubjectOverrideSchema.optional(),
  })
  .strict()
  .refine((v) => v.zh !== undefined || v.en !== undefined, {
    message: "at least one locale is required",
  });
/**
 * Variant html 上限 100KB（与 EmailTemplateLocale 的 1MB 上限刻意不同）：
 * A/B variant 的实际用法是"在主模板基础上换主题 / 改一小段 html / 改 CTA"，
 * 而非整体替换大模板。100KB 已经覆盖 99% 场景，更小的上限能：
 *  - 防止误用（运营把整封新邮件塞进 variant，丢失"对照实验"语义）
 *  - 让发送高峰期的内存占用更可预期（variant 内容会随 Campaign 全量加载）
 * 如果未来出现大 variant 的合理场景，再单独调整这里。
 */
const LocaleHtmlMapSchema = z
  .object({
    zh: z.string().min(1).max(100_000).optional(),
    en: z.string().min(1).max(100_000).optional(),
  })
  .strict()
  .refine((v) => v.zh !== undefined || v.en !== undefined, {
    message: "at least one locale is required",
  });
const LocaleNullableTextMapSchema = z
  .object({
    zh: z.union([z.string().max(100_000), z.null()]).optional(),
    en: z.union([z.string().max(100_000), z.null()]).optional(),
  })
  .strict()
  .optional();
/**
 * From 头：允许裸地址（news@example.com）或 RFC 5322 Display Name 格式
 * （`Marketing <news@example.com>`），内部地址必须合法。
 */
const FromEmailSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(isValidFromHeader, {
    message: "fromEmail must be a valid email or 'Name <addr@domain>' header",
  });
const ReplyToSchema = z.string().trim().email().max(255);

const TagFilterModeRaw = z
  .enum(["ANY", "ALL", "AND", "OR"])
  .transform((v): "ANY" | "ALL" => {
    if (v === "AND") return "ALL";
    if (v === "OR") return "ANY";
    return v;
  });

const UtmParamsSchema = z
  .record(z.string().min(1).max(40), z.string().min(0).max(200))
  .refine((obj) => Object.keys(obj).length <= 16, {
    message: "Too many UTM parameters (max 16)",
  });

/**
 * A/B 测试配置（specs §229-§240）。
 * 字段：
 *  - winnerMetric: 'open' | 'click' | 'conversion'
 *  - testDurationHours: 1..168
 *  - autoSendWinner: boolean (默认 true)
 *  - confidenceLevel: 0.80..0.99 (默认 0.95)
 * 不在 schema 列出的额外键被剔除（strict）。
 */
const AbTestConfigSchema = z
  .object({
    winnerMetric: z.enum(["open", "click", "conversion"]),
    testDurationHours: z.coerce.number().int().min(1).max(168),
    autoSendWinner: z.boolean().optional().default(true),
    confidenceLevel: z.coerce.number().min(0.8).max(0.99).optional().default(0.95),
  })
  .strict();

/**
 * Variant 输入（specs §232-§238）。
 *  - samplePercentage：每个 variant 占比 1..50；service 层会在 isAbTest=true 时
 *    再校验「总和 ≤ 50」（其余空间留给最终大众发送）。
 *  - htmlContent：与模板一致，最长 100KB（与模板 schema 对齐）。
 */
const VariantInputSchema = z
  .object({
    variantName: z.string().trim().min(1).max(80),
    subjects: LocaleTextMapSchema,
    htmlContents: LocaleHtmlMapSchema,
    textContents: LocaleNullableTextMapSchema,
    samplePercentage: z.coerce.number().int().min(1).max(50).default(10),
  })
  .superRefine((v, ctx) => {
    // spec §237: variant 的 subjects / htmlContents 必须严格 key 对齐，避免
    // "有 html 没 subject"导致 selectVariantContent 退化为空 subject 邮件。
    const subjectKeys = Object.keys(v.subjects).filter(
      (k) => v.subjects[k as "zh" | "en"] !== undefined,
    );
    const htmlKeys = Object.keys(v.htmlContents).filter(
      (k) => v.htmlContents[k as "zh" | "en"] !== undefined,
    );
    const subjectSet = new Set(subjectKeys);
    const htmlSet = new Set(htmlKeys);
    if (
      subjectSet.size !== htmlSet.size ||
      [...subjectSet].some((k) => !htmlSet.has(k))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["htmlContents"],
        message:
          "variant subjects and htmlContents must declare the same locale keys",
      });
    }
    if (v.textContents) {
      for (const k of Object.keys(v.textContents)) {
        const value = v.textContents[k as "zh" | "en"];
        if (value === undefined) continue;
        if (!htmlSet.has(k)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["textContents", k],
            message:
              "variant textContents locale must also exist in htmlContents",
          });
        }
      }
    }
  });

export const CreateCampaignSchema = z
  .object({
    name: NameSchema,
    templateId: z.string().min(1),
    subjects: LocaleSubjectOverrideMapSchema.optional(),
    localeStrategy: z.enum(["AUTO", "FORCE"]).default("AUTO"),
    forcedLocale: LocaleSchema.optional(),
    fromEmail: FromEmailSchema.optional(),
    replyTo: ReplyToSchema.optional(),
    sendingChannelId: z.string().min(1).optional(),
    tagFilter: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
    tagFilterMode: TagFilterModeRaw.optional(),
    segmentId: z.string().optional(),
    subscriptionCategory: z.string().trim().min(1).max(80).optional(),
    isAbTest: z.boolean().optional().default(false),
    abTestConfig: AbTestConfigSchema.optional(),
    variants: z.array(VariantInputSchema).min(2).max(5).optional(),
    utmParams: UtmParamsSchema.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.localeStrategy === "FORCE" && !v.forcedLocale) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["forcedLocale"],
        message: "forcedLocale required when localeStrategy=FORCE",
      });
    }
    if (v.isAbTest) {
      if (!v.abTestConfig) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["abTestConfig"],
          message: "abTestConfig required when isAbTest=true",
        });
      }
      if (!v.variants || v.variants.length < 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["variants"],
          message: "At least 2 variants required when isAbTest=true",
        });
      }
      if (v.variants && v.variants.length >= 2) {
        const total = v.variants.reduce((s, x) => s + x.samplePercentage, 0);
        if (total > 50) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["variants"],
            message: `Sum of variant samplePercentage must be <= 50 (got ${total})`,
          });
        }
        const names = new Set<string>();
        for (let i = 0; i < v.variants.length; i++) {
          const name = v.variants[i]!.variantName;
          if (names.has(name)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["variants", i, "variantName"],
              message: `Duplicate variantName: ${name}`,
            });
          }
          names.add(name);
        }
      }
    }
  });
export type CreateCampaignInput = z.infer<typeof CreateCampaignSchema>;

/**
 * 更新 schema：仅在 DRAFT/SCHEDULED 时由 service 接受全字段更新；
 * 其他状态下 service 会拒绝非允许字段。这里仅做语法校验。
 */
export const UpdateCampaignSchema = z
  .object({
    name: NameSchema.optional(),
    subjects: LocaleSubjectOverrideMapSchema.optional(),
    localeStrategy: z.enum(["AUTO", "FORCE"]).optional(),
    forcedLocale: LocaleSchema.nullable().optional(),
    fromEmail: FromEmailSchema.optional(),
    replyTo: ReplyToSchema.optional(),
    sendingChannelId: z.string().min(1).nullable().optional(),
    tagFilter: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
    tagFilterMode: TagFilterModeRaw.optional(),
    segmentId: z.string().nullable().optional(),
    subscriptionCategory: z.string().trim().min(1).max(80).nullable().optional(),
    utmParams: UtmParamsSchema.nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, {
    message: "must provide at least one field",
  });
export type UpdateCampaignInput = z.infer<typeof UpdateCampaignSchema>;

export const ListCampaignsQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  status: z
    .enum([
      "DRAFT",
      "SCHEDULED",
      "SENDING",
      "AB_TESTING",
      "PAUSED",
      "COMPLETED",
      "FAILED",
      "CANCELLED",
    ])
    .optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});
export type ListCampaignsQuery = z.infer<typeof ListCampaignsQuerySchema>;

/** schedule 操作：仅可在 DRAFT 状态下设置/调整 scheduledAt。 */
export const ScheduleCampaignSchema = z.object({
  scheduledAt: z
    .string()
    .datetime({ offset: true })
    .transform((v) => new Date(v))
    .refine((d) => d.getTime() > Date.now() + 60_000, {
      message: "scheduledAt must be at least 60 seconds in the future",
    }),
});
export type ScheduleCampaignInput = z.infer<typeof ScheduleCampaignSchema>;

/** send 操作：可选 scheduledAt（缺省立即发送）。 */
export const SendCampaignSchema = z
  .object({
    scheduledAt: z
      .string()
      .datetime({ offset: true })
      .transform((v) => new Date(v))
      .optional(),
  })
  .optional()
  .transform((v) => v ?? {});
export type SendCampaignInput = z.infer<typeof SendCampaignSchema>;
