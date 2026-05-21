/**
 * Phase 10.5：import-source 表单前端 zod 校验，镜像后端 CreateImportSourceSchema。
 * 注意：后端真实 schema 见 lib/modules/import/schema.ts；前端只做 UX 校验，最终以后端为准。
 */
import { z } from "zod";

const HttpsUrl = z
  .string()
  .url()
  .refine(
    (u) =>
      /^https:\/\//i.test(u) ||
      /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(u),
    { message: "baseUrl 必须 https，或 http://localhost" },
  );

const FieldMappingSchema = z
  .record(z.string().min(1), z.string().min(1))
  .refine((v) => typeof v.email === "string" && v.email.length > 0, {
    message: "fieldMapping.email 必填",
    path: ["email"],
  });

const PaginationTypeSchema = z.enum([
  "offset",
  "cursor",
  "page",
  "link_header",
]);

const AuthTypeSchema = z.enum([
  "NONE",
  "BEARER",
  "BASIC",
  "API_KEY_HEADER",
]);

const HeadersSchema = z.record(z.string(), z.string()).optional();

const Base = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  baseUrl: HttpsUrl,
  authType: AuthTypeSchema.default("NONE"),
  authValue: z.string().optional(),
  authHeader: z.string().optional(),
  headers: HeadersSchema,
  paginationType: PaginationTypeSchema.default("offset"),
  pageSize: z.number().int().min(1).max(1000).default(100),
  pageSizeParam: z.string().optional(),
  pageParam: z.string().optional(),
  cursorParam: z.string().optional(),
  cursorJsonPath: z.string().optional(),
  dataJsonPath: z.string().default("$.data"),
  fieldMapping: FieldMappingSchema,
  schedule: z.string().max(64).optional().nullable(),
  enabled: z.boolean().default(true),
});

export const CreateImportSourceFormSchema = Base.refine(
  (v) =>
    v.authType === "NONE" ||
    (typeof v.authValue === "string" && v.authValue.length > 0),
  { message: "authValue 不能为空", path: ["authValue"] },
)
  .refine(
    (v) =>
      v.authType !== "API_KEY_HEADER" ||
      (typeof v.authHeader === "string" && v.authHeader.length > 0),
    { message: "API_KEY_HEADER 必须填写 authHeader", path: ["authHeader"] },
  )
  .refine(
    (v) =>
      v.paginationType !== "cursor" ||
      (typeof v.cursorParam === "string" && v.cursorParam.length > 0),
    { message: "cursor 分页需要 cursorParam", path: ["cursorParam"] },
  )
  .refine(
    (v) =>
      v.paginationType !== "cursor" ||
      (typeof v.cursorJsonPath === "string" && v.cursorJsonPath.length > 0),
    { message: "cursor 分页需要 cursorJsonPath", path: ["cursorJsonPath"] },
  )
  .refine(
    (v) =>
      v.paginationType !== "page" ||
      (typeof v.pageParam === "string" && v.pageParam.length > 0),
    { message: "page 分页需要 pageParam", path: ["pageParam"] },
  );

export const UpdateImportSourceFormSchema = Base.partial()
  .extend({
    schedule: z.string().max(64).nullable().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.paginationType !== "cursor") return;
    if (!v.cursorParam) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cursorParam"],
        message: "cursor 分页需要 cursorParam",
      });
    }
    if (!v.cursorJsonPath) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cursorJsonPath"],
        message: "cursor 分页需要 cursorJsonPath",
      });
    }
  });

export type CreateImportSourceFormValues = z.infer<typeof Base>;

export function buildImportSourcePayload(
  values: CreateImportSourceFormValues,
  headers: Record<string, string>,
  isEdit: boolean,
  keepAuth: boolean,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: values.name,
    baseUrl: values.baseUrl,
    authType: values.authType,
    headers,
    paginationType: values.paginationType,
    pageSize: values.pageSize,
    dataJsonPath: values.dataJsonPath || "$.data",
    fieldMapping: values.fieldMapping,
    enabled: values.enabled,
  };

  if (values.description) payload.description = values.description;
  if (values.authType === "API_KEY_HEADER" && values.authHeader) {
    payload.authHeader = values.authHeader;
  }
  if (values.pageSizeParam) payload.pageSizeParam = values.pageSizeParam;
  if (values.pageParam) payload.pageParam = values.pageParam;
  if (values.cursorParam) payload.cursorParam = values.cursorParam;
  if (values.cursorJsonPath) payload.cursorJsonPath = values.cursorJsonPath;
  if (values.schedule) payload.schedule = values.schedule;
  else if (isEdit) payload.schedule = null;

  if (values.authType === "NONE") {
    if (isEdit && !keepAuth) payload.authValue = "";
  } else if (!isEdit || !keepAuth) {
    payload.authValue = values.authValue;
  }

  return payload;
}

const CRON_PIECE_RE = /^[\d*\-,/]+$/;

// 极简 cron 校验：必须 5 段，每段只能含数字 / `*` / `,` / `-` / `/`。
// 复杂语义（如步长、L、? 等）交给后端 / cron 库；返回 null 表示合法。
export function validateScheduleString(
  schedule: string | null | undefined,
): string | null {
  if (schedule == null || schedule.trim() === "") return null;
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) {
    return "cron 表达式必须为 5 段，例如 `*/5 * * * *`";
  }
  for (const p of parts) {
    if (!CRON_PIECE_RE.test(p)) {
      return `非法字符：${p}`;
    }
  }
  return null;
}
