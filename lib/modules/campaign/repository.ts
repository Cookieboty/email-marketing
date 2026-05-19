/**
 * Campaign 数据访问层。
 *
 * 设计要点：
 *  - 列表查询包含模板与计数关系，便于前端列表页直接渲染。
 *  - 状态切换用 updateMany + status 乐观锁条件：count===0 时 service 层抛 ConflictError。
 *  - 不在此层做状态合法性判断（交给 state-machine + service）。
 *  - templateSnapshot 必填，由 service 层在 create/send 时显式构造。
 */

import type { Campaign, CampaignStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { PrismaTx } from "../user/repository";

export interface CampaignListItem extends Campaign {
  template: { id: string; name: string } | null;
}

export interface ListCampaignsResult {
  data: CampaignListItem[];
  total: number;
  page: number;
  pageSize: number;
}

interface ListParams {
  q?: string;
  status?: CampaignStatus;
  page: number;
  pageSize: number;
}

export const campaignRepository = {
  async list(params: ListParams, db: PrismaTx = prisma): Promise<ListCampaignsResult> {
    const where: Prisma.CampaignWhereInput = {};
    if (params.status) where.status = params.status;
    if (params.q) {
      where.OR = [
        { name: { contains: params.q, mode: "insensitive" } },
        { subject: { contains: params.q, mode: "insensitive" } },
      ];
    }

    const [total, rows] = await Promise.all([
      db.campaign.count({ where }),
      db.campaign.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        include: { template: { select: { id: true, name: true } } },
      }),
    ]);

    return {
      data: rows as CampaignListItem[],
      total,
      page: params.page,
      pageSize: params.pageSize,
    };
  },

  async findById(id: string, db: PrismaTx = prisma) {
    return db.campaign.findUnique({
      where: { id },
      include: {
        template: { select: { id: true, name: true } },
        variants: true,
      },
    });
  },

  async create(data: Prisma.CampaignCreateInput | Prisma.CampaignUncheckedCreateInput, db: PrismaTx = prisma) {
    return db.campaign.create({ data: data as Prisma.CampaignCreateInput });
  },

  async update(
    id: string,
    data: Prisma.CampaignUpdateInput,
    db: PrismaTx = prisma,
  ) {
    return db.campaign.update({ where: { id }, data });
  },

  async delete(id: string, db: PrismaTx = prisma) {
    return db.campaign.delete({ where: { id } });
  },

  /**
   * 乐观锁状态切换：仅当当前 status === expected 时更新，返回受影响行数。
   * 调用方应判断 count===0 抛 ConflictError。
   */
  async transitionStatus(
    id: string,
    expected: CampaignStatus,
    next: CampaignStatus,
    extra: Prisma.CampaignUpdateManyMutationInput = {},
    db: PrismaTx = prisma,
  ): Promise<number> {
    const result = await db.campaign.updateMany({
      where: { id, status: expected },
      data: { status: next, ...extra },
    });
    return result.count;
  },
};
