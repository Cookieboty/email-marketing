/**
 * 服务端环境变量加载与校验。
 *
 * 设计：
 * - 使用 zod 在模块加载时校验，失败立即抛出（fail-fast）。
 * - 仅服务端使用；不要在客户端组件 import 此模块。
 * - 读取过程兼容 Edge Runtime（不依赖 fs/path）。
 * - 测试环境放宽：测试中允许大部分变量缺省，避免每个 test file 都 stub。
 */

import { z } from "zod";

const isTestEnv = process.env.NODE_ENV === "test";

const Schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  DATABASE_URL: isTestEnv ? z.string().optional() : z.string().min(1),

  ADMIN_TOKEN: isTestEnv ? z.string().optional() : z.string().min(16),
  SESSION_SECRET: isTestEnv ? z.string().optional() : z.string().min(16),

  RESEND_API_KEY: z.string().optional(),
  RESEND_WEBHOOK_SECRET: z.string().optional(),

  EMAIL_FROM: z.string().optional(),
  APP_URL: z.string().url().optional(),
  DOUBLE_OPT_IN_ENABLED: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
  UPLOAD_DIR: z.string().default("./uploads"),

  FREQUENCY_CAP_DEFAULT_MAX: z.coerce.number().int().positive().default(10),
  FREQUENCY_CAP_DEFAULT_DAYS: z.coerce.number().int().positive().default(7),

  STORE_IP_ADDRESSES: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),

  SENTRY_DSN: z.string().optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  WORKER_POLL_INTERVAL: z.coerce.number().int().positive().default(60_000),

  RATE_LIMIT_LOGIN_MAX: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_LOGIN_WINDOW_SEC: z.coerce.number().int().positive().default(900),
  RATE_LIMIT_TEST_SEND_MAX: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_TEST_SEND_WINDOW_SEC: z.coerce.number().int().positive().default(3600),

  INBOUND_TIMESTAMP_TOLERANCE_SEC: z.coerce.number().int().positive().default(300),
  INBOUND_REQUEST_LOG_TTL_DAYS: z.coerce.number().int().positive().default(7),
  INBOUND_DEFAULT_RPS: z.coerce.number().int().positive().default(20),
  INBOUND_DEFAULT_RPH: z.coerce.number().int().positive().default(3600),
  INBOUND_TOKEN_GRACE_SEC: z.coerce.number().int().positive().default(300),

  IMPORT_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  IMPORT_MAX_RESPONSE_BYTES: z.coerce.number().int().positive().default(52_428_800),
  IMPORT_SOURCE_SECRET_KEY: z.string().optional(),
  IMPORT_JOB_STALE_MINUTES: z.coerce.number().int().positive().default(60),

  SMTP_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(20),
  SMTP_TEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
});

export type Env = z.infer<typeof Schema>;

let cached: Env | null = null;

export function loadEnv(input: NodeJS.ProcessEnv = process.env): Env {
  const parsed = Schema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  return parsed.data;
}

export function env(): Env {
  if (cached) return cached;
  cached = loadEnv();
  return cached;
}

/** 仅供测试：清除缓存以便重新加载。 */
export function __resetEnvCache(): void {
  cached = null;
}
