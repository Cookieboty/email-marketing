/**
 * 模板测试发送（specs/plan §4.4 §test-send）。
 *
 * 设计：
 *  - 收件人必须命中 ADMIN_TEST_EMAILS 白名单（逗号分隔，大小写不敏感、归一化）
 *  - 限流维度：当前 session 的 sub（Phase-2 SessionPayload 用 sessionId 作为 admin 标识）
 *  - 与登录限流共享 RateLimiter 抽象，独立 bucket 命名空间 `test-send`
 *  - 调用 Resend 单发；不写 CampaignRecipient/EmailEvent
 *  - AuditLog 记录目标邮箱（已脱敏）与模板 id
 */

import { env } from "@/lib/env";
import { ForbiddenError, RateLimitError, ValidationError } from "@/lib/errors";
import { audit } from "@/lib/audit";
import { normalizeEmail } from "@/lib/email-utils";
import { __resetRateLimiters, getRateLimiter } from "@/lib/rate-limit";
import { sendSingle, type SendResult } from "@/lib/modules/mail/transport";
import {
  buildTemplateSnapshot,
  type TemplateWithLocalesForSnapshot,
} from "@/lib/modules/template/snapshot";
import { renderSnapshotContent } from "@/lib/modules/template/render";
import type { Locale } from "@prisma/client";

export interface TestSendContext {
  adminId: string; // 来自 SessionPayload.sessionId
  to: string;
  variables?: Record<string, string>;
  locale?: Locale;
  subjects?: Partial<Record<Locale, string>>;
  template: TemplateWithLocalesForSnapshot & { id: string; name: string };
  req?: { headers: Headers } | null;
}

const RL_NAME = "test-send";

/** 解析 ADMIN_TEST_EMAILS（逗号分隔），返回归一化后的 Set。 */
export function getAdminTestWhitelist(): Set<string> {
  const raw = env().ADMIN_TEST_EMAILS ?? "";
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => normalizeEmail(s));
  return new Set(list);
}

function getTestSendLimiter() {
  return getRateLimiter(RL_NAME, {
    maxAttempts: env().RATE_LIMIT_TEST_SEND_MAX,
    windowSec: env().RATE_LIMIT_TEST_SEND_WINDOW_SEC,
    lockSec: 60,
  });
}

/** 测试用：清空 test-send 限流计数（同时重置整个命名注册表，便于 env 切换）。 */
export function __resetTestSendLimiter(): void {
  __resetRateLimiters();
}

export async function testSendTemplate(ctx: TestSendContext): Promise<SendResult> {
  // 1. 白名单（specs/plan §4.4 §测试发送）
  const whitelist = getAdminTestWhitelist();
  if (whitelist.size === 0) {
    throw new ForbiddenError("Test send is disabled (ADMIN_TEST_EMAILS not configured)");
  }
  const target = normalizeEmail(ctx.to);
  if (!whitelist.has(target)) {
    throw new ForbiddenError("Recipient is not in admin test whitelist");
  }

  // 2. 限流（按 admin 维度：bucket = test-send:<adminId>）
  const limiter = getTestSendLimiter();
  const decision = limiter.check(`${RL_NAME}:${ctx.adminId}`);
  if (!decision.allowed) {
    throw new RateLimitError(decision.retryAfterSec);
  }

  // 3. 发件人
  const fromAddr = env().EMAIL_FROM;
  if (!fromAddr) {
    throw new ValidationError("EMAIL_FROM is not configured");
  }

  // 4. 渲染（使用 template-engine 的内置变量 + 用户提供变量）
  const builtin = {
    userEmail: target,
    userName: ctx.variables?.user_name ?? "测试用户",
    campaignName: "[测试发送] " + ctx.template.name,
  };
  const rendered = renderSnapshotContent({
    snapshot: buildTemplateSnapshot(ctx.template),
    resolvedLocale: ctx.locale ?? ctx.template.defaultLocale,
    subjects: ctx.subjects,
    variables: ctx.variables ?? {},
    builtin,
  });

  // 5. 发送
  const result = await sendSingle({
    from: fromAddr,
    to: target,
    subject: `[TEST] ${rendered.subject}`,
    html: rendered.html,
    ...(rendered.text ? { text: rendered.text } : {}),
    headers: {
      "X-Email-Test-Send": "1",
      "X-Template-Id": ctx.template.id,
    },
    tags: [{ name: "test-send", value: "1" }],
  });

  // 6. 记录限流计数（recordFailure 内含计数，以"每次调用算 1 次"为限流逻辑）
  limiter.recordFailure(`${RL_NAME}:${ctx.adminId}`);

  // 7. 审计
  audit({
    action: "template.test_send",
    entityType: "EmailTemplate",
    entityId: ctx.template.id,
    actorType: "ADMIN",
    details: {
      to: target,
      ok: result.ok,
      ...(result.ok ? { messageId: result.id } : { error: result.error }),
    },
    req: ctx.req ?? null,
  });

  return result;
}
