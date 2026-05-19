/**
 * AuditLog 写入封装。
 *
 * 设计：
 *  - action 形如 `entity.verb`，运行时 zod 校验（防止 typo）
 *  - 自动从 Headers 提取 IP / UserAgent
 *  - details.email 自动 maskEmail，避免泄露
 *  - 异步 fire-and-forget：失败仅记录日志，不抛出，不阻塞业务
 *  - DB 层 trigger 已防 UPDATE/DELETE（Phase 1 migration），此处仅 INSERT
 */

import { z } from "zod";
import { prisma } from "./prisma";
import { logger } from "./logger";
import { maskEmail } from "./email-utils";
import { getClientIpFromHeaders } from "./api-helpers";

const ActionSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/, "action must be `entity.verb`");

export type ActorType = "ADMIN" | "SYSTEM" | "WEBHOOK";

export interface AuditInput {
  action: string;
  entityType: string;
  entityId: string;
  actorType: ActorType;
  details?: Record<string, unknown>;
  req?: { headers: Headers } | null;
  ipAddress?: string;
  userAgent?: string;
}

export function maskDetails(details?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!details) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(details)) {
    if ((k === "email" || k === "userEmail" || k === "to") && typeof v === "string") {
      out[k] = maskEmail(v);
    } else if (k === "emails" && Array.isArray(v)) {
      out[k] = v.map((e) => (typeof e === "string" ? maskEmail(e) : e));
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * 同步版本：用于测试或确实需要等待写入完成的场景。
 * 业务代码请优先使用 `audit()`（fire-and-forget）。
 */
export async function auditNow(input: AuditInput): Promise<void> {
  const action = ActionSchema.parse(input.action);
  const ip =
    input.ipAddress ?? (input.req ? getClientIpFromHeaders(input.req.headers) : undefined);
  const ua =
    input.userAgent ?? (input.req ? (input.req.headers.get("user-agent") ?? undefined) : undefined);

  await prisma.auditLog.create({
    data: {
      action,
      entityType: input.entityType,
      entityId: input.entityId,
      actorType: input.actorType,
      details: maskDetails(input.details) as object | undefined,
      ipAddress: ip && ip !== "unknown" ? ip : null,
      userAgent: ua ?? null,
    },
  });
}

/** Fire-and-forget 写入；任何失败被吞掉并写日志。 */
export function audit(input: AuditInput): void {
  auditNow(input).catch((err) => {
    logger.error("audit log write failed", {
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      message: err instanceof Error ? err.message : String(err),
    });
  });
}
