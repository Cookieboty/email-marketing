/**
 * 模板 / 模板片段 zod schema 边界测试。
 *
 * 与 user-tag-schema.test.ts 风格一致：不接 DB，仅校验输入边界。
 */

import { describe, it, expect } from "vitest";
import {
  CreateTemplateSchema,
  UpdateTemplateSchema,
  ListTemplatesQuerySchema,
  PreviewTemplateSchema,
  TestSendSchema,
  HTML_MAX_BYTES,
} from "@/lib/modules/template/schema";
import {
  CreateTemplateBlockSchema,
  UpdateTemplateBlockSchema,
  ListTemplateBlocksQuerySchema,
  BLOCK_HTML_MAX_BYTES,
} from "@/lib/modules/template-block/schema";

describe("CreateTemplateSchema", () => {
  it("accepts minimal valid input", () => {
    const out = CreateTemplateSchema.parse({
      name: "  Welcome  ",
      defaultLocale: "zh",
      locales: {
        zh: {
          subject: "Hi {{user_name}}",
          htmlContent: "<p>Hello</p>",
        },
      },
    });
    expect(out.name).toBe("Welcome");
    expect(out.defaultLocale).toBe("zh");
    expect(out.locales.zh?.subject).toBe("Hi {{user_name}}");
    expect(out.locales.zh?.textContent).toBeUndefined();
  });

  it("rejects empty name", () => {
    expect(() =>
      CreateTemplateSchema.parse({
        name: "   ",
        defaultLocale: "zh",
        locales: { zh: { subject: "s", htmlContent: "<p>x</p>" } },
      }),
    ).toThrow();
  });

  it("rejects htmlContent over 1MB", () => {
    const big = "a".repeat(HTML_MAX_BYTES + 1);
    expect(() =>
      CreateTemplateSchema.parse({
        name: "n",
        defaultLocale: "zh",
        locales: { zh: { subject: "s", htmlContent: big } },
      }),
    ).toThrow(/1MB/);
  });

  it("treats null textContent as undefined", () => {
    const out = CreateTemplateSchema.parse({
      name: "n",
      defaultLocale: "zh",
      locales: {
        zh: {
          subject: "s",
          htmlContent: "<p>x</p>",
          textContent: null,
        },
      },
    });
    expect(out.locales.zh?.textContent).toBeUndefined();
  });

  it("rejects defaultLocale missing from locales", () => {
    expect(() =>
      CreateTemplateSchema.parse({
        name: "n",
        defaultLocale: "en",
        locales: { zh: { subject: "s", htmlContent: "<p>x</p>" } },
      }),
    ).toThrow(/defaultLocale/);
  });

  it("rejects legacy top-level content fields", () => {
    expect(() =>
      CreateTemplateSchema.parse({
        name: "n",
        defaultLocale: "zh",
        locales: { zh: { subject: "s", htmlContent: "<p>x</p>" } },
        subject: "legacy",
      }),
    ).toThrow();
  });
});

describe("UpdateTemplateSchema", () => {
  it("requires at least one field", () => {
    expect(() => UpdateTemplateSchema.parse({})).toThrow(/at least one field/);
  });

  it("rejects unknown fields (strict)", () => {
    expect(() =>
      UpdateTemplateSchema.parse({ name: "n", isArchived: true } as unknown),
    ).toThrow();
  });

  it("accepts a single name update", () => {
    const out = UpdateTemplateSchema.parse({ name: "  Renamed  " });
    expect(out.name).toBe("Renamed");
  });

  it("accepts locale patch with null textContent", () => {
    const out = UpdateTemplateSchema.parse({
      locales: {
        en: {
          subject: "Hello",
          htmlContent: "<p>Hello</p>",
          textContent: null,
        },
      },
    });
    expect(out.locales?.en?.textContent).toBeNull();
  });
});

