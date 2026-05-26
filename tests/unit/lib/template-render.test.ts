import { describe, expect, it } from "vitest";
import { renderSnapshotContent, resolveLocale } from "@/lib/modules/template/render";
import type { TemplateSnapshot } from "@/lib/modules/template/snapshot";
import { BlockExpansionError, type BlockResolver } from "@/lib/template-engine";

describe("resolveLocale", () => {
  it("uses the user locale when AUTO and the template has that locale", () => {
    expect(resolveLocale({
      strategy: "AUTO",
      forcedLocale: null,
      userLocale: "en",
      defaultLocale: "zh",
      availableLocales: ["zh", "en"],
    })).toBe("en");
  });

  it("uses the default locale when AUTO and user locale is missing", () => {
    expect(resolveLocale({
      strategy: "AUTO",
      forcedLocale: null,
      userLocale: null,
      defaultLocale: "zh",
      availableLocales: ["zh", "en"],
    })).toBe("zh");
  });

  it("falls back to default locale when AUTO user locale content is missing", () => {
    expect(resolveLocale({
      strategy: "AUTO",
      forcedLocale: null,
      userLocale: "en",
      defaultLocale: "zh",
      availableLocales: ["zh"],
    })).toBe("zh");
  });

  it("uses forced locale when FORCE and content exists", () => {
    expect(resolveLocale({
      strategy: "FORCE",
      forcedLocale: "en",
      userLocale: "zh",
      defaultLocale: "zh",
      availableLocales: ["zh", "en"],
    })).toBe("en");
  });

  it("fails when FORCE has no forced locale", () => {
    expect(() => resolveLocale({
      strategy: "FORCE",
      forcedLocale: null,
      userLocale: "zh",
      defaultLocale: "zh",
      availableLocales: ["zh", "en"],
    })).toThrow(/MissingLocaleContent/);
  });

  it("fails when the default locale content is missing", () => {
    expect(() => resolveLocale({
      strategy: "AUTO",
      forcedLocale: null,
      userLocale: "en",
      defaultLocale: "zh",
      availableLocales: [],
    })).toThrow(/MissingLocaleContent/);
  });
});

const snapshot: TemplateSnapshot = {
  version: 1,
  defaultLocale: "zh",
  variables: ["name", "unsubscribe_link"],
  locales: {
    zh: {
      subject: "你好 {{name}}",
      htmlContent: "<p>你好 {{name}} {{unsubscribe_link}}</p>",
      textContent: "你好 {{name}}",
    },
    en: {
      subject: "Hello {{name}}",
      htmlContent: "<p>Hello {{name}} {{unsubscribe_link}}</p>",
      textContent: null,
    },
  },
};

describe("renderSnapshotContent", () => {
  it("renders the resolved locale content with localized builtins", () => {
    const out = renderSnapshotContent({
      snapshot,
      resolvedLocale: "en",
      variables: { name: "Alice" },
      builtin: { unsubscribeUrl: "https://example.com/u" },
    });

    expect(out.locale).toBe("en");
    expect(out.subject).toBe("Hello Alice");
    expect(out.html).toContain("Hello Alice");
    expect(out.html).toContain(">Unsubscribe</a>");
    expect(out.text).toBeUndefined();
  });

  it("falls back to the default locale when resolved content is missing", () => {
    const zhOnly: TemplateSnapshot = {
      ...snapshot,
      locales: { zh: snapshot.locales.zh },
    };

    const out = renderSnapshotContent({
      snapshot: zhOnly,
      resolvedLocale: "en",
      variables: { name: "小明" },
      builtin: { unsubscribeUrl: "https://example.com/u" },
    });

    expect(out.locale).toBe("zh");
    expect(out.subject).toBe("你好 小明");
    expect(out.html).toContain(">退订</a>");
  });

  it("uses non-empty subject override for the selected locale", () => {
    const out = renderSnapshotContent({
      snapshot,
      resolvedLocale: "en",
      subjects: { en: "Special {{name}}", zh: "" },
      variables: { name: "Alice" },
      builtin: {},
    });

    expect(out.subject).toBe("Special Alice");
  });

  it("uses variant content when the variant has the selected locale", () => {
    const out = renderSnapshotContent({
      snapshot,
      resolvedLocale: "en",
      variant: {
        subjects: { en: "Variant {{name}}" },
        htmlContents: { en: "<p>Variant body {{name}}</p>" },
        textContents: { en: "Variant text {{name}}" },
      },
      variables: { name: "Alice" },
      builtin: {},
    });

    expect(out.subject).toBe("Variant Alice");
    expect(out.html).toBe("<p>Variant body Alice</p>");
    expect(out.text).toBe("Variant text Alice");
  });

  it("falls back to base template content when variant misses the selected locale", () => {
    const out = renderSnapshotContent({
      snapshot,
      resolvedLocale: "en",
      variant: {
        subjects: { zh: "變體 {{name}}" },
        htmlContents: { zh: "<p>變體</p>" },
      },
      variables: { name: "Alice" },
      builtin: {},
    });

    expect(out.subject).toBe("Hello Alice");
    expect(out.html).toContain("Hello Alice");
  });

  it("falls back to base template when variant subject is missing for the locale", () => {
    const out = renderSnapshotContent({
      snapshot,
      resolvedLocale: "en",
      variant: {
        // 故意制造 html 有 en 但 subject 没有 en：spec §239 要求两者都齐才算
        // variant 提供该 locale；否则回退主模板，不允许空 subject 邮件溢出。
        subjects: { zh: "變體 {{name}}" },
        htmlContents: { en: "<p>Half variant {{name}}</p>" },
      },
      variables: { name: "Alice" },
      builtin: {},
    });

    expect(out.subject).toBe("Hello Alice");
    expect(out.html).toContain("Hello Alice");
  });

  it("localizes topic unsubscribe link text for English content", () => {
    const topicSnapshot: TemplateSnapshot = {
      ...snapshot,
      locales: {
        en: {
          subject: "Topic",
          htmlContent: "{{unsubscribe_topic_link}}",
          textContent: null,
        },
      },
    };

    const out = renderSnapshotContent({
      snapshot: topicSnapshot,
      resolvedLocale: "en",
      variables: {},
      builtin: { unsubscribeTopicUrl: "https://example.com/u?topic=weekly" },
    });

    expect(out.html).toContain(">Unsubscribe from this topic</a>");
  });
});

