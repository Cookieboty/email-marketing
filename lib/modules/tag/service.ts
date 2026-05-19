/**
 * 标签业务服务。
 *
 * 职责：
 *  - 唯一性冲突 → ConflictError
 *  - 缺失 → NotFoundError
 *  - 写 AuditLog（fire-and-forget）
 *  - DELETE 通过外键 CASCADE 自动清理 UserTag
 */

import { Prisma } from "@prisma/client";
import { audit } from "@/lib/audit";
import { ConflictError, NotFoundError } from "@/lib/errors";
import type { CreateTagInput, ListTagsQuery, TagUsersQuery, UpdateTagInput } from "./schema";
import { tagRepository } from "./repository";

interface ActorContext {
  actorType: "ADMIN" | "SYSTEM" | "WEBHOOK";
  req?: { headers: Headers } | null;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

export const tagService = {
  list(query: ListTagsQuery) {
    return tagRepository.list(query);
  },

  async getById(id: string) {
    const t = await tagRepository.findById(id);
    if (!t) throw new NotFoundError("Tag not found");
    return t;
  },

  async create(input: CreateTagInput, ctx: ActorContext) {
    try {
      const tag = await tagRepository.create({ name: input.name, color: input.color ?? null });
      audit({
        action: "tag.create",
        entityType: "Tag",
        entityId: tag.id,
        actorType: ctx.actorType,
        details: { name: tag.name },
        req: ctx.req ?? null,
      });
      return tag;
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError("Tag name already exists");
      throw err;
    }
  },

  async update(id: string, input: UpdateTagInput, ctx: ActorContext) {
    const existing = await tagRepository.findById(id);
    if (!existing) throw new NotFoundError("Tag not found");
    const data: Prisma.TagUncheckedUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.color !== undefined) data.color = input.color ?? null;
    try {
      const tag = await tagRepository.update(id, data);
      audit({
        action: "tag.update",
        entityType: "Tag",
        entityId: id,
        actorType: ctx.actorType,
        details: { name: tag.name, fields: Object.keys(input) },
        req: ctx.req ?? null,
      });
      return tag;
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError("Tag name already exists");
      throw err;
    }
  },

  async delete(id: string, ctx: ActorContext) {
    const existing = await tagRepository.findById(id);
    if (!existing) throw new NotFoundError("Tag not found");
    await tagRepository.delete(id);
    audit({
      action: "tag.delete",
      entityType: "Tag",
      entityId: id,
      actorType: ctx.actorType,
      details: { name: existing.name },
      req: ctx.req ?? null,
    });
  },

  async listUsers(id: string, query: TagUsersQuery) {
    const t = await tagRepository.findById(id);
    if (!t) throw new NotFoundError("Tag not found");
    return tagRepository.listUsers(id, query);
  },
};

export type TagService = typeof tagService;
