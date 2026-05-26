/**
 * 模板片段数据访问层。
 *
 * 仅做 SQL 操作，无业务校验。
 */

import type { Locale, Prisma, TemplateBlock } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { PrismaTx } from "../user/repository";
import type { ListTemplateBlocksQuery } from "./schema";

export interface ListTemplateBlocksResult {
  data: TemplateBlock[];
  total: number;
  page: number;
  pageSize: number;
}

export interface FindBlockPair {
  locale: Locale;
  name: string;
}

export type TemplateBlockRefRow = Pick<
  TemplateBlock,
  "id" | "name" | "locale" | "htmlContent" | "updatedAt"
>;

export const templateBlockRepository = {
  async list(
    query: ListTemplateBlocksQuery,
    db: PrismaTx = prisma,
  ): Promise<ListTemplateBlocksResult> {
    const where: Prisma.TemplateBlockWhereInput = {};
    if (query.category) where.category = query.category;
    if (query.locale) where.locale = query.locale;
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

  /**
   * 按 (locale, name) 配对批量查询模板片段。
   *
   * - `pairs.length === 0` 时短路返回空数组，避免 Prisma 把空 `OR` 数组解释为
   *   空过滤导致全表扫描。
   * - 仅 `select` 渲染 / 冻结所需字段，避免拉取潜在大字段。
   * - 不存在的 pair 不会出现在结果中，也不抛错；调用方负责缺失校验。
   */
  async findManyByPairs(
    pairs: ReadonlyArray<FindBlockPair>,
    db: PrismaTx = prisma,
  ): Promise<TemplateBlockRefRow[]> {
    if (pairs.length === 0) return [];
    const seen = new Set<string>();
    const dedup: FindBlockPair[] = [];
    for (const p of pairs) {
      const key = `${p.locale}::${p.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      dedup.push({ locale: p.locale, name: p.name });
    }
    return db.templateBlock.findMany({
      where: { OR: dedup.map((p) => ({ locale: p.locale, name: p.name })) },
      select: {
        id: true,
        name: true,
        locale: true,
        htmlContent: true,
        updatedAt: true,
      },
    });
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
