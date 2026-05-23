/**
 * Double Opt-in 业务逻辑（specs/modules/user-management.md §438-496，phase-4 §4.2）。
 *
 * 设计：
 *  - Token：32 字节随机 → URL-safe base64（无填充），约 43 字符；写 User.optInToken（unique）
 *  - 过期：48h；任何"读路径"（确认 / 资格判断）发现已超期 → 写 EXPIRED 并清 token
 *  - 状态机：
 *      NOT_REQUIRED：DOUBLE_OPT_IN_ENABLED=false 时新增用户的默认值（不进入流程）
 *      PENDING     ：等待确认；token + sentAt 必须同时存在
 *      CONFIRMED   ：已确认（幂等返回 success）
 *      EXPIRED     ：48h 未确认；可被 resendOptIn 重置回 PENDING
 *  - 邮件渲染：使用 lib/template-engine.render；正文为系统内置 HTML 模板（不入库）
 *  - 重发限流：按 userId 维度（具体用户重复触发受限），与登录/test-send 共享 RateLimiter
 *  - 所有副作用走 audit fire-and-forget；失败不抛
 */

import { randomBytes } from "node:crypto";
import { OptInStatus, type Prisma, type User } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import {
  ConflictError,
  NotFoundError,
  RateLimitError,
  ValidationError,
} from "@/lib/errors";
import { getRateLimiter, __resetRateLimiters } from "@/lib/rate-limit";
import { sendSingle } from "@/lib/modules/mail/transport";
import { render } from "@/lib/template-engine";

export const OPT_IN_TOKEN_TTL_MS = 48 * 60 * 60 * 1000;
const RL_NAME = "opt-in-resend";

