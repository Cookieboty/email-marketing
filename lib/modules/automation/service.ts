import { Prisma, type Automation, type AutomationRun, type AutomationTriggerType, type Locale } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { isSuppressed } from "@/lib/modules/suppression/check";
import { isOverLimit } from "@/lib/modules/frequency/check";
import { logger } from "@/lib/logger";
import {
  applySubjectOverrides,
  buildTemplateSnapshot,
  type TemplateSnapshot,
} from "@/lib/modules/template/snapshot";
import { freezeBlocksForSnapshot } from "@/lib/modules/template/service";
import { resolveLocale } from "@/lib/modules/template/render";
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

function subjectsRecord(
  subjects: Prisma.JsonValue | null | undefined,
): Partial<Record<Locale, string>> {
  if (!subjects || typeof subjects !== "object" || Array.isArray(subjects)) {
    return {};
  }
  const out: Partial<Record<Locale, string>> = {};
  for (const [k, v] of Object.entries(subjects as Record<string, unknown>)) {
    if ((k === "zh" || k === "en") && typeof v === "string" && v.trim()) {
      out[k] = v.trim();
    }
  }
  return out;
}

function buildSubjectSnapshot(
  subjects: Prisma.JsonValue | null | undefined,
  version = 1,
): TemplateSnapshot {
  const raw = subjectsRecord(subjects);
  const locales = Object.fromEntries(
    Object.entries(raw).map(([locale, subject]) => [
      locale,
      { subject, htmlContent: `<p>${subject}</p>`, textContent: null },
    ]),
  ) as TemplateSnapshot["locales"];
  const defaultLocale: Locale = locales.zh ? "zh" : "en";
  if (!locales[defaultLocale]) {
    throw new NotFoundError("Automation template content not found");
  }
  return { version, defaultLocale, locales, variables: [] };
}

/**
 * 计算 Automation 给定（templateAvailable, subjectsKeys）后允许 FORCE 的 locale 集合。
 * 无 template 时仅 subjects 决定；有 template 时仅 template locales 决定（subjects 仅作主题覆盖）。
 */
function automationAvailableLocales(
  templateLocales: Locale[] | null,
  subjects: Partial<Record<Locale, string>>,
): Set<Locale> {
  if (templateLocales) return new Set(templateLocales);
  return new Set(Object.keys(subjects) as Locale[]);
}

/**
 * Automation 的写入不变量（create / update 共用）。覆盖：
 *  - 必须至少一个内容源（templateId 或 subjects）
 *  - localeStrategy=FORCE 时 forcedLocale 必须在实际可用 locale 集合中
 */
