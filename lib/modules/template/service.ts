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

import { Prisma, type EmailTemplate } from "@prisma/client";
import { audit } from "@/lib/audit";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { extractVariables } from "@/lib/template-engine";
import { templateRepository, TemplateVersionConflict } from "./repository";
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

export const templateService = {
  list(query: ListTemplatesQuery) {
    return templateRepository.list(query);
  },

  async getById(id: string): Promise<EmailTemplate> {
    const t = await templateRepository.findById(id);
    if (!t) throw new NotFoundError("Template not found");
    return t;
  },

  async create(input: CreateTemplateInput, ctx: ActorContext): Promise<EmailTemplate> {
    const html = sanitizeHtml(input.htmlContent);
    const variables = buildVariableList([input.subject, html, input.textContent]);
    try {
      const tpl = await templateRepository.create({
        name: input.name,
        subject: input.subject,
        htmlContent: html,
        textContent: input.textContent ?? null,
        variables,
        version: 1,
        isArchived: false,
      });
      audit({
        action: "template.create",
        entityType: "EmailTemplate",
        entityId: tpl.id,
        actorType: ctx.actorType,
        details: { name: tpl.name, variables },
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
  ): Promise<EmailTemplate> {
    const existing = await templateRepository.findById(id);
    if (!existing) throw new NotFoundError("Template not found");

    if ((await templateRepository.countSendingCampaigns(id)) > 0) {
      throw new ConflictError("Template is in use by a SENDING campaign");
    }

    const nextSubject = input.subject ?? existing.subject;
    const nextHtml = input.htmlContent !== undefined ? sanitizeHtml(input.htmlContent) : existing.htmlContent;
    const nextText = input.textContent !== undefined ? (input.textContent ?? null) : existing.textContent;
    const nextVariables = buildVariableList([nextSubject, nextHtml, nextText]);

    const data: Omit<Prisma.EmailTemplateUncheckedUpdateInput, "version"> = {};
    if (input.name !== undefined) data.name = input.name;
    data.subject = nextSubject;
    data.htmlContent = nextHtml;
    data.textContent = nextText;
    data.variables = { set: nextVariables };

    try {
      const tpl = await templateRepository.updateWithVersion(id, existing.version, data);
      audit({
        action: "template.update",
        entityType: "EmailTemplate",
        entityId: id,
        actorType: ctx.actorType,
        details: {
          name: tpl.name,
          version: tpl.version,
          fields: Object.keys(input),
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

  async archive(id: string, ctx: ActorContext): Promise<EmailTemplate> {
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

  async unarchive(id: string, ctx: ActorContext): Promise<EmailTemplate> {
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

  /** 选择模板创建活动前的可用性校验：归档模板不可用于新活动（specs §229/§325）。 */
  assertUsableForNewCampaign(tpl: EmailTemplate): void {
    if (tpl.isArchived) {
      throw new ValidationError("Archived template cannot be used for new campaigns");
    }
  },
};

export type TemplateService = typeof templateService;
