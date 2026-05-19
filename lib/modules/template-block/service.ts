/**
 * 模板片段业务服务。
 *
 * 职责：
 *  - htmlContent 走 sanitizeHtml（与模板共用）
 *  - 自动提取 variables（仅 htmlContent，片段无 subject）
 *  - isSystem 片段保护：不允许通过 API 删除（specs §278-289 隐含）
 *  - AuditLog（fire-and-forget）
 */

import type { Prisma, TemplateBlock } from "@prisma/client";
import { audit } from "@/lib/audit";
import { ConflictError, ForbiddenError, NotFoundError } from "@/lib/errors";
import { extractVariables } from "@/lib/template-engine";
import { sanitizeHtml } from "../template/service";
import { templateBlockRepository } from "./repository";
import type {
  CreateTemplateBlockInput,
  ListTemplateBlocksQuery,
  UpdateTemplateBlockInput,
} from "./schema";

interface ActorContext {
  actorType: "ADMIN" | "SYSTEM" | "WEBHOOK";
  req?: { headers: Headers } | null;
}

export const templateBlockService = {
  list(query: ListTemplateBlocksQuery) {
    return templateBlockRepository.list(query);
  },

  async getById(id: string): Promise<TemplateBlock> {
    const b = await templateBlockRepository.findById(id);
    if (!b) throw new NotFoundError("Template block not found");
    return b;
  },

  async create(
    input: CreateTemplateBlockInput,
    ctx: ActorContext,
  ): Promise<TemplateBlock> {
    const html = sanitizeHtml(input.htmlContent);
    const variables = extractVariables(html);
    const block = await templateBlockRepository.create({
      name: input.name,
      category: input.category ?? null,
      htmlContent: html,
      variables,
      isSystem: false,
    });
    audit({
      action: "template_block.create",
      entityType: "TemplateBlock",
      entityId: block.id,
      actorType: ctx.actorType,
      details: { name: block.name, category: block.category },
      req: ctx.req ?? null,
    });
    return block;
  },

  async update(
    id: string,
    input: UpdateTemplateBlockInput,
    ctx: ActorContext,
  ): Promise<TemplateBlock> {
    const existing = await templateBlockRepository.findById(id);
    if (!existing) throw new NotFoundError("Template block not found");
    if (existing.isSystem) {
      throw new ConflictError("System blocks cannot be modified");
    }
    const data: Prisma.TemplateBlockUncheckedUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.category !== undefined) data.category = input.category ?? null;
    if (input.htmlContent !== undefined) {
      const html = sanitizeHtml(input.htmlContent);
      data.htmlContent = html;
      data.variables = { set: extractVariables(html) };
    }
    const block = await templateBlockRepository.update(id, data);
    audit({
      action: "template_block.update",
      entityType: "TemplateBlock",
      entityId: id,
      actorType: ctx.actorType,
      details: { name: block.name, fields: Object.keys(input) },
      req: ctx.req ?? null,
    });
    return block;
  },

  async delete(id: string, ctx: ActorContext): Promise<void> {
    const existing = await templateBlockRepository.findById(id);
    if (!existing) throw new NotFoundError("Template block not found");
    if (existing.isSystem) {
      throw new ForbiddenError("System blocks cannot be deleted");
    }
    await templateBlockRepository.delete(id);
    audit({
      action: "template_block.delete",
      entityType: "TemplateBlock",
      entityId: id,
      actorType: ctx.actorType,
      details: { name: existing.name },
      req: ctx.req ?? null,
    });
  },
};

export type TemplateBlockService = typeof templateBlockService;
