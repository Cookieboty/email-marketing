/**
 * templateRepository.list 的 where 构造单测。
 *
 * 不连真实 DB：注入伪 PrismaTx，断言 count/findMany 被正确传入 where 与分页参数。
 */

import { describe, expect, it, vi } from "vitest";
import { templateRepository } from "@/lib/modules/template/repository";
import { ListTemplatesQuerySchema } from "@/lib/modules/template/schema";

function makeDb() {
  const count = vi.fn(async (_args: { where: Record<string, unknown> }) => 0);
  const findMany = vi.fn(
    async (_args: {
      where: Record<string, unknown>;
      skip?: number;
      take?: number;
      orderBy?: unknown;
      include?: unknown;
    }) => [] as unknown[],
  );
  return {
    db: { emailTemplate: { count, findMany } } as unknown as Parameters<
      typeof templateRepository.list
    >[1],
    count,
    findMany,
  };
}

function parse(query: Record<string, unknown>) {
  return ListTemplatesQuerySchema.parse(query);
}

describe("templateRepository.list where construction", () => {
  it("filters out archived by default and applies q via case-insensitive contains", async () => {
    const { db, count, findMany } = makeDb();
    await templateRepository.list(parse({ q: "wel" }), db);
    const where = findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({
      isArchived: false,
      name: { contains: "wel", mode: "insensitive" },
    });
    expect(count).toHaveBeenCalledWith({ where });
  });

  it("includes archived when includeArchived=true", async () => {
    const { db, findMany } = makeDb();
    await templateRepository.list(parse({ includeArchived: "true" }), db);
    const where = findMany.mock.calls[0][0].where;
    expect("isArchived" in where).toBe(false);
  });

  it("localeFilter=zh adds some locale=zh", async () => {
    const { db, findMany } = makeDb();
    await templateRepository.list(parse({ localeFilter: "zh" }), db);
    const where = findMany.mock.calls[0][0].where;
    expect(where.locales).toEqual({ some: { locale: "zh" } });
  });

  it("localeFilter=en adds some locale=en", async () => {
    const { db, findMany } = makeDb();
    await templateRepository.list(parse({ localeFilter: "en" }), db);
    const where = findMany.mock.calls[0][0].where;
    expect(where.locales).toEqual({ some: { locale: "en" } });
  });

  it("localeFilter=bilingual requires both zh and en", async () => {
    const { db, findMany } = makeDb();
    await templateRepository.list(parse({ localeFilter: "bilingual" }), db);
    const where = findMany.mock.calls[0][0].where;
    expect(where.AND).toEqual([
      { locales: { some: { locale: "zh" } } },
      { locales: { some: { locale: "en" } } },
    ]);
  });

  it("localeFilter=single matches templates with exactly one locale", async () => {
    const { db, findMany } = makeDb();
    await templateRepository.list(parse({ localeFilter: "single" }), db);
    const where = findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([
      {
        AND: [
          { locales: { some: { locale: "zh" } } },
          { locales: { none: { locale: "en" } } },
        ],
      },
      {
        AND: [
          { locales: { some: { locale: "en" } } },
          { locales: { none: { locale: "zh" } } },
        ],
      },
    ]);
  });

  it("localeFilter=all (default) does not add locale where", async () => {
    const { db, findMany } = makeDb();
    await templateRepository.list(parse({}), db);
    const where = findMany.mock.calls[0][0].where;
    expect("locales" in where).toBe(false);
    expect("OR" in where).toBe(false);
    expect("AND" in where).toBe(false);
  });

  it("applies pagination skip/take and orderBy updatedAt desc", async () => {
    const { db, findMany } = makeDb();
    await templateRepository.list(parse({ page: "3", pageSize: "20" }), db);
    const arg = findMany.mock.calls[0][0];
    expect(arg.skip).toBe(40);
    expect(arg.take).toBe(20);
    expect(arg.orderBy).toEqual({ updatedAt: "desc" });
    expect(arg.include).toEqual({ locales: true });
  });
});
