/**
 * ApiClient & InboundRequestLog 数据访问层。
 *
 * 关联 spec：specs/modules/inbound-connector.md
 */

import type { ApiClient, ApiClientStatus, InboundRequestLog, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { PrismaTx } from "../user/repository";
import type { ListApiClientsQuery } from "./schema";

export interface ListApiClientsResult {
  data: ApiClient[];
  total: number;
  page: number;
  pageSize: number;
}

export const apiClientRepository = {
  async list(query: ListApiClientsQuery, db: PrismaTx = prisma): Promise<ListApiClientsResult> {
    const where: Prisma.ApiClientWhereInput = {};
    if (query.q) {
      where.OR = [
        { name: { contains: query.q, mode: "insensitive" } },
        { tokenPrefix: { contains: query.q, mode: "insensitive" } },
      ];
    }
    if (query.status) where.status = query.status;

    const [total, data] = await Promise.all([
      db.apiClient.count({ where }),
      db.apiClient.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return { data, total, page: query.page, pageSize: query.pageSize };
  },

  findById(id: string, db: PrismaTx = prisma): Promise<ApiClient | null> {
    return db.apiClient.findUnique({ where: { id } });
  },

  findByTokenHash(hash: string, db: PrismaTx = prisma): Promise<ApiClient | null> {
    return db.apiClient.findUnique({ where: { tokenHash: hash } });
  },

  /** 兼容轮转 grace：先查 tokenHash，再回退 previousTokenHash 且未过期。 */
  async findByActiveOrPreviousToken(
    hash: string,
    now: Date = new Date(),
    db: PrismaTx = prisma,
  ): Promise<{ client: ApiClient; viaPrevious: boolean } | null> {
    const direct = await db.apiClient.findUnique({ where: { tokenHash: hash } });
    if (direct) return { client: direct, viaPrevious: false };
    const prev = await db.apiClient.findFirst({
      where: {
        previousTokenHash: hash,
        previousTokenExpiresAt: { gt: now },
      },
    });
    if (prev) return { client: prev, viaPrevious: true };
    return null;
  },

  create(
    data: Prisma.ApiClientUncheckedCreateInput,
    db: PrismaTx = prisma,
  ): Promise<ApiClient> {
    return db.apiClient.create({ data });
  },

  update(
    id: string,
    data: Prisma.ApiClientUncheckedUpdateInput,
    db: PrismaTx = prisma,
  ): Promise<ApiClient> {
    return db.apiClient.update({ where: { id }, data });
  },

  updateStatus(
    id: string,
    status: ApiClientStatus,
    db: PrismaTx = prisma,
  ): Promise<ApiClient> {
    return db.apiClient.update({ where: { id }, data: { status } });
  },

  /** lastUsedAt 异步更新，调用方不应 await。 */
  async touchLastUsedAt(id: string, when: Date = new Date()): Promise<void> {
    try {
      await prisma.apiClient.update({
        where: { id },
        data: { lastUsedAt: when },
      });
    } catch {
      // 忽略：lastUsedAt 不影响业务
    }
  },
};

export const inboundRequestLogRepository = {
  findByKey(
    apiClientId: string,
    idempotencyKey: string,
    db: PrismaTx = prisma,
  ): Promise<InboundRequestLog | null> {
    return db.inboundRequestLog.findUnique({
      where: { apiClientId_idempotencyKey: { apiClientId, idempotencyKey } },
    });
  },

  create(
    data: Prisma.InboundRequestLogUncheckedCreateInput,
    db: PrismaTx = prisma,
  ): Promise<InboundRequestLog> {
    return db.inboundRequestLog.create({ data });
  },

  update(
    apiClientId: string,
    idempotencyKey: string,
    data: Prisma.InboundRequestLogUncheckedUpdateInput,
    db: PrismaTx = prisma,
  ): Promise<InboundRequestLog> {
    return db.inboundRequestLog.update({
      where: { apiClientId_idempotencyKey: { apiClientId, idempotencyKey } },
      data,
    });
  },

  async deleteExpired(now: Date = new Date(), batch = 1000): Promise<number> {
    let total = 0;
    for (;;) {
      const rows = await prisma.inboundRequestLog.findMany({
        where: { expiresAt: { lt: now } },
        select: { id: true },
        take: batch,
      });
      if (rows.length === 0) break;
      const { count } = await prisma.inboundRequestLog.deleteMany({
        where: { id: { in: rows.map((r) => r.id) } },
      });
      total += count;
      if (rows.length < batch) break;
    }
    return total;
  },
};

export type ApiClientRepository = typeof apiClientRepository;
export type InboundRequestLogRepository = typeof inboundRequestLogRepository;
