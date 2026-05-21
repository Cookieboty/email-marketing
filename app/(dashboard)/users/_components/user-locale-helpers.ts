import type { Locale } from "@/app/(dashboard)/templates/_components/types";

export type UserLocale = Locale | null;

export const USER_LOCALE_LABELS: Record<Locale, string> = {
  zh: "中文",
  en: "English",
};

export function formatUserLocale(locale: UserLocale): string {
  if (!locale) return "—";
  return USER_LOCALE_LABELS[locale];
}

export function formatUserLocaleShort(locale: UserLocale): string {
  return locale ?? "—";
}

export function parseLocaleFormValue(raw: string): UserLocale {
  if (raw === "zh" || raw === "en") return raw;
  return null;
}

export interface DiffLocaleResult {
  changed: boolean;
  value: UserLocale;
}

export function diffUserLocale(
  next: UserLocale,
  original: UserLocale,
): DiffLocaleResult {
  return { changed: next !== original, value: next };
}