/** 生成 URL-safe base64 token（无填充）。约 43 字符。 */
export function generateOptInToken(): string {
  return randomBytes(32)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function isOptInExpired(sentAt: Date | null | undefined, now: Date = new Date()): boolean {
  if (!sentAt) return false;
  return now.getTime() - sentAt.getTime() > OPT_IN_TOKEN_TTL_MS;
}

/** 系统内置确认邮件模板（不入库）。变量：user_email / confirm_url。 */
export const CONFIRM_EMAIL_SUBJECT = "请确认您的订阅";
export const CONFIRM_EMAIL_HTML = [
  "<!doctype html><html><body style=\"font-family:Arial,sans-serif;line-height:1.6;color:#222\">",
  "<p>你好 {{user_email}}，</p>",
  "<p>感谢订阅。请点击下方链接完成订阅确认：</p>",
  '<p><a href="{{confirm_url}}" style="display:inline-block;padding:10px 20px;background:#2563eb;color:#fff;text-decoration:none;border-radius:4px">确认订阅</a></p>',
  "<p>若按钮无法点击，请复制以下链接到浏览器打开：</p>",
  "<p>{{confirm_url}}</p>",
  "<p>该链接 48 小时内有效。如非本人操作，请忽略此邮件。</p>",
  "</body></html>",
].join("");
export const CONFIRM_EMAIL_TEXT = [
  "你好 {{user_email}}，",
  "",
  "感谢订阅。请打开以下链接完成订阅确认（48 小时内有效）：",
  "{{confirm_url}}",
  "",
  "如非本人操作，请忽略此邮件。",
].join("\n");

/** 拼接确认 URL。要求 APP_URL 已配置。 */
export function buildConfirmUrl(token: string): string {
  const base = env().APP_URL;
  if (!base) throw new ValidationError("APP_URL is not configured");
  const trimmed = base.replace(/\/+$/, "");
  return `${trimmed}/api/confirm?token=${encodeURIComponent(token)}`;
}

export interface SendOptInEmailResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

export interface SendOptInEmailDeps {
  send?: typeof sendSingle;
  now?: () => Date;
}

/**
 * 渲染并发送确认邮件，写回 optInToken/sentAt/status=PENDING。
 * 仅当 DOUBLE_OPT_IN_ENABLED=true 时调用方应触发。
 */
export async function sendOptInEmail(
  userId: string,
  deps: SendOptInEmailDeps = {},
): Promise<SendOptInEmailResult> {
  const fromAddr = env().EMAIL_FROM;
  if (!fromAddr) throw new ValidationError("EMAIL_FROM is not configured");

  const now = (deps.now ?? (() => new Date()))();
  const token = generateOptInToken();
  const confirmUrl = buildConfirmUrl(token);

  // 落 token + sentAt + PENDING 必须先于发邮件，避免重复点击/重发竞态
  const user = await prisma.user.update({
    where: { id: userId },
    data: {
      optInToken: token,
      optInSentAt: now,
      optInStatus: OptInStatus.PENDING,
    },
  });

  const builtin = { userEmail: user.email };
  const vars = { user_email: user.email, confirm_url: confirmUrl };

  const send = deps.send ?? sendSingle;
  const result = await send({
    from: fromAddr,
    to: user.email,
    subject: render(CONFIRM_EMAIL_SUBJECT, vars, { builtin }),
    html: render(CONFIRM_EMAIL_HTML, vars, { builtin }),
    text: render(CONFIRM_EMAIL_TEXT, vars, { builtin }),
    headers: {
      "X-Email-Opt-In": "1",
      "X-User-Id": userId,
    },
    tags: [{ name: "opt-in", value: "1" }],
  });

  audit({
    action: "user.opt_in_send",
    entityType: "User",
    entityId: userId,
    actorType: "SYSTEM",
    details: {
      to: user.email,
      ok: result.ok,
      ...(result.ok ? { messageId: result.id } : { error: result.error }),
    },
  });

  if (!result.ok) {
    logger.warn("opt-in email send failed", {
      userId,
      error: result.error,
    });
    return { ok: false, error: result.error };
  }
  return { ok: true, messageId: result.id };
}

/**
 * 重发确认邮件：仅 PENDING / EXPIRED 允许；CONFIRMED 拒绝；NOT_REQUIRED 拒绝。
 * 限流：按 userId 维度（默认借用 RATE_LIMIT_TEST_SEND_*，避免单用户被刷邮件）。
 */
export async function resendOptInEmail(
  userId: string,
  ctx: { req?: { headers: Headers } | null } = {},
): Promise<SendOptInEmailResult> {
  if (!env().DOUBLE_OPT_IN_ENABLED) {
    throw new ConflictError("Double opt-in is disabled");
  }
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new NotFoundError("User not found");
  if (user.optInStatus === OptInStatus.NOT_REQUIRED) {
    throw new ConflictError("User does not require opt-in");
  }
  if (user.optInStatus === OptInStatus.CONFIRMED) {
    throw new ConflictError("User is already confirmed");
  }

  const limiter = getRateLimiter(RL_NAME, {
    maxAttempts: env().RATE_LIMIT_TEST_SEND_MAX,
    windowSec: env().RATE_LIMIT_TEST_SEND_WINDOW_SEC,
    lockSec: 60,
  });
  const key = `${RL_NAME}:${userId}`;
  const decision = limiter.check(key);
  if (!decision.allowed) throw new RateLimitError(decision.retryAfterSec);

  const result = await sendOptInEmail(userId);
  limiter.recordFailure(key);

  audit({
    action: "user.opt_in_resend",
    entityType: "User",
    entityId: userId,
    actorType: "ADMIN",
    details: { to: user.email, ok: result.ok },
    req: ctx.req ?? null,
  });

  return result;
}

export type ConfirmOutcome =
  | { status: "confirmed"; user: User }
  | { status: "already_confirmed"; user: User }
  | { status: "expired" }
  | { status: "not_found" };

/**
 * 执行确认（POST /api/confirm）。处理逻辑遵循 specs §480-485 + phase-4 §4.2：
 *  1. WHERE optInToken=token；不存在 → not_found（404）
 *  2. CONFIRMED → already_confirmed（200，幂等）
 *  3. PENDING + 已超期 → 写 EXPIRED + 清 token，返回 expired（410）
 *  4. PENDING 未超期 → 写 CONFIRMED，清 token，返回 confirmed
 */
export async function confirmOptInByToken(
  token: string,
  ctx: { req?: { headers: Headers } | null; now?: Date } = {},
): Promise<ConfirmOutcome> {
  if (!token || typeof token !== "string") {
    throw new ValidationError("token is required");
  }
  const now = ctx.now ?? new Date();
  const user = await prisma.user.findUnique({ where: { optInToken: token } });
  if (!user) return { status: "not_found" };

  if (user.optInStatus === OptInStatus.CONFIRMED) {
    return { status: "already_confirmed", user };
  }

  if (isOptInExpired(user.optInSentAt, now)) {
    const data: Prisma.UserUncheckedUpdateInput = {
      optInStatus: OptInStatus.EXPIRED,
      optInToken: null,
    };
    await prisma.user.update({ where: { id: user.id }, data });
    audit({
      action: "user.opt_in_expired",
      entityType: "User",
      entityId: user.id,
      actorType: "SYSTEM",
      details: { email: user.email },
      req: ctx.req ?? null,
    });
    return { status: "expired" };
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: {
      optInStatus: OptInStatus.CONFIRMED,
      optInToken: null,
    },
  });
  audit({
    action: "user.opt_in_confirm",
    entityType: "User",
    entityId: user.id,
    actorType: "SYSTEM",
    details: { email: user.email },
    req: ctx.req ?? null,
  });
  return { status: "confirmed", user: updated };
}

/** 仅供测试：清除重发限流计数（与 test-send 共享同一注册表）。 */
export function __resetOptInResendLimiter(): void {
  __resetRateLimiters();
}
