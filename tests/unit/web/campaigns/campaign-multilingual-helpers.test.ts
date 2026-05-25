import { describe, expect, it } from "vitest";
import {
  buildCampaignPayload,
  cleanSubjects,
  cleanVariantLocales,
  forcedLocaleOptions,
  summarizeCoverageWarnings,
  type CampaignFormState,
  type TemplateOption,
} from "@/app/(dashboard)/campaigns/new/_components/campaign-multilingual-helpers";

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

function makeForm(overrides: Partial<CampaignFormState> = {}): CampaignFormState {
  return {
    name: "5 月促销",
    templateId: "tpl_1",
    subjects: {},
    localeStrategy: "AUTO",
    forcedLocale: "",
    fromEmail: "",
    replyTo: "",
    sendingChannelId: "",
    tagFilter: "",
    tagFilterMode: "ANY",
    segmentId: "",
    subscriptionCategory: "",
    isAbTest: false,
    variants: [
      {
        variantName: "A",
        samplePercentage: 25,
        locales: {
          zh: { subject: "中文主题", htmlContent: "<p>zh</p>", textContent: "" },
          en: { subject: "EN subject", htmlContent: "<p>en</p>", textContent: "" },
        },
      },
      {
        variantName: "B",
        samplePercentage: 25,
        locales: {
          zh: { subject: "中文主题2", htmlContent: "<p>zh2</p>", textContent: "" },
          en: { subject: "EN subject2", htmlContent: "<p>en2</p>", textContent: "" },
        },
      },
    ],
    utmSource: "",
    utmMedium: "email",
    utmCampaign: "",
    abTestConfig: {
      winnerMetric: "open",
      testDurationHours: 4,
      autoSendWinner: true,
      confidenceLevel: 0.95,
    },
    ...overrides,
  };
}

describe("forcedLocaleOptions", () => {
  it("returns empty when no template", () => {
    expect(forcedLocaleOptions(null)).toEqual([]);
  });

  it("returns only locales available on template, in canonical order", () => {
    expect(forcedLocaleOptions(makeTemplate({ availableLocales: ["en"] }))).toEqual([
      "en",
    ]);
    expect(
      forcedLocaleOptions(makeTemplate({ availableLocales: ["en", "zh"] })),
    ).toEqual(["zh", "en"]);
  });
});

describe("cleanSubjects", () => {
  it("trims and drops empty entries", () => {
    expect(
      cleanSubjects({ zh: "  你好  ", en: "  " }, ["zh", "en"]),
    ).toEqual({ zh: "你好" });
  });

  it("returns undefined when nothing left", () => {
    expect(cleanSubjects({ zh: "  ", en: "" }, ["zh", "en"])).toBeUndefined();
  });

  it("ignores locales not allowed", () => {
    expect(cleanSubjects({ zh: "中文", en: "EN" }, ["en"])).toEqual({ en: "EN" });
  });
});

describe("cleanVariantLocales", () => {
  it("keeps complete locales and skips ones missing subject or html", () => {
    const result = cleanVariantLocales(
      {
        zh: { subject: "中文", htmlContent: "<p>zh</p>", textContent: "  " },
        en: { subject: " ", htmlContent: "<p>en</p>", textContent: "plain" },
      },
      ["zh", "en"],
    );
    expect(result.subjects).toEqual({ zh: "中文" });
    expect(result.htmlContents).toEqual({ zh: "<p>zh</p>" });
    expect(result.textContents).toEqual({});
  });

  it("includes textContent when not blank", () => {
    const result = cleanVariantLocales(
      {
        en: {
          subject: "EN",
          htmlContent: "<p>en</p>",
          textContent: "plain text",
        },
      },
      ["zh", "en"],
    );
    expect(result.textContents).toEqual({ en: "plain text" });
  });
});