async function assertAutomationInvariants(input: {
  templateId: string | null;
  subjects: Partial<Record<Locale, string>>;
  localeStrategy: "AUTO" | "FORCE";
  forcedLocale: Locale | null;
}): Promise<void> {
  if (!input.templateId && Object.keys(input.subjects).length === 0) {
    throw new ValidationError(
      "Automation must have either a template or non-empty subjects",
    );
  }
  let templateLocales: Locale[] | null = null;
  if (input.templateId) {
    const template = await prisma.emailTemplate.findUnique({
      where: { id: input.templateId },
      include: { locales: { select: { locale: true } } },
    });
    if (!template) throw new NotFoundError("Template not found");
    templateLocales = template.locales.map((row) => row.locale);
  }
  if (input.localeStrategy === "FORCE") {
    const available = automationAvailableLocales(templateLocales, input.subjects);
    if (!input.forcedLocale || !available.has(input.forcedLocale)) {
      throw new ValidationError("forcedLocale content is missing");
    }
  }
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
    await assertAutomationInvariants({
      templateId: input.templateId ?? null,
      subjects: subjectsRecord(input.subjects ?? null),
      localeStrategy: input.localeStrategy,
      forcedLocale: input.forcedLocale ?? null,
    });
    const created = await prisma.automation.create({
      data: {
        name: input.name,
        triggerType: input.triggerType as AutomationTriggerType,
        triggerConfig: input.triggerConfig as Prisma.InputJsonValue,
        templateId: input.templateId ?? null,
        subjects: input.subjects ? (input.subjects as Prisma.InputJsonValue) : Prisma.DbNull,
        localeStrategy: input.localeStrategy,
        forcedLocale: input.forcedLocale ?? null,
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
    const nextTemplateId =
      input.templateId === undefined ? existing.templateId : input.templateId;
    const nextStrategy = input.localeStrategy ?? existing.localeStrategy;
    const nextForcedLocale =
      input.forcedLocale === undefined ? existing.forcedLocale : input.forcedLocale;
    const nextSubjects = subjectsRecord(
      input.subjects === undefined ? existing.subjects : input.subjects,
    );
    await assertAutomationInvariants({
      templateId: nextTemplateId,
      subjects: nextSubjects,
      localeStrategy: nextStrategy,
      forcedLocale: nextForcedLocale,
    });

    const data: Prisma.AutomationUncheckedUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.triggerType !== undefined) data.triggerType = input.triggerType as AutomationTriggerType;
    if (input.triggerConfig !== undefined) data.triggerConfig = input.triggerConfig as Prisma.InputJsonValue;
    if (input.templateId !== undefined) data.templateId = input.templateId;
    if (input.subjects !== undefined) data.subjects = input.subjects as Prisma.InputJsonValue;
    if (input.localeStrategy !== undefined) data.localeStrategy = input.localeStrategy;
    if (input.forcedLocale !== undefined) data.forcedLocale = input.forcedLocale ?? null;
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

  /**
   * 创建一个 AutomationRun。
   *
   * 调用方必须传入**已预取**的 automation（include template + template.locales），
   * 避免 trigger hook 与定时巡检在循环里重复 findUnique（原始实现是 N+1：每个
   * (user, automation) pair 一次 SQL）。语义上 automation 是值对象，scheduleRun
   * 不再回查数据库以确认 automation 是否存在或被改动 — 创建 Run 即视为以传入的
   * automation 快照下单。
   */
  async scheduleRun(
    automation: AutomationForSchedule,
    userId: string,
    delayMinutes: number,
  ): Promise<AutomationRun | null> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, unsubscribed: true, totalBounceCount: true, locale: true },
    });
    if (!user || user.unsubscribed || user.totalBounceCount >= 3) return null;

    if (await isSuppressed(user.email)) return null;
    if (await isOverLimit(userId)) return null;

    const duplicate = await prisma.automationRun.findFirst({
      where: {
        automationId: automation.id,
        userId,
        status: "SCHEDULED",
      },
    });
    if (duplicate) return null;

    const scheduledAt = new Date(Date.now() + delayMinutes * 60_000);
    // spec §25：Run 创建后只读快照。subjects 既可能是"无 template 时的内容源"
    // （buildSubjectSnapshot 已直接吃下），也可能是"有 template 时的主题覆盖"，
    // 后者必须在创建 run 时烘焙进 snapshot，否则后续 Automation.subjects 编辑会
    // 影响已调度 / 重试中的 run。
    //
    // 14.9：有 template 时同步冻结模板片段（freezeBlocksForSnapshot），缺片段
    // 直接抛 ValidationError，避免 run 在 worker 阶段才发现引用悬空。
    const blocksPerLocale = automation.template
      ? await freezeBlocksForSnapshot(automation.template)
      : undefined;
    const baseSnapshot = automation.template
      ? buildTemplateSnapshot(automation.template, blocksPerLocale)
      : buildSubjectSnapshot(automation.subjects);
    const templateSnapshot = automation.template
      ? applySubjectOverrides(baseSnapshot, subjectsRecord(automation.subjects))
      : baseSnapshot;
    const availableLocales = Object.keys(templateSnapshot.locales) as Array<"zh" | "en">;
    const resolvedLocale = resolveLocale({
      strategy: automation.localeStrategy,
      forcedLocale: automation.forcedLocale,
      userLocale: user.locale,
      defaultLocale: templateSnapshot.defaultLocale,
      availableLocales,
    });
    return prisma.automationRun.create({
      data: {
        automationId: automation.id,
        userId,
        scheduledAt,
        resolvedLocale,
        templateSnapshot: templateSnapshot as unknown as Prisma.InputJsonValue,
      },
    });
  },
};

/**
 * scheduleRun 所需的预取形状：automation + 可选 template + template.locales。
 * 调用方应当在 trigger hook 顶部用 findMany({ include: SCHEDULE_RUN_INCLUDE })
 * 一次性取齐，避免 N+1。
 */
export const SCHEDULE_RUN_INCLUDE = {
  template: { include: { locales: true } },
} as const satisfies Prisma.AutomationInclude;

export type AutomationForSchedule = Prisma.AutomationGetPayload<{
  include: typeof SCHEDULE_RUN_INCLUDE;
}>;

export async function onUserCreated(userId: string): Promise<void> {
  try {
    const automations = await prisma.automation.findMany({
      where: { status: "ENABLED", triggerType: "USER_CREATED" },
      include: SCHEDULE_RUN_INCLUDE,
    });
    for (const auto of automations) {
      await automationService.scheduleRun(auto, userId, auto.delayMinutes);
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
      include: SCHEDULE_RUN_INCLUDE,
    });
    for (const auto of automations) {
      const config = auto.triggerConfig as Record<string, unknown> | null;
      const requiredTag = config?.tagName as string | undefined;
      if (requiredTag && !tagNames.includes(requiredTag)) continue;
      await automationService.scheduleRun(auto, userId, auto.delayMinutes);
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
      include: SCHEDULE_RUN_INCLUDE,
    });
    for (const auto of automations) {
      const config = auto.triggerConfig as Record<string, unknown> | null;
      if (config?.eventName !== eventName) continue;
      await automationService.scheduleRun(auto, userId, auto.delayMinutes);
    }
  } catch (err) {
    log.error("onCustomEvent hook failed", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export type AutomationService = typeof automationService;
