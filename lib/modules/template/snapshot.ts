import type { Locale } from "@prisma/client";

export interface LocaleContent {
  subject: string;
  htmlContent: string;
  textContent: string | null;
}

/**
 * 已冻结的模板片段表：`blocks[locale][blockName] = htmlContent`。
 *
 * - 字段为可选：旧 snapshot（写入前于 phase-14 之前）不含 `blocks`，
 *   反序列化后保持 `undefined`，调用方需用空 resolver 兜底。
 * - 内层 `Record<name, htmlContent>` 仅冻结渲染所需 HTML 内容；不存
 *   `id/updatedAt` 等元数据，避免快照体积膨胀。
 */
export type FrozenBlocksByLocale = Partial<
  Record<Locale, Record<string, string>>
>;

export interface TemplateSnapshot {
  version: number;
  defaultLocale: Locale;
  locales: Partial<Record<Locale, LocaleContent>>;
  variables: string[];
  blocks?: FrozenBlocksByLocale;
}

export interface TemplateWithLocalesForSnapshot {
  version: number;
  defaultLocale: Locale;
  variables: string[];
  locales: Array<LocaleContent & { locale: Locale }>;
}

/**
 * 构造模板快照。
 *
 * @param template 模板及其各 locale 内容
 * @param blocksPerLocale 已预取并准备冻结的片段表；未提供时 snapshot 中
 *   `blocks` 字段保持 `undefined`，下游渲染会走"无 resolver"路径。
 */
export function buildTemplateSnapshot(
  template: TemplateWithLocalesForSnapshot,
  blocksPerLocale?: FrozenBlocksByLocale,
): TemplateSnapshot {
  const locales: Partial<Record<Locale, LocaleContent>> = {};
  for (const row of template.locales) {
    locales[row.locale] = {
      subject: row.subject,
      htmlContent: row.htmlContent,
      textContent: row.textContent,
    };
  }

  const snapshot: TemplateSnapshot = {
    version: template.version,
    defaultLocale: template.defaultLocale,
    locales,
    variables: template.variables,
    ...(blocksPerLocale ? { blocks: blocksPerLocale } : {}),
  };
  assertSnapshotHasDefaultLocale(snapshot);
  return snapshot;
}

export function assertSnapshotHasDefaultLocale(snapshot: TemplateSnapshot): void {
  if (!snapshot.locales[snapshot.defaultLocale]) {
    throw new Error("MissingLocaleContent");
  }
}

/**
 * 把 subject 覆盖按 locale 烘焙进快照副本，返回新的 snapshot。用于在 AutomationRun
 * 创建时把 Automation.subjects 的即时值锁定，避免后续 Automation 编辑影响已调度
 * 的 run（spec §25 "Run 发送和重试只读快照"）。
 *
 * 规则：
 *  - overrides 中空字符串 / 非字符串 / 模板无对应 locale → 跳过
 *  - 非空 trim 后写入 snapshot.locales[locale].subject
 *  - 返回 deep-copied 副本，原 snapshot 不被改动
 */
export function applySubjectOverrides(
  snapshot: TemplateSnapshot,
  overrides: Partial<Record<Locale, string | null | undefined>> | null | undefined,
): TemplateSnapshot {
  if (!overrides) return snapshot;
  const nextLocales: Partial<Record<Locale, LocaleContent>> = {};
  for (const [locale, content] of Object.entries(snapshot.locales) as Array<[
    Locale,
    LocaleContent | undefined,
  ]>) {
    if (!content) continue;
    const raw = overrides[locale];
    const override = typeof raw === "string" ? raw.trim() : "";
    nextLocales[locale] = {
      ...content,
      ...(override ? { subject: override } : {}),
    };
  }
  return { ...snapshot, locales: nextLocales };
}

/**
 * 把已有的 templateSnapshot 还原成 testSendTemplate 所需的轻量"模板"形状。
 * 用在测试发送 Campaign 时：以发送快照为准，不回查 live EmailTemplateLocale。
 */
export function snapshotToTemplateForTestSend(
  snapshot: TemplateSnapshot,
  meta: { id: string; name: string },
): TemplateWithLocalesForSnapshot & { id: string; name: string } {
  const locales: Array<LocaleContent & { locale: Locale }> = [];
  for (const [locale, content] of Object.entries(snapshot.locales) as Array<[
    Locale,
    LocaleContent | undefined,
  ]>) {
    if (!content) continue;
    locales.push({ locale, ...content });
  }
  return {
    id: meta.id,
    name: meta.name,
    version: snapshot.version,
    defaultLocale: snapshot.defaultLocale,
    variables: snapshot.variables,
    locales,
  };
}
