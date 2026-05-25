/**
 * 模板测试发送。
 *
 * 设计：
 *  - 限流维度：当前 session 的 sub（Phase-2 SessionPayload 用 sessionId 作为 admin 标识）
 *  - 与登录限流共享 RateLimiter 抽象，独立 bucket 命名空间 `test-send`
 *  - 不写 CampaignRecipient/EmailEvent
 *  - AuditLog 记录目标邮箱与模板 id
 */

import { env } from "@/lib/env";
import { RateLimitError, ValidationError } from "@/lib/errors";
import { audit } from "@/lib/audit";
import { normalizeEmail } from "@/lib/email-utils";
import { __resetRateLimiters, getRateLimiter } from "@/lib/rate-limit";
import { sendSingle, getTransportForChannel, getSystemDefaultTransport, type SendResult } from "@/lib/modules/mail/transport";
import {
  buildTemplateSnapshot,
  type TemplateWithLocalesForSnapshot,
} from "@/lib/modules/template/snapshot";
import { renderSnapshotContent } from "@/lib/modules/template/render";
import { environmentVariableService } from "@/lib/modules/environment-variable/service";
import type { Locale } from "@prisma/client";

export interface TestSendContext {
  adminId: string; // 来自 SessionPayload.sessionId
  to: string;
  variables?: Record<string, string>;
  locale?: Locale;
  subjects?: Partial<Record<Locale, string>>;
  template: TemplateWithLocalesForSnapshot & { id: string; name: string };
  req?: { headers: Headers } | null;
  channelId?: string;
}

const RL_NAME = "test-send";

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
  const target = normalizeEmail(ctx.to);

  // 1. 限流（按 admin 维度：bucket = test-send:<adminId>）
  const limiter = getTestSendLimiter();
  const decision = limiter.check(`${RL_NAME}:${ctx.adminId}`);
  if (!decision.allowed) {
    throw new RateLimitError(decision.retryAfterSec);
  }

  // 2. 发件人
  const fromAddr = env().EMAIL_FROM;
  if (!fromAddr) {
    throw new ValidationError("EMAIL_FROM is not configured");
  }

  // 3. 渲染
  const envVars = await environmentVariableService.getVariablesMap();
  const mergedVars = { ...envVars, ...(ctx.variables ?? {}) };
  const builtin = {
    userEmail: target,
    userName: mergedVars.user_name ?? "测试用户",
    campaignName: "[测试发送] " + ctx.template.name,
  };
  const rendered = renderSnapshotContent({
    snapshot: buildTemplateSnapshot(ctx.template),
    resolvedLocale: ctx.locale ?? ctx.template.defaultLocale,
    subjects: ctx.subjects,
    variables: mergedVars,
    builtin,
  });

  // 4. 发送（指定 channelId 时走对应通道，否则走系统默认）
  const emailInput = {
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
  };
  let result: SendResult;
  if (ctx.channelId) {
    const transport = await getTransportForChannel(ctx.channelId);
    try {
      result = await transport.sendSingle(emailInput);
    } finally {
      await transport.close();
    }
  } else {
    let transport;
    try {
      transport = await getSystemDefaultTransport();
    } catch {
      throw new ValidationError("请先在「设置 → 发信渠道」中配置一个系统默认渠道，或在测试发送时选择指定渠道");
    }
    try {
      result = await transport.sendSingle(emailInput);
    } finally {
      await transport.close();
    }
  }

  // 5. 记录限流计数
  limiter.recordFailure(`${RL_NAME}:${ctx.adminId}`);

  // 6. 审计
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
