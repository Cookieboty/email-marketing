/**
 * SMTP 配置模块的 zod 校验。
 *
 * 关联 spec：specs/modules/smtp-configuration.md（"API 设计"小节）
 *
 * 设计要点：
 * - port 与 secure 的兼容性走 `superRefine`，保留具体 issue path 以便表单定位。
 * - 创建 / 更新分两个 schema：更新里 `password` 三态语义（undefined/空串=不变，
 *   null=清除，非空字符串=覆盖），由 service 层判定。
 * - 列表 query 与 ApiClient 同风格：`status` 可选 + `q` 可选。
 * - "切换激活通道"的 schema 单独导出，由 `/api/mail-provider/activate` 路由复用。
 */

import { z } from "zod";

export const SECURE_MODES = ["NONE", "STARTTLS", "TLS"] as const;
export type SmtpSecureMode = (typeof SECURE_MODES)[number];

export const CONFIG_STATUSES = ["ACTIVE", "DISABLED", "REVOKED"] as const;
export type SmtpConfigStatus = (typeof CONFIG_STATUSES)[number];

export const PROVIDER_TYPES = ["RESEND", "SMTP"] as const;
export type MailProviderType = (typeof PROVIDER_TYPES)[number];

const SecureModeEnum = z.enum(SECURE_MODES);
const ProviderTypeEnum = z.enum(PROVIDER_TYPES);

/**
 * RFC5322 兼容的最小邮件正则：支持 `local@host` 与 `Display Name <addr>`。
 * 仅在 zod 层做粗校验；正式投递前还会经过 nodemailer 的解析。
 */
const fromEmailSchema = z
  .string()
  .trim()
  .min(1)
  .max(254)
  .refine(
    (v) =>
      /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(v) ||
      /^[^<>]{1,80}<[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>$/.test(v),
    "fromEmail must be a valid RFC5322 address (optionally with display name)",
  );

const plainEmailSchema = z
  .string()
  .trim()
  .min(3)
  .max(254)
  .regex(/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/, "must be a plain email address");

/**
 * 校验 secure / port 组合：
 * - 465 必须 TLS；
 * - 25/587 仅允许 STARTTLS / NONE；
 * - 其它端口（如 2525）不强约束，由用户负责。
 */
function refinePortSecure<
  T extends { port?: number; secure?: SmtpSecureMode },
>(input: T, ctx: z.RefinementCtx): void {
  const { port, secure } = input;
  if (port === undefined || secure === undefined) return;

  if (port === 465 && secure !== "TLS") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "port 465 必须使用 TLS",
      path: ["secure"],
    });
  }
  if ((port === 25 || port === 587) && secure === "TLS") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `port ${port} 必须使用 STARTTLS 或 NONE`,
      path: ["secure"],
    });
  }
}

const baseShape = {
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).optional(),

  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  secure: SecureModeEnum,

  username: z.string().trim().min(1).max(255).optional(),

  fromEmail: fromEmailSchema,
  fromName: z.string().trim().max(80).optional(),
  replyTo: plainEmailSchema.optional(),

  maxConnections: z.number().int().min(1).max(100).optional(),
  maxMessagesPerConn: z.number().int().min(1).max(10_000).optional(),
  rateLimitPerSec: z.number().int().min(1).max(10_000).optional(),
  connectionTimeoutMs: z.number().int().min(1_000).max(120_000).optional(),
  greetingTimeoutMs: z.number().int().min(1_000).max(120_000).optional(),
  socketTimeoutMs: z.number().int().min(1_000).max(300_000).optional(),

  rejectUnauthorized: z.boolean().optional(),
  requireTls: z.boolean().optional(),
};

/**
 * 创建 SmtpConfig：
 * - `password` 可选；为空字符串 / undefined → 不写入加密字段（适用于 IP 白名单
 *   / OAuth 场景，但此时 `username` 也必须为空）。
 * - 校验失败统一抛 ZodError，由 `handleApiError` 转 400。
 */
export const CreateSmtpConfigSchema = z
  .object({
    ...baseShape,
    password: z.string().min(1).max(1024).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    refinePortSecure(value, ctx);
    if (value.password !== undefined && !value.username) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "username 为空时不能携带 password",
        path: ["password"],
      });
    }
  });

export type CreateSmtpConfigInput = z.infer<typeof CreateSmtpConfigSchema>;

/**
 * 更新 SmtpConfig：所有字段可选；`password` 三态：
 * - 缺省（undefined） / 空串：保持原密码不变；
 * - `null`：清除密码，同时 `username` 必须显式置 `null`；
 * - 非空字符串：重新加密覆盖。
 *
 * `isDefault` / `status` 不在此 schema 中——切换默认通道走 activate 接口；
 * 软删除走 DELETE 路由。
 */
export const UpdateSmtpConfigSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(500).nullable().optional(),

    host: z.string().trim().min(1).max(255).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    secure: SecureModeEnum.optional(),

    username: z.string().trim().min(1).max(255).nullable().optional(),
    /**
     * undefined / "" → 不变；null → 清除；非空字符串 → 重新加密。
     * 这里允许空串以便前端"未触摸"的占位字段也能透传。
     */
    password: z.union([z.string().max(1024), z.null()]).optional(),

    fromEmail: fromEmailSchema.optional(),
    fromName: z.string().trim().max(80).nullable().optional(),
    replyTo: plainEmailSchema.nullable().optional(),

    maxConnections: z.number().int().min(1).max(100).optional(),
    maxMessagesPerConn: z.number().int().min(1).max(10_000).optional(),
    rateLimitPerSec: z.number().int().min(1).max(10_000).nullable().optional(),
    connectionTimeoutMs: z.number().int().min(1_000).max(120_000).optional(),
    greetingTimeoutMs: z.number().int().min(1_000).max(120_000).optional(),
    socketTimeoutMs: z.number().int().min(1_000).max(300_000).optional(),

    rejectUnauthorized: z.boolean().optional(),
    requireTls: z.boolean().optional(),

    status: z.enum(["ACTIVE", "DISABLED"]).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    refinePortSecure(value, ctx);
    // password=null 必须搭配 username=null（spec 第 394 行）。
    if (value.password === null && value.username !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "清除密码时必须同时把 username 置为 null",
        path: ["password"],
      });
    }
  });

export type UpdateSmtpConfigInput = z.infer<typeof UpdateSmtpConfigSchema>;

export const ListSmtpConfigsQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  status: z.enum(CONFIG_STATUSES).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});

export type ListSmtpConfigsQuery = z.infer<typeof ListSmtpConfigsQuerySchema>;

/** 测试发送的请求体；与 campaigns/test-send 形态一致。 */
export const TestSendSchema = z.object({
  to: plainEmailSchema,
  subject: z.string().trim().min(1).max(200),
  html: z.string().min(1).max(200_000),
});

export type TestSendInput = z.infer<typeof TestSendSchema>;

/**
 * 切换激活通道：
 * - provider=RESEND → smtpId 必须为空；
 * - provider=SMTP → smtpId 必填。
 */
export const ActivateProviderSchema = z
  .object({
    provider: ProviderTypeEnum,
    smtpId: z.string().trim().min(1).max(64).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.provider === "SMTP" && !value.smtpId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "切换到 SMTP 通道时必须指定 smtpId",
        path: ["smtpId"],
      });
    }
    if (value.provider === "RESEND" && value.smtpId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "切换到 RESEND 通道时不应携带 smtpId",
        path: ["smtpId"],
      });
    }
  });

export type ActivateProviderInput = z.infer<typeof ActivateProviderSchema>;
