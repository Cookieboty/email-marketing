/**
 * 抑制名单数据访问层。
 *
 * 关键决策：
 *  - PATTERN 类型用 `value ILIKE $pattern` 直接做后端字符串匹配；存储时保留原始大小写
 *    （phase-1 §3.2 / specs §3.2）
 *  - DOMAIN 类型在 isSuppressed 中做后缀匹配（输入 email → 提取 domain →
 *    `WHERE type='DOMAIN' AND value=domain`），不需要 LIKE
 *  - (type, value) 已建唯一索引，重复写入由调用方处理 P2002
 *  - 所有列表查询都按 createdAt desc 默认排序，便于看最新写入
 */

import type { Prisma, SuppressionEntry, SuppressionType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { PrismaTx } from "../user/repository";

export interface ListSuppressionResult {
  data: SuppressionEntry[];
  total: number;
  page: number;
  pageSize: number;
}

interface ListParams {
  q?: string;
  type?: SuppressionType;
  page: number;
  pageSize: number;
}

export const suppressionRepository = {
  async list(params: ListParams, db: PrismaTx = prisma): Promise<ListSuppressionResult> {
    const where: Prisma.SuppressionEntryWhereInput = {};
    if (params.type) where.type = params.type;
    if (params.q) {
      where.OR = [
        { value: { contains: params.q, mode: "insensitive" } },
        { reason: { contains: params.q, mode: "insensitive" } },
      ];
    }
    const [data, total] = await Promise.all([
      db.suppressionEntry.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
      }),
      db.suppressionEntry.count({ where }),
    ]);
    return { data, total, page: params.page, pageSize: params.pageSize };
  },

  findById(id: string, db: PrismaTx = prisma): Promise<SuppressionEntry | null> {
    return db.suppressionEntry.findUnique({ where: { id } });
  },

  findByTypeValue(
    type: SuppressionType,
    value: string,
    db: PrismaTx = prisma,
  ): Promise<SuppressionEntry | null> {
    return db.suppressionEntry.findUnique({ where: { type_value: { type, value } } });
  },

  create(
    data: Prisma.SuppressionEntryUncheckedCreateInput,
    db: PrismaTx = prisma,
  ): Promise<SuppressionEntry> {
    return db.suppressionEntry.create({ data });
  },

  update(
    id: string,
    data: Prisma.SuppressionEntryUncheckedUpdateInput,
    db: PrismaTx = prisma,
  ): Promise<SuppressionEntry> {
    return db.suppressionEntry.update({ where: { id }, data });
  },

  async delete(id: string, db: PrismaTx = prisma): Promise<void> {
    await db.suppressionEntry.delete({ where: { id } });
  },

  /**
   * 批量 upsert：用于 import；通过 $transaction + 串行 upsert 保证原子性。
   * 单条失败立即抛出，调用方捕获后转化为行级错误。
   */
  async upsertMany(
    rows: Array<{
      type: SuppressionType;
      value: string;
      reason?: string | null;
      source?: string | null;
    }>,
    db: PrismaTx = prisma,
  ): Promise<{ created: number; updated: number }> {
    let created = 0;
    let updated = 0;
    for (const r of rows) {
      const existing = await db.suppressionEntry.findUnique({
        where: { type_value: { type: r.type, value: r.value } },
      });
      if (existing) {
        await db.suppressionEntry.update({
          where: { id: existing.id },
          data: {
            reason: r.reason ?? existing.reason,
            source: r.source ?? existing.source,
          },
        });
        updated += 1;
      } else {
        await db.suppressionEntry.create({
          data: {
            type: r.type,
            value: r.value,
            reason: r.reason ?? null,
            source: r.source ?? null,
          },
        });
        created += 1;
      }
    }
    return { created, updated };
  },

  /**
   * 检查给定邮箱地址是否被任意一条抑制规则命中。
   *
   * SQL 决策：单次 query，在 PostgreSQL 内同时验证 EMAIL/DOMAIN/PATTERN：
   *   SELECT 1 FROM suppression_entries WHERE
   *     (type='EMAIL'   AND value=$email) OR
   *     (type='DOMAIN'  AND value=$domain) OR
   *     (type='PATTERN' AND $email ILIKE value)
   *   LIMIT 1
   *
   * - 减少往返次数（缓存未命中时只发 1 条 SQL）
   * - PATTERN 走 ILIKE 大小写不敏感；EMAIL/DOMAIN 已 lowercase 存储
   */
  async existsForEmail(
    email: string,
    domain: string,
    db: PrismaTx = prisma,
  ): Promise<boolean> {
    const rows = await db.$queryRaw<Array<{ exists: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM suppression_entries
        WHERE
          (type = 'EMAIL'   AND value = ${email}) OR
          (type = 'DOMAIN'  AND value = ${domain}) OR
          (type = 'PATTERN' AND ${email} ILIKE value)
        LIMIT 1
      ) AS exists
    `;
    return rows[0]?.exists === true;
  },
};

export type SuppressionRepository = typeof suppressionRepository;
