import { describe, expect, it } from "vitest";
import {
  buildCreateAutomationPayload,
  buildUpdateAutomationPayload,
  cleanAutomationSubjects,
  forcedLocaleOptions,
  recordToFormValues,
  subjectInputLocales,
  summarizeSubjects,
  type AutomationFormValues,
  type AutomationRecord,
  type TemplateOption,
} from "@/app/(dashboard)/automations/_components/automation-multilingual-helpers";

function makeTemplate(
  overrides: Partial<TemplateOption> = {},
): TemplateOption {
  return {
    id: "tpl_1",
    name: "Welcome",
    defaultLocale: "zh",
    availableLocales: ["zh", "en"],
    ...overrides,
  };
}

function makeForm(
  overrides: Partial<AutomationFormValues> = {},
): AutomationFormValues {
  return {
    name: "新人欢迎",
    triggerType: "USER_CREATED",
    templateId: "tpl_1",
    subjects: {},
    localeStrategy: "AUTO",
    forcedLocale: "",
    delayMinutes: 0,
    ...overrides,
  };
}

function makeRecord(
  overrides: Partial<AutomationRecord> = {},
): AutomationRecord {
  return {
    id: "auto_1",
    name: "新人欢迎",
    triggerType: "USER_CREATED",
    templateId: "tpl_1",
    subjects: null,
    localeStrategy: "AUTO",
    forcedLocale: null,
    delayMinutes: 0,
    status: "DISABLED",
    triggerConfig: {},
    conditions: null,
    createdAt: "2026-05-20T00:00:00.000Z",
    updatedAt: "2026-05-20T00:00:00.000Z",
    ...overrides,
  };
}

describe("forcedLocaleOptions", () => {
  it("returns canonical full set when no template is provided", () => {
    expect(forcedLocaleOptions(null)).toEqual(["zh", "en"]);
  });

  it("filters by template available locales", () => {
    expect(
      forcedLocaleOptions(makeTemplate({ availableLocales: ["en"] })),
    ).toEqual(["en"]);
  });
});

describe("cleanAutomationSubjects", () => {
  it("trims and drops empty entries", () => {
    expect(
      cleanAutomationSubjects({ zh: "  你好  ", en: "  " }, ["zh", "en"]),
    ).toEqual({ zh: "你好" });
  });

  it("returns undefined when nothing left", () => {
    expect(cleanAutomationSubjects({ zh: "  ", en: "" }, ["zh", "en"])).toBeUndefined();
  });

  it("ignores locales not allowed", () => {
    expect(cleanAutomationSubjects({ zh: "中文", en: "EN" }, ["en"])).toEqual({
      en: "EN",
    });
  });
});

describe("subjectInputLocales", () => {
  it("returns all template locales under AUTO", () => {
    expect(
      subjectInputLocales(
        { templateId: "tpl_1", localeStrategy: "AUTO", forcedLocale: "" },
        makeTemplate(),
      ),
    ).toEqual(["zh", "en"]);
  });

  it("returns only forced locale under FORCE", () => {
    expect(
      subjectInputLocales(
        { templateId: "tpl_1", localeStrategy: "FORCE", forcedLocale: "en" },
        makeTemplate(),
      ),
    ).toEqual(["en"]);
  });

  it("returns canonical locales when no template is selected", () => {
    expect(
      subjectInputLocales(
        { templateId: "", localeStrategy: "AUTO", forcedLocale: "" },
        null,
      ),
    ).toEqual(["zh", "en"]);
  });
});

