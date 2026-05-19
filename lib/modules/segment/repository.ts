/**
 * 分群数据访问层。
 *
 * 职责：
 *  - Segment CRUD（条件树以 Json 存储）
 *  - 用条件编译器把树编译成 UserWhereInput，再委托 prisma.user.count/findMany
 *  - 不写审计日志；service 层负责
 *
 * 备注：
 *  - schema 中 Segment.name 没有 @unique 约束，但产品层面期望唯一；这里在 list/findByName
 *    用普通 findFirst，service 层在 create/update 时显式查询冲突并抛 ConflictError。
 */

import type { Prisma, Segment, User } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { PrismaTx } from "../user/repository";
import {
  compileSegmentCondition,
  type CompileOptions,
} from "./compiler";
import {
  parseSegmentCondition,
  type SegmentCondition,
} from "./conditions";
import type { ListSegmentsQuery } from "./schema";

export interface ListSegmentsResult {
  data: Segment[];
  total: number;
  page: number;
  pageSize: number;
}

export interface SegmentPreviewResult {
  total: number;
  users: Pick<User, "id" | "email" | "name" | "userLevel" | "createdAt">[];
}

/**
 * 把 DB 中 Json 字段反序列化为 SegmentCondition。
 * 写入路径已经做过 schema 校验，因此这里 parse 主要起到「重启进程后再校验一次」的防御作用。
 */
export function parseStoredConditions(raw: Prisma.JsonValue): SegmentCondition {
  return parseSegmentCondition(raw);
}

export const segmentRepository = {
  async list(query: ListSegmentsQuery, db: PrismaTx = prisma): Promise<ListSegmentsResult> {
    const where: Prisma.SegmentWhereInput = query.q
      ? { name: { contains: query.q, mode: "insensitive" } }
      : {};
    const [total, data] = await Promise.all([
      db.segment.count({ where }),
      db.segment.findMany({
        where,
        orderBy: [{ isSystem: "desc" }, { name: "asc" }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return { data, total, page: query.page, pageSize: query.pageSize };
  },

  findById(id: string, db: PrismaTx = prisma): Promise<Segment | null> {
    return db.segment.findUnique({ where: { id } });
  },

  findByName(name: string, db: PrismaTx = prisma): Promise<Segment | null> {
    return db.segment.findFirst({ where: { name } });
  },

  create(data: Prisma.SegmentUncheckedCreateInput, db: PrismaTx = prisma): Promise<Segment> {
    return db.segment.create({ data });
  },

  update(
    id: string,
    data: Prisma.SegmentUncheckedUpdateInput,
    db: PrismaTx = prisma,
  ): Promise<Segment> {
    return db.segment.update({ where: { id }, data });
  },

  async delete(id: string, db: PrismaTx = prisma): Promise<void> {
    await db.segment.delete({ where: { id } });
  },

  /**
   * 计算给定条件树命中的用户数。
   *
   * 注意：这里不会自动叠加「unsubscribed=false」等隐式发件规则，
   * 因为分群本身的语义是「条件成立的用户集合」；发送阶段会在外面再 AND 一层
   * 隐式过滤（详见 specs/modules/segmentation-engine.md §发送时过滤）。
   */
  countMatching(
    condition: SegmentCondition,
    options: CompileOptions = {},
    db: PrismaTx = prisma,
  ): Promise<number> {
    const where = compileSegmentCondition(condition, options);
    return db.user.count({ where });
  },

  /**
   * 预览前 N 个命中用户，按 createdAt 降序，便于前端「条件树构建器」实时反馈。
   */
  async previewMatching(
    condition: SegmentCondition,
    limit: number,
    options: CompileOptions = {},
    db: PrismaTx = prisma,
  ): Promise<SegmentPreviewResult> {
    const where = compileSegmentCondition(condition, options);
    const [total, users] = await Promise.all([
      db.user.count({ where }),
      db.user.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        select: {
          id: true,
          email: true,
          name: true,
          userLevel: true,
          createdAt: true,
        },
      }),
    ]);
    return { total, users };
  },
};

export type SegmentRepository = typeof segmentRepository;
