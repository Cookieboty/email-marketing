import { describe, expect, it } from "vitest";
import {
  TEMPLATE_LOCALES,
  TemplateFormSchema,
  availableLocales,
  buildCreatePayload,
  buildInitialLocales,
  buildUpdatePayload,
  classifyVariableUsage,
  copyLocaleContent,
  diffLocaleMaps,
  emptyLocaleContent,
  type TemplateFormValues,
  type TemplateRecord,
} from "@/app/(dashboard)/templates/_components/types";

function makeRecord(
  overrides: Partial<TemplateRecord> = {},
): TemplateRecord {
  return {
    id: "tpl_1",
    name: "Welcome",
    defaultLocale: "zh",
    variables: ["user_name"],
    version: 3,
    isArchived: false,
    createdAt: "2026-05-20T00:00:00.000Z",
    updatedAt: "2026-05-20T00:00:00.000Z",
    locales: [
      {
        locale: "zh",
        subject: "你好 {{user_name}}",
        htmlContent: "<p>欢迎</p>",
        textContent: "欢迎",
      },
      {
        locale: "en",
        subject: "Hi {{user_name}}",
        htmlContent: "<p>Welcome</p>",
        textContent: null,
      },
    ],
    ...overrides,
  };
}

function makeFormValues(
  overrides: Partial<TemplateFormValues> = {},
): TemplateFormValues {
  const base: TemplateFormValues = {
    name: "Welcome",
    defaultLocale: "zh",
    locales: {
      zh: {
        subject: "你好 {{user_name}}",
        htmlContent: "<p>欢迎</p>",
        textContent: "欢迎",
      },
      en: {
        subject: "Hi {{user_name}}",
        htmlContent: "<p>Welcome</p>",
        textContent: "",
      },
    },
  };
  return { ...base, ...overrides } as TemplateFormValues;
}

describe("template multilingual constants", () => {
  it("exposes zh and en in fixed order", () => {
    expect(TEMPLATE_LOCALES).toEqual(["zh", "en"]);
  });
});

describe("emptyLocaleContent / buildInitialLocales", () => {
  it("returns blank strings", () => {
    expect(emptyLocaleContent()).toEqual({
      subject: "",
      htmlContent: "",
      textContent: "",
    });
  });

  it("seeds default locale when record is null", () => {
    const map = buildInitialLocales(null);
    expect(Object.keys(map)).toEqual(["zh"]);
    expect(map.zh).toEqual(emptyLocaleContent());
  });

  it("hydrates from record locales and converts null textContent to empty string", () => {
    const map = buildInitialLocales(makeRecord());
    expect(map.zh?.textContent).toBe("欢迎");
    expect(map.en?.textContent).toBe("");
  });
});

describe("availableLocales", () => {
  it("returns ordered locales that have content", () => {
    expect(availableLocales({ en: emptyLocaleContent() })).toEqual(["en"]);
    expect(
      availableLocales({ zh: emptyLocaleContent(), en: emptyLocaleContent() }),
    ).toEqual(["zh", "en"]);
  });
});

