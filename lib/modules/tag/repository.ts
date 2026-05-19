/**
 * 标签数据访问层。
 *
 * 提供：CRUD + userCount 聚合 + 标签下用户列表（分页）。
 */

import type { Prisma, Tag } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { PrismaTx, UserWithTags } from "../user/repository";
import type { ListTagsQuery, TagUsersQuery } from "./schema";

export interface TagWithCount extends Tag {
  userCount: number;
}

export interface ListTagsResult {
  data: TagWithCount[];
  total: number;
  page: number;
  pageSize: number;
}

export const tagRepository = {
  async list(query: ListTagsQuery, db: PrismaTx = prisma): Promise<ListTagsResult> {
    const where: Prisma.TagWhereInput = query.q
      ? { name: { contains: query.q, mode: "insensitive" } }
      : {};
    const [total, rows] = await Promise.all([
      db.tag.count({ where }),
      db.tag.findMany({
        where,
        orderBy: { name: "asc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: { _count: { select: { userTags: true } } },
      }),
    ]);
    const data = rows.map((r) => {
      const { _count, ...rest } = r as typeof r & { _count: { userTags: number } };
      return { ...(rest as Tag), userCount: _count.userTags };
    });
    return { data, total, page: query.page, pageSize: query.pageSize };
  },

  async findById(id: string, db: PrismaTx = prisma): Promise<Tag | null> {
    return db.tag.findUnique({ where: { id } });
  },

  async findByName(name: string, db: PrismaTx = prisma): Promise<Tag | null> {
    return db.tag.findUnique({ where: { name } });
  },

  async create(data: Prisma.TagUncheckedCreateInput, db: PrismaTx = prisma): Promise<Tag> {
    return db.tag.create({ data });
  },

  async update(
    id: string,
    data: Prisma.TagUncheckedUpdateInput,
    db: PrismaTx = prisma,
  ): Promise<Tag> {
    return db.tag.update({ where: { id }, data });
  },

  async delete(id: string, db: PrismaTx = prisma): Promise<void> {
    await db.tag.delete({ where: { id } });
  },

  async listUsers(
    tagId: string,
    query: TagUsersQuery,
    db: PrismaTx = prisma,
  ): Promise<{ data: UserWithTags[]; total: number; page: number; pageSize: number }> {
    const where: Prisma.UserWhereInput = { userTags: { some: { tagId } } };
    const [total, rows] = await Promise.all([
      db.user.count({ where }),
      db.user.findMany({
        where,
        include: { userTags: { include: { tag: true } } },
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return {
      data: rows.map((u) => {
        const { userTags, ...rest } = u;
        return {
          ...rest,
          tags: userTags.map((ut) => ({
            id: ut.tag.id,
            name: ut.tag.name,
            color: ut.tag.color ?? null,
          })),
        } as UserWithTags;
      }),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  },
};

export type TagRepository = typeof tagRepository;
