/**
 * SMTP 业务服务层。
 *
 * 关联 spec：specs/modules/smtp-configuration.md
 *
 * 职责：
 * - 把 zod 校验过的 DTO 翻译成 Prisma 写入；
 * - 处理 password 三态、isDefault 切换、激活通道切换等业务规则；
 * - 集成审计日志（fire-and-forget）；
 * - 对外只暴露脱敏视图（VIEW），永远不返回 passwordCipher。
 *
 * 不在本层处理的事项：
 * - 真正的 SMTP 连接 / 投递（→ P4 transport）；
 * - HTTP 解析与鉴权（→ P5 路由层）。
 */

import type {
  MailProviderSetting,
  Prisma,
  SmtpConfig,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { audit } from "@/lib/audit";
import { normalizeEmail } from "@/lib/email-utils";
import { getRateLimiter } from "@/lib/rate-limit";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RateLimitError,
  ValidationError,
} from "@/lib/errors";
import {
  buildPasswordHint,
  decryptSmtpPassword,
  encryptSmtpPassword,
  SmtpCryptoError,
} from "./crypto";
import {
  mailProviderSettingRepository,
  smtpConfigRepository,
  type ListSmtpConfigsResult,
  PROVIDER_SETTING_ID,
} from "./repository";
import type {
  ActivateProviderInput,
  CreateSmtpConfigInput,
  ListSmtpConfigsQuery,
  TestSendInput,
  UpdateSmtpConfigInput,
} from "./schema";
import {
  invalidateActiveTransport,
  verifySmtpConnection,
  SmtpTransport,
} from "@/lib/modules/mail/transport";

/** 解析 ADMIN_TEST_EMAILS（逗号分隔），返回归一化后的 Set。 */
function getAdminTestWhitelist(): Set<string> {
  const raw = env().ADMIN_TEST_EMAILS ?? "";
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => normalizeEmail(s));
  return new Set(list);
}

const ENTITY = "SmtpConfig" as const;
const PROVIDER_ENTITY = "MailProviderSetting" as const;

/** 对外脱敏视图：剥离 passwordCipher，保留 hint。 */
export interface SmtpConfigView {
  id: string;
  name: string;
  description: string | null;
  host: string;
  port: number;
  secure: SmtpConfig["secure"];
  username: string | null;
  hasPassword: boolean;
  passwordHint: string | null;
  fromEmail: string;
  fromName: string | null;
  replyTo: string | null;
  maxConnections: number;
  maxMessagesPerConn: number;
  rateLimitPerSec: number | null;
  connectionTimeoutMs: number;
  greetingTimeoutMs: number;
  socketTimeoutMs: number;
  rejectUnauthorized: boolean;
  requireTls: boolean;
  status: SmtpConfig["status"];
  isDefault: boolean;
  lastTestAt: string | null;
  lastTestStatus: SmtpConfig["lastTestStatus"];
  lastTestError: string | null;
  lastSendAt: string | null;
  recentFailures: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
}

export function toSmtpConfigView(row: SmtpConfig): SmtpConfigView {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    host: row.host,
    port: row.port,
    secure: row.secure,
    username: row.username,
    hasPassword: !!row.passwordCipher,
    passwordHint: row.passwordHint,
    fromEmail: row.fromEmail,
    fromName: row.fromName,
    replyTo: row.replyTo,
    maxConnections: row.maxConnections,
    maxMessagesPerConn: row.maxMessagesPerConn,
    rateLimitPerSec: row.rateLimitPerSec,
    connectionTimeoutMs: row.connectionTimeoutMs,
    greetingTimeoutMs: row.greetingTimeoutMs,
    socketTimeoutMs: row.socketTimeoutMs,
    rejectUnauthorized: row.rejectUnauthorized,
    requireTls: row.requireTls,
    status: row.status,
    isDefault: row.isDefault,
    lastTestAt: row.lastTestAt?.toISOString() ?? null,
    lastTestStatus: row.lastTestStatus,
    lastTestError: row.lastTestError,
    lastSendAt: row.lastSendAt?.toISOString() ?? null,
    recentFailures: row.recentFailures,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
  };
}

export interface ListSmtpConfigsView {
  data: SmtpConfigView[];
  total: number;
  page: number;
  pageSize: number;
}

