/**
 * Topic 数据访问层。
 *
 * 关联 spec：specs/modules/unsubscribe-topic-level.md
 */

import type { Prisma, Topic } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { PrismaTx } from "../user/repository";
import type { ListTopicsQuery } from "./schema";

export interface TopicWithCounts extends Topic {
  unsubscribedCount: number;
  campaignCount: number;
  automationCount: number;
}

export const topicRepository = {
  async list(query: ListTopicsQuery, db: PrismaTx = prisma): Promise<TopicWithCounts[]> {
    const where: Prisma.TopicWhereInput = query.q
      ? {
          OR: [
            { name: { contains: query.q, mode: "insensitive" } },
            { slug: { contains: query.q, mode: "insensitive" } },
            { externalRef: { contains: query.q, mode: "insensitive" } },
          ],
        }
      : {};
    const rows = await db.topic.findMany({
      where,
      orderBy: [{ createdAt: "desc" }],
      include: {
        _count: {
          select: {
            unsubscribes: true,
            campaigns: true,
            automations: true,
          },
        },
      },
    });
    return rows.map((r) => {
      const { _count, ...rest } = r as typeof r & {
        _count: { unsubscribes: number; campaigns: number; automations: number };
      };
      return {
        ...(rest as Topic),
        unsubscribedCount: _count.unsubscribes,
        campaignCount: _count.campaigns,
        automationCount: _count.automations,
      };
    });
  },

  findById(id: string, db: PrismaTx = prisma): Promise<Topic | null> {
    return db.topic.findUnique({ where: { id } });
  },

  findBySlug(slug: string, db: PrismaTx = prisma): Promise<Topic | null> {
    return db.topic.findUnique({ where: { slug } });
  },

  findByExternalRef(externalRef: string, db: PrismaTx = prisma): Promise<Topic | null> {
    return db.topic.findUnique({ where: { externalRef } });
  },

  create(
    data: Prisma.TopicUncheckedCreateInput,
    db: PrismaTx = prisma,
  ): Promise<Topic> {
    return db.topic.create({ data });
  },

  update(
    id: string,
    data: Prisma.TopicUncheckedUpdateInput,
    db: PrismaTx = prisma,
  ): Promise<Topic> {
    return db.topic.update({ where: { id }, data });
  },

  async delete(id: string, db: PrismaTx = prisma): Promise<void> {
    await db.topic.delete({ where: { id } });
  },

  async countCampaignReferences(id: string, db: PrismaTx = prisma): Promise<number> {
    return db.campaign.count({ where: { topicId: id } });
  },

  async countAutomationReferences(id: string, db: PrismaTx = prisma): Promise<number> {
    return db.automation.count({ where: { topicId: id } });
  },
};

export type TopicRepository = typeof topicRepository;
