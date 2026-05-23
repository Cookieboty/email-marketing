/**
 * 统一发件传输层。
 *
 * 关联 spec：docs/superpowers/specs/modules/smtp-configuration.md（"发送层抽象"小节）
 *
 * 设计要点：
 *  - 对外暴露与 lib/resend.ts 同形态的 sendSingle/sendBatch；返回 SendResult。
 *  - getActiveTransport() 读取 MailProviderSetting，按 activeProvider 分发：
 *      RESEND → 包装现有 lib/resend.ts；
 *      SMTP   → 解密 + 复用 nodemailer pool transport；
 *  - 进程内 60 秒缓存 + 显式 invalidateActiveTransport()（activate API 调用后立即失效）。
 *  - 同时刻只构造一个 nodemailer pool：用 in-flight Promise 串行化构造。
 *  - 错误归一化：复用 lib/resend.ts 的 SendResult 形态；SMTP 端的错误统一映射为
 *    `{ ok:false, error, statusCode? }`，与 Resend 错误共享 worker 的重试路径。
 *  - sendBatch 在 SMTP 实现里降级为顺序单发 + 速率节流（rateLimitPerSec），保序返回。
 *  - 任何"读 DB / 解密 / 构造 transport"失败都视为最后一道兜底：logger.error 并 fallback
 *    到 RESEND，避免因配置错误把整条发件链路打死。
 */

import { createTransport, type Transporter } from "nodemailer";
import type { MailProviderSetting, SmtpConfig } from "@prisma/client";

import { logger } from "@/lib/logger";
import { decryptSmtpPassword } from "@/lib/modules/smtp/crypto";
import {
  mailProviderSettingRepository,
  smtpConfigRepository,
} from "@/lib/modules/smtp/repository";
import {
  sendBatch as resendSendBatch,
  sendSingle as resendSendSingle,
  type SendEmailInput,
  type SendResult,
} from "@/lib/resend";

export type { SendEmailInput, SendResult };

export interface MailTransport {
  /** 标识当前生效的 provider 类型 + 关联 SmtpConfig.id（仅 SMTP 时有值）。 */
  readonly provider: "RESEND" | "SMTP";
  readonly smtpId: string | null;
  sendSingle(input: SendEmailInput): Promise<SendResult>;
  sendBatch(inputs: SendEmailInput[]): Promise<SendResult[]>;
  /** 关闭底层连接池（仅 SMTP 实际使用）；在 invalidate 时由模块自动调用。 */
  close(): Promise<void>;
}

const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  transport: MailTransport;
  builtAt: number;
}

let cached: CacheEntry | null = null;
let inflight: Promise<MailTransport> | null = null;