export async function listSmtpConfigs(
  query: ListSmtpConfigsQuery,
): Promise<ListSmtpConfigsView> {
  const result: ListSmtpConfigsResult = await smtpConfigRepository.list(query);
  return {
    data: result.data.map(toSmtpConfigView),
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
  };
}

export async function getSmtpConfig(id: string): Promise<SmtpConfigView> {
  const row = await smtpConfigRepository.findById(id);
  if (!row) throw new NotFoundError("smtp config not found");
  return toSmtpConfigView(row);
}

/**
 * 创建 SmtpConfig：
 * - 重复 (host, port, username) 报 409；
 * - 加密密码 + 生成 hint；
 * - 审计 `smtp.create`（不写明文）。
 */
export async function createSmtpConfig(
  input: CreateSmtpConfigInput,
  actor: { adminId: string; req?: { headers: Headers } | null },
): Promise<SmtpConfigView> {
  const username = input.username ?? null;
  const existing = await smtpConfigRepository.findByHostPortUser(
    input.host,
    input.port,
    username,
  );
  if (existing) {
    throw new ConflictError(
      `SMTP 配置已存在（host=${input.host} port=${input.port}）`,
    );
  }

  const data: Prisma.SmtpConfigUncheckedCreateInput = {
    name: input.name,
    description: input.description ?? null,
    host: input.host,
    port: input.port,
    secure: input.secure,
    username,
    passwordCipher: input.password ? encryptSmtpPassword(input.password) : null,
    passwordHint: input.password ? buildPasswordHint(input.password) : null,
    fromEmail: input.fromEmail,
    fromName: input.fromName ?? null,
    replyTo: input.replyTo ?? null,
    rejectUnauthorized: input.rejectUnauthorized ?? true,
    requireTls: input.requireTls ?? true,
    createdBy: actor.adminId,
    updatedBy: actor.adminId,
  };
  if (input.maxConnections !== undefined) data.maxConnections = input.maxConnections;
  if (input.maxMessagesPerConn !== undefined)
    data.maxMessagesPerConn = input.maxMessagesPerConn;
  if (input.rateLimitPerSec !== undefined) data.rateLimitPerSec = input.rateLimitPerSec;
  if (input.connectionTimeoutMs !== undefined)
    data.connectionTimeoutMs = input.connectionTimeoutMs;
  if (input.greetingTimeoutMs !== undefined)
    data.greetingTimeoutMs = input.greetingTimeoutMs;
  if (input.socketTimeoutMs !== undefined)
    data.socketTimeoutMs = input.socketTimeoutMs;

  const created = await smtpConfigRepository.create(data);

  audit({
    action: "smtp.create",
    entityType: ENTITY,
    entityId: created.id,
    actorType: "ADMIN",
    details: {
      name: created.name,
      host: created.host,
      port: created.port,
      secure: created.secure,
      hasPassword: !!created.passwordCipher,
      adminId: actor.adminId,
    },
    req: actor.req ?? null,
  });

  return toSmtpConfigView(created);
}

/**
 * 更新 SmtpConfig：
 * - password 三态：undefined/"" → 不动；null → 清除（username 必须同步置空，
 *   schema 已校验）；非空 string → 重新加密。
 * - 任何关键字段（host/port/username）变化都重新查重。
 * - 不接受 isDefault 入参；切换默认走 `activateProvider`。
 */
