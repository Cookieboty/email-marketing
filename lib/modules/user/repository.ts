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

export interface UserWithTags extends User {
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
  const { userTags, ...rest } = user;
  return {
    ...(rest as User),
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
};

export type UserRepository = typeof userRepository;
