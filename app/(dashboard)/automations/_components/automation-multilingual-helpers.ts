import {
  TEMPLATE_LOCALES,
  type Locale,
} from "@/app/(dashboard)/templates/_components/types";

export type LocaleStrategy = "AUTO" | "FORCE";

export type AutomationTriggerType =
  | "USER_CREATED"
  | "TAG_CHANGED"
  | "BIRTHDAY"
  | "REENGAGEMENT"
  | "CUSTOM_EVENT";

export interface TemplateOption {
  id: string;
  name: string;
  defaultLocale: Locale;
  availableLocales: Locale[];
}

export interface AutomationFormValues {
  name: string;
  triggerType: AutomationTriggerType;
  templateId: string;
  subjects: Partial<Record<Locale, string>>;
  localeStrategy: LocaleStrategy;
  forcedLocale: Locale | "";
  delayMinutes: number;
}

export interface AutomationRecord {
  id: string;
  name: string;
  triggerType: AutomationTriggerType;
  templateId: string | null;
  subjects: Partial<Record<Locale, string>> | null;
  localeStrategy: LocaleStrategy;
  forcedLocale: Locale | null;
  delayMinutes: number;
  status: "ENABLED" | "DISABLED";
  triggerConfig: Record<string, unknown>;
  conditions: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface ValidationIssue {
  field: string;
  message: string;
}

export function forcedLocaleOptions(
  template: TemplateOption | null,
): Locale[] {
  if (!template) return [...TEMPLATE_LOCALES];
  return TEMPLATE_LOCALES.filter((locale) =>
    template.availableLocales.includes(locale),
  );
}

export function cleanAutomationSubjects(
  subjects: Partial<Record<Locale, string>>,
  allowedLocales: Locale[],
): Partial<Record<Locale, string>> | undefined {
  const out: Partial<Record<Locale, string>> = {};
  for (const locale of allowedLocales) {
    const raw = subjects[locale];
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (trimmed.length > 0) out[locale] = trimmed;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function subjectInputLocales(
  values: Pick<
    AutomationFormValues,
    "templateId" | "localeStrategy" | "forcedLocale"
  >,
  template: TemplateOption | null,
): Locale[] {
  const allowed = forcedLocaleOptions(template);
  if (values.localeStrategy === "FORCE" && values.forcedLocale) {
    return allowed.includes(values.forcedLocale) ? [values.forcedLocale] : [];
  }
  return allowed;
}

export interface CreateAutomationPayload {
  name: string;
  triggerType: AutomationTriggerType;
  triggerConfig: Record<string, unknown>;
  templateId?: string;
  subjects?: Partial<Record<Locale, string>>;
  localeStrategy: LocaleStrategy;
  forcedLocale?: Locale;
  delayMinutes: number;
}

export interface BuildCreateResult {
  payload: CreateAutomationPayload | null;
  errors: ValidationIssue[];
}

export function buildCreateAutomationPayload(
  values: AutomationFormValues,
  template: TemplateOption | null,
): BuildCreateResult {
  const errors: ValidationIssue[] = [];
  const name = values.name.trim();
  if (!name) errors.push({ field: "name", message: "请输入名称" });
  if (!values.triggerType) {
    errors.push({ field: "triggerType", message: "请选择触发类型" });
  }
  if (
    values.delayMinutes < 0 ||
    values.delayMinutes > 525600 ||
    !Number.isInteger(values.delayMinutes)
  ) {
    errors.push({
      field: "delayMinutes",
      message: "延迟需为 0~525600 的整数分钟",
    });
  }

  const allowed = forcedLocaleOptions(template);
  if (values.localeStrategy === "FORCE") {
    if (!values.forcedLocale) {
      errors.push({
        field: "forcedLocale",
        message: "强制语言模式需选择目标语言",
      });
    } else if (
      values.templateId &&
      template &&
      !allowed.includes(values.forcedLocale)
    ) {
      errors.push({
        field: "forcedLocale",
        message: "所选语言不在模板可用语言列表中",
      });
    }
  }

  const subjectAllowed: Locale[] =
    values.localeStrategy === "FORCE" && values.forcedLocale
      ? [values.forcedLocale]
      : values.templateId
        ? allowed
        : [...TEMPLATE_LOCALES];
  const subjects = cleanAutomationSubjects(values.subjects, subjectAllowed);

  if (!values.templateId && !subjects) {
    errors.push({
      field: "subjects",
      message: "未选择模板时至少填写一个语言的主题",
    });
  }

  if (errors.length > 0) return { payload: null, errors };

  const payload: CreateAutomationPayload = {
    name,
    triggerType: values.triggerType,
    triggerConfig: {},
    localeStrategy: values.localeStrategy,
    delayMinutes: values.delayMinutes,
  };
  if (values.templateId) payload.templateId = values.templateId;
  if (subjects) payload.subjects = subjects;
  if (values.localeStrategy === "FORCE" && values.forcedLocale) {
    payload.forcedLocale = values.forcedLocale;
  }
  return { payload, errors: [] };
}

export type UpdateAutomationPayload = Partial<{
  name: string;
  triggerType: AutomationTriggerType;
  templateId: string | null;
  subjects: Partial<Record<Locale, string>>;
  localeStrategy: LocaleStrategy;
  forcedLocale: Locale | null;
  delayMinutes: number;
}>;

export interface BuildUpdateResult {
  payload: UpdateAutomationPayload | null;
  errors: ValidationIssue[];
  hasChanges: boolean;
}

function subjectsEqual(
  a: Partial<Record<Locale, string>> | undefined | null,
  b: Partial<Record<Locale, string>> | undefined | null,
): boolean {
  const left = a ?? {};
  const right = b ?? {};
  const keys = new Set<Locale>([
    ...(Object.keys(left) as Locale[]),
    ...(Object.keys(right) as Locale[]),
  ]);
  for (const k of keys) {
    if ((left[k] ?? "") !== (right[k] ?? "")) return false;
  }
  return true;
}

export function buildUpdateAutomationPayload(
  values: AutomationFormValues,
  original: AutomationRecord,
  template: TemplateOption | null,
): BuildUpdateResult {
  const create = buildCreateAutomationPayload(values, template);
  if (!create.payload) {
    return { payload: null, errors: create.errors, hasChanges: false };
  }
  const next = create.payload;
  const patch: UpdateAutomationPayload = {};

  if (next.name !== original.name) patch.name = next.name;
  if (next.triggerType !== original.triggerType) {
    patch.triggerType = next.triggerType;
  }
  const nextTemplateId = next.templateId ?? null;
  if (nextTemplateId !== (original.templateId ?? null)) {
    patch.templateId = nextTemplateId;
  }
  if (!subjectsEqual(next.subjects, original.subjects)) {
    if (next.subjects) patch.subjects = next.subjects;
  }
  if (next.localeStrategy !== original.localeStrategy) {
    patch.localeStrategy = next.localeStrategy;
  }
  const nextForced = next.forcedLocale ?? null;
  if (nextForced !== (original.forcedLocale ?? null)) {
    patch.forcedLocale = nextForced;
  }
  if (next.delayMinutes !== original.delayMinutes) {
    patch.delayMinutes = next.delayMinutes;
  }

  const hasChanges = Object.keys(patch).length > 0;
  return { payload: hasChanges ? patch : null, errors: [], hasChanges };
}

export function recordToFormValues(
  record: AutomationRecord,
): AutomationFormValues {
  return {
    name: record.name,
    triggerType: record.triggerType,
    templateId: record.templateId ?? "",
    subjects: { ...(record.subjects ?? {}) },
    localeStrategy: record.localeStrategy,
    forcedLocale: record.forcedLocale ?? "",
    delayMinutes: record.delayMinutes,
  };
}

export function summarizeSubjects(
  subjects: Partial<Record<Locale, string>> | null | undefined,
): string {
  if (!subjects) return "";
  return TEMPLATE_LOCALES.filter((loc) => {
    const v = subjects[loc];
    return typeof v === "string" && v.trim().length > 0;
  })
    .map((loc) => `[${loc}] ${subjects[loc]?.trim() ?? ""}`)
    .join(" / ");
}
