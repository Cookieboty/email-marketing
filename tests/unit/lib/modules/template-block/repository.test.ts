/**
 * 模板片段 repository.findManyByPairs 单元测试。
 *
 * 不接 DB：通过 PrismaTx 注入 mock 客户端，验证：
 *   - 多对 (locale,name) 拼装为 OR 查询并透传
 *   - pairs 为空时短路返回 [] 且不调用 Prisma
 *   - 重复 pair 去重（避免 SQL OR 列表膨胀）
 *   - select 字段限定为 id/name/locale/htmlContent/updatedAt
 *   - 不存在的 pair 不出现在结果中（不抛错）
 */

import { describe, expect, it, vi } from "vitest";

import { templateBlockRepository } from "@/lib/modules/template-block/repository";
import type { PrismaTx } from "@/lib/modules/user/repository";

function makeDb(rows: unknown[]) {
  const findMany = vi.fn((_args: unknown) => Promise.resolve(rows));
  const db = { templateBlock: { findMany } } as unknown as PrismaTx;
  return { db, findMany };
}

describe("templateBlockRepository.findManyByPairs", () => {
  it("returns empty array and skips Prisma call when pairs is empty", async () => {
    const { db, findMany } = makeDb([]);
    const out = await templateBlockRepository.findManyByPairs([], db);
    expect(out).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("builds OR clause from (locale,name) pairs and selects only ref fields", async () => {
    const rows = [
      {
        id: "b1",
        name: "footer",
        locale: "zh",
        htmlContent: "<p>zh</p>",
        updatedAt: new Date(),
      },
      {
        id: "b2",
        name: "footer",
        locale: "en",
        htmlContent: "<p>en</p>",
        updatedAt: new Date(),
      },
    ];
    const { db, findMany } = makeDb(rows);
    const out = await templateBlockRepository.findManyByPairs(
      [
        { locale: "zh" as const, name: "footer" },
        { locale: "en" as const, name: "footer" },
      ],
      db,
    );
    expect(findMany).toHaveBeenCalledTimes(1);
    const args = findMany.mock.calls[0]![0] as {
      where: { OR: Array<{ locale: string; name: string }> };
      select: Record<string, true>;
    };
    expect(args.where.OR).toEqual([
      { locale: "zh", name: "footer" },
      { locale: "en", name: "footer" },
    ]);
    expect(args.select).toEqual({
      id: true,
      name: true,
      locale: true,
      htmlContent: true,
      updatedAt: true,
    });
    expect(out).toBe(rows);
  });

  it("dedupes duplicate pairs before issuing the query", async () => {
    const { db, findMany } = makeDb([]);
    await templateBlockRepository.findManyByPairs(
      [
        { locale: "zh" as const, name: "footer" },
        { locale: "zh" as const, name: "footer" },
        { locale: "en" as const, name: "footer" },
      ],
      db,
    );
    const args = findMany.mock.calls[0]![0] as {
      where: { OR: Array<unknown> };
    };
    expect(args.where.OR).toHaveLength(2);
  });

  it("returns whatever Prisma yields; missing pairs simply do not appear", async () => {
    // 调用方请求两对，但 DB 里只有一条；不抛错，缺失校验由 service 负责。
    const rows = [
      {
        id: "b1",
        name: "footer",
        locale: "zh",
        htmlContent: "<p>zh</p>",
        updatedAt: new Date(),
      },
    ];
    const { db } = makeDb(rows);
    const out = await templateBlockRepository.findManyByPairs(
      [
        { locale: "zh" as const, name: "footer" },
        { locale: "en" as const, name: "footer" },
      ],
      db,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.locale).toBe("zh");
  });
});
