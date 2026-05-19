/**
 * Topic 业务服务。
 *
 * 关联 spec：specs/modules/unsubscribe-topic-level.md
 *
 * 关键约束：
 *  - slug 唯一；slug 不可更新（避免历史邮件中的退订链接失效）
 *  - 被 Campaign / Automation 引用的 Topic 不可删除（外键 SetNull 也禁止主动删除以保留语义）
 *  - 删除后若仍有 UserTopicUnsubscribe 行为级联清除（Cascade）
 */

import { Prisma } from "@prisma/client";
import { audit } from "@/lib/audit";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { topicRepository, type TopicWithCounts } from "./repository";
import type {
  CreateTopicInput,
  ListTopicsQuery,
  UpdateTopicInput,
} from "./schema";

interface ActorContext {
  actorType: "ADMIN" | "SYSTEM" | "WEBHOOK";
  req?: { headers: Headers } | null;
  apiClientId?: string;
  idempotencyKey?: string | null;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

export const topicService = {
  list(query: ListTopicsQuery): Promise<TopicWithCounts[]> {
    return topicRepository.list(query);
  },

  async getById(id: string) {
    const t = await topicRepository.findById(id);
    if (!t) throw new NotFoundError("Topic not found");
    return t;
  },

  async create(input: CreateTopicInput, ctx: ActorContext) {
    try {
      const t = await topicRepository.create({
        name: input.name,
        slug: input.slug,
        description: input.description ?? null,
        externalRef: input.externalRef ?? null,
      });
      audit({
        action: "topic.create",
        entityType: "Topic",
        entityId: t.id,
        actorType: ctx.actorType,
        details: {
          slug: t.slug,
          name: t.name,
          externalRef: t.externalRef,
          apiClientId: ctx.apiClientId,
          idempotencyKey: ctx.idempotencyKey ?? undefined,
        },
        req: ctx.req ?? null,
      });
      return t;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictError("Topic slug or externalRef already exists");
      }
      throw err;
    }
  },

  async update(id: string, input: UpdateTopicInput, ctx: ActorContext) {
    const existing = await topicRepository.findById(id);
    if (!existing) throw new NotFoundError("Topic not found");
    const data: Prisma.TopicUncheckedUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.description !== undefined) data.description = input.description ?? null;
    if (input.externalRef !== undefined) data.externalRef = input.externalRef ?? null;
    try {
      const t = await topicRepository.update(id, data);
      audit({
        action: "topic.update",
        entityType: "Topic",
        entityId: id,
        actorType: ctx.actorType,
        details: {
          slug: t.slug,
          fields: Object.keys(input),
          apiClientId: ctx.apiClientId,
          idempotencyKey: ctx.idempotencyKey ?? undefined,
        },
        req: ctx.req ?? null,
      });
      return t;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictError("Topic externalRef already exists");
      }
      throw err;
    }
  },

  async delete(id: string, ctx: ActorContext) {
    const existing = await topicRepository.findById(id);
    if (!existing) throw new NotFoundError("Topic not found");
    const [campaignRefs, automationRefs] = await Promise.all([
      topicRepository.countCampaignReferences(id),
      topicRepository.countAutomationReferences(id),
    ]);
    if (campaignRefs > 0 || automationRefs > 0) {
      throw new ConflictError(
        `Topic is referenced by ${campaignRefs} campaign(s) and ${automationRefs} automation(s) and cannot be deleted`,
      );
    }
    await topicRepository.delete(id);
    audit({
      action: "topic.delete",
      entityType: "Topic",
      entityId: id,
      actorType: ctx.actorType,
      details: {
        slug: existing.slug,
        name: existing.name,
        apiClientId: ctx.apiClientId,
        idempotencyKey: ctx.idempotencyKey ?? undefined,
      },
      req: ctx.req ?? null,
    });
  },
};

export type TopicService = typeof topicService;
