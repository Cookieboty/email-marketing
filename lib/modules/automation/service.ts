import { Prisma, type Automation, type AutomationRun, type AutomationTriggerType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { NotFoundError } from "@/lib/errors";
import { isSuppressed } from "@/lib/modules/suppression/check";
import { isOverLimit } from "@/lib/modules/frequency/check";
import { logger } from "@/lib/logger";
import type {
  CreateAutomationInput,
  UpdateAutomationInput,
  ListAutomationsQuery,
  ListRunsQuery,
} from "./schema";

const log = logger.child("automation");

interface ActorContext {
  actorType: "ADMIN" | "SYSTEM" | "WEBHOOK";
  req?: { headers: Headers } | null;
}

export interface ListAutomationsResult {
  data: Automation[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ListRunsResult {
  data: AutomationRun[];
  total: number;
  page: number;
  pageSize: number;
}

export const automationService = {
  async list(query: ListAutomationsQuery): Promise<ListAutomationsResult> {
    const where: Prisma.AutomationWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.triggerType) where.triggerType = query.triggerType;

    const [data, total] = await Promise.all([
      prisma.automation.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      prisma.automation.count({ where }),
    ]);
    return { data, total, page: query.page, pageSize: query.pageSize };
  },

  async getById(id: string): Promise<Automation> {
    const a = await prisma.automation.findUnique({ where: { id } });
    if (!a) throw new NotFoundError("Automation not found");
    return a;
  },

  async create(input: CreateAutomationInput, ctx: ActorContext): Promise<Automation> {
    const created = await prisma.automation.create({
      data: {
        name: input.name,
        triggerType: input.triggerType as AutomationTriggerType,
        triggerConfig: input.triggerConfig as Prisma.InputJsonValue,
        templateId: input.templateId ?? null,
        subject: input.subject,
        delayMinutes: input.delayMinutes,
        conditions: input.conditions ? (input.conditions as Prisma.InputJsonValue) : Prisma.DbNull,
        status: input.status,
      },
    });
    audit({
      action: "automation.create",
      entityType: "Automation",
      entityId: created.id,
      actorType: ctx.actorType,
      details: { name: created.name, triggerType: created.triggerType },
      req: ctx.req ?? null,
    });
    return created;
  },

  async update(id: string, input: UpdateAutomationInput, ctx: ActorContext): Promise<Automation> {
    const existing = await prisma.automation.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError("Automation not found");

    const data: Prisma.AutomationUncheckedUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.triggerType !== undefined) data.triggerType = input.triggerType as AutomationTriggerType;
    if (input.triggerConfig !== undefined) data.triggerConfig = input.triggerConfig as Prisma.InputJsonValue;
    if (input.templateId !== undefined) data.templateId = input.templateId;
    if (input.subject !== undefined) data.subject = input.subject;
    if (input.delayMinutes !== undefined) data.delayMinutes = input.delayMinutes;
    if (input.conditions !== undefined) data.conditions = input.conditions ? (input.conditions as Prisma.InputJsonValue) : Prisma.DbNull;
    if (input.status !== undefined) data.status = input.status;

    const updated = await prisma.automation.update({ where: { id }, data });
    audit({
      action: "automation.update",
      entityType: "Automation",
      entityId: id,
      actorType: ctx.actorType,
      details: { fields: Object.keys(input) },
      req: ctx.req ?? null,
    });
    return updated;
  },

  async delete(id: string, ctx: ActorContext): Promise<void> {
    const existing = await prisma.automation.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError("Automation not found");
    await prisma.automation.delete({ where: { id } });
    audit({
      action: "automation.delete",
      entityType: "Automation",
      entityId: id,
      actorType: ctx.actorType,
      details: { name: existing.name },
      req: ctx.req ?? null,
    });
  },

  async listRuns(automationId: string, query: ListRunsQuery): Promise<ListRunsResult> {
    const existing = await prisma.automation.findUnique({ where: { id: automationId } });
    if (!existing) throw new NotFoundError("Automation not found");

    const where: Prisma.AutomationRunWhereInput = { automationId };
    if (query.status) where.status = query.status;

    const [data, total] = await Promise.all([
      prisma.automationRun.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: { user: { select: { id: true, email: true, name: true } } },
      }),
      prisma.automationRun.count({ where }),
    ]);
    return { data, total, page: query.page, pageSize: query.pageSize };
  },

  async scheduleRun(
    automationId: string,
    userId: string,
    delayMinutes: number,
  ): Promise<AutomationRun | null> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, unsubscribed: true, totalBounceCount: true },
    });
    if (!user || user.unsubscribed || user.totalBounceCount >= 3) return null;

    if (await isSuppressed(user.email)) return null;
    if (await isOverLimit(userId)) return null;

    const duplicate = await prisma.automationRun.findFirst({
      where: {
        automationId,
        userId,
        status: "SCHEDULED",
      },
    });
    if (duplicate) return null;

    const scheduledAt = new Date(Date.now() + delayMinutes * 60_000);
    return prisma.automationRun.create({
      data: { automationId, userId, scheduledAt },
    });
  },
};

export async function onUserCreated(userId: string): Promise<void> {
  try {
    const automations = await prisma.automation.findMany({
      where: { status: "ENABLED", triggerType: "USER_CREATED" },
    });
    for (const auto of automations) {
      await automationService.scheduleRun(auto.id, userId, auto.delayMinutes);
    }
  } catch (err) {
    log.error("onUserCreated hook failed", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function onTagChanged(userId: string, tagNames: string[]): Promise<void> {
  try {
    const automations = await prisma.automation.findMany({
      where: { status: "ENABLED", triggerType: "TAG_CHANGED" },
    });
    for (const auto of automations) {
      const config = auto.triggerConfig as Record<string, unknown> | null;
      const requiredTag = config?.tagName as string | undefined;
      if (requiredTag && !tagNames.includes(requiredTag)) continue;
      await automationService.scheduleRun(auto.id, userId, auto.delayMinutes);
    }
  } catch (err) {
    log.error("onTagChanged hook failed", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function onCustomEvent(
  userId: string,
  eventName: string,
): Promise<void> {
  try {
    const automations = await prisma.automation.findMany({
      where: { status: "ENABLED", triggerType: "CUSTOM_EVENT" },
    });
    for (const auto of automations) {
      const config = auto.triggerConfig as Record<string, unknown> | null;
      if (config?.eventName !== eventName) continue;
      await automationService.scheduleRun(auto.id, userId, auto.delayMinutes);
    }
  } catch (err) {
    log.error("onCustomEvent hook failed", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export type AutomationService = typeof automationService;
