/**
 * 统一发件传输层。
 *
 * 设计要点：
 *  - 对外暴露 sendSingle/sendBatch（便捷包装，走系统默认通道）+ getTransportForChannel。
 *  - getTransportForChannel(channelId) 读 SendingChannel → 构造对应 transport。
 *  - getSystemDefaultTransport() 读 isSystemDefault=true 的 channel，用于系统邮件。
 *  - ResendTransport 接受注入的 Resend client（不再读全局 env key）。
 *  - SmtpTransport 与之前一致，解密 + nodemailer pool。
 *  - 错误归一化：复用 SendResult 形态。
 *  - sendBatch 在 SMTP 实现里降级为顺序单发 + 速率节流（rateLimitPerSec）。
 */

import { Resend } from "resend";
import { createTransport, type Transporter } from "nodemailer";
import type { SmtpConfig } from "@prisma/client";

import { logger } from "@/lib/logger";
import { decryptSmtpPassword, decryptResendApiKey } from "@/lib/modules/smtp/crypto";
import { prisma } from "@/lib/prisma";

export interface SendEmailInput {
  from: string;
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  headers?: Record<string, string>;
  tags?: { name: string; value: string }[];
}

export type SendResult =
  | { ok: true; id: string }
  | { ok: false; error: string; rateLimited?: boolean; retryAfterMs?: number; statusCode?: number };

export interface MailTransport {
  readonly provider: "RESEND" | "SMTP";
  readonly channelId: string | null;
  sendSingle(input: SendEmailInput): Promise<SendResult>;
  sendBatch(inputs: SendEmailInput[]): Promise<SendResult[]>;
  close(): Promise<void>;
}

// ───────────────────────────── Channel-based transport ─────────────────────────────

/**
 * 为指定 SendingChannel 构造 transport。每次调用新建（不缓存），适用于 worker 批次粒度。
 */
export async function getTransportForChannel(channelId: string): Promise<MailTransport> {
  const channel = await prisma.sendingChannel.findUnique({
    where: { id: channelId },
    include: { smtpConfig: true, resendConfig: true },
  });
  if (!channel) throw new Error(`SendingChannel not found: ${channelId}`);
  if (channel.status !== "ACTIVE") throw new Error(`SendingChannel is ${channel.status}: ${channelId}`);

  if (channel.providerType === "RESEND") {
    if (!channel.resendConfig) throw new Error(`SendingChannel ${channelId} missing resendConfig`);
    if (channel.resendConfig.status !== "ACTIVE") {
      throw new Error(`ResendConfig is ${channel.resendConfig.status}`);
    }
    const apiKey = decryptResendApiKey(channel.resendConfig.apiKeyCipher);
    const client = new Resend(apiKey);
    return new ResendTransport(client, channelId);
  }

  // SMTP
  if (!channel.smtpConfig) throw new Error(`SendingChannel ${channelId} missing smtpConfig`);
  if (channel.smtpConfig.status !== "ACTIVE") {
    throw new Error(`SmtpConfig is ${channel.smtpConfig.status}`);
  }

  let plainPassword: string | null = null;
  if (channel.smtpConfig.passwordCipher) {
    plainPassword = decryptSmtpPassword(channel.smtpConfig.passwordCipher);
  }
  return new SmtpTransport(channel.smtpConfig, plainPassword, channelId);
}

/**
 * 取系统默认通道的 transport。用于系统邮件（opt-in 等）。
 */
export async function getSystemDefaultTransport(): Promise<MailTransport> {
  const channel = await prisma.sendingChannel.findFirst({
    where: { isSystemDefault: true, status: "ACTIVE" },
  });
  if (!channel) throw new Error("No system default SendingChannel configured");
  return getTransportForChannel(channel.id);
}

// ───────────────────────────── 便捷转发（系统邮件用） ─────────────────────────────

export async function sendSingle(input: SendEmailInput): Promise<SendResult> {
  const t = await getSystemDefaultTransport();
  try {
    return await t.sendSingle(input);
  } finally {
    await t.close();
  }
}

export async function sendBatch(inputs: SendEmailInput[]): Promise<SendResult[]> {
  const t = await getSystemDefaultTransport();
  try {
    return await t.sendBatch(inputs);
  } finally {
    await t.close();
  }
}

// ───────────────────────────── ResendTransport ─────────────────────────────