export async function updateSmtpConfig(
  id: string,
  input: UpdateSmtpConfigInput,
  actor: { adminId: string; req?: { headers: Headers } | null },
): Promise<SmtpConfigView> {
  const current = await smtpConfigRepository.findById(id);
  if (!current) throw new NotFoundError("smtp config not found");
  if (current.status === "REVOKED") {
    throw new ConflictError("已撤销的 SMTP 配置不可更新");
  }

  const nextHost = input.host ?? current.host;
  const nextPort = input.port ?? current.port;
  const nextUsername =
    input.username === undefined
      ? current.username
      : input.username; // 含 null 显式清除
  const keyChanged =
    nextHost !== current.host ||
    nextPort !== current.port ||
    nextUsername !== current.username;

  if (keyChanged) {
    const dup = await smtpConfigRepository.findByHostPortUser(
      nextHost,
      nextPort,
      nextUsername,
    );
    if (dup && dup.id !== id) {
      throw new ConflictError("SMTP 配置 (host, port, username) 冲突");
    }
  }

  const data: Prisma.SmtpConfigUncheckedUpdateInput = {
    updatedBy: actor.adminId,
  };
  if (input.name !== undefined) data.name = input.name;
  if (input.description !== undefined) data.description = input.description;
  if (input.host !== undefined) data.host = input.host;
  if (input.port !== undefined) data.port = input.port;
  if (input.secure !== undefined) data.secure = input.secure;
  if (input.username !== undefined) data.username = input.username;

  // password 三态处理
  let passwordChanged = false;
  if (input.password === null) {
    data.passwordCipher = null;
    data.passwordHint = null;
    passwordChanged = true;
  } else if (typeof input.password === "string" && input.password.length > 0) {
    data.passwordCipher = encryptSmtpPassword(input.password);
    data.passwordHint = buildPasswordHint(input.password);
    passwordChanged = true;
  }

  if (input.fromEmail !== undefined) data.fromEmail = input.fromEmail;
  if (input.fromName !== undefined) data.fromName = input.fromName;
  if (input.replyTo !== undefined) data.replyTo = input.replyTo;
  if (input.maxConnections !== undefined) data.maxConnections = input.maxConnections;
  if (input.maxMessagesPerConn !== undefined)
    data.maxMessagesPerConn = input.maxMessagesPerConn;
  if (input.rateLimitPerSec !== undefined)
    data.rateLimitPerSec = input.rateLimitPerSec;
  if (input.connectionTimeoutMs !== undefined)
    data.connectionTimeoutMs = input.connectionTimeoutMs;
  if (input.greetingTimeoutMs !== undefined)
    data.greetingTimeoutMs = input.greetingTimeoutMs;
  if (input.socketTimeoutMs !== undefined)
    data.socketTimeoutMs = input.socketTimeoutMs;
  if (input.rejectUnauthorized !== undefined)
    data.rejectUnauthorized = input.rejectUnauthorized;
  if (input.requireTls !== undefined) data.requireTls = input.requireTls;
  if (input.status !== undefined) data.status = input.status;

  // 凭证 / 关键字段变更时重置健康度，强制重新测试
  if (passwordChanged || keyChanged) {
    data.lastTestAt = null;
    data.lastTestStatus = null;
    data.lastTestError = null;
    data.recentFailures = 0;
  }

  const updated = await smtpConfigRepository.update(id, data);

  // 若当前激活通道就是它，让 transport 缓存立即失效，确保下一次发送用新配置
  try {
    const setting = await mailProviderSettingRepository.get();
    if (setting.activeProvider === "SMTP" && setting.activeSmtpId === id) {
      await invalidateActiveTransport();
    }
  } catch (err) {
    logger.warn("invalidate transport after update failed", {
      smtpId: id,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  audit({
    action: "smtp.update",
    entityType: ENTITY,
    entityId: updated.id,
    actorType: "ADMIN",
    details: {
      adminId: actor.adminId,
      passwordChanged,
      keyChanged,
      changedFields: Object.keys(data).filter((k) => k !== "updatedBy"),
    },
    req: actor.req ?? null,
  });

  return toSmtpConfigView(updated);
}

/**
 * 撤销（软删除）：状态置 REVOKED。
 * - 当前激活的 SMTP 通道不能撤销，需先切回 RESEND（与 spec 第 230 行一致）；
 * - 撤销后 isDefault 归零，避免与 activeSmtpId 不一致。
 */
export async function revokeSmtpConfig(
  id: string,
  actor: { adminId: string; req?: { headers: Headers } | null },
): Promise<SmtpConfigView> {
  const current = await smtpConfigRepository.findById(id);
  if (!current) throw new NotFoundError("smtp config not found");
  if (current.status === "REVOKED") return toSmtpConfigView(current);

  const setting = await mailProviderSettingRepository.get();
  if (setting.activeProvider === "SMTP" && setting.activeSmtpId === id) {
    throw new ConflictError(
      "当前激活的 SMTP 通道不可撤销，请先切回 RESEND 或更换激活通道",
    );
  }

  const updated = await smtpConfigRepository.update(id, {
    status: "REVOKED",
    isDefault: false,
    passwordCipher: null,
    passwordHint: null,
    updatedBy: actor.adminId,
  });

  audit({
    action: "smtp.revoke",
    entityType: ENTITY,
    entityId: updated.id,
    actorType: "ADMIN",
    details: { adminId: actor.adminId },
    req: actor.req ?? null,
  });

  return toSmtpConfigView(updated);
}

/** 当前激活通道视图（不直接暴露 setting 行，避免外键泄露）。 */
export interface MailProviderSettingView {
  activeProvider: MailProviderSetting["activeProvider"];
  activeSmtpId: string | null;
  fallback: MailProviderSetting["fallback"];
  updatedAt: string;
  updatedBy: string | null;
}

function toProviderView(row: MailProviderSetting): MailProviderSettingView {
  return {
    activeProvider: row.activeProvider,
    activeSmtpId: row.activeSmtpId,
    fallback: row.fallback,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
  };
}

export async function getMailProviderSetting(): Promise<MailProviderSettingView> {
  const row = await mailProviderSettingRepository.get();
  return toProviderView(row);
}

/**
 * 切换激活通道（事务保证）：
 * - provider=RESEND：清除 activeSmtpId，并把所有 SmtpConfig.isDefault 置 false；
 * - provider=SMTP：smtpId 必须存在 + status=ACTIVE + 已通过测试，事务内把目标
 *   记录置 isDefault=true，其它清零。
 */
export async function activateProvider(
  input: ActivateProviderInput,
  actor: { adminId: string; req?: { headers: Headers } | null },
): Promise<MailProviderSettingView> {
  const result = await prisma.$transaction(async (tx) => {
    if (input.provider === "RESEND") {
      await smtpConfigRepository.clearDefaultExcept(null, tx);
      const setting = await mailProviderSettingRepository.setActive(
        "RESEND",
        null,
        actor.adminId,
        tx,
      );
      return setting;
    }

    const smtpId = input.smtpId!;
    const target = await smtpConfigRepository.findById(smtpId, tx);
    if (!target) throw new NotFoundError("smtp config not found");
    if (target.status !== "ACTIVE") {
      throw new ValidationError("目标 SMTP 配置未启用，无法激活");
    }
    if (target.lastTestStatus !== "OK") {
      throw new ValidationError("目标 SMTP 配置尚未通过连接测试，无法激活");
    }

    await smtpConfigRepository.clearDefaultExcept(smtpId, tx);
    await smtpConfigRepository.setDefault(smtpId, tx);
    const setting = await mailProviderSettingRepository.setActive(
      "SMTP",
      smtpId,
      actor.adminId,
      tx,
    );
    return setting;
  });

  // 立即失效 transport 缓存，让通道切换无需等待 60s TTL
  try {
    await invalidateActiveTransport();
  } catch (err) {
    logger.warn("invalidate transport after activate failed", {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  audit({
    action: "smtp.activate",
    entityType: PROVIDER_ENTITY,
    entityId: PROVIDER_SETTING_ID,
    actorType: "ADMIN",
    details: {
      adminId: actor.adminId,
      provider: input.provider,
      smtpId: input.smtpId ?? null,
    },
    req: actor.req ?? null,
  });

  logger.info("mail provider activated", {
    provider: result.activeProvider,
    smtpId: result.activeSmtpId,
    adminId: actor.adminId,
  });

  return toProviderView(result);
}

// ───────────────────────────── 连接测试 / 测试发送 ─────────────────────────────

/** SMTP 连接测试结果（API 响应形态）。 */
export interface SmtpTestConnectionResult {
  ok: boolean;
  error?: string;
  code?: string;
  responseCode?: number;
  elapsedMs: number;
  testedAt: string;
  config: SmtpConfigView;
}

/** SMTP 测试发送结果（API 响应形态）。 */
export interface SmtpTestSendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
  testedAt: string;
}

const TEST_ERROR_MAX_LEN = 1024;

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max);
}

/**
 * 不发邮件，仅验证 SMTP 服务器可连且鉴权通过。
 *
 * - 已撤销的配置直接 Conflict；
 * - 用解密后的明文密码 + 配置参数交给 verifySmtpConnection；
 * - 无论成功失败，都把结果回写 SmtpConfig.lastTest*；
 * - 写审计 `smtp.test` 不携带凭证；错误摘要截断 1KB。
 */
export async function testSmtpConnection(
  id: string,
  actor: { adminId: string; req?: { headers: Headers } | null },
): Promise<SmtpTestConnectionResult> {
  const current = await smtpConfigRepository.findById(id);
  if (!current) throw new NotFoundError("smtp config not found");
  if (current.status === "REVOKED") {
    throw new ConflictError("已撤销的 SMTP 配置不可测试");
  }

  let plainPassword: string | null = null;
  if (current.passwordCipher) {
    try {
      plainPassword = decryptSmtpPassword(current.passwordCipher);
    } catch (err) {
      const message =
        err instanceof SmtpCryptoError
          ? "凭证解密失败，请重新设置密码"
          : err instanceof Error
            ? err.message
            : "decrypt password failed";
      const at = new Date();
      const updated = await smtpConfigRepository.recordTestResult(id, {
        status: "UNKNOWN",
        error: truncate(message, TEST_ERROR_MAX_LEN),
        at,
      });
      audit({
        action: "smtp.test",
        entityType: ENTITY,
        entityId: id,
        actorType: "ADMIN",
        details: { adminId: actor.adminId, ok: false, reason: "decrypt_failed" },
        req: actor.req ?? null,
      });
      return {
        ok: false,
        error: message,
        elapsedMs: 0,
        testedAt: at.toISOString(),
        config: toSmtpConfigView(updated),
      };
    }
  }

  const t0 = Date.now();
  const result = await verifySmtpConnection({
    host: current.host,
    port: current.port,
    secure: current.secure,
    username: current.username,
    password: plainPassword,
    rejectUnauthorized: current.rejectUnauthorized,
    requireTls: current.requireTls,
    connectionTimeoutMs: current.connectionTimeoutMs,
    greetingTimeoutMs: current.greetingTimeoutMs,
    socketTimeoutMs: current.socketTimeoutMs,
  });
  const elapsedMs = Date.now() - t0;

  const at = new Date();
  const status: "OK" | "AUTH_FAILED" | "TIMEOUT" | "CONN_FAILED" | "UNKNOWN" =
    result.ok
      ? "OK"
      : result.code === "ETIMEDOUT" || result.code === "ESOCKET"
        ? "TIMEOUT"
        : result.responseCode === 535 || result.responseCode === 534
          ? "AUTH_FAILED"
          : result.code === "ECONNECTION" ||
            result.code === "ECONNREFUSED" ||
            result.code === "ENOTFOUND" ||
            result.code === "EDNS"
            ? "CONN_FAILED"
            : "UNKNOWN";

  const updated = await smtpConfigRepository.recordTestResult(id, {
    status,
    error: result.ok ? null : truncate(result.error ?? "unknown", TEST_ERROR_MAX_LEN),
    at,
  });

  audit({
    action: "smtp.test",
    entityType: ENTITY,
    entityId: id,
    actorType: "ADMIN",
    details: {
      adminId: actor.adminId,
      ok: result.ok,
      status,
      ...(result.code ? { code: result.code } : {}),
      ...(result.responseCode !== undefined ? { responseCode: result.responseCode } : {}),
    },
    req: actor.req ?? null,
  });

  return {
    ok: result.ok,
    ...(result.error ? { error: result.error } : {}),
    ...(result.code ? { code: result.code } : {}),
    ...(result.responseCode !== undefined ? { responseCode: result.responseCode } : {}),
    elapsedMs,
    testedAt: at.toISOString(),
    config: toSmtpConfigView(updated),
  };
}

const SMTP_TEST_SEND_RL = "smtp-test-send";

function getSmtpTestSendLimiter() {
  return getRateLimiter(SMTP_TEST_SEND_RL, {
    maxAttempts: env().RATE_LIMIT_TEST_SEND_MAX,
    windowSec: env().RATE_LIMIT_TEST_SEND_WINDOW_SEC,
    lockSec: 60,
  });
}

/**
 * 用指定 SmtpConfig 真实发送一封测试邮件。
 *
 * - 收件人必须在 ADMIN_TEST_EMAILS 白名单内；
 * - 受 RATE_LIMIT_TEST_SEND_* 限流；
 * - 走一次性 SmtpTransport（不污染 transport 缓存），用完关闭；
 * - 成功 → recordSendSuccess；失败 → recordSendFailure；
 * - 审计 `smtp.test_send`。
 */
export async function testSmtpSend(
  id: string,
  input: TestSendInput,
  actor: { adminId: string; req?: { headers: Headers } | null },
): Promise<SmtpTestSendResult> {
  const whitelist = getAdminTestWhitelist();
  if (whitelist.size === 0) {
    throw new ForbiddenError("Test send is disabled (ADMIN_TEST_EMAILS not configured)");
  }
  const target = normalizeEmail(input.to);
  if (!whitelist.has(target)) {
    throw new ForbiddenError("目标邮箱不在 ADMIN_TEST_EMAILS 白名单内");
  }

  const limiter = getSmtpTestSendLimiter();
  const decision = limiter.check(`${SMTP_TEST_SEND_RL}:${actor.adminId}`);
  if (!decision.allowed) {
    throw new RateLimitError(decision.retryAfterSec);
  }

  const current = await smtpConfigRepository.findById(id);
  if (!current) throw new NotFoundError("smtp config not found");
  if (current.status !== "ACTIVE") {
    throw new ConflictError("仅启用状态下的 SMTP 配置可执行测试发送");
  }

  let plainPassword: string | null = null;
  if (current.passwordCipher) {
    try {
      plainPassword = decryptSmtpPassword(current.passwordCipher);
    } catch {
      throw new ValidationError("凭证解密失败，请重新设置密码");
    }
  }

  const transport = new SmtpTransport(current, plainPassword);
  let result: Awaited<ReturnType<SmtpTransport["sendSingle"]>>;
  try {
    result = await transport.sendSingle({
      from: current.fromName
        ? `${current.fromName} <${current.fromEmail}>`
        : current.fromEmail,
      to: input.to,
      subject: input.subject,
      html: input.html,
      ...(current.replyTo ? { replyTo: current.replyTo } : {}),
    });
  } finally {
    await transport.close();
  }

  limiter.recordFailure(`${SMTP_TEST_SEND_RL}:${actor.adminId}`);

  const at = new Date();
  if (result.ok) {
    await smtpConfigRepository.recordSendSuccess(id, at);
  } else {
    const afterFail = await smtpConfigRepository.recordSendFailure(id);
    await checkSmtpDegradedAlert(afterFail);
  }

  audit({
    action: "smtp.test_send",
    entityType: ENTITY,
    entityId: id,
    actorType: "ADMIN",
    details: {
      adminId: actor.adminId,
      to: input.to,
      ok: result.ok,
      ...(result.ok ? { messageId: result.id } : { error: truncate(result.error, TEST_ERROR_MAX_LEN) }),
    },
    req: actor.req ?? null,
  });

  if (result.ok) {
    return { ok: true, messageId: result.id, testedAt: at.toISOString() };
  }
  return { ok: false, error: result.error, testedAt: at.toISOString() };
}

// ───────────────────────────── 健康度告警 ─────────────────────────────

/**
 * recentFailures 达到阈值时写入 DeliverabilityAlert（SMTP_DEGRADED）。
 * 幂等：同一 SmtpConfig 只保留一个未 resolved 的 SMTP_DEGRADED alert。
 */
export async function checkSmtpDegradedAlert(config: SmtpConfig): Promise<void> {
  const threshold = env().SMTP_FAILURE_THRESHOLD;
  if (config.recentFailures < threshold) return;

  try {
    const existing = await prisma.deliverabilityAlert.findFirst({
      where: {
        type: "SMTP_DEGRADED",
        resolved: false,
        action: config.id,
      },
    });
    if (existing) return;

    await prisma.deliverabilityAlert.create({
      data: {
        type: "SMTP_DEGRADED",
        threshold,
        actualValue: config.recentFailures,
        action: config.id,
      },
    });
    logger.warn("smtp degraded alert created", {
      smtpId: config.id,
      recentFailures: config.recentFailures,
      threshold,
    });
  } catch (err) {
    logger.error("failed to create smtp degraded alert", {
      smtpId: config.id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
