/**
 * 媒体资源数据访问层。
 *
 * 设计：
 *  - 仅做 SQL 操作；业务校验、文件落地由 service/storage 完成。
 *  - list 支持 mimeType 精确匹配 + q（filename / alt / tags 任一含 q，case-insensitive）。
 *  - findBySha256 用于上传前去重判断（specs §382「不覆盖旧文件」与「上传同名生成新 ID」并行：
 *    我们以 sha256 为唯一性单位，命中即返回旧记录，不再落盘）。
 */

import type { MediaAsset, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { PrismaTx } from "../user/repository";
import type { ListMediaQuery } from "./schema";

export interface ListMediaResult {
  data: MediaAsset[];
  total: number;
  page: number;
  pageSize: number;
}

export const mediaRepository = {
  async list(query: ListMediaQuery, db: PrismaTx = prisma): Promise<ListMediaResult> {
    const where: Prisma.MediaAssetWhereInput = {};
    if (query.type) where.mimeType = query.type;
    if (query.q) {
      const q = query.q;
      where.OR = [
        { filename: { contains: q, mode: "insensitive" } },
        { alt: { contains: q, mode: "insensitive" } },
        { tags: { has: q } },
      ];
    }
    const [total, rows] = await Promise.all([
      db.mediaAsset.count({ where }),
      db.mediaAsset.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return { data: rows, total, page: query.page, pageSize: query.pageSize };
  },

  async findById(id: string, db: PrismaTx = prisma): Promise<MediaAsset | null> {
    return db.mediaAsset.findUnique({ where: { id } });
  },

  async findBySha256(sha256: string, db: PrismaTx = prisma): Promise<MediaAsset | null> {
    return db.mediaAsset.findUnique({ where: { sha256 } });
  },

  async create(
    data: Prisma.MediaAssetUncheckedCreateInput,
    db: PrismaTx = prisma,
  ): Promise<MediaAsset> {
    return db.mediaAsset.create({ data });
  },

  async update(
    id: string,
    data: Prisma.MediaAssetUncheckedUpdateInput,
    db: PrismaTx = prisma,
  ): Promise<MediaAsset> {
    return db.mediaAsset.update({ where: { id }, data });
  },

  async delete(id: string, db: PrismaTx = prisma): Promise<void> {
    await db.mediaAsset.delete({ where: { id } });
  },
};

export type MediaRepository = typeof mediaRepository;
