import type { Locale, LocaleStrategy } from "@prisma/client";
import { resolveLocale } from "@/lib/modules/template/render";

export interface LocaleCoverageInput {
  localeStrategy: LocaleStrategy;
  forcedLocale: Locale | null;
  defaultLocale: Locale;
  availableLocales: Locale[];
  users: Array<{ locale: Locale | null }>;
  variants: Array<{ htmlLocales: Locale[] }>;
}

export interface LocaleCoverageResult {
  totalRecipients: number;
  countsByUserLocale: Record<Locale | "null", number>;
  countsByResolvedLocale: Record<Locale, number>;
  fallbackCount: number;
  variantMissingLocaleWarningCount: number;
}

export function computeLocaleCoverage(input: LocaleCoverageInput): LocaleCoverageResult {
  const countsByUserLocale: Record<Locale | "null", number> = { zh: 0, en: 0, null: 0 };
  const countsByResolvedLocale: Record<Locale, number> = { zh: 0, en: 0 };
  let fallbackCount = 0;

  for (const user of input.users) {
    const userLocale = user.locale ?? "null";
    countsByUserLocale[userLocale] += 1;
    const resolved = resolveLocale({
      strategy: input.localeStrategy,
      forcedLocale: input.forcedLocale,
      userLocale: user.locale,
      defaultLocale: input.defaultLocale,
      availableLocales: input.availableLocales,
    });
    countsByResolvedLocale[resolved] += 1;
    if (
      input.localeStrategy === "AUTO" &&
      user.locale !== null &&
      user.locale !== resolved
    ) {
      fallbackCount += 1;
    }
  }

  let variantMissingLocaleWarningCount = 0;
  for (const variant of input.variants) {
    for (const locale of input.availableLocales) {
      if (!variant.htmlLocales.includes(locale)) {
        variantMissingLocaleWarningCount += 1;
      }
    }
  }

  return {
    totalRecipients: input.users.length,
    countsByUserLocale,
    countsByResolvedLocale,
    fallbackCount,
    variantMissingLocaleWarningCount,
  };
}