describe("renderSnapshotContent: block expansion", () => {
  const withBlocks: TemplateSnapshot = {
    version: 1,
    defaultLocale: "zh",
    variables: ["name"],
    locales: {
      zh: {
        subject: "你好 {{name}}",
        htmlContent: "<main>{{name}} {{> footer}}</main>",
        textContent: "你好 {{name}} {{> footer}}",
      },
    },
  };

  const resolver = (map: Record<string, string>): BlockResolver => ({
    get: (n) => (Object.prototype.hasOwnProperty.call(map, n) ? map[n]! : null),
  });

  it("zero-overhead path: no resolver leaves block markers untouched in stage 1, vars still render", () => {
    // 不传 blocks resolver：subject 没有引用，html 中 `{{> footer}}` 直接当字面量进入
    // render，因 VAR_RE 是 `{{(\w+)}}`，不会误匹配 `{{> footer}}`，故按字面量保留。
    const out = renderSnapshotContent({
      snapshot: withBlocks,
      resolvedLocale: "zh",
      variables: { name: "Alice" },
      builtin: {},
    });
    expect(out.html).toBe("<main>Alice {{> footer}}</main>");
    expect(out.text).toBe("你好 Alice {{> footer}}");
  });

  it("expands block then renders variables (depth-first across both stages)", () => {
    const out = renderSnapshotContent({
      snapshot: withBlocks,
      resolvedLocale: "zh",
      variables: { name: "Alice" },
      builtin: {},
      blocks: resolver({ footer: "<small>{{name}} bye</small>" }),
    });
    // 1) Stage1: footer 插回 HTML：<main>{{name}} <small>{{name}} bye</small></main>
    // 2) Stage2: 变量 name=Alice 替换两处
    expect(out.html).toBe("<main>Alice <small>Alice bye</small></main>");
  });

  it("propagates BlockExpansionError(CYCLE) when resolver yields a self-reference", () => {
    expect(() =>
      renderSnapshotContent({
        snapshot: withBlocks,
        resolvedLocale: "zh",
        variables: { name: "Alice" },
        builtin: {},
        blocks: resolver({ footer: "{{> footer}}" }),
      }),
    ).toThrow(BlockExpansionError);
  });

  it("missingBlock='throw' surfaces missing block as BlockExpansionError", () => {
    expect(() =>
      renderSnapshotContent({
        snapshot: withBlocks,
        resolvedLocale: "zh",
        variables: { name: "Alice" },
        builtin: {},
        blocks: resolver({}), // 没有 footer
        missingBlock: "throw",
      }),
    ).toThrow(BlockExpansionError);
  });

  it("missingBlock='keep' preserves the unresolved ref through stage 2", () => {
    const out = renderSnapshotContent({
      snapshot: withBlocks,
      resolvedLocale: "zh",
      variables: { name: "Alice" },
      builtin: {},
      blocks: resolver({}),
      missingBlock: "keep",
    });
    expect(out.html).toBe("<main>Alice {{> footer}}</main>");
  });
});
