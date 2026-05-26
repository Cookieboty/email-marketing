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
import { isValidFromHeader, normalizeEmail } from "@/lib/email-utils";
import { prisma } from "@/lib/prisma";
import { __resetRateLimiters, getRateLimiter } from "@/lib/rate-limit";
import { getTransportForChannel, type SendResult } from "@/lib/modules/mail/transport";
import {
  buildTemplateSnapshot,
  type TemplateWithLocalesForSnapshot,
} from "@/lib/modules/template/snapshot";
import { renderSnapshotContent } from "@/lib/modules/template/render";
import {
  blockErrorToValidationError,
  collectBlockRefsPerLocale,
  loadBlocksByPairs,
} from "@/lib/modules/template/service";
import {
  BlockExpansionError,
  type BlockResolver,
} from "@/lib/template-engine";
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

  // 2. 解析渠道 + 发件人
  //    优先使用 SendingChannel 上配置的 fromEmail/fromName（与渠道域名授权一致），
  //    仅当渠道未配 fromEmail 时回退到 env().EMAIL_FROM。
  //    不在此处 fallback 到环境变量是 Resend "domain not authorized" 报错的根因。
  const channel = await resolveChannelForTestSend(ctx.channelId);
  const fromAddr = buildFromHeader(channel.fromEmail, channel.fromName) ?? env().EMAIL_FROM;
  if (!fromAddr) {
    throw new ValidationError(
      "未配置发件人：请在「设置 → 发信渠道」为渠道填写 From Email，或配置 EMAIL_FROM 环境变量",
    );
  }
  if (!isValidFromHeader(fromAddr)) {
    throw new ValidationError(`Invalid from header: ${fromAddr}`);
  }

  // 3. 渲染
  //    优先级（与正式发送 worker 对齐）：
  //      ctx.variables.user_name（调用方显式覆盖）
  //        > 收件人邮箱在 User 表里命中的 name
  //        > "测试用户"（兜底，邮箱不在用户库时）
  const envVars = await environmentVariableService.getVariablesMap();
  const mergedVars = { ...envVars, ...(ctx.variables ?? {}) };
  const recipientUser = await prisma.user.findUnique({
    where: { email: target },
    select: { name: true },
  });
  const recipientName = recipientUser?.name?.trim() || undefined;
  const builtin = {
    userEmail: target,
    userName: mergedVars.user_name?.trim() || recipientName || "测试用户",
    campaignName: "[测试发送] " + ctx.template.name,
  };

  // 3.1 预取模板片段（按当前 resolvedLocale 实时取最新内容）
  //     测试发送语义是"立刻看效果"，所以**不**走 snapshot 冻结路径，
  //     而是按 (resolvedLocale, name) 现场拉一遍片段表 → 构造 resolver。
  //     渲染时使用 missingBlock='throw'：模板里写了未注册片段名时直接抛出，
  //     由下面的 catch 把 BlockExpansionError 转成 ValidationError 返给前端。
  const resolvedLocale = ctx.locale ?? ctx.template.defaultLocale;
  const refsPerLocale = collectBlockRefsPerLocale(ctx.template.locales);
  const resolver = await buildResolverForLocale(refsPerLocale, resolvedLocale);

  let rendered;
  try {
    rendered = renderSnapshotContent({
      snapshot: buildTemplateSnapshot(ctx.template),
      resolvedLocale,
      subjects: ctx.subjects,
      variables: mergedVars,
      builtin,
      blocks: resolver,
      missingBlock: "throw",
    });
  } catch (err) {
    if (err instanceof BlockExpansionError) {
      throw blockErrorToValidationError(err);
    }
    throw err;
  }

  // 4. 发送（使用步骤 2 中解析到的渠道）
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
  const transport = await getTransportForChannel(channel.id);
  let result: SendResult;
  try {
    result = await transport.sendSingle(emailInput);
  } finally {
    await transport.close();
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

interface ResolvedChannel {
  id: string;
  fromEmail: string | null;
  fromName: string | null;
}

/**
 * 解析测试发送使用的渠道：
 *  - 指定 channelId：必须存在且 ACTIVE
 *  - 未指定：取系统默认 ACTIVE 渠道
 *  - 都不满足：抛 ValidationError，给出可操作提示
 */
async function resolveChannelForTestSend(channelId?: string): Promise<ResolvedChannel> {
  if (channelId) {
    const ch = await prisma.sendingChannel.findUnique({
      where: { id: channelId },
      select: { id: true, fromEmail: true, fromName: true, status: true },
    });
    if (!ch) {
      throw new ValidationError(`SendingChannel not found: ${channelId}`);
    }
    if (ch.status !== "ACTIVE") {
      throw new ValidationError(`SendingChannel is ${ch.status}: ${channelId}`);
    }
    return { id: ch.id, fromEmail: ch.fromEmail, fromName: ch.fromName };
  }
  const def = await prisma.sendingChannel.findFirst({
    where: { isSystemDefault: true, status: "ACTIVE" },
    select: { id: true, fromEmail: true, fromName: true },
  });
  if (!def) {
    throw new ValidationError(
      "请先在「设置 → 发信渠道」中配置一个系统默认渠道，或在测试发送时选择指定渠道",
    );
  }
  return { id: def.id, fromEmail: def.fromEmail, fromName: def.fromName };
}

/** 拼装 RFC5322 from 头：`Name <addr>` 或裸地址；fromEmail 缺失时返回 null。 */
function buildFromHeader(fromEmail: string | null, fromName: string | null): string | null {
  if (!fromEmail) return null;
  const email = fromEmail.trim();
  if (!email) return null;
  const name = fromName?.trim();
  return name ? `${name} <${email}>` : email;
}

/**
 * 仅为当前 resolvedLocale 构造 BlockResolver。
 *
 * - 仅取**该 locale** 的片段（因为 renderSnapshotContent 只渲染单 locale）
 * - 利用现成的 `loadBlocksByPairs` 走仓储，缓存友好且与写时校验同源
 * - resolver 仅返回 string 或 null（null 让 expandBlocks 按 missingBlock 策略处理）
 */
async function buildResolverForLocale(
  refsPerLocale: Partial<Record<Locale, string[]>>,
  resolvedLocale: Locale,
): Promise<BlockResolver> {
  const names = refsPerLocale[resolvedLocale];
  if (!names || names.length === 0) {
    return { get: () => null };
  }
  const blocks = await loadBlocksByPairs({ [resolvedLocale]: names });
  const map = blocks[resolvedLocale] ?? {};
  return {
    get(name: string) {
      return Object.prototype.hasOwnProperty.call(map, name) ? map[name]! : null;
    },
  };
}

