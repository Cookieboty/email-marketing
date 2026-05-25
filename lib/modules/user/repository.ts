/**
 * 用户数据访问层（Prisma 封装）。
 *
 * 设计要点：
 *  - 仅做 SQL 操作，不做业务校验（业务校验在 service 层）
 *  - 写入前不做 normalizeEmail；调用方必须先归一化
 *  - 列表/详情统一返回 `UserWithTags`（标签内联），便于上层直接序列化
 *  - tagFilterMode=all 用 N 次 `userTags some` 形成 AND；any 用单个 `in`
 */

import type { Prisma, PrismaClient, User } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { ListUsersQuery } from "./schema";

export type PrismaTx = Prisma.TransactionClient | PrismaClient;

export interface UserTagBrief {
  id: string;
  name: string;
  color: string | null;
}

/**
 * 安全的 BigInt → JSON 标量。
 * - 在 Number.MAX_SAFE_INTEGER 范围内（< 2^53）→ number，前端可直接 Intl.NumberFormat
 * - 超出 → string，避免精度丢失
 * - null → null
 *
 * 设计动机：amux 的 quota 字段（INT8 列）单值可达数百亿（49,554,480,228），
 * 超过 INT4，但仍远低于 2^53；为了让 NextResponse.json 不在 BigInt 上炸（JSON
 * 不支持 bigint），在 repository 出口处统一转换。
 */
function bigintToJson(v: bigint | null): number | string | null {
  if (v === null) return null;
  if (v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(-Number.MAX_SAFE_INTEGER)) {
    return Number(v);
  }
  return v.toString();
}

export interface UserWithTags extends Omit<User, "balance" | "usedQuota" | "requestCount"> {
  balance: number | string | null;
  usedQuota: number | string | null;
  requestCount: number | string | null;
  tags: UserTagBrief[];
}

export interface ListUsersResult {
  data: UserWithTags[];
  total: number;
  page: number;
  pageSize: number;
}

function buildWhere(query: ListUsersQuery): Prisma.UserWhereInput {
  const AND: Prisma.UserWhereInput[] = [];

  if (query.q) {
    AND.push({
      OR: [
        { email: { contains: query.q, mode: "insensitive" } },
        { name: { contains: query.q, mode: "insensitive" } },
        { externalId: { equals: query.q } },
      ],
    });
  }

  if (query.tagIds && query.tagIds.length > 0) {
    if (query.tagFilterMode === "any") {
      AND.push({ userTags: { some: { tagId: { in: query.tagIds } } } });
    } else {
      // AND：必须拥有全部标签
      for (const tagId of query.tagIds) {
        AND.push({ userTags: { some: { tagId } } });
      }
    }
  }

  if (typeof query.unsubscribed === "boolean") {
    AND.push({ unsubscribed: query.unsubscribed });
  }
  if (query.userLevel) AND.push({ userLevel: query.userLevel });
  if (query.minSpend !== undefined) AND.push({ totalSpend: { gte: query.minSpend } });
  if (query.maxSpend !== undefined) AND.push({ totalSpend: { lte: query.maxSpend } });
  if (query.minOrderCount !== undefined) AND.push({ orderCount: { gte: query.minOrderCount } });
  if (query.lastOrderAfter) AND.push({ lastOrderAt: { gte: query.lastOrderAfter } });

  return AND.length > 0 ? { AND } : {};
}

function attachTags(user: User & { userTags?: Array<{ tag: UserTagBrief }> }): UserWithTags {
  const { userTags, balance, usedQuota, requestCount, ...rest } = user;
  return {
    ...rest,
    balance: bigintToJson(balance),
    usedQuota: bigintToJson(usedQuota),
    requestCount: bigintToJson(requestCount),
    tags: (userTags ?? []).map((ut) => ({
      id: ut.tag.id,
      name: ut.tag.name,
      color: ut.tag.color ?? null,
    })),
  };
}