function normalizeResendError(err: unknown): SendResult {
  let message = "Unknown send error";
  if (err instanceof Error) {
    message = err.message;
  } else if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string" && m.length > 0) message = m;
  } else if (typeof err === "string") {
    message = err;
  }

  let statusCode: number | undefined;
  let rateLimited = false;
  let retryAfterMs: number | undefined;

  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    const status = (e.statusCode as number) ?? (e.status as number) ?? undefined;
    statusCode = typeof status === "number" ? status : undefined;
    const name = (e.name as string) ?? "";
    const msg = message.toLowerCase();
    rateLimited =
      status === 429 ||
      name === "rate_limit_exceeded" ||
      msg.includes("rate limit") ||
      msg.includes("too many requests");
    if (rateLimited) {
      const headers = e.headers as Record<string, string> | undefined;
      const retryAfter = headers?.["retry-after"] ?? headers?.["Retry-After"];
      if (typeof retryAfter === "string") {
        const sec = Number(retryAfter);
        if (Number.isFinite(sec)) retryAfterMs = sec * 1000;
      }
    }
  }
  return { ok: false, error: message, rateLimited, retryAfterMs, statusCode };
}

export class ResendTransport implements MailTransport {
  readonly provider = "RESEND" as const;
  readonly channelId: string | null;
  private readonly client: Resend;

  constructor(client: Resend, channelId: string | null = null) {
    this.client = client;
    this.channelId = channelId;
  }

  async sendSingle(input: SendEmailInput): Promise<SendResult> {
    try {
      const { data, error } = await this.client.emails.send({
        from: input.from,
        to: input.to,
        subject: input.subject,
        html: input.html,
        ...(input.text ? { text: input.text } : {}),
        ...(input.replyTo ? { replyTo: input.replyTo } : {}),
        ...(input.headers ? { headers: input.headers } : {}),
        ...(input.tags ? { tags: input.tags } : {}),
      });
      if (error) {
        logger.warn("resend send error", { error: error.message, name: error.name });
        return normalizeResendError(error);
      }
      if (!data?.id) return { ok: false, error: "resend returned no id" };
      return { ok: true, id: data.id };
    } catch (err) {
      logger.warn("resend send threw", { message: err instanceof Error ? err.message : String(err) });
      return normalizeResendError(err);
    }
  }

  async sendBatch(inputs: SendEmailInput[]): Promise<SendResult[]> {
    if (inputs.length === 0) return [];
    if (inputs.length > 100) {
      throw new Error(`sendBatch supports up to 100 emails per call, got ${inputs.length}`);
    }
    const payload = inputs.map((i) => ({
      from: i.from,
      to: i.to,
      subject: i.subject,
      html: i.html,
      ...(i.text ? { text: i.text } : {}),
      ...(i.replyTo ? { replyTo: i.replyTo } : {}),
      ...(i.headers ? { headers: i.headers } : {}),
      ...(i.tags ? { tags: i.tags } : {}),
    }));
    try {
      const { data, error } = await this.client.batch.send(payload);
      if (error) {
        logger.warn("resend batch error", { error: error.message, name: error.name });
        const norm = normalizeResendError(error);
        return inputs.map(() => norm);
      }
      const items = data?.data ?? [];
      return inputs.map((_, idx) => {
        const item = items[idx];
        if (!item || !item.id) return { ok: false, error: "missing batch item id" };
        return { ok: true, id: item.id };
      });
    } catch (err) {
      logger.warn("resend batch threw", { message: err instanceof Error ? err.message : String(err) });
      const norm = normalizeResendError(err);
      return inputs.map(() => norm);
    }
  }

  async close(): Promise<void> {}
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
  readonly channelId: string | null;
  private readonly transporter: Transporter;
  private readonly fromHeader: string;
  private readonly replyTo: string | null;
  private readonly minIntervalMs: number;
  private lastSendAt = 0;

  constructor(
    config: SmtpConfig,
    plainPassword: string | null,
    channelId: string | null = null,
    transporterFactory: typeof createTransport = createTransport,
  ) {
    this.channelId = channelId;
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
    } catch { /* ignore */ }
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
        channelId: this.channelId,
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

/** @deprecated No longer caches globally; kept for backward compat with SmtpService. */
export async function invalidateActiveTransport(): Promise<void> {}

/** @deprecated Test helper; no longer needed. */
export function __resetTransportCacheForTest(): void {}

/** @deprecated Use getTransportForChannel or getSystemDefaultTransport. */
export const getActiveTransport = getSystemDefaultTransport;

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
    } catch { /* ignore */ }
  }
}
