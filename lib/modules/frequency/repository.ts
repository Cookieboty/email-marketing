/**
 * 频次控制数据访问层。
 *
 * 关键决策：
 *  - 唯一活跃约束由 DB partial unique index 保证（idx_frequency_cap_single_active）；
 *    上层只需捕获 P2002 即可。
 *  - 计数走 `CampaignRecipient WHERE userId AND sentAt >= since`；
 *    sentAt 已在 schema 中索引（campaign_recipients 的 (status,nextRetryAt)），
 *    新增 (userId, sentAt) 索引由迁移层处理；当前规模下扫描可接受。
 */

import type { FrequencyCap, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { PrismaTx } from "../user/repository";

export const frequencyRepository = {
  list(
    where: Prisma.FrequencyCapWhereInput = {},
    db: PrismaTx = prisma,
  ): Promise<FrequencyCap[]> {
    return db.frequencyCap.findMany({ where, orderBy: { createdAt: "desc" } });
  },

  findActive(db: PrismaTx = prisma): Promise<FrequencyCap | null> {
    return db.frequencyCap.findFirst({ where: { isActive: true } });
  },

  findById(id: string, db: PrismaTx = prisma): Promise<FrequencyCap | null> {
    return db.frequencyCap.findUnique({ where: { id } });
  },

  create(
    data: Prisma.FrequencyCapUncheckedCreateInput,
    db: PrismaTx = prisma,
  ): Promise<FrequencyCap> {
    return db.frequencyCap.create({ data });
  },

  update(
    id: string,
    data: Prisma.FrequencyCapUncheckedUpdateInput,
    db: PrismaTx = prisma,
  ): Promise<FrequencyCap> {
    return db.frequencyCap.update({ where: { id }, data });
  },

  async delete(id: string, db: PrismaTx = prisma): Promise<void> {
    await db.frequencyCap.delete({ where: { id } });
  },

  /** 统计 since 之后该用户已 sent 的 CampaignRecipient 数量。 */
  countSentSince(userId: string, since: Date, db: PrismaTx = prisma): Promise<number> {
    return db.campaignRecipient.count({
      where: {
        userId,
        sentAt: { gte: since },
      },
    });
  },
};

export type FrequencyRepository = typeof frequencyRepository;
