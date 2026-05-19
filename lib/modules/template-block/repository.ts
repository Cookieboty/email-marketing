/**
 * 模板片段数据访问层。
 *
 * 仅做 SQL 操作，无业务校验。
 */

import type { Prisma, TemplateBlock } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { PrismaTx } from "../user/repository";
import type { ListTemplateBlocksQuery } from "./schema";

export interface ListTemplateBlocksResult {
  data: TemplateBlock[];
  total: number;
  page: number;
  pageSize: number;
}

export const templateBlockRepository = {
  async list(
    query: ListTemplateBlocksQuery,
    db: PrismaTx = prisma,
  ): Promise<ListTemplateBlocksResult> {
    const where: Prisma.TemplateBlockWhereInput = {};
    if (query.category) where.category = query.category;
    if (query.q) where.name = { contains: query.q, mode: "insensitive" };
    const [total, rows] = await Promise.all([
      db.templateBlock.count({ where }),
      db.templateBlock.findMany({
        where,
        orderBy: [{ category: "asc" }, { name: "asc" }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return { data: rows, total, page: query.page, pageSize: query.pageSize };
  },

  async findById(id: string, db: PrismaTx = prisma): Promise<TemplateBlock | null> {
    return db.templateBlock.findUnique({ where: { id } });
  },

  async create(
    data: Prisma.TemplateBlockUncheckedCreateInput,
    db: PrismaTx = prisma,
  ): Promise<TemplateBlock> {
    return db.templateBlock.create({ data });
  },

  async update(
    id: string,
    data: Prisma.TemplateBlockUncheckedUpdateInput,
    db: PrismaTx = prisma,
  ): Promise<TemplateBlock> {
    return db.templateBlock.update({ where: { id }, data });
  },

  async delete(id: string, db: PrismaTx = prisma): Promise<void> {
    await db.templateBlock.delete({ where: { id } });
  },
};

export type TemplateBlockRepository = typeof templateBlockRepository;