export const userRepository = {
  async list(query: ListUsersQuery, db: PrismaTx = prisma): Promise<ListUsersResult> {
    const where = buildWhere(query);
    const [total, rows] = await Promise.all([
      db.user.count({ where }),
      db.user.findMany({
        where,
        include: { userTags: { include: { tag: true } } },
        orderBy: { [query.sortBy]: query.sortDir },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return {
      data: rows.map((r) => attachTags(r)),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  },

  async findById(id: string, db: PrismaTx = prisma): Promise<UserWithTags | null> {
    const row = await db.user.findUnique({
      where: { id },
      include: { userTags: { include: { tag: true } } },
    });
    return row ? attachTags(row) : null;
  },

  async findByEmail(email: string, db: PrismaTx = prisma): Promise<UserWithTags | null> {
    const row = await db.user.findUnique({
      where: { email },
      include: { userTags: { include: { tag: true } } },
    });
    return row ? attachTags(row) : null;
  },

  async findByExternalId(
    externalId: string,
    db: PrismaTx = prisma,
  ): Promise<UserWithTags | null> {
    const row = await db.user.findUnique({
      where: { externalId },
      include: { userTags: { include: { tag: true } } },
    });
    return row ? attachTags(row) : null;
  },

  async create(
    data: Prisma.UserUncheckedCreateInput,
    db: PrismaTx = prisma,
  ): Promise<UserWithTags> {
    const row = await db.user.create({
      data,
      include: { userTags: { include: { tag: true } } },
    });
    return attachTags(row);
  },

  async update(
    id: string,
    data: Prisma.UserUncheckedUpdateInput,
    db: PrismaTx = prisma,
  ): Promise<UserWithTags> {
    const row = await db.user.update({
      where: { id },
      data,
      include: { userTags: { include: { tag: true } } },
    });
    return attachTags(row);
  },

  async delete(id: string, db: PrismaTx = prisma): Promise<void> {
    await db.user.delete({ where: { id } });
  },

  async setTags(userId: string, tagIds: string[], db: PrismaTx = prisma): Promise<void> {
    await db.userTag.deleteMany({ where: { userId } });
    if (tagIds.length > 0) {
      await db.userTag.createMany({
        data: tagIds.map((tagId) => ({ userId, tagId })),
        skipDuplicates: true,
      });
    }
  },

  async addTags(userId: string, tagIds: string[], db: PrismaTx = prisma): Promise<void> {
    if (tagIds.length === 0) return;
    await db.userTag.createMany({
      data: tagIds.map((tagId) => ({ userId, tagId })),
      skipDuplicates: true,
    });
  },

  async removeTag(userId: string, tagId: string, db: PrismaTx = prisma): Promise<void> {
    await db.userTag.deleteMany({ where: { userId, tagId } });
  },

  async listIds(query: Omit<ListUsersQuery, "page" | "pageSize" | "sortBy" | "sortDir">, db: PrismaTx = prisma): Promise<string[]> {
    const where = buildWhere({ ...query, page: 1, pageSize: 1, sortBy: "createdAt", sortDir: "desc" });
    const rows = await db.user.findMany({ where, select: { id: true } });
    return rows.map((r) => r.id);
  },

  async batchAddTags(userIds: string[], tagIds: string[], db: PrismaTx = prisma): Promise<number> {
    if (userIds.length === 0 || tagIds.length === 0) return 0;
    const data = userIds.flatMap((userId) => tagIds.map((tagId) => ({ userId, tagId })));
    const result = await db.userTag.createMany({ data, skipDuplicates: true });
    return result.count;
  },

  async batchRemoveTags(userIds: string[], tagIds: string[], db: PrismaTx = prisma): Promise<number> {
    if (userIds.length === 0 || tagIds.length === 0) return 0;
    const result = await db.userTag.deleteMany({
      where: { userId: { in: userIds }, tagId: { in: tagIds } },
    });
    return result.count;
  },
};

export type UserRepository = typeof userRepository;