describe("buildCampaignPayload", () => {
  it("builds AUTO payload with subject overrides for both locales", () => {
    const form = makeForm({
      subjects: { zh: "中文覆盖", en: "  EN override  " },
    });
    const result = buildCampaignPayload(form, makeTemplate());
    expect(result.errors).toEqual([]);
    expect(result.payload).toMatchObject({
      name: "5 月促销",
      templateId: "tpl_1",
      localeStrategy: "AUTO",
      isAbTest: false,
      subjects: { zh: "中文覆盖", en: "EN override" },
    });
    expect(result.payload).not.toHaveProperty("forcedLocale");
  });

  it("FORCE without forcedLocale is rejected", () => {
    const form = makeForm({ localeStrategy: "FORCE", forcedLocale: "" });
    const result = buildCampaignPayload(form, makeTemplate());
    expect(result.payload).toBeNull();
    expect(result.errors).toContainEqual({
      field: "forcedLocale",
      message: "强制语言模式需选择目标语言",
    });
  });

  it("FORCE only sends override for forced locale", () => {
    const form = makeForm({
      localeStrategy: "FORCE",
      forcedLocale: "en",
      subjects: { zh: "中文覆盖", en: "EN" },
    });
    const result = buildCampaignPayload(form, makeTemplate());
    expect(result.errors).toEqual([]);
    expect(result.payload?.localeStrategy).toBe("FORCE");
    expect(result.payload?.forcedLocale).toBe("en");
    expect(result.payload?.subjects).toEqual({ en: "EN" });
  });

  it("FORCE with locale not on template fails", () => {
    const form = makeForm({
      localeStrategy: "FORCE",
      forcedLocale: "en",
    });
    const result = buildCampaignPayload(
      form,
      makeTemplate({ availableLocales: ["zh"] }),
    );
    expect(result.payload).toBeNull();
    expect(result.errors).toContainEqual({
      field: "forcedLocale",
      message: "所选语言不在模板可用语言列表中",
    });
  });

  it("rejects A/B test when sum of samples exceeds 50", () => {
    const form = makeForm({
      isAbTest: true,
      variants: [
        {
          variantName: "A",
          samplePercentage: 30,
          locales: {
            zh: { subject: "A", htmlContent: "<p>a</p>", textContent: "" },
          },
        },
        {
          variantName: "B",
          samplePercentage: 30,
          locales: {
            zh: { subject: "B", htmlContent: "<p>b</p>", textContent: "" },
          },
        },
      ],
    });
    const result = buildCampaignPayload(form, makeTemplate());
    expect(result.payload).toBeNull();
    expect(
      result.errors.some((err) => err.field === "variants"),
    ).toBe(true);
  });

  it("rejects A/B test variant lacking any locale content", () => {
    const form = makeForm({
      isAbTest: true,
      variants: [
        {
          variantName: "A",
          samplePercentage: 10,
          locales: {
            zh: { subject: "A", htmlContent: "<p>a</p>", textContent: "" },
          },
        },
        {
          variantName: "B",
          samplePercentage: 10,
          locales: {
            zh: { subject: "", htmlContent: "<p>b</p>", textContent: "" },
          },
        },
      ],
    });
    const result = buildCampaignPayload(form, makeTemplate());
    expect(result.payload).toBeNull();
    expect(
      result.errors.some((err) => err.field === "variants.1.locales"),
    ).toBe(true);
  });

  it("builds A/B test payload with abTestConfig and trimmed variants", () => {
    const form = makeForm({ isAbTest: true });
    const result = buildCampaignPayload(form, makeTemplate());
    expect(result.errors).toEqual([]);
    expect(result.payload?.isAbTest).toBe(true);
    expect(result.payload?.variants).toHaveLength(2);
    expect(result.payload?.variants?.[0]).toMatchObject({
      variantName: "A",
      samplePercentage: 25,
      subjects: { zh: "中文主题", en: "EN subject" },
    });
    expect(result.payload?.abTestConfig).toEqual({
      winnerMetric: "open",
      testDurationHours: 4,
      autoSendWinner: true,
      confidenceLevel: 0.95,
    });
  });

  it("includes utmParams and tagFilter when provided", () => {
    const form = makeForm({
      tagFilter: " vip , premium ",
      tagFilterMode: "ALL",
      utmSource: "newsletter",
      utmMedium: "email",
      utmCampaign: "may",
    });
    const result = buildCampaignPayload(form, makeTemplate());
    expect(result.payload?.tagFilter).toEqual(["vip", "premium"]);
    expect(result.payload?.tagFilterMode).toBe("ALL");
    expect(result.payload?.utmParams).toEqual({
      utm_source: "newsletter",
      utm_medium: "email",
      utm_campaign: "may",
    });
  });

  it("requires name and templateId", () => {
    const result = buildCampaignPayload(
      makeForm({ name: "  ", templateId: "" }),
      null,
    );
    expect(result.payload).toBeNull();
    expect(result.errors.map((err) => err.field)).toEqual(
      expect.arrayContaining(["name", "templateId"]),
    );
  });
});

describe("summarizeCoverageWarnings", () => {
  it("returns no warnings when counts are zero", () => {
    expect(
      summarizeCoverageWarnings({
        localeStrategy: "AUTO",
        fallbackCount: 0,
        variantMissingLocaleWarningCount: 0,
      }),
    ).toEqual([]);
  });

  it("ignores fallback warning under FORCE strategy", () => {
    expect(
      summarizeCoverageWarnings({
        localeStrategy: "FORCE",
        fallbackCount: 5,
        variantMissingLocaleWarningCount: 0,
      }),
    ).toEqual([]);
  });

  it("reports both warning kinds when present", () => {
    expect(
      summarizeCoverageWarnings({
        localeStrategy: "AUTO",
        fallbackCount: 3,
        variantMissingLocaleWarningCount: 2,
      }),
    ).toEqual([
      { kind: "fallback", count: 3 },
      { kind: "variant-missing", count: 2 },
    ]);
  });
});
