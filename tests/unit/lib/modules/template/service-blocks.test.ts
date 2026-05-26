/**
 * 模板服务层片段相关 helper 单测（14.5）。
 *
 * 不接 DB：mock templateBlockRepository.findManyByPairs，验证：
 *   - collectBlockRefsPerLocale 仅扫描顶层、按 locale 聚合、去重
 *   - loadBlocksByPairs 把按 locale 聚合的 refs 拍扁成 pairs 后调仓储
 *   - 仓储返回的行被分组回 Record<Locale, Record<name, html>>
 *   - 空 refs 直接短路、不调仓储
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/modules/template-block/repository", () => ({
  templateBlockRepository: {
    findManyByPairs: vi.fn(),
  },
}));

import { templateBlockRepository } from "@/lib/modules/template-block/repository";
import {
  buildPreviewResolver,
  collectBlockRefsPerLocale,
  freezeBlocksForSnapshot,
  loadBlocksByPairs,
} from "@/lib/modules/template/service";

const findManyByPairs = templateBlockRepository.findManyByPairs as unknown as ReturnType<
  typeof vi.fn
>;

describe("collectBlockRefsPerLocale", () => {
  it("collects top-level refs per locale and dedupes within a locale", () => {
    const out = collectBlockRefsPerLocale([
      {
        locale: "zh",
        subject: "你好 {{> footer}}",
        htmlContent: "<p>{{> footer}} {{> header}}</p>",
        textContent: null,
      },
      {
        locale: "en",
        subject: "Hi",
        htmlContent: "<p>{{> footer}}</p>",
        textContent: "{{> footer}}",
      },
    ]);
    expect(out.zh?.sort()).toEqual(["footer", "header"]);
    expect(out.en).toEqual(["footer"]);
  });

  it("omits a locale when no refs are present", () => {
    const out = collectBlockRefsPerLocale([
      {
        locale: "zh",
        subject: "纯文本",
        htmlContent: "<p>plain</p>",
        textContent: null,
      },
    ]);
    expect(out.zh).toBeUndefined();
  });
});

describe("loadBlocksByPairs", () => {
  it("returns empty object and skips repo call when no refs", async () => {
    findManyByPairs.mockReset();
    const out = await loadBlocksByPairs({});
    expect(out).toEqual({});
    expect(findManyByPairs).not.toHaveBeenCalled();
  });

  it("flattens refs to pairs, groups results back per locale", async () => {
    findManyByPairs.mockReset();
    findManyByPairs.mockResolvedValueOnce([
      { id: "1", name: "footer", locale: "zh", htmlContent: "<small>zh</small>", updatedAt: new Date() },
      { id: "2", name: "header", locale: "zh", htmlContent: "<h1>zh</h1>", updatedAt: new Date() },
      { id: "3", name: "footer", locale: "en", htmlContent: "<small>en</small>", updatedAt: new Date() },
    ]);
    const out = await loadBlocksByPairs({
      zh: ["footer", "header"],
      en: ["footer"],
    });
    expect(findManyByPairs).toHaveBeenCalledTimes(1);
    const pairs = findManyByPairs.mock.calls[0]![0] as Array<{ locale: string; name: string }>;
    expect(pairs.sort((a, b) => `${a.locale}${a.name}`.localeCompare(`${b.locale}${b.name}`))).toEqual([
      { locale: "en", name: "footer" },
      { locale: "zh", name: "footer" },
      { locale: "zh", name: "header" },
    ]);
    expect(out).toEqual({
      zh: { footer: "<small>zh</small>", header: "<h1>zh</h1>" },
      en: { footer: "<small>en</small>" },
    });
  });

  it("missing pairs simply do not show up in the grouped result", async () => {
    findManyByPairs.mockReset();
    findManyByPairs.mockResolvedValueOnce([
      { id: "1", name: "footer", locale: "zh", htmlContent: "<small>zh</small>", updatedAt: new Date() },
    ]);
    const out = await loadBlocksByPairs({ zh: ["footer", "missing"] });
    expect(out).toEqual({ zh: { footer: "<small>zh</small>" } });
  });
});

describe("buildPreviewResolver (14.7)", () => {
  it("returns an empty resolver and skips repo call when refs are empty", async () => {
    findManyByPairs.mockReset();
    const r = await buildPreviewResolver("zh", []);
    expect(r.get("anything")).toBeNull();
    expect(findManyByPairs).not.toHaveBeenCalled();
  });

  it("only fetches the requested locale and resolves names case-sensitively", async () => {
    findManyByPairs.mockReset();
    findManyByPairs.mockResolvedValueOnce([
      { id: "1", name: "footer", locale: "zh", htmlContent: "<small>zh</small>", updatedAt: new Date() },
    ]);
    const r = await buildPreviewResolver("zh", ["footer"]);
    expect(r.get("footer")).toBe("<small>zh</small>");
    // missing name returns null (triggers `missing` strategy in expandBlocks)
    expect(r.get("Footer")).toBeNull();
    expect(r.get("ghost")).toBeNull();
    const pairs = findManyByPairs.mock.calls[0]![0] as Array<{ locale: string; name: string }>;
    expect(pairs).toEqual([{ locale: "zh", name: "footer" }]);
  });

  it("treats not-found names as resolver miss (not as empty string)", async () => {
    findManyByPairs.mockReset();
    findManyByPairs.mockResolvedValueOnce([]);
    const r = await buildPreviewResolver("en", ["ghost"]);
    // Important: resolver returns null for unknown so callers can choose
    // 'keep'/'throw'/'empty' strategy in expandBlocks.
    expect(r.get("ghost")).toBeNull();
  });
});

describe("freezeBlocksForSnapshot (14.8/14.9)", () => {
  it("returns blocks per locale grouped by repo result for use in snapshot", async () => {
    findManyByPairs.mockReset();
    findManyByPairs.mockResolvedValueOnce([
      { id: "1", name: "footer", locale: "zh", htmlContent: "<small>zh</small>", updatedAt: new Date() },
      { id: "2", name: "header", locale: "zh", htmlContent: "<h1>zh</h1>", updatedAt: new Date() },
      { id: "3", name: "footer", locale: "en", htmlContent: "<small>en</small>", updatedAt: new Date() },
    ]);
    const blocks = await freezeBlocksForSnapshot({
      locales: [
        {
          locale: "zh",
          subject: "你好 {{> footer}}",
          htmlContent: "<p>{{> header}}</p>",
          textContent: null,
        },
        {
          locale: "en",
          subject: "Hi",
          htmlContent: "<p>{{> footer}}</p>",
          textContent: null,
        },
      ],
    });
    expect(blocks).toEqual({
      zh: { footer: "<small>zh</small>", header: "<h1>zh</h1>" },
      en: { footer: "<small>en</small>" },
    });
  });

  it("throws ValidationError listing missing names per locale (14.9 missing rejection)", async () => {
    findManyByPairs.mockReset();
    findManyByPairs.mockResolvedValueOnce([
      { id: "1", name: "footer", locale: "zh", htmlContent: "<small>zh</small>", updatedAt: new Date() },
    ]);
    await expect(
      freezeBlocksForSnapshot({
        locales: [
          {
            locale: "zh",
            subject: "你好 {{> footer}}",
            htmlContent: "<p>{{> header}}</p>",
            textContent: null,
          },
        ],
      }),
    ).rejects.toThrow(/Missing blocks for locale=zh.*header/);
  });

  it("returns empty per-locale buckets and skips repo when no refs at all", async () => {
    findManyByPairs.mockReset();
    const blocks = await freezeBlocksForSnapshot({
      locales: [
        {
          locale: "zh",
          subject: "纯标题",
          htmlContent: "<p>plain</p>",
          textContent: null,
        },
      ],
    });
    expect(blocks).toEqual({});
    expect(findManyByPairs).not.toHaveBeenCalled();
  });

  it("snapshot drift safety: a later repo change cannot retroactively alter the returned bytes", async () => {
    // 调用①：取到的是 v1
    findManyByPairs.mockReset();
    findManyByPairs.mockResolvedValueOnce([
      { id: "1", name: "footer", locale: "zh", htmlContent: "<small>v1</small>", updatedAt: new Date() },
    ]);
    const frozen = await freezeBlocksForSnapshot({
      locales: [
        { locale: "zh", subject: "{{> footer}}", htmlContent: "<p>x</p>", textContent: null },
      ],
    });
    // 调用②：仓储改成了 v2（模拟 admin 编辑），但已冻结的 frozen 引用必须保持 v1
    findManyByPairs.mockResolvedValueOnce([
      { id: "1", name: "footer", locale: "zh", htmlContent: "<small>v2</small>", updatedAt: new Date() },
    ]);
    await freezeBlocksForSnapshot({
      locales: [
        { locale: "zh", subject: "{{> footer}}", htmlContent: "<p>x</p>", textContent: null },
      ],
    });
    expect(frozen).toEqual({ zh: { footer: "<small>v1</small>" } });
  });
});
