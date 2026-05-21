import type { Locale, LocaleStrategy } from "@prisma/client";
import { render, type BuiltinVariableInput } from "@/lib/template-engine";
import type { LocaleContent, TemplateSnapshot } from "./snapshot";

export class MissingLocaleContentError extends Error {
  constructor(message = "MissingLocaleContent") {
    super(message);
    this.name = "MissingLocaleContentError";
  }
}

export function resolveLocale(input: {
  strategy: LocaleStrategy;
  forcedLocale: Locale | null;
  userLocale: Locale | null;
  defaultLocale: Locale;
  availableLocales: readonly Locale[];
}): Locale {
  const available = new Set(input.availableLocales);
  if (!available.has(input.defaultLocale)) {
    throw new MissingLocaleContentError();
  }

  if (input.strategy === "FORCE") {
    if (!input.forcedLocale || !available.has(input.forcedLocale)) {
      throw new MissingLocaleContentError();
    }
    return input.forcedLocale;
  }

  const candidate = input.userLocale ?? input.defaultLocale;
  return available.has(candidate) ? candidate : input.defaultLocale;
}

export interface TemplateVariantContent {
  subjects: Partial<Record<Locale, string>>;
  htmlContents: Partial<Record<Locale, string>>;
  textContents?: Partial<Record<Locale, string | null>>;
}

export function renderSnapshotContent(input: {
  snapshot: TemplateSnapshot;
  resolvedLocale: Locale;
  subjects?: Partial<Record<Locale, string>>;
  variant?: TemplateVariantContent | null;
  variables?: Record<string, string>;
  builtin?: BuiltinVariableInput;
}): { subject: string; html: string; text?: string; locale: Locale } {
  let locale = input.resolvedLocale;
  let baseContent = input.snapshot.locales[locale] ?? null;
  if (!baseContent) {
    locale = input.snapshot.defaultLocale;
    baseContent = input.snapshot.locales[locale] ?? null;
  }
  if (!baseContent) throw new MissingLocaleContentError();

  const content = selectVariantContent(input.variant, locale) ?? baseContent;
  const overrideSubject = input.subjects?.[locale]?.trim();
  const subjectTemplate = overrideSubject ? overrideSubject : content.subject;
  const builtin = withLocalizedBuiltinText(locale, input.builtin ?? {});

  return {
    locale,
    subject: render(subjectTemplate, input.variables ?? {}, { builtin }),
    html: render(content.htmlContent, input.variables ?? {}, { builtin }),
    ...(content.textContent
      ? { text: render(content.textContent, input.variables ?? {}, { builtin }) }
      : {}),
  };
}

function selectVariantContent(
  variant: TemplateVariantContent | null | undefined,
  locale: Locale,
): LocaleContent | null {
  if (!variant) return null;
  const htmlContent = variant.htmlContents[locale];
  const subject = variant.subjects[locale];
  // 仅当 subject 与 htmlContent 同时存在时才视为 variant 提供该 locale；任一缺
  // 失都回退到主模板内容（spec §239），避免下游用空 subject 发邮件。
  if (!htmlContent || !subject) return null;
  return {
    subject,
    htmlContent,
    textContent: variant.textContents?.[locale] ?? null,
  };
}

export function withLocalizedBuiltinText(
  locale: Locale,
  builtin: BuiltinVariableInput,
): BuiltinVariableInput {
  return {
    ...builtin,
    unsubscribeLinkText:
      builtin.unsubscribeLinkText ?? (locale === "en" ? "Unsubscribe" : "退订"),
    unsubscribeTopicLinkText:
      builtin.unsubscribeTopicLinkText ??
      (locale === "en" ? "Unsubscribe from this topic" : "退订该主题"),
  };
}
