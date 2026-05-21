import { describe, expect, it } from "vitest";
import { computeLocaleCoverage } from "@/lib/modules/campaign/locale-coverage";

describe("computeLocaleCoverage", () => {
  it("counts AUTO recipients by resolved locale and fallback", () => {
    const result = computeLocaleCoverage({
      localeStrategy: "AUTO",
      forcedLocale: null,
      defaultLocale: "zh",
      availableLocales: ["zh"],
      users: [
        { locale: "zh" },
        { locale: "en" },
        { locale: null },
      ],
      variants: [],
    });

    expect(result.totalRecipients).toBe(3);
    expect(result.countsByUserLocale).toEqual({ zh: 1, en: 1, null: 1 });
    expect(result.countsByResolvedLocale).toEqual({ zh: 3, en: 0 });
    expect(result.fallbackCount).toBe(1);
  });

  it("does not count fallback for FORCE when target locale exists", () => {
    const result = computeLocaleCoverage({
      localeStrategy: "FORCE",
      forcedLocale: "en",
      defaultLocale: "zh",
      availableLocales: ["zh", "en"],
      users: [
        { locale: "zh" },
        { locale: null },
      ],
      variants: [],
    });

    expect(result.countsByResolvedLocale).toEqual({ zh: 0, en: 2 });
    expect(result.fallbackCount).toBe(0);
  });

  it("counts variant locale gaps", () => {
    const result = computeLocaleCoverage({
      localeStrategy: "AUTO",
      forcedLocale: null,
      defaultLocale: "zh",
      availableLocales: ["zh", "en"],
      users: [{ locale: "en" }],
      variants: [{ htmlLocales: ["zh"] }],
    });

    expect(result.variantMissingLocaleWarningCount).toBe(1);
  });
});
