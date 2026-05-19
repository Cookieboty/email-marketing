/**
 * 邮件模板数据访问层（Prisma 封装）。
 *
 * 仅做 SQL 操作，不做业务校验（业务校验在 service 层）。
 *
 * 设计：
 *  - list 支持 q 模糊搜索 / includeArchived 过滤 / 分页（count + findMany 并发）
 *  - update 不在此层处理 version+1，避免遗漏（统一在 service 层显式 increment）
 *  - countActiveCampaigns / hasBlockingCampaigns 用于 PATCH/DELETE 时判断是否被
 *    DRAFT/SCHEDULED/SENDING 状态活动引用（specs §218/§238）
 */

import type { EmailTemplate, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { PrismaTx } from "../user/repository";
import type { ListTemplatesQuery } from "./schema";

export interface ListTemplatesResult {
  data: EmailTemplate[];
  total: number;
  page: number;
  pageSize: number;
}

const BLOCKING_CAMPAIGN_STATUSES: Prisma.CampaignWhereInput["status"] = {
  in: ["DRAFT", "SCHEDULED", "SENDING", "AB_TESTING", "PAUSED"],
};

const SENDING_CAMPAIGN_STATUSES: Prisma.CampaignWhereInput["status"] = {
  in: ["SENDING", "AB_TESTING"],
};

export const templateRepository = {
  async list(
    query: ListTemplatesQuery,
    db: PrismaTx = prisma,
  ): Promise<ListTemplatesResult> {
    const where: Prisma.EmailTemplateWhereInput = {};
    if (!query.includeArchived) where.isArchived = false;
    if (query.q) where.name = { contains: query.q, mode: "insensitive" };
    const [total, rows] = await Promise.all([
      db.emailTemplate.count({ where }),
      db.emailTemplate.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return { data: rows, total, page: query.page, pageSize: query.pageSize };
  },

  async findById(id: string, db: PrismaTx = prisma): Promise<EmailTemplate | null> {
    return db.emailTemplate.findUnique({ where: { id } });
  },

  async findByName(name: string, db: PrismaTx = prisma): Promise<EmailTemplate | null> {
    return db.emailTemplate.findUnique({ where: { name } });
  },

  async create(
    data: Prisma.EmailTemplateUncheckedCreateInput,
    db: PrismaTx = prisma,
  ): Promise<EmailTemplate> {
    return db.emailTemplate.create({ data });
  },

  /** 更新并自增 version，使用乐观锁（specs §336/§337）：where 中带上 expectedVersion 防并发覆盖。 */
  async updateWithVersion(
    id: string,
    expectedVersion: number,
    data: Omit<Prisma.EmailTemplateUncheckedUpdateInput, "version">,
    db: PrismaTx = prisma,
  ): Promise<EmailTemplate> {
    const result = await db.emailTemplate.updateMany({
      where: { id, version: expectedVersion },
      data: { ...data, version: expectedVersion + 1 },
    });
    if (result.count === 0) {
      // 行不存在或版本被并发更新；交由 service 层判断
      throw new TemplateVersionConflict(id, expectedVersion);
    }
    return (await db.emailTemplate.findUnique({ where: { id } }))!;
  },

  async setArchived(
    id: string,
    isArchived: boolean,
    db: PrismaTx = prisma,
  ): Promise<EmailTemplate> {
    return db.emailTemplate.update({ where: { id }, data: { isArchived } });
  },

  async delete(id: string, db: PrismaTx = prisma): Promise<void> {
    await db.emailTemplate.delete({ where: { id } });
  },

  /** 是否被 DRAFT/SCHEDULED/SENDING/AB_TESTING/PAUSED 活动引用（用于 DELETE 校验）。 */
  async countBlockingCampaigns(
    templateId: string,
    db: PrismaTx = prisma,
  ): Promise<number> {
    return db.campaign.count({
      where: { templateId, status: BLOCKING_CAMPAIGN_STATUSES },
    });
  },

  /** 是否正在被 SENDING/AB_TESTING 活动使用（用于 PATCH 校验）。 */
  async countSendingCampaigns(
    templateId: string,
    db: PrismaTx = prisma,
  ): Promise<number> {
    return db.campaign.count({
      where: { templateId, status: SENDING_CAMPAIGN_STATUSES },
    });
  },
};

export class TemplateVersionConflict extends Error {
  readonly templateId: string;
  readonly expectedVersion: number;
  constructor(templateId: string, expectedVersion: number) {
    super(`Template ${templateId} version conflict (expected ${expectedVersion})`);
    this.name = "TemplateVersionConflict";
    this.templateId = templateId;
    this.expectedVersion = expectedVersion;
  }
}

export type TemplateRepository = typeof templateRepository;
