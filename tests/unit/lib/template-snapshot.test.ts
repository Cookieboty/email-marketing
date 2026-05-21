import { describe, expect, it } from "vitest";
import {
  applySubjectOverrides,
  assertSnapshotHasDefaultLocale,
  buildTemplateSnapshot,
  snapshotToTemplateForTestSend,
  type TemplateSnapshot,
} from "@/lib/modules/template/snapshot";

describe("template snapshot helpers", () => {
  it("builds a multilingual snapshot from template locale rows", () => {
    const snapshot = buildTemplateSnapshot({
      version: 3,
      defaultLocale: "zh",
      variables: ["name", "unsubscribe_link"],
      locales: [
        {
          locale: "zh",
          subject: "你好 {{name}}",
          htmlContent: "<p>你好</p>",
          textContent: null,
        },
        {
          locale: "en",
          subject: "Hello {{name}}",
          htmlContent: "<p>Hello</p>",
          textContent: "Hello",
        },
      ],
    });

    expect(snapshot).toEqual({
      version: 3,
      defaultLocale: "zh",
      variables: ["name", "unsubscribe_link"],
      locales: {
        zh: {
          subject: "你好 {{name}}",
          htmlContent: "<p>你好</p>",
          textContent: null,
        },
        en: {
          subject: "Hello {{name}}",
          htmlContent: "<p>Hello</p>",
          textContent: "Hello",
        },
      },
    });
  });

  it("fails when the default locale has no content", () => {
    const snapshot = {
      version: 1,
      defaultLocale: "en" as const,
      variables: [],
      locales: {
        zh: {
          subject: "你好",
          htmlContent: "<p>你好</p>",
          textContent: null,
        },
      },
    };

    expect(() => assertSnapshotHasDefaultLocale(snapshot)).toThrow(
      /MissingLocaleContent/,
    );
  });

  describe("applySubjectOverrides", () => {
    const base: TemplateSnapshot = {
      version: 2,
      defaultLocale: "zh",
      variables: [],
      locales: {
        zh: { subject: "原标题", htmlContent: "<p>zh</p>", textContent: null },
        en: { subject: "Original", htmlContent: "<p>en</p>", textContent: null },
      },
    };

    it("returns the snapshot unchanged when overrides is nullish", () => {
      expect(applySubjectOverrides(base, undefined)).toBe(base);
      expect(applySubjectOverrides(base, null)).toBe(base);
    });

    it("applies non-empty overrides and ignores blank / missing locales", () => {
      const out = applySubjectOverrides(base, { zh: "  新标题  ", en: "" });
      expect(out.locales.zh?.subject).toBe("新标题");
      expect(out.locales.en?.subject).toBe("Original");
      expect(out).not.toBe(base);
      expect(base.locales.zh?.subject).toBe("原标题");
    });

    it("does not introduce locales that are not in the snapshot", () => {
      const zhOnly: TemplateSnapshot = {
        ...base,
        locales: { zh: base.locales.zh },
      };
      const out = applySubjectOverrides(zhOnly, { zh: "新", en: "Ignored" });
      expect(Object.keys(out.locales)).toEqual(["zh"]);
      expect(out.locales.en).toBeUndefined();
    });
  });

  describe("snapshotToTemplateForTestSend", () => {
    it("rebuilds a template-shape from a snapshot for test-send reuse", () => {
      const snapshot: TemplateSnapshot = {
        version: 7,
        defaultLocale: "en",
        variables: ["name"],
        locales: {
          en: { subject: "Hi", htmlContent: "<p>Hi</p>", textContent: null },
          zh: { subject: "你好", htmlContent: "<p>你好</p>", textContent: "你好" },
        },
      };
      const tpl = snapshotToTemplateForTestSend(snapshot, {
        id: "tpl_1",
        name: "Greeting",
      });
      expect(tpl).toEqual({
        id: "tpl_1",
        name: "Greeting",
        version: 7,
        defaultLocale: "en",
        variables: ["name"],
        locales: [
          { locale: "en", subject: "Hi", htmlContent: "<p>Hi</p>", textContent: null },
          { locale: "zh", subject: "你好", htmlContent: "<p>你好</p>", textContent: "你好" },
        ],
      });
    });
  });
});