/** 调试 / 测试用：手动失效缓存。activateProvider 调用此函数让通道立即生效。 */
export async function invalidateActiveTransport(): Promise<void> {
  const old = cached;
  cached = null;
  inflight = null;
  if (old) {
    try {
      await old.transport.close();
    } catch (err) {
      logger.warn("close stale transport failed", {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** 仅供单测：完全清空状态。 */
export function __resetTransportCacheForTest(): void {
  cached = null;
  inflight = null;
}

/**
 * 取当前激活的发件 transport。
 *  - 命中缓存（且 signature 一致、未超 TTL）直接返回；
 *  - 否则构造新 transport，并把 in-flight Promise 暴露给并发调用方共享。
 */
export async function getActiveTransport(now: number = Date.now()): Promise<MailTransport> {
  if (cached && now - cached.builtAt < CACHE_TTL_MS) return cached.transport;

  if (inflight) return inflight;

  inflight = buildTransport()
    .then((t) => {
      cached = { transport: t, builtAt: Date.now() };
      return t;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

async function buildTransport(): Promise<MailTransport> {
  let setting: MailProviderSetting;
  try {
    setting = await mailProviderSettingRepository.get();
  } catch (err) {
    logger.error("read MailProviderSetting failed; falling back to RESEND", {
      message: err instanceof Error ? err.message : String(err),
    });
    return new ResendTransport();
  }

  if (setting.activeProvider === "RESEND") return new ResendTransport();

  // SMTP
  const smtpId = setting.activeSmtpId;
  if (!smtpId) {
    logger.error(
      "MailProviderSetting.activeProvider=SMTP but activeSmtpId is null; falling back to RESEND",
    );
    return new ResendTransport();
  }

  let config: SmtpConfig | null;
  try {
    config = await smtpConfigRepository.findById(smtpId);
  } catch (err) {
    logger.error("load SmtpConfig failed; falling back to RESEND", {
      smtpId,
      message: err instanceof Error ? err.message : String(err),
    });
    return new ResendTransport();
  }
  if (!config || config.status !== "ACTIVE") {
    logger.error("active SmtpConfig missing or not ACTIVE; falling back to RESEND", {
      smtpId,
      status: config?.status ?? null,
    });
    return new ResendTransport();
  }

  let plainPassword: string | null = null;
  if (config.passwordCipher) {
    try {
      plainPassword = decryptSmtpPassword(config.passwordCipher);
    } catch (err) {
      logger.error("decrypt SmtpConfig password failed; falling back to RESEND", {
        smtpId,
        message: err instanceof Error ? err.message : String(err),
      });
      return new ResendTransport();
    }
  }

  try {
    return new SmtpTransport(config, plainPassword);
  } catch (err) {
    logger.error("build SmtpTransport failed; falling back to RESEND", {
      smtpId,
      message: err instanceof Error ? err.message : String(err),
    });
    return new ResendTransport();
  }
}

// ───────────────────────────── ResendTransport ─────────────────────────────

export class ResendTransport implements MailTransport {
  readonly provider = "RESEND" as const;
  readonly smtpId: string | null = null;

  sendSingle(input: SendEmailInput): Promise<SendResult> {
    return resendSendSingle(input);
  }

  sendBatch(inputs: SendEmailInput[]): Promise<SendResult[]> {
    return resendSendBatch(inputs);
  }

  async close(): Promise<void> {
    /* Resend 客户端无显式池可关 */
  }
}

// ───────────────────────────── SmtpTransport ─────────────────────────────

interface NodemailerLikeError {
  message?: unknown;
  responseCode?: unknown;
  code?: unknown;
  command?: unknown;
}

export class SmtpTransport implements MailTransport {
  readonly provider = "SMTP" as const;
  readonly smtpId: string;
  private readonly transporter: Transporter;
  private readonly fromHeader: string;
  private readonly replyTo: string | null;
  private readonly minIntervalMs: number;
  private lastSendAt = 0;

  constructor(
    config: SmtpConfig,
    plainPassword: string | null,
    /** 测试注入：替换 nodemailer.createTransport，便于单元测试不开真 socket。 */
    transporterFactory: typeof createTransport = createTransport,
  ) {
    this.smtpId = config.id;
    this.fromHeader = config.fromName
      ? `${config.fromName} <${config.fromEmail}>`
      : config.fromEmail;
    this.replyTo = config.replyTo ?? null;
    this.minIntervalMs =
      config.rateLimitPerSec && config.rateLimitPerSec > 0
        ? Math.ceil(1000 / config.rateLimitPerSec)
        : 0;

    const auth =
      config.username && plainPassword
        ? { user: config.username, pass: plainPassword }
        : undefined;

    this.transporter = transporterFactory({
      host: config.host,
      port: config.port,
      secure: config.secure === "TLS",
      requireTLS: config.secure === "STARTTLS" || config.requireTls,
      ...(auth ? { auth } : {}),
      pool: true,
      maxConnections: config.maxConnections,
      maxMessages: config.maxMessagesPerConn,
      connectionTimeout: config.connectionTimeoutMs,
      greetingTimeout: config.greetingTimeoutMs,
      socketTimeout: config.socketTimeoutMs,
      tls: { rejectUnauthorized: config.rejectUnauthorized },
    });
  }

  async sendSingle(input: SendEmailInput): Promise<SendResult> {
    return this.scheduledSend(input);
  }

  /**
   * SMTP 没有 batch API：顺序单发；rateLimitPerSec 决定相邻两封的最小间隔。
   * 顺序由 `inputs` 决定，保证返回数组与输入一一对应（与 Resend 行为对齐）。
   */
  async sendBatch(inputs: SendEmailInput[]): Promise<SendResult[]> {
    const out: SendResult[] = [];
    for (const input of inputs) {
      out.push(await this.scheduledSend(input));
    }
    return out;
  }

  async close(): Promise<void> {
    try {
      this.transporter.close();
    } catch {
      /* nodemailer 的 close 同步且不抛，但保险起见忽略 */
    }
  }

  private async scheduledSend(input: SendEmailInput): Promise<SendResult> {
    if (this.minIntervalMs > 0) {
      const now = Date.now();
      const wait = this.lastSendAt + this.minIntervalMs - now;
      if (wait > 0) await sleep(wait);
      this.lastSendAt = Date.now();
    }
    return this.sendOnce(input);
  }

  private async sendOnce(input: SendEmailInput): Promise<SendResult> {
    const replyTo = input.replyTo ?? this.replyTo ?? undefined;
    try {
      const info = await this.transporter.sendMail({
        from: input.from || this.fromHeader,
        to: input.to,
        subject: input.subject,
        html: input.html,
        ...(input.text ? { text: input.text } : {}),
        ...(replyTo ? { replyTo } : {}),
        ...(input.headers ? { headers: input.headers } : {}),
      });
      const id = (info as { messageId?: string } | null)?.messageId;
      if (!id) return { ok: false, error: "smtp returned no messageId" };
      return { ok: true, id };
    } catch (err) {
      const e = err as NodemailerLikeError;
      const message =
        typeof e.message === "string" && e.message.length > 0
          ? e.message
          : err instanceof Error
            ? err.message
            : "Unknown SMTP send error";
      const statusCode =
        typeof e.responseCode === "number" && Number.isFinite(e.responseCode)
          ? (e.responseCode as number)
          : undefined;
      logger.warn("smtp send error", {
        smtpId: this.smtpId,
        code: typeof e.code === "string" ? e.code : undefined,
        statusCode,
        message,
      });
      return {
        ok: false,
        error: message,
        ...(statusCode !== undefined ? { statusCode } : {}),
      };
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ───────────────────────────── 连接验证 ─────────────────────────────

export interface VerifySmtpConnectionInput {
  host: string;
  port: number;
  secure: SmtpConfig["secure"];
  username: string | null;
  password: string | null;
  rejectUnauthorized: boolean;
  requireTls: boolean;
  connectionTimeoutMs: number;
  greetingTimeoutMs: number;
  socketTimeoutMs: number;
}

export interface VerifySmtpConnectionResult {
  ok: boolean;
  error?: string;
  code?: string;
  responseCode?: number;
}

/**
 * 不发邮件，只用 nodemailer.verify() 验证 SMTP 服务器可达 + 鉴权通过。
 *
 * - 一次性 transporter（pool=false），用完即关；
 * - 错误归一化：返回 { ok:false, error, code?, responseCode? }，
 *   不抛异常，调用方按 SmtpTestStatus 写回 DB。
 */
export async function verifySmtpConnection(
  input: VerifySmtpConnectionInput,
  transporterFactory: typeof createTransport = createTransport,
): Promise<VerifySmtpConnectionResult> {
  const auth =
    input.username && input.password
      ? { user: input.username, pass: input.password }
      : undefined;

  const transporter = transporterFactory({
    host: input.host,
    port: input.port,
    secure: input.secure === "TLS",
    requireTLS: input.secure === "STARTTLS" || input.requireTls,
    ...(auth ? { auth } : {}),
    connectionTimeout: input.connectionTimeoutMs,
    greetingTimeout: input.greetingTimeoutMs,
    socketTimeout: input.socketTimeoutMs,
    tls: { rejectUnauthorized: input.rejectUnauthorized },
  });

  try {
    await transporter.verify();
    return { ok: true };
  } catch (err) {
    const e = err as NodemailerLikeError;
    const message =
      typeof e.message === "string" && e.message.length > 0
        ? e.message
        : err instanceof Error
          ? err.message
          : "SMTP verify failed";
    const code = typeof e.code === "string" ? e.code : undefined;
    const responseCode =
      typeof e.responseCode === "number" && Number.isFinite(e.responseCode)
        ? (e.responseCode as number)
        : undefined;
    return {
      ok: false,
      error: message,
      ...(code ? { code } : {}),
      ...(responseCode !== undefined ? { responseCode } : {}),
    };
  } finally {
    try {
      transporter.close();
    } catch {
      /* ignore */
    }
  }
}

// ───────────────────────────── 便捷转发 ─────────────────────────────

/**
 * 便捷包装：单封发送，等价于 `(await getActiveTransport()).sendSingle(input)`。
 * 提供给迁移自 lib/resend.ts 的调用方零摩擦切换。
 */
export async function sendSingle(input: SendEmailInput): Promise<SendResult> {
  const t = await getActiveTransport();
  return t.sendSingle(input);
}

export async function sendBatch(inputs: SendEmailInput[]): Promise<SendResult[]> {
  const t = await getActiveTransport();
  return t.sendBatch(inputs);
}