describe("ListTemplatesQuerySchema", () => {
  it("coerces page/pageSize from string", () => {
    const out = ListTemplatesQuerySchema.parse({ page: "2", pageSize: "20" });
    expect(out.page).toBe(2);
    expect(out.pageSize).toBe(20);
    expect(out.includeArchived).toBe(false);
  });

  it("caps pageSize at 200", () => {
    expect(() => ListTemplatesQuerySchema.parse({ pageSize: "500" })).toThrow();
  });

  it("defaults localeFilter to all and accepts known values", () => {
    expect(ListTemplatesQuerySchema.parse({}).localeFilter).toBe("all");
    for (const v of ["all", "zh", "en", "bilingual", "single"] as const) {
      expect(
        ListTemplatesQuerySchema.parse({ localeFilter: v }).localeFilter,
      ).toBe(v);
    }
  });

  it("rejects unknown localeFilter", () => {
    expect(() =>
      ListTemplatesQuerySchema.parse({ localeFilter: "ja" }),
    ).toThrow();
  });
});

describe("PreviewTemplateSchema", () => {
  it("defaults missingStrategy to empty", () => {
    const out = PreviewTemplateSchema.parse({});
    expect(out.missingStrategy).toBe("empty");
  });

  it("accepts variables map", () => {
    const out = PreviewTemplateSchema.parse({
      htmlContent: "<p>{{x}}</p>",
      variables: { x: "1" },
      missingStrategy: "keep",
    });
    expect(out.variables).toEqual({ x: "1" });
    expect(out.missingStrategy).toBe("keep");
  });
});

describe("TestSendSchema", () => {
  it("requires a valid email", () => {
    expect(() => TestSendSchema.parse({ to: "nope" })).toThrow();
  });

  it("accepts variables", () => {
    const out = TestSendSchema.parse({ to: "qa@example.com", variables: { a: "b" } });
    expect(out.to).toBe("qa@example.com");
    expect(out.variables).toEqual({ a: "b" });
  });
});

describe("CreateTemplateBlockSchema", () => {
  it("accepts null category", () => {
    const out = CreateTemplateBlockSchema.parse({
      name: "Footer",
      category: null,
      locale: "en",
      htmlContent: "<footer>x</footer>",
    });
    expect(out.category).toBeNull();
    expect(out.locale).toBe("en");
  });

  it("defaults block locale to zh", () => {
    const out = CreateTemplateBlockSchema.parse({
      name: "Footer",
      htmlContent: "<footer>x</footer>",
    });
    expect(out.locale).toBe("zh");
  });

  it("rejects empty htmlContent", () => {
    expect(() =>
      CreateTemplateBlockSchema.parse({ name: "n", htmlContent: "" }),
    ).toThrow();
  });

  it("rejects htmlContent over 256KB", () => {
    const big = "a".repeat(BLOCK_HTML_MAX_BYTES + 1);
    expect(() =>
      CreateTemplateBlockSchema.parse({ name: "n", htmlContent: big }),
    ).toThrow(/256KB/);
  });
});

describe("UpdateTemplateBlockSchema", () => {
  it("requires at least one field", () => {
    expect(() => UpdateTemplateBlockSchema.parse({})).toThrow(/at least one field/);
  });

  it("rejects unknown fields", () => {
    expect(() =>
      UpdateTemplateBlockSchema.parse({ isSystem: true } as unknown),
    ).toThrow();
  });

  it("accepts locale update", () => {
    const out = UpdateTemplateBlockSchema.parse({ locale: "en" });
    expect(out.locale).toBe("en");
  });
});

describe("ListTemplateBlocksQuerySchema", () => {
  it("defaults page/pageSize", () => {
    const out = ListTemplateBlocksQuerySchema.parse({});
    expect(out.page).toBe(1);
    expect(out.pageSize).toBe(50);
  });

  it("accepts locale filter", () => {
    const out = ListTemplateBlocksQuerySchema.parse({ locale: "en" });
    expect(out.locale).toBe("en");
  });
});
