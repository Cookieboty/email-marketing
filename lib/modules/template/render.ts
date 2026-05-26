import type { Locale, LocaleStrategy } from "@prisma/client";
import {
  expandBlocks,
  render,
  type BlockResolver,
  type BuiltinVariableInput,
  type ExpandOptions,
} from "@/lib/template-engine";
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

/**
 * Render-time expansion 渲染入口。
 *
 * 两阶段：
 *   1. 若提供 `blocks` resolver，对 subject/html/text 调 `expandBlocks` 展开
 *      `{{> name}}` 引用；展开过程中循环 / 深度 / 大小越界会抛 `BlockExpansionError`。
 *   2. 然后才走变量替换（已有 `render`）。这样确保 stage-2 输出的字面量
 *      `{{> evil}}` 不会被再次解析，满足"不可逃逸"不变量。
 *
 * `blocks` 缺省时走零开销路径（与升级前完全一致），方便旧调用点逐步切换。
 *
 * @param input.blocks 片段解析器。Campaign/Automation 路径传"快照内只读 resolver"，
 *   测试发送 / 预览路径传"实时仓储 resolver"。
 * @param input.missingBlock 透传给 `expandBlocks` 的 missing 策略：
 *   - `'throw'`：测试发送 / Worker 应使用，避免静默漂移；
 *   - `'keep'`：预览应使用，便于编辑器展示未解析片段；
 *   - `'empty'`：兜底；
 *   未指定时遵从 `expandBlocks` 默认值（`'throw'`）。
 */
export function renderSnapshotContent(input: {
  snapshot: TemplateSnapshot;
  resolvedLocale: Locale;
  subjects?: Partial<Record<Locale, string>>;
  variant?: TemplateVariantContent | null;
  variables?: Record<string, string>;
  builtin?: BuiltinVariableInput;
  blocks?: BlockResolver;
  missingBlock?: ExpandOptions["missing"];
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

  const expand = (src: string): string => {
    if (!input.blocks) return src;
    return expandBlocks(src, input.blocks, {
      ...(input.missingBlock ? { missing: input.missingBlock } : {}),
    });
  };

  const subjectExpanded = expand(subjectTemplate);
  const htmlExpanded = expand(content.htmlContent);
  const textExpanded = content.textContent ? expand(content.textContent) : null;

  return {
    locale,
    subject: render(subjectExpanded, input.variables ?? {}, { builtin }),
    html: render(htmlExpanded, input.variables ?? {}, { builtin }),
    ...(textExpanded !== null
      ? { text: render(textExpanded, input.variables ?? {}, { builtin }) }
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
