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
import {
  BlockExpansionError,
  extractAllVariables,
  extractBlockRefs,
  type BlockResolver,
} from "@/lib/template-engine";
import {
  templateBlockRepository,
  type FindBlockPair,
  type TemplateBlockRefRow,
} from "../template-block/repository";
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

interface LocaleSourceLike {
  subject: string;
  htmlContent: string;
  textContent?: string | null;
}

/**
 * 把同一 locale 的 subject/html/text 拼成一个"超级源串"用于 ref 提取。
 * 用 `\n` 分隔避免相邻字段被误识别为同一引用。
 */
function joinLocaleSources(content: LocaleSourceLike): string {
  return [content.subject, content.htmlContent, content.textContent ?? ""].join(
    "\n",
  );
}

/**
 * 收集模板各 locale 内出现的片段引用名（已去重，按 locale 聚合）。
 *
 * 仅扫描"顶层"模板源码 —— 片段内部的引用由 `expandBlocks` 在渲染期递归发现，
 * 这里的目的只是为了**预取**片段表行，所以不需要递归解析。
 */
export function collectBlockRefsPerLocale(
  locales: Array<LocaleSourceLike & { locale: Locale }>,
): Partial<Record<Locale, string[]>> {
  const out: Partial<Record<Locale, string[]>> = {};
  for (const row of locales) {
    const refs = extractBlockRefs(joinLocaleSources(row));
    if (refs.length === 0) continue;
    out[row.locale] = refs;
  }
  return out;
}

/**
 * 按 (locale, name) 配对从仓储批量取片段，并整理为
 * `Record<Locale, Record<name, htmlContent>>` 结构（即 snapshot.blocks 形态）。
 *
 * - 入参为按 locale 聚合的引用集合
 * - 内部展开为扁平的 pair 列表交给 `findManyByPairs`
 * - 同一 (locale,name) 重复也安全（仓储层已 dedupe）
 */
export async function loadBlocksByPairs(
  refsPerLocale: Partial<Record<Locale, string[]>>,
): Promise<Partial<Record<Locale, Record<string, string>>>> {
  const pairs: FindBlockPair[] = [];
  for (const [locale, names] of Object.entries(refsPerLocale) as Array<
    [Locale, string[] | undefined]
  >) {
    if (!names) continue;
    for (const name of names) pairs.push({ locale, name });
  }
  if (pairs.length === 0) return {};
  const rows = await templateBlockRepository.findManyByPairs(pairs);
  return groupBlocksByLocale(rows);
}

function groupBlocksByLocale(
  rows: TemplateBlockRefRow[],
): Partial<Record<Locale, Record<string, string>>> {
  const out: Partial<Record<Locale, Record<string, string>>> = {};
  for (const row of rows) {
    (out[row.locale] ??= {})[row.name] = row.htmlContent;
  }
  return out;
}

/**
 * 校验"模板每个 locale 的引用都能在该 locale 的 blocks 表中解析"。
 * 缺失抛 ValidationError，错误信息包含具体 locale + 缺失名字，便于前端定位。
 */
export function assertAllBlocksResolvable(
  refsPerLocale: Partial<Record<Locale, string[]>>,
  blocksPerLocale: Partial<Record<Locale, Record<string, string>>>,
): void {
  for (const [locale, names] of Object.entries(refsPerLocale) as Array<
    [Locale, string[] | undefined]
  >) {
    if (!names || names.length === 0) continue;
    const provided = blocksPerLocale[locale] ?? {};
    const missing = names.filter((n) => !(n in provided));
    if (missing.length > 0) {
      throw new ValidationError(
        `Missing blocks for locale=${locale}: [${missing.join(", ")}]`,
      );
    }
  }
}

/** 构造单 locale 的只读 BlockResolver（为 extractAllVariables 提供片段查找）。 */
export function makeLocaleBlockResolver(
  blocks: Record<string, string> | undefined,
): BlockResolver {
  const safe = blocks ?? {};
  return {
    get(name: string) {
      return Object.prototype.hasOwnProperty.call(safe, name) ? safe[name]! : null;
    },
  };
}

/**
 * 预览专用：按 (locale, refNames) 实时取片段并构造 resolver。
 *
 * 与持久化路径（snapshot.blocks 冻结）有意区别：预览要"即取即用"，
 * 这样编辑器键入 `{{> footer}}` 即可立即生效。空 refNames 直接返回空 resolver，
 * 避免无谓查询。
 */
