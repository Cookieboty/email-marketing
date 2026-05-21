/**
 * 邮件模板业务服务。
 *
 * 职责：
 *  - 输入清洗：trim、剥离 <script>...</script> 与 javascript: 协议（specs §332/§193）
 *  - 自动提取 variables（subject + htmlContent + textContent）
 *  - PATCH 走乐观锁（version+1 + expectedVersion 守卫）
 *  - DELETE/PATCH/archive 引用校验（specs §218/§238）
 *  - AuditLog（fire-and-forget）
 *  - 唯一冲突 → ConflictError；缺失 → NotFoundError
 */

import { Locale, Prisma } from "@prisma/client";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { extractVariables } from "@/lib/template-engine";
import {
  templateRepository,
  type ListTemplatesResult,
  TemplateVersionConflict,
  type EmailTemplateWithLocales,
} from "./repository";
import type {
  CreateTemplateInput,
  ListTemplatesQuery,
  UpdateTemplateInput,
} from "./schema";

interface ActorContext {
  actorType: "ADMIN" | "SYSTEM" | "WEBHOOK";
  req?: { headers: Headers } | null;
}

const SCRIPT_TAG_RE = /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script\s*>/gi;
const SCRIPT_TAG_OPEN_RE = /<script\b[^>]*>/gi;
const SCRIPT_TAG_CLOSE_RE = /<\/script\s*>/gi;
/** event handler 属性，例如 onclick=... */
const EVENT_HANDLER_ATTR_RE = / on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
/** href/src 中的 javascript: 协议 */
const JS_PROTOCOL_RE = /(href|src)\s*=\s*("|')\s*javascript:[^"']*(\2)/gi;

/**
 * 安全清洗 HTML：剥离 script 标签、内联事件处理器、javascript: 协议。
 * 注意：不试图做完整 HTML 净化（那需要 DOMPurify 之类），仅做最关键的攻击面剥离，
 * 配合渲染端 iframe sandbox（无 allow-scripts）形成纵深防御。
 */
export function sanitizeHtml(html: string): string {
  return html
    .replace(SCRIPT_TAG_RE, "")
    .replace(SCRIPT_TAG_OPEN_RE, "")
    .replace(SCRIPT_TAG_CLOSE_RE, "")
    .replace(EVENT_HANDLER_ATTR_RE, "")
    .replace(JS_PROTOCOL_RE, '$1=$2about:blank$2');
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

function buildVariableList(parts: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    if (!part) continue;
    for (const v of extractVariables(part)) {
      if (seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

type LocaleKey = "zh" | "en";
interface TemplateListItem {
  id: string;
  name: string;
  defaultLocale: Locale;
  availableLocales: Locale[];
  variables: string[];
  version: number;
  isArchived: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface TemplateListResult extends Omit<ListTemplatesResult, "data"> {
  data: TemplateListItem[];
}

function entriesOfLocales<T>(
  locales: Partial<Record<LocaleKey, T>>,
): Array<[LocaleKey, T]> {
  return Object.entries(locales).filter(
    (entry): entry is [LocaleKey, T] => entry[1] !== undefined,
  );
}

function variablesFromLocales(
  locales: Array<{
    subject: string;
    htmlContent: string;
    textContent?: string | null;
  }>,
): string[] {
  return buildVariableList(
    locales.flatMap((locale) => [
      locale.subject,
      locale.htmlContent,
      locale.textContent,
    ]),
  );
}

export const templateService = {
  async list(query: ListTemplatesQuery): Promise<TemplateListResult> {
    const result = await templateRepository.list(query);
    return {
      ...result,
      data: result.data.map((template) => ({
        id: template.id,
        name: template.name,
        defaultLocale: template.defaultLocale,
        availableLocales: template.locales.map((locale) => locale.locale),
        variables: template.variables,
        version: template.version,
        isArchived: template.isArchived,
        createdAt: template.createdAt,
        updatedAt: template.updatedAt,
      })),
    };
  },

  async getById(id: string): Promise<EmailTemplateWithLocales> {
    const t = await templateRepository.findById(id);
    if (!t) throw new NotFoundError("Template not found");
    return t;
  },

  async create(
    input: CreateTemplateInput,
    ctx: ActorContext,
  ): Promise<EmailTemplateWithLocales> {
    const localeRows = entriesOfLocales(input.locales).map(([locale, content]) => ({
      locale: locale as Locale,
      subject: content.subject,
      htmlContent: sanitizeHtml(content.htmlContent),
      textContent: content.textContent ?? null,
    }));
    const variables = variablesFromLocales(localeRows);
    try {
      const tpl = await templateRepository.create({
        name: input.name,
        defaultLocale: input.defaultLocale as Locale,
        variables,
        version: 1,
        isArchived: false,
        locales: {
          create: localeRows,
        },
      });
      audit({
        action: "template.create",
        entityType: "EmailTemplate",
        entityId: tpl.id,
        actorType: ctx.actorType,
        details: {
          name: tpl.name,
          variables,
          affectedLocales: localeRows.map((row) => row.locale),
        },
        req: ctx.req ?? null,
      });
      return tpl;
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError("Template name already exists");
      throw err;
    }
  },

  async update(
    id: string,
    input: UpdateTemplateInput,
    ctx: ActorContext,
  ): Promise<EmailTemplateWithLocales> {
    const existing = await templateRepository.findById(id);
    if (!existing) throw new NotFoundError("Template not found");

    if ((await templateRepository.countSendingCampaigns(id)) > 0) {
      throw new ConflictError("Template is in use by a SENDING campaign");
    }

    try {
      const affectedLocales = input.locales
        ? entriesOfLocales(input.locales).map(([locale]) => locale)
        : [];
      const nextLocaleMap = new Map(
        existing.locales.map((locale) => [locale.locale, {
          subject: locale.subject,
          htmlContent: locale.htmlContent,
          textContent: locale.textContent,
        }]),
      );
      if (input.locales) {
        for (const [locale, content] of entriesOfLocales(input.locales)) {
          const current = nextLocaleMap.get(locale as Locale);
          nextLocaleMap.set(locale as Locale, {
            subject: content.subject,
            htmlContent: sanitizeHtml(content.htmlContent),
            textContent:
              content.textContent !== undefined
                ? content.textContent
                : current?.textContent ?? null,
          });
        }
      }

      const nextDefaultLocale = (input.defaultLocale ?? existing.defaultLocale) as Locale;
      if (!nextLocaleMap.has(nextDefaultLocale)) {
        throw new ValidationError("defaultLocale must exist in locales");
      }
      const nextVariables = variablesFromLocales(Array.from(nextLocaleMap.values()));

      const tpl = await prisma.$transaction(async (tx) => {
        const count = await tx.emailTemplate.updateMany({
          where: { id, version: existing.version },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            defaultLocale: nextDefaultLocale,
            variables: { set: nextVariables },
            version: existing.version + 1,
          },
        });
        if (count.count === 0) {
          throw new TemplateVersionConflict(id, existing.version);
        }
        if (input.locales) {
          for (const [locale, content] of entriesOfLocales(input.locales)) {
            await tx.emailTemplateLocale.upsert({
              where: { templateId_locale: { templateId: id, locale: locale as Locale } },
              create: {
                templateId: id,
                locale: locale as Locale,
                subject: content.subject,
                htmlContent: sanitizeHtml(content.htmlContent),
                textContent: content.textContent ?? null,
              },
              update: {
                subject: content.subject,
                htmlContent: sanitizeHtml(content.htmlContent),
                ...(content.textContent !== undefined
                  ? { textContent: content.textContent }
                  : {}),
              },
            });
          }
        }
        return (await tx.emailTemplate.findUnique({
          where: { id },
          include: { locales: true },
        }))!;
      });
      audit({
        action: "template.update",
        entityType: "EmailTemplate",
        entityId: id,
        actorType: ctx.actorType,
        details: {
          name: tpl.name,
          version: tpl.version,
          fields: Object.keys(input),
          affectedLocales,
        },
        req: ctx.req ?? null,
      });
      return tpl;
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError("Template name already exists");
      if (err instanceof TemplateVersionConflict) {
        throw new ConflictError("Template was updated concurrently; please reload");
      }
      throw err;
    }
  },

  async archive(id: string, ctx: ActorContext): Promise<EmailTemplateWithLocales> {
    const existing = await templateRepository.findById(id);
    if (!existing) throw new NotFoundError("Template not found");
    if (existing.isArchived) return existing;
    const tpl = await templateRepository.setArchived(id, true);
    audit({
      action: "template.archive",
      entityType: "EmailTemplate",
      entityId: id,
      actorType: ctx.actorType,
      details: { name: tpl.name },
      req: ctx.req ?? null,
    });
    return tpl;
  },

  async unarchive(id: string, ctx: ActorContext): Promise<EmailTemplateWithLocales> {
    const existing = await templateRepository.findById(id);
    if (!existing) throw new NotFoundError("Template not found");
    if (!existing.isArchived) return existing;
    const tpl = await templateRepository.setArchived(id, false);
    audit({
      action: "template.unarchive",
      entityType: "EmailTemplate",
      entityId: id,
      actorType: ctx.actorType,
      details: { name: tpl.name },
      req: ctx.req ?? null,
    });
    return tpl;
  },

  async delete(id: string, ctx: ActorContext): Promise<void> {
    const existing = await templateRepository.findById(id);
    if (!existing) throw new NotFoundError("Template not found");
    const blocking = await templateRepository.countBlockingCampaigns(id);
    if (blocking > 0) {
      throw new ConflictError(
        `Template is referenced by ${blocking} active campaign(s); cannot delete`,
      );
    }
    try {
      await templateRepository.delete(id);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003") {
        throw new ConflictError("Template is referenced by other entities");
      }
      throw err;
    }
    audit({
      action: "template.delete",
      entityType: "EmailTemplate",
      entityId: id,
      actorType: ctx.actorType,
      details: { name: existing.name },
      req: ctx.req ?? null,
    });
  },

  async deleteLocale(
    id: string,
    locale: Locale,
    ctx: ActorContext,
  ): Promise<EmailTemplateWithLocales> {
    const existing = await templateRepository.findById(id);
    if (!existing) throw new NotFoundError("Template not found");
    if (existing.defaultLocale === locale) {
      throw new ValidationError("Cannot delete default locale");
    }
    if (existing.locales.length <= 1) {
      throw new ValidationError("Template must keep at least one locale");
    }
    if (!existing.locales.some((row) => row.locale === locale)) {
      throw new NotFoundError("Template locale not found");
    }

    const tpl = await prisma.$transaction(async (tx) => {
      await tx.emailTemplateLocale.delete({
        where: { templateId_locale: { templateId: id, locale } },
      });
      const remaining = await tx.emailTemplateLocale.findMany({
        where: { templateId: id },
      });
      const variables = variablesFromLocales(remaining);
      await tx.emailTemplate.update({
        where: { id },
        data: {
          variables: { set: variables },
          version: existing.version + 1,
        },
      });
      return (await tx.emailTemplate.findUnique({
        where: { id },
        include: { locales: true },
      }))!;
    });
    audit({
      action: "template.locale_delete",
      entityType: "EmailTemplate",
      entityId: id,
      actorType: ctx.actorType,
      details: { locale, version: tpl.version },
      req: ctx.req ?? null,
    });
    return tpl;
  },

  /** 选择模板创建活动前的可用性校验：归档模板不可用于新活动（specs §229/§325）。 */
  assertUsableForNewCampaign(tpl: EmailTemplateWithLocales): void {
    if (tpl.isArchived) {
      throw new ValidationError("Archived template cannot be used for new campaigns");
    }
  },
};

export type TemplateService = typeof templateService;
