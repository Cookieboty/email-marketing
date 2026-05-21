import { z } from "zod";

export const TEMPLATE_LOCALES = ["zh", "en"] as const;
export type Locale = (typeof TEMPLATE_LOCALES)[number];

export const LOCALE_LABELS: Record<Locale, string> = {
  zh: "中文",
  en: "English",
};

export interface TemplateLocaleContent {
  subject: string;
  htmlContent: string;
  textContent: string;
}

export type TemplateLocaleMap = Partial<Record<Locale, TemplateLocaleContent>>;

export interface TemplateRecord {
  id: string;
  name: string;
  defaultLocale: Locale;
  variables: string[];
  version: number;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
  locales: Array<{
    locale: Locale;
    subject: string;
    htmlContent: string;
    textContent: string | null;
  }>;
}

export interface TemplateListItem {
  id: string;
  name: string;
  defaultLocale: Locale;
  availableLocales: Locale[];
  variables: string[];
  version: number;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
}

export function emptyLocaleContent(): TemplateLocaleContent {
  return { subject: "", htmlContent: "", textContent: "" };
}

export function buildInitialLocales(
  record: TemplateRecord | null,
): TemplateLocaleMap {
  if (!record) {
    return { zh: emptyLocaleContent() };
  }
  const out: TemplateLocaleMap = {};
  for (const row of record.locales) {
    out[row.locale] = {
      subject: row.subject,
      htmlContent: row.htmlContent,
      textContent: row.textContent ?? "",
    };
  }
  return out;
}

export function availableLocales(map: TemplateLocaleMap): Locale[] {
  return TEMPLATE_LOCALES.filter((locale) => map[locale] !== undefined);
}

export const TemplateLocaleContentSchema = z.object({
  subject: z.string().trim().min(1, "请输入邮件主题").max(512),
  htmlContent: z.string().min(1, "请输入 HTML 正文"),
  textContent: z.string().default(""),
});

export const TemplateFormSchema = z
  .object({
    name: z.string().trim().min(1, "请输入模板名称").max(128),
    defaultLocale: z.enum(TEMPLATE_LOCALES),
    locales: z
      .object({
        zh: TemplateLocaleContentSchema.optional(),
        en: TemplateLocaleContentSchema.optional(),
      })
      .refine((v) => v.zh !== undefined || v.en !== undefined, {
        message: "至少需要保留一个语言版本",
      }),
  })
  .refine((v) => v.locales[v.defaultLocale] !== undefined, {
    message: "默认语言必须存在内容",
    path: ["defaultLocale"],
  });

export type TemplateFormValues = z.infer<typeof TemplateFormSchema>;

export interface CreateTemplatePayload {
  name: string;
  defaultLocale: Locale;
  locales: Partial<
    Record<
      Locale,
      {
        subject: string;
        htmlContent: string;
        textContent?: string;
      }
    >
  >;
}

export interface UpdateTemplatePayload {
  name?: string;
  defaultLocale?: Locale;
  locales?: Partial<
    Record<
      Locale,
      {
        subject: string;
        htmlContent: string;
        textContent?: string | null;
      }
    >
  >;
}

function normalizeLocaleContent(
  content: TemplateLocaleContent,
): { subject: string; htmlContent: string; textContent?: string } {
  const trimmedText = content.textContent.trim();
  return {
    subject: content.subject.trim(),
    htmlContent: content.htmlContent,
    ...(trimmedText.length > 0 ? { textContent: content.textContent } : {}),
  };
}

export function buildCreatePayload(
  values: TemplateFormValues,
): CreateTemplatePayload {
  const locales: CreateTemplatePayload["locales"] = {};
  for (const locale of TEMPLATE_LOCALES) {
    const content = values.locales[locale];
    if (content) {
      locales[locale] = normalizeLocaleContent(content);
    }
  }
  return {
    name: values.name.trim(),
    defaultLocale: values.defaultLocale,
    locales,
  };
}

export function diffLocaleMaps(
  prev: TemplateLocaleMap,
  next: TemplateLocaleMap,
): {
  removed: Locale[];
  changed: Array<[Locale, TemplateLocaleContent]>;
} {
  const removed: Locale[] = [];
  const changed: Array<[Locale, TemplateLocaleContent]> = [];
  for (const locale of TEMPLATE_LOCALES) {
    const before = prev[locale];
    const after = next[locale];
    if (before && !after) {
      removed.push(locale);
      continue;
    }
    if (!after) continue;
    if (
      !before ||
      before.subject !== after.subject ||
      before.htmlContent !== after.htmlContent ||
      (before.textContent ?? "") !== (after.textContent ?? "")
    ) {
      changed.push([locale, after]);
    }
  }
  return { removed, changed };
}

export interface UpdateTemplateDiff {
  /** PATCH /api/templates/:id 请求体；可能为空对象表示无字段变更 */
  payload: UpdateTemplatePayload;
  /** 需要额外调用 DELETE /api/templates/:id/locales/:locale 的语言列表 */
  removedLocales: Locale[];
}

export function buildUpdatePayload(
  initial: TemplateRecord,
  values: TemplateFormValues,
): UpdateTemplateDiff {
  const payload: UpdateTemplatePayload = {};
  const trimmedName = values.name.trim();
  if (trimmedName !== initial.name) payload.name = trimmedName;
  if (values.defaultLocale !== initial.defaultLocale) {
    payload.defaultLocale = values.defaultLocale;
  }

  const initialMap = buildInitialLocales(initial);
  const nextMap = values.locales as TemplateLocaleMap;
  const { removed, changed } = diffLocaleMaps(initialMap, nextMap);

  if (changed.length > 0) {
    const locales: NonNullable<UpdateTemplatePayload["locales"]> = {};
    for (const [locale, content] of changed) {
      locales[locale] = normalizeLocaleContent(content);
    }
    payload.locales = locales;
  }

  return { payload, removedLocales: removed };
}

export function copyLocaleContent(
  source: TemplateLocaleContent,
): TemplateLocaleContent {
  return {
    subject: source.subject,
    htmlContent: source.htmlContent,
    textContent: source.textContent,
  };
}

export type VariableUsageStatus =
  | "shared"
  | "current-only"
  | "missing-in-current";

export interface VariableUsageEntry {
  name: string;
  status: VariableUsageStatus;
  presentLocales: Locale[];
}

export function classifyVariableUsage(
  active: Locale,
  perLocale: Partial<Record<Locale, ReadonlyArray<string>>>,
): VariableUsageEntry[] {
  const presentByVar = new Map<string, Set<Locale>>();
  for (const locale of TEMPLATE_LOCALES) {
    const list = perLocale[locale];
    if (!list) continue;
    for (const v of list) {
      let set = presentByVar.get(v);
      if (!set) {
        set = new Set<Locale>();
        presentByVar.set(v, set);
      }
      set.add(locale);
    }
  }
  const activeSet = new Set(perLocale[active] ?? []);
  const otherLocales = TEMPLATE_LOCALES.filter(
    (l) => l !== active && perLocale[l] !== undefined,
  );

  const out: VariableUsageEntry[] = [];
  for (const [name, locales] of presentByVar) {
    const inActive = activeSet.has(name);
    const inOthers = otherLocales.some((l) => locales.has(l));
    let status: VariableUsageStatus;
    if (inActive && inOthers) status = "shared";
    else if (inActive) status = "current-only";
    else status = "missing-in-current";
    out.push({
      name,
      status,
      presentLocales: TEMPLATE_LOCALES.filter((l) => locales.has(l)),
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