export async function buildPreviewResolver(
  locale: Locale,
  refNames: string[],
): Promise<BlockResolver> {
  if (refNames.length === 0) return makeLocaleBlockResolver(undefined);
  const blocks = await loadBlocksByPairs({ [locale]: refNames });
  return makeLocaleBlockResolver(blocks[locale]);
}

/** 从多段源码中收集去重的片段引用名。 */
export function uniqueBlockRefs(sources: string[]): string[] {
  const set = new Set<string>();
  for (const s of sources) {
    if (!s) continue;
    for (const name of extractBlockRefs(s)) set.add(name);
  }
  return Array.from(set);
}

/** 把 BlockExpansionError 转译为 API 层 4xx ValidationError。 */
export function blockErrorToValidationError(err: BlockExpansionError): ValidationError {
  const detail = err.blockName ? ` block=${err.blockName}` : "";
  const trace =
    err.trace && err.trace.length > 0 ? ` trace=[${err.trace.join("→")}]` : "";
  return new ValidationError(
    `Template block expansion failed [${err.code}]${detail}${trace}: ${err.message}`,
  );
}

/**
 * 持久化专用（Campaign / Automation / AutomationRun snapshot 冻结）：
 *
 * 1. 收集模板各 locale 的顶层片段引用
 * 2. 一次批量取出 (locale, name) 配对的片段 HTML
 * 3. 任一引用未命中 → 抛 ValidationError，禁止创建调度对象（防漂移＆防未发现的缺片段）
 *
 * 返回值即可直接传给 `buildTemplateSnapshot(tpl, blocksPerLocale)`，写入快照后发送
 * 路径不再回查 TemplateBlock 表（spec §快照不漂移）。
 */
export async function freezeBlocksForSnapshot(template: {
  locales: Array<{
    locale: Locale;
    subject: string;
    htmlContent: string;
    textContent: string | null;
  }>;
}): Promise<Partial<Record<Locale, Record<string, string>>>> {
  const refsPerLocale = collectBlockRefsPerLocale(template.locales);
  const blocksPerLocale = await loadBlocksByPairs(refsPerLocale);
  assertAllBlocksResolvable(refsPerLocale, blocksPerLocale);
  return blocksPerLocale;
}

/**
 * 计算 template.variables：扫描 defaultLocale 的源码 + 该 locale 的 blocks，
 * 递归提取所有变量名（含片段内的）。这样片段被引用后，模板的 variables 自动
 * 同步出现内层占位符，前端 / API 校验都能直接使用。
 */
function computeTemplateVariables(
  locales: Array<LocaleSourceLike & { locale: Locale }>,
  defaultLocale: Locale,
  blocksPerLocale: Partial<Record<Locale, Record<string, string>>>,
): string[] {
  const target =
    locales.find((row) => row.locale === defaultLocale) ?? locales[0];
  if (!target) return [];
  const resolver = makeLocaleBlockResolver(blocksPerLocale[target.locale]);
  return extractAllVariables(joinLocaleSources(target), resolver);
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
    locale: Locale;
    subject: string;
    htmlContent: string;
    textContent?: string | null;
  }>,
  defaultLocale: Locale,
  blocksPerLocale: Partial<Record<Locale, Record<string, string>>>,
): string[] {
  return computeTemplateVariables(locales, defaultLocale, blocksPerLocale);
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
    const refsPerLocale = collectBlockRefsPerLocale(localeRows);
    const blocksPerLocale = await loadBlocksByPairs(refsPerLocale);
    assertAllBlocksResolvable(refsPerLocale, blocksPerLocale);
    const variables = variablesFromLocales(
      localeRows,
      input.defaultLocale as Locale,
      blocksPerLocale,
    );
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
      const nextLocaleRows = Array.from(nextLocaleMap.entries()).map(
        ([locale, content]) => ({ locale, ...content }),
      );
      const refsPerLocale = collectBlockRefsPerLocale(nextLocaleRows);
      const blocksPerLocale = await loadBlocksByPairs(refsPerLocale);
      assertAllBlocksResolvable(refsPerLocale, blocksPerLocale);
      const nextVariables = variablesFromLocales(
        nextLocaleRows,
        nextDefaultLocale,
        blocksPerLocale,
      );

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
      const nextDefaultLocale = existing.defaultLocale;
      const refsPerLocale = collectBlockRefsPerLocale(remaining);
      const blocksPerLocale = await loadBlocksByPairs(refsPerLocale);
      assertAllBlocksResolvable(refsPerLocale, blocksPerLocale);
      const variables = variablesFromLocales(
        remaining,
        nextDefaultLocale,
        blocksPerLocale,
      );
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