describe("buildCreateAutomationPayload", () => {
  it("builds AUTO payload with template and subject overrides", () => {
    const result = buildCreateAutomationPayload(
      makeForm({ subjects: { zh: "中文覆盖", en: "  EN override  " } }),
      makeTemplate(),
    );
    expect(result.errors).toEqual([]);
    expect(result.payload).toEqual({
      name: "新人欢迎",
      triggerType: "USER_CREATED",
      triggerConfig: {},
      templateId: "tpl_1",
      localeStrategy: "AUTO",
      delayMinutes: 0,
      subjects: { zh: "中文覆盖", en: "EN override" },
    });
  });

  it("rejects FORCE without forcedLocale", () => {
    const result = buildCreateAutomationPayload(
      makeForm({ localeStrategy: "FORCE" }),
      makeTemplate(),
    );
    expect(result.payload).toBeNull();
    expect(result.errors).toContainEqual({
      field: "forcedLocale",
      message: "强制语言模式需选择目标语言",
    });
  });

  it("rejects FORCE with locale not on template", () => {
    const result = buildCreateAutomationPayload(
      makeForm({ localeStrategy: "FORCE", forcedLocale: "en" }),
      makeTemplate({ availableLocales: ["zh"] }),
    );
    expect(result.payload).toBeNull();
    expect(result.errors).toContainEqual({
      field: "forcedLocale",
      message: "所选语言不在模板可用语言列表中",
    });
  });

  it("FORCE only emits forced locale subject override", () => {
    const result = buildCreateAutomationPayload(
      makeForm({
        localeStrategy: "FORCE",
        forcedLocale: "en",
        subjects: { zh: "中文覆盖", en: "EN" },
      }),
      makeTemplate(),
    );
    expect(result.errors).toEqual([]);
    expect(result.payload?.localeStrategy).toBe("FORCE");
    expect(result.payload?.forcedLocale).toBe("en");
    expect(result.payload?.subjects).toEqual({ en: "EN" });
  });

  it("requires subjects when no template is selected", () => {
    const result = buildCreateAutomationPayload(
      makeForm({ templateId: "", subjects: {} }),
      null,
    );
    expect(result.payload).toBeNull();
    expect(result.errors).toContainEqual({
      field: "subjects",
      message: "未选择模板时至少填写一个语言的主题",
    });
  });

  it("allows subjects-only automation without template", () => {
    const result = buildCreateAutomationPayload(
      makeForm({
        templateId: "",
        subjects: { zh: "你好", en: "Hi" },
      }),
      null,
    );
    expect(result.errors).toEqual([]);
    expect(result.payload).toMatchObject({
      subjects: { zh: "你好", en: "Hi" },
      localeStrategy: "AUTO",
    });
    expect(result.payload).not.toHaveProperty("templateId");
  });

  it("rejects non-integer delayMinutes", () => {
    const result = buildCreateAutomationPayload(
      makeForm({ delayMinutes: 1.5 }),
      makeTemplate(),
    );
    expect(result.payload).toBeNull();
    expect(result.errors).toContainEqual({
      field: "delayMinutes",
      message: "延迟需为 0~525600 的整数分钟",
    });
  });
});

describe("buildUpdateAutomationPayload", () => {
  it("returns no changes when form equals record", () => {
    const record = makeRecord({ subjects: { zh: "你好" } });
    const result = buildUpdateAutomationPayload(
      makeForm({ subjects: { zh: "你好" } }),
      record,
      makeTemplate(),
    );
    expect(result.hasChanges).toBe(false);
    expect(result.payload).toBeNull();
    expect(result.errors).toEqual([]);
  });

  it("only emits changed fields", () => {
    const record = makeRecord({
      name: "原名",
      delayMinutes: 5,
      subjects: { zh: "原" },
    });
    const result = buildUpdateAutomationPayload(
      makeForm({
        name: "新名",
        delayMinutes: 5,
        subjects: { zh: "新主题" },
      }),
      record,
      makeTemplate(),
    );
    expect(result.payload).toEqual({
      name: "新名",
      subjects: { zh: "新主题" },
    });
  });

  it("captures templateId removal as null", () => {
    const record = makeRecord({ templateId: "tpl_1" });
    const result = buildUpdateAutomationPayload(
      makeForm({
        templateId: "",
        subjects: { zh: "新主题" },
      }),
      record,
      null,
    );
    expect(result.payload).toMatchObject({ templateId: null });
  });

  it("propagates validation errors", () => {
    const record = makeRecord();
    const result = buildUpdateAutomationPayload(
      makeForm({ name: "  " }),
      record,
      makeTemplate(),
    );
    expect(result.payload).toBeNull();
    expect(result.errors.some((e) => e.field === "name")).toBe(true);
  });
});

describe("recordToFormValues", () => {
  it("normalizes nullable fields to empty defaults", () => {
    const record = makeRecord({
      templateId: null,
      forcedLocale: null,
      subjects: null,
    });
    expect(recordToFormValues(record)).toEqual({
      name: "新人欢迎",
      triggerType: "USER_CREATED",
      templateId: "",
      forcedLocale: "",
      subjects: {},
      localeStrategy: "AUTO",
      delayMinutes: 0,
    });
  });
});

describe("summarizeSubjects", () => {
  it("returns ordered locale prefix labels", () => {
    expect(summarizeSubjects({ en: "Hi", zh: "你好" })).toBe(
      "[zh] 你好 / [en] Hi",
    );
  });

  it("returns empty string when nothing meaningful", () => {
    expect(summarizeSubjects(null)).toBe("");
    expect(summarizeSubjects({})).toBe("");
    expect(summarizeSubjects({ zh: "  " })).toBe("");
  });
});