describe("TemplateFormSchema", () => {
  it("rejects when default locale has no content", () => {
    const result = TemplateFormSchema.safeParse({
      name: "X",
      defaultLocale: "en",
      locales: {
        zh: {
          subject: "你好",
          htmlContent: "<p>你好</p>",
          textContent: "",
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects when no locale provided", () => {
    const result = TemplateFormSchema.safeParse({
      name: "X",
      defaultLocale: "zh",
      locales: {},
    });
    expect(result.success).toBe(false);
  });

  it("accepts valid multi-locale form", () => {
    const result = TemplateFormSchema.safeParse(makeFormValues());
    expect(result.success).toBe(true);
  });
});

describe("buildCreatePayload", () => {
  it("trims name and drops empty textContent", () => {
    const payload = buildCreatePayload(
      makeFormValues({
        name: "  Welcome  ",
        locales: {
          zh: {
            subject: "  你好  ",
            htmlContent: "<p>欢迎</p>",
            textContent: "   ",
          },
          en: {
            subject: "Hi",
            htmlContent: "<p>Welcome</p>",
            textContent: "Welcome",
          },
        },
      }),
    );
    expect(payload.name).toBe("Welcome");
    expect(payload.defaultLocale).toBe("zh");
    expect(payload.locales.zh).toEqual({
      subject: "你好",
      htmlContent: "<p>欢迎</p>",
    });
    expect(payload.locales.en).toEqual({
      subject: "Hi",
      htmlContent: "<p>Welcome</p>",
      textContent: "Welcome",
    });
  });

  it("omits locales whose key is missing", () => {
    const payload = buildCreatePayload(
      makeFormValues({
        locales: {
          zh: {
            subject: "你好",
            htmlContent: "<p>欢迎</p>",
            textContent: "",
          },
        },
      }),
    );
    expect(Object.keys(payload.locales)).toEqual(["zh"]);
  });
});

describe("diffLocaleMaps", () => {
  it("detects added / changed / removed entries", () => {
    const prev = {
      zh: { subject: "A", htmlContent: "<p>a</p>", textContent: "" },
      en: { subject: "B", htmlContent: "<p>b</p>", textContent: "" },
    };
    const next = {
      zh: { subject: "A2", htmlContent: "<p>a</p>", textContent: "" },
    };
    const { changed, removed } = diffLocaleMaps(prev, next);
    expect(removed).toEqual(["en"]);
    expect(changed.map(([locale]) => locale)).toEqual(["zh"]);
  });

  it("treats undefined and empty textContent as equal", () => {
    const prev = {
      zh: { subject: "A", htmlContent: "<p>a</p>", textContent: "" },
    };
    const next = {
      zh: { subject: "A", htmlContent: "<p>a</p>", textContent: "" },
    };
    expect(diffLocaleMaps(prev, next)).toEqual({ removed: [], changed: [] });
  });
});

describe("buildUpdatePayload", () => {
  it("returns empty payload when nothing changed", () => {
    const record = makeRecord();
    const values = makeFormValues();
    const diff = buildUpdatePayload(record, values);
    expect(diff.payload).toEqual({});
    expect(diff.removedLocales).toEqual([]);
  });

  it("captures name and defaultLocale changes", () => {
    const record = makeRecord();
    const values = makeFormValues({
      name: " Renamed ",
      defaultLocale: "en",
    });
    const diff = buildUpdatePayload(record, values);
    expect(diff.payload.name).toBe("Renamed");
    expect(diff.payload.defaultLocale).toBe("en");
    expect(diff.payload.locales).toBeUndefined();
  });

  it("includes only changed locales in payload and reports removed locales", () => {
    const record = makeRecord();
    const values = makeFormValues({
      locales: {
        zh: {
          subject: "你好",
          htmlContent: "<p>欢迎更新</p>",
          textContent: "欢迎",
        },
      },
    });
    const diff = buildUpdatePayload(record, values);
    expect(diff.payload.locales?.zh?.htmlContent).toBe("<p>欢迎更新</p>");
    expect(diff.payload.locales?.en).toBeUndefined();
    expect(diff.removedLocales).toEqual(["en"]);
  });
});

describe("copyLocaleContent", () => {
  it("clones content fields", () => {
    const source = {
      subject: "Hi",
      htmlContent: "<p>Hello</p>",
      textContent: "Hello",
    };
    const copy = copyLocaleContent(source);
    expect(copy).toEqual(source);
    expect(copy).not.toBe(source);
  });
});

describe("classifyVariableUsage", () => {
  it("returns empty array when no locales provided", () => {
    expect(classifyVariableUsage("zh", {})).toEqual([]);
  });

  it("returns current-only when only the active locale is present", () => {
    const result = classifyVariableUsage("zh", {
      zh: ["user_name", "amount"],
    });
    expect(result.map((u) => u.name)).toEqual(["amount", "user_name"]);
    expect(result.every((u) => u.status === "current-only")).toBe(true);
  });

  it("classifies variables across locales correctly", () => {
    const result = classifyVariableUsage("zh", {
      zh: ["user_name", "amount"],
      en: ["user_name", "discount"],
    });
    const byName = Object.fromEntries(result.map((u) => [u.name, u]));
    expect(byName.user_name?.status).toBe("shared");
    expect(byName.user_name?.presentLocales).toEqual(["zh", "en"]);
    expect(byName.amount?.status).toBe("current-only");
    expect(byName.amount?.presentLocales).toEqual(["zh"]);
    expect(byName.discount?.status).toBe("missing-in-current");
    expect(byName.discount?.presentLocales).toEqual(["en"]);
  });

  it("treats missing active locale entry as no current variables", () => {
    const result = classifyVariableUsage("en", {
      zh: ["user_name"],
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: "user_name",
      status: "missing-in-current",
      presentLocales: ["zh"],
    });
  });
});
