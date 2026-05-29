import type { Locale } from "@/app/(dashboard)/templates/_components/types";
import { TEMPLATE_LOCALES } from "@/app/(dashboard)/templates/_components/types";

export type LocaleStrategy = "AUTO" | "FORCE";

export interface TemplateOption {
  id: string;
  name: string;
  defaultLocale: Locale;
  availableLocales: Locale[];
}

export interface VariantLocaleContent {
  subject: string;
  htmlContent: string;
  textContent: string;
}

export interface VariantInput {
  variantName: string;
  samplePercentage: number;
  locales: Partial<Record<Locale, VariantLocaleContent>>;
}

export interface CampaignFormState {
  name: string;
  templateId: string;
  subjects: Partial<Record<Locale, string>>;
  localeStrategy: LocaleStrategy;
  forcedLocale: Locale | "";
  fromEmail: string;
  replyTo: string;
  sendingChannelId: string;
  tagFilter: string;
  tagFilterMode: "ANY" | "ALL";
  segmentId: string;
  subscriptionCategory: string;
  isAbTest: boolean;
  variants: VariantInput[];
  scheduledAt: string;
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  abTestConfig: {
    winnerMetric: "open" | "click" | "conversion";
    testDurationHours: number;
    autoSendWinner: boolean;
    confidenceLevel: number;
  };
}

export function forcedLocaleOptions(template: TemplateOption | null): Locale[] {
  if (!template) return [];
  return TEMPLATE_LOCALES.filter((locale) =>
    template.availableLocales.includes(locale),
  );
}

