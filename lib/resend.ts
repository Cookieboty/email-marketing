/**
 * Resend SDK 适配层。
 *
 * 设计：
 *  - 单例 Resend client，避免重复持有 HTTP keep-alive
 *  - sendBatch 保序：batch.send() 返回 data.data 数组，下标与入参一致
 *  - sendSingle 走 emails.send；二者均返回标准化结果 `{ ok, id?, error? }`
 *  - parseRateLimitError：尝试从错误对象/响应头中提取 retryAfterMs；
 *    若不可得，按 `attempt` 计算指数退避（1s/2s/4s/8s/16s，封顶 5min）
 *  - 真正的 retry 逻辑由调用方（worker）控制；本层只负责一次调用与错误归一化
 */

import { Resend } from "resend";
import { env } from "./env";
import { logger } from "./logger";

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

let cached: Resend | null = null;

export function getResendClient(): Resend {
  if (cached) return cached;
  const apiKey = env().RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY is required to use Resend client");
  cached = new Resend(apiKey);
  return cached;
}

/** 测试用：替换/重置单例。 */
export function __setResendClient(client: Resend | null): void {
  cached = client;
}

const DEFAULT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000];
const MAX_BACKOFF_MS = 5 * 60 * 1000;

export function computeBackoffMs(attempt: number): number {
  if (attempt < 0) return 0;
  if (attempt < DEFAULT_BACKOFF_MS.length) return DEFAULT_BACKOFF_MS[attempt]!;
  const exp = Math.pow(2, attempt) * 1000;
  return Math.min(exp, MAX_BACKOFF_MS);
}

interface RateLimitInfo {
  rateLimited: boolean;
  retryAfterMs?: number;
  statusCode?: number;
}

export function parseRateLimitError(err: unknown): RateLimitInfo {
  if (!err || typeof err !== "object") return { rateLimited: false };
  const e = err as Record<string, unknown>;
  const status = (e.statusCode as number) ?? (e.status as number) ?? undefined;
  const name = (e.name as string) ?? "";
  const message = ((e.message as string) ?? "").toLowerCase();

  const isRateLimit =
    status === 429 ||
    name === "rate_limit_exceeded" ||
    message.includes("rate limit") ||
    message.includes("too many requests");

  if (!isRateLimit) return { rateLimited: false, statusCode: status };

  let retryAfterMs: number | undefined;
  const headers = e.headers as Record<string, string> | undefined;
  const retryAfter =
    headers?.["retry-after"] ??
    headers?.["Retry-After"] ??
    (e.retryAfter as string | number | undefined);
  if (typeof retryAfter === "number" && Number.isFinite(retryAfter)) {
    retryAfterMs = retryAfter * 1000;
  } else if (typeof retryAfter === "string") {
    const sec = Number(retryAfter);
    if (Number.isFinite(sec)) retryAfterMs = sec * 1000;
  }

  return { rateLimited: true, retryAfterMs, statusCode: status };
}

function normalizeError(err: unknown): SendResult {
  const info = parseRateLimitError(err);
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : "Unknown send error";
  return {
    ok: false,
    error: message,
    rateLimited: info.rateLimited,
    retryAfterMs: info.retryAfterMs,
    statusCode: info.statusCode,
  };
}

export async function sendSingle(input: SendEmailInput): Promise<SendResult> {
  const client = getResendClient();
  try {
    const { data, error } = await client.emails.send({
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
      return normalizeError(error);
    }
    if (!data?.id) return { ok: false, error: "resend returned no id" };
    return { ok: true, id: data.id };
  } catch (err) {
    logger.warn("resend send threw", {
      message: err instanceof Error ? err.message : String(err),
    });
    return normalizeError(err);
  }
}

/**
 * 批量发送，最多 100 封/调用（Resend 限制）。返回数组与 inputs 同序：
 *  - 整个 batch 失败时，所有项标记同一 error
 *  - 单项失败由 Resend 标记在对应位置
 */
export async function sendBatch(inputs: SendEmailInput[]): Promise<SendResult[]> {
  if (inputs.length === 0) return [];
  if (inputs.length > 100) {
    throw new Error(`sendBatch supports up to 100 emails per call, got ${inputs.length}`);
  }
  const client = getResendClient();
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
    const { data, error } = await client.batch.send(payload);
    if (error) {
      logger.warn("resend batch error", { error: error.message, name: error.name });
      const norm = normalizeError(error);
      return inputs.map(() => norm);
    }
    const items = data?.data ?? [];
    return inputs.map((_, idx) => {
      const item = items[idx];
      if (!item || !item.id) return { ok: false, error: "missing batch item id" };
      return { ok: true, id: item.id };
    });
  } catch (err) {
    logger.warn("resend batch threw", {
      message: err instanceof Error ? err.message : String(err),
    });
    const norm = normalizeError(err);
    return inputs.map(() => norm);
  }
}
