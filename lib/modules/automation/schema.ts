import { z } from "zod";

const TriggerTypeSchema = z.enum([
  "USER_CREATED",
  "TAG_CHANGED",
  "BIRTHDAY",
  "REENGAGEMENT",
  "CUSTOM_EVENT",
]);

const TriggerConfigSchema = z.record(z.string(), z.unknown());

const ConditionsSchema = z.record(z.string(), z.unknown()).nullable().optional();
const LocaleSchema = z.enum(["zh", "en"]);
const LocaleSubjectMapSchema = z
  .object({
    zh: z.string().trim().min(1).max(255).optional(),
    en: z.string().trim().min(1).max(255).optional(),
  })
  .strict()
  .refine((v) => v.zh !== undefined || v.en !== undefined, {
    message: "at least one locale is required",
  });

export const CreateAutomationSchema = z.object({
  name: z.string().trim().min(1).max(120),
  triggerType: TriggerTypeSchema,
  triggerConfig: TriggerConfigSchema.default({}),
  templateId: z.string().min(1).optional(),
  subjects: LocaleSubjectMapSchema.optional(),
  localeStrategy: z.enum(["AUTO", "FORCE"]).default("AUTO"),
  forcedLocale: LocaleSchema.optional(),
  delayMinutes: z.coerce.number().int().min(0).max(525600).default(0),
  conditions: ConditionsSchema,
  status: z.enum(["ENABLED", "DISABLED"]).optional().default("DISABLED"),
}).strict().superRefine((v, ctx) => {
  if (!v.templateId && !v.subjects) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["subjects"],
      message: "subjects required when templateId is missing",
    });
  }
  if (v.localeStrategy === "FORCE" && !v.forcedLocale) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["forcedLocale"],
      message: "forcedLocale required when localeStrategy=FORCE",
    });
  }
});
export type CreateAutomationInput = z.infer<typeof CreateAutomationSchema>;

export const UpdateAutomationSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    triggerType: TriggerTypeSchema.optional(),
    triggerConfig: TriggerConfigSchema.optional(),
    templateId: z.string().min(1).nullable().optional(),
    subjects: LocaleSubjectMapSchema.optional(),
    localeStrategy: z.enum(["AUTO", "FORCE"]).optional(),
    forcedLocale: LocaleSchema.nullable().optional(),
    delayMinutes: z.coerce.number().int().min(0).max(525600).optional(),
    conditions: ConditionsSchema,
    status: z.enum(["ENABLED", "DISABLED"]).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, {
    message: "must provide at least one field",
  });
export type UpdateAutomationInput = z.infer<typeof UpdateAutomationSchema>;

export const ListAutomationsQuerySchema = z.object({
  status: z.enum(["ENABLED", "DISABLED"]).optional(),
  triggerType: TriggerTypeSchema.optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});
export type ListAutomationsQuery = z.infer<typeof ListAutomationsQuerySchema>;

export const ListRunsQuerySchema = z.object({
  status: z.enum(["SCHEDULED", "SENT", "SKIPPED", "FAILED"]).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});
export type ListRunsQuery = z.infer<typeof ListRunsQuerySchema>;