export function cleanSubjects(
  subjects: Partial<Record<Locale, string>>,
  allowedLocales: Locale[],
): Partial<Record<Locale, string>> | undefined {
  const out: Partial<Record<Locale, string>> = {};
  for (const locale of allowedLocales) {
    const raw = subjects[locale];
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      out[locale] = trimmed;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function cleanVariantLocales(
  locales: Partial<Record<Locale, VariantLocaleContent>>,
  allowedLocales: Locale[],
): {
  subjects: Partial<Record<Locale, string>>;
  htmlContents: Partial<Record<Locale, string>>;
  textContents: Partial<Record<Locale, string | null>>;
} {
  const subjects: Partial<Record<Locale, string>> = {};
  const htmlContents: Partial<Record<Locale, string>> = {};
  const textContents: Partial<Record<Locale, string | null>> = {};
  for (const locale of allowedLocales) {
    const content = locales[locale];
    if (!content) continue;
    const subject = content.subject.trim();
    const html = content.htmlContent;
    if (subject.length === 0 || html.length === 0) continue;
    subjects[locale] = subject;
    htmlContents[locale] = html;
    const trimmedText = content.textContent.trim();
    if (trimmedText.length > 0) {
      textContents[locale] = content.textContent;
    }
  }
  return { subjects, htmlContents, textContents };
}

export interface CampaignPayload {
  name: string;
  templateId: string;
  subjects?: Partial<Record<Locale, string>>;
  localeStrategy: LocaleStrategy;
  forcedLocale?: Locale;
  fromEmail?: string;
  replyTo?: string;
  sendingChannelId?: string;
  tagFilter?: string[];
  tagFilterMode?: "ANY" | "ALL";
  segmentId?: string;
  subscriptionCategory?: string;
  isAbTest: boolean;
  variants?: Array<{
    variantName: string;
    subjects: Partial<Record<Locale, string>>;
    htmlContents: Partial<Record<Locale, string>>;
    textContents?: Partial<Record<Locale, string | null>>;
    samplePercentage: number;
  }>;
  abTestConfig?: {
    winnerMetric: "open" | "click" | "conversion";
    testDurationHours: number;
    autoSendWinner: boolean;
    confidenceLevel: number;
  };
  utmParams?: Record<string, string>;
}

export interface ValidationIssue {
  field: string;
  message: string;
}

export interface BuildPayloadResult {
  payload: CampaignPayload | null;
  errors: ValidationIssue[];
}

export function buildCampaignPayload(
  form: CampaignFormState,
  template: TemplateOption | null,
): BuildPayloadResult {
  const errors: ValidationIssue[] = [];

  const name = form.name.trim();
  if (!name) errors.push({ field: "name", message: "请输入活动名称" });
  if (!form.templateId)
    errors.push({ field: "templateId", message: "请选择模板" });
  if (!template && form.templateId) {
    errors.push({ field: "templateId", message: "模板信息加载失败" });
  }

  const allowedLocales = forcedLocaleOptions(template);

  if (form.localeStrategy === "FORCE") {
    if (!form.forcedLocale) {
      errors.push({
        field: "forcedLocale",
        message: "强制语言模式需选择目标语言",
      });
    } else if (!allowedLocales.includes(form.forcedLocale)) {
      errors.push({
        field: "forcedLocale",
        message: "所选语言不在模板可用语言列表中",
      });
    }
  }

  const subjectsAllowed: Locale[] =
    form.localeStrategy === "FORCE" && form.forcedLocale
      ? [form.forcedLocale]
      : allowedLocales;
  const subjects = cleanSubjects(form.subjects, subjectsAllowed);

  const tags = form.tagFilter
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  const utmParams: Record<string, string> = {};
  if (form.utmSource) utmParams.utm_source = form.utmSource;
  if (form.utmMedium) utmParams.utm_medium = form.utmMedium;
  if (form.utmCampaign) utmParams.utm_campaign = form.utmCampaign;

  let variants: CampaignPayload["variants"] | undefined;
  if (form.isAbTest) {
    if (form.variants.length < 2) {
      errors.push({
        field: "variants",
        message: "A/B 测试需要至少 2 个变体",
      });
    }
    const totalSample = form.variants.reduce(
      (sum, v) => sum + v.samplePercentage,
      0,
    );
    if (totalSample > 50) {
      errors.push({
        field: "variants",
        message: `所有变体样本总和不能超过 50%（当前 ${totalSample}%）`,
      });
    }
    const seenNames = new Set<string>();
    variants = [];
    form.variants.forEach((variant, idx) => {
      const variantName = variant.variantName.trim();
      if (!variantName) {
        errors.push({
          field: `variants.${idx}.variantName`,
          message: `变体 ${idx + 1} 名称不能为空`,
        });
      } else if (seenNames.has(variantName)) {
        errors.push({
          field: `variants.${idx}.variantName`,
          message: `变体名称重复：${variantName}`,
        });
      }
      seenNames.add(variantName);

      const cleaned = cleanVariantLocales(variant.locales, allowedLocales);
      if (Object.keys(cleaned.subjects).length === 0) {
        errors.push({
          field: `variants.${idx}.locales`,
          message: `变体 ${variantName || idx + 1} 至少需填写一个语言版本的主题与 HTML`,
        });
      }
      const entry: NonNullable<CampaignPayload["variants"]>[number] = {
        variantName,
        subjects: cleaned.subjects,
        htmlContents: cleaned.htmlContents,
        samplePercentage: variant.samplePercentage,
      };
      if (Object.keys(cleaned.textContents).length > 0) {
        entry.textContents = cleaned.textContents;
      }
      variants!.push(entry);
    });
  }

  if (errors.length > 0) {
    return { payload: null, errors };
  }

  const payload: CampaignPayload = {
    name,
    templateId: form.templateId,
    localeStrategy: form.localeStrategy,
    isAbTest: form.isAbTest,
  };
  if (subjects) payload.subjects = subjects;
  if (form.localeStrategy === "FORCE" && form.forcedLocale) {
    payload.forcedLocale = form.forcedLocale;
  }
  if (form.fromEmail.trim()) payload.fromEmail = form.fromEmail.trim();
  if (form.replyTo.trim()) payload.replyTo = form.replyTo.trim();
  if (form.sendingChannelId) payload.sendingChannelId = form.sendingChannelId;
  if (tags.length > 0) {
    payload.tagFilter = tags;
    payload.tagFilterMode = form.tagFilterMode;
  }
  if (form.segmentId) payload.segmentId = form.segmentId;
  if (form.subscriptionCategory.trim()) {
    payload.subscriptionCategory = form.subscriptionCategory.trim();
  }
  if (Object.keys(utmParams).length > 0) payload.utmParams = utmParams;
  if (form.isAbTest) {
    payload.variants = variants;
    payload.abTestConfig = { ...form.abTestConfig };
  }

  return { payload, errors: [] };
}

export interface CoverageWarningInput {
  localeStrategy: LocaleStrategy;
  fallbackCount: number;
  variantMissingLocaleWarningCount: number;
}

export type CoverageWarning =
  | { kind: "fallback"; count: number }
  | { kind: "variant-missing"; count: number };

export function summarizeCoverageWarnings(
  input: CoverageWarningInput,
): CoverageWarning[] {
  const warnings: CoverageWarning[] = [];
  if (input.localeStrategy === "AUTO" && input.fallbackCount > 0) {
    warnings.push({ kind: "fallback", count: input.fallbackCount });
  }
  if (input.variantMissingLocaleWarningCount > 0) {
    warnings.push({
      kind: "variant-missing",
      count: input.variantMissingLocaleWarningCount,
    });
  }
  return warnings;
}
