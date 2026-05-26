"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import useSWR from "swr";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { RichTextEditor } from "@/components/rich-text-editor";
import {
  apiDelete,
  apiPatch,
  apiPost,
  swrFetcher,
} from "@/lib/api-client";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { swrKeys } from "@/lib/swr-keys";
import {
  BUILTIN_VARIABLE_NAMES,
  extractVariables,
} from "@/lib/template-engine";
import {
  LOCALE_LABELS,
  TEMPLATE_LOCALES,
  TemplateFormSchema,
  buildCreatePayload,
  buildInitialLocales,
  buildUpdatePayload,
  classifyVariableUsage,
  copyLocaleContent,
  emptyLocaleContent,
  type Locale,
  type TemplateFormValues,
  type TemplateLocaleContent,
  type TemplateLocaleMap,
  type TemplateRecord,
  type VariableUsageEntry,
} from "./types";

export type { TemplateRecord } from "./types";

interface PreviewResp {
  renderedSubject: string;
  renderedHtml: string;
  renderedText: string | null;
  detectedVariables: string[];
  unknownBlocks?: string[];
}

export interface TemplateEditorPageProps {
  mode: "create" | "edit";
  initial?: TemplateRecord;
}

const BUILTIN_SET = new Set<string>(BUILTIN_VARIABLE_NAMES);

const SAMPLE_BUILTIN: Record<string, string> = {
  unsubscribe_url: "https://example.com/unsubscribe?token=sample",
  unsubscribe_link: '<a href="https://example.com/unsubscribe">退订</a>',
  user_email: "alice@example.com",
  user_name: "Alice",
  campaign_name: "示例活动",
  current_year: String(new Date().getFullYear()),
};

function asMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return "操作失败";
}

function statusOf(e: unknown): number | undefined {
  if (e && typeof e === "object" && "status" in e) {
    const s = (e as { status?: unknown }).status;
    if (typeof s === "number") return s;
  }
  return undefined;
}

export default function TemplateEditorPage({
  mode,
  initial,
}: TemplateEditorPageProps) {
  const router = useRouter();
  const { toast } = useToast();

  const [name, setName] = useState(initial?.name ?? "");
  const [defaultLocale, setDefaultLocale] = useState<Locale>(
    initial?.defaultLocale ?? "zh",
  );
  const [locales, setLocales] = useState<TemplateLocaleMap>(() =>
    buildInitialLocales(initial ?? null),
  );
  const initialLocaleKeys = TEMPLATE_LOCALES.filter(
    (locale) => locales[locale] !== undefined,
  );
  const [activeLocale, setActiveLocale] = useState<Locale>(
    initialLocaleKeys[0] ?? "zh",
  );
  const [editorMode, setEditorMode] = useState<"rich" | "html">("rich");
  const [showText, setShowText] = useState(() =>
    Boolean(initial?.locales.some((row) => row.textContent)),
  );
  const [version, setVersion] = useState(initial?.version ?? 1);
  const [isArchived, setIsArchived] = useState(initial?.isArchived ?? false);
  const [saving, setSaving] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmCopy, setConfirmCopy] = useState<{
    from: Locale;
    to: Locale;
  } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<Locale | null>(null);
  const [testOpen, setTestOpen] = useState(false);

  const [initialRecord, setInitialRecord] = useState<TemplateRecord | null>(
    initial ?? null,
  );

  const activeContent = locales[activeLocale];

  const presentLocales = useMemo(
    () => TEMPLATE_LOCALES.filter((locale) => locales[locale] !== undefined),
    [locales],
  );
  const missingLocales = useMemo(
    () => TEMPLATE_LOCALES.filter((locale) => locales[locale] === undefined),
    [locales],
  );

  const detectedVariables = useMemo(() => {
    const set = new Set<string>();
    if (activeContent) {
      for (const v of extractVariables(activeContent.subject)) set.add(v);
      for (const v of extractVariables(activeContent.htmlContent)) set.add(v);
      for (const v of extractVariables(activeContent.textContent)) set.add(v);
    }
    return Array.from(set);
  }, [activeContent]);

  const variablesPerLocale = useMemo(() => {
    const map: Partial<Record<Locale, string[]>> = {};
    for (const locale of TEMPLATE_LOCALES) {
      const c = locales[locale];
      if (!c) continue;
      const set = new Set<string>();
      for (const v of extractVariables(c.subject)) set.add(v);
      for (const v of extractVariables(c.htmlContent)) set.add(v);
      for (const v of extractVariables(c.textContent)) set.add(v);
      map[locale] = Array.from(set);
    }
    return map;
  }, [locales]);

  const variableUsage = useMemo(
    () => classifyVariableUsage(activeLocale, variablesPerLocale),
    [activeLocale, variablesPerLocale],
  );

  const [preview, setPreview] = useState<PreviewResp | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const previewSeqRef = useRef(0);

  const customVariables = useMemo(() => {
    // 优先用后端 preview 返回的 detectedVariables（已通过 extractAllVariables
    // 递归含片段内变量）；preview 未到达时退回前端顶层估算，避免初次渲染闪烁。
    const source =
      preview?.detectedVariables && preview.detectedVariables.length > 0
        ? preview.detectedVariables
        : detectedVariables;
    return source.filter((v) => !BUILTIN_SET.has(v));
  }, [preview?.detectedVariables, detectedVariables]);

  const [variableValues, setVariableValues] = useState<Record<string, string>>(
    {},
  );
  useEffect(() => {
    setVariableValues((prev) => {
      const next: Record<string, string> = {};
      for (const v of customVariables) next[v] = prev[v] ?? "";
      return next;
    });
  }, [customVariables]);

  const previewVariables = useMemo(() => {
    const merged: Record<string, string> = {};
    for (const v of detectedVariables) {
      if (BUILTIN_SET.has(v)) merged[v] = SAMPLE_BUILTIN[v] ?? "";
      else merged[v] = variableValues[v] ?? "";
    }
    return merged;
  }, [detectedVariables, variableValues]);

  const debouncedSubject = useDebouncedValue(activeContent?.subject ?? "", 300);
  const debouncedHtml = useDebouncedValue(activeContent?.htmlContent ?? "", 300);
  const debouncedText = useDebouncedValue(activeContent?.textContent ?? "", 300);
  const debouncedVars = useDebouncedValue(previewVariables, 300);

  useEffect(() => {
    const seq = ++previewSeqRef.current;
    if (!debouncedHtml && !debouncedSubject) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    void (async () => {
      try {
        const res = await apiPost<PreviewResp>("/api/templates/preview", {
          locale: activeLocale,
          subject: debouncedSubject,
          htmlContent: debouncedHtml,
          textContent: debouncedText || undefined,
          variables: debouncedVars,
          missingStrategy: "keep",
        });
        if (previewSeqRef.current !== seq) return;
        setPreview(res);
        setPreviewError(null);
      } catch (e) {
        if (previewSeqRef.current !== seq) return;
        setPreviewError(asMessage(e));
      }
    })();
  }, [activeLocale, debouncedSubject, debouncedHtml, debouncedText, debouncedVars]);

  function updateActiveLocale(patch: Partial<TemplateLocaleContent>) {
    setLocales((prev) => {
      const current = prev[activeLocale] ?? emptyLocaleContent();
      return {
        ...prev,
        [activeLocale]: { ...current, ...patch },
      };
    });
  }

  function switchMode(next: "rich" | "html") {
    if (next === editorMode) return;
    setEditorMode(next);
  }

  function addLocale(locale: Locale) {
    if (locales[locale]) return;
    setLocales((prev) => ({ ...prev, [locale]: emptyLocaleContent() }));
    setActiveLocale(locale);
  }

  function performCopy(from: Locale, to: Locale) {
    const source = locales[from];
    if (!source) return;
    setLocales((prev) => ({ ...prev, [to]: copyLocaleContent(source) }));
    setActiveLocale(to);
    toast({
      title: "已复制",
      description: `${LOCALE_LABELS[from]} → ${LOCALE_LABELS[to]}`,
    });
  }

  function requestCopyTo(target: Locale) {
    if (target === activeLocale) return;
    if (locales[target]) {
      setConfirmCopy({ from: activeLocale, to: target });
      return;
    }
    performCopy(activeLocale, target);
  }

  function performRemove(locale: Locale) {
    if (locale === defaultLocale) {
      toast({
        title: "无法删除默认语言",
        description: "请先切换默认语言",
        variant: "destructive",
      });
      return;
    }
    if (presentLocales.length <= 1) {
      toast({
        title: "至少需要保留一个语言版本",
        variant: "destructive",
      });
      return;
    }
    setLocales((prev) => {
      const next = { ...prev };
      delete next[locale];
      return next;
    });
    if (activeLocale === locale) {
      const fallback = presentLocales.find((l) => l !== locale) ?? defaultLocale;
      setActiveLocale(fallback);
    }
  }

  function buildFormValues(): TemplateFormValues {
    return {
      name,
      defaultLocale,
      locales: locales as TemplateFormValues["locales"],
    };
  }

  async function onSave(): Promise<void> {
    const parsed = TemplateFormSchema.safeParse(buildFormValues());
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      toast({
        title: "请检查表单",
        description: first?.message ?? "存在未填写字段",
        variant: "destructive",
      });
      return;
    }
    setSaving(true);
    try {
      if (mode === "create") {
        const payload = buildCreatePayload(parsed.data);
        const created = await apiPost<TemplateRecord>("/api/templates", payload);
        toast({ title: "已创建" });
        router.push(`/templates/${created.id}/edit`);
      } else if (initialRecord) {
        const { payload, removedLocales } = buildUpdatePayload(
          initialRecord,
          parsed.data,
        );

        let latest: TemplateRecord = initialRecord;
        if (Object.keys(payload).length > 0) {
          latest = await apiPatch<TemplateRecord>(
            `/api/templates/${initialRecord.id}`,
            payload,
          );
        }
        for (const locale of removedLocales) {
          latest = await apiDelete<TemplateRecord>(
            `/api/templates/${initialRecord.id}/locales/${locale}`,
          );
        }
        setVersion(latest.version);
        setIsArchived(latest.isArchived);
        setInitialRecord(latest);
        toast({ title: "已保存", description: `v${latest.version}` });
      }
    } catch (e) {
      const status = statusOf(e);
      toast({
        title: status === 409 ? "保存冲突" : "保存失败",
        description: asMessage(e),
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }

  async function onToggleArchive(): Promise<void> {
    if (!initialRecord) return;
    setArchiving(true);
    try {
      const url = isArchived
        ? `/api/templates/${initialRecord.id}/unarchive`
        : `/api/templates/${initialRecord.id}/archive`;
      const tpl = await apiPost<TemplateRecord>(url);
      setIsArchived(tpl.isArchived);
      setInitialRecord(tpl);
      toast({ title: isArchived ? "已取消归档" : "已归档" });
    } catch (e) {
      toast({
        title: "操作失败",
        description: asMessage(e),
        variant: "destructive",
      });
    } finally {
      setArchiving(false);
    }
  }

  async function onDelete(): Promise<void> {
    if (!initialRecord) return;
    setDeleting(true);
    try {
      await apiDelete(`/api/templates/${initialRecord.id}`);
      toast({ title: "已删除" });
      router.push("/templates");
    } catch (e) {
      toast({
        title: "删除失败",
        description: asMessage(e),
        variant: "destructive",
      });
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  return (
    <section className="space-y-4" data-testid="template-editor">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h1
              className="text-2xl font-semibold tracking-tight"
              data-testid="template-editor-heading"
            >
              {mode === "create" ? "新建模板" : "编辑模板"}
            </h1>
            {mode === "edit" ? (
              <>
                <Badge variant="outline" className="text-[10px]">
                  v{version}
                </Badge>
                {isArchived ? (
                  <Badge variant="secondary" className="text-[10px]">
                    已归档
                  </Badge>
                ) : null}
              </>
            ) : null}
          </div>
          <Link
            href="/templates"
            className="text-xs text-muted-foreground hover:underline"
            data-testid="template-editor-back"
          >
            ← 返回模板列表
          </Link>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {mode === "edit" && initialRecord ? (
            <>
              <Button
                type="button"
                variant="outline"
                onClick={() => setTestOpen(true)}
                data-testid="template-test-send-open"
              >
                测试发送
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={archiving}
                onClick={onToggleArchive}
                data-testid="template-archive-toggle"
              >
                {isArchived ? "取消归档" : "归档"}
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={deleting}
                onClick={() => setConfirmDelete(true)}
                data-testid="template-delete"
              >
                删除
              </Button>
            </>
          ) : null}
          <Button
            type="button"
            disabled={saving}
            onClick={onSave}
            data-testid="template-save"
          >
            {saving ? "保存中..." : mode === "create" ? "创建" : "保存"}
          </Button>
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* 左栏：编辑区 */}
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="template-name">名称</Label>
              <Input
                id="template-name"
                value={name}
                maxLength={128}
                onChange={(e) => setName(e.target.value)}
                data-testid="template-name"
                placeholder="欢迎邮件"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="template-default-locale">默认语言</Label>
              <Select
                id="template-default-locale"
                value={defaultLocale}
                onChange={(e) => {
                  const next = e.target.value as Locale;
                  if (!locales[next]) {
                    addLocale(next);
                  }
                  setDefaultLocale(next);
                }}
                data-testid="template-default-locale"
              >
                {TEMPLATE_LOCALES.map((locale) => (
                  <option key={locale} value={locale}>
                    {LOCALE_LABELS[locale]}
                  </option>
                ))}
              </Select>
              <p className="text-[11px] text-muted-foreground">
                收件人语言缺失时回退到此语言。
              </p>
            </div>
          </div>

          <LocaleTabBar
            present={presentLocales}
            missing={missingLocales}
            active={activeLocale}
            defaultLocale={defaultLocale}
            onSwitch={setActiveLocale}
            onAdd={addLocale}
            onRequestRemove={(locale) => setConfirmRemove(locale)}
          />

          {activeContent ? (
            <>
              <div className="space-y-2">
                <Label htmlFor="template-subject">
                  主题（支持 {`{{variable}}`}）
                </Label>
                <Input
                  id="template-subject"
                  value={activeContent.subject}
                  maxLength={512}
                  onChange={(e) => updateActiveLocale({ subject: e.target.value })}
                  data-testid={`template-subject-${activeLocale}`}
                  placeholder="欢迎 {{user_name}}！"
                />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>正文 HTML</Label>
                  <div className="flex items-center gap-2">
                    <BlockInserter
                      locale={activeLocale}
                      onInsert={(name) =>
                        updateActiveLocale({
                          htmlContent: `${activeContent.htmlContent}\n{{> ${name}}}`,
                        })
                      }
                    />
                    {presentLocales
                      .filter((l) => l !== activeLocale)
                      .map((target) => (
                        <Button
                          key={target}
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => requestCopyTo(target)}
                          data-testid={`template-copy-to-${target}`}
                        >
                          复制到 {LOCALE_LABELS[target]}
                        </Button>
                      ))}
                    <div className="inline-flex rounded-md border p-0.5 text-xs">
                      <button
                        type="button"
                        className={`rounded px-2 py-1 ${editorMode === "rich"
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground"
                          }`}
                        onClick={() => switchMode("rich")}
                        data-testid="template-mode-rich"
                      >
                        富文本
                      </button>
                      <button
                        type="button"
                        className={`rounded px-2 py-1 ${editorMode === "html"
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground"
                          }`}
                        onClick={() => switchMode("html")}
                        data-testid="template-mode-html"
                      >
                        HTML
                      </button>
                    </div>
                  </div>
                </div>
                {editorMode === "rich" ? (
                  <RichTextEditor
                    key={activeLocale}
                    value={activeContent.htmlContent}
                    onChange={(value) => updateActiveLocale({ htmlContent: value })}
                    testId={`template-rich-editor-${activeLocale}`}
                  />
                ) : (
                  <Textarea
                    value={activeContent.htmlContent}
                    onChange={(e) =>
                      updateActiveLocale({ htmlContent: e.target.value })
                    }
                    rows={16}
                    className="font-mono text-xs"
                    data-testid={`template-html-textarea-${activeLocale}`}
                    spellCheck={false}
                  />
                )}
                <p className="text-[11px] text-muted-foreground">
                  {new Blob([activeContent.htmlContent]).size.toLocaleString()} bytes / 1 MB 限制
                </p>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>纯文本版本（可选）</Label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowText((v) => !v)}
                    data-testid="template-text-toggle"
                  >
                    {showText ? "收起" : "展开"}
                  </Button>
                </div>
                {showText ? (
                  <Textarea
                    value={activeContent.textContent}
                    onChange={(e) =>
                      updateActiveLocale({ textContent: e.target.value })
                    }
                    rows={6}
                    className="font-mono text-xs"
                    data-testid={`template-text-textarea-${activeLocale}`}
                    spellCheck={false}
                    placeholder="为不支持 HTML 的客户端提供降级版本"
                  />
                ) : null}
              </div>

              <VariablePanel
                detected={detectedVariables}
                usage={variableUsage}
                customVariables={customVariables}
                values={variableValues}
                onValueChange={(name, value) =>
                  setVariableValues((prev) => ({ ...prev, [name]: value }))
                }
              />
            </>
          ) : (
            <div
              className="rounded-md border border-dashed bg-muted/30 px-4 py-12 text-center text-sm text-muted-foreground"
              data-testid="template-locale-empty"
            >
              请添加一个语言版本以开始编辑。
            </div>
          )}
        </div>

        {/* 右栏：预览 */}
        <div className="space-y-3">
          {preview?.unknownBlocks && preview.unknownBlocks.length > 0 ? (
            <div
              className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900"
              data-testid="template-preview-unknown-blocks"
            >
              <div className="font-medium">未知片段引用</div>
              <div className="mt-1 flex flex-wrap gap-1">
                {preview.unknownBlocks.map((name) => (
                  <Badge key={name} variant="outline" className="border-amber-400 bg-white">
                    {`{{> ${name}}}`}
                  </Badge>
                ))}
              </div>
              <div className="mt-1 text-[11px] text-amber-700">
                这些片段在 {LOCALE_LABELS[activeLocale]} 下未找到；保存或测试发送会被拒绝。
              </div>
            </div>
          ) : null}
          <div className="rounded-md border bg-card">
            <div className="flex items-center justify-between border-b px-3 py-2 text-xs text-muted-foreground">
              <span>主题预览（{LOCALE_LABELS[activeLocale]}）</span>
            </div>
            <div
              className="px-3 py-2 text-sm font-medium"
              data-testid="template-preview-subject"
            >
              {preview?.renderedSubject || (
                <span className="text-muted-foreground">（暂无内容）</span>
              )}
            </div>
          </div>
          <div className="overflow-hidden rounded-md border bg-card">
            <div className="flex items-center justify-between border-b px-3 py-2 text-xs text-muted-foreground">
              <span>正文预览</span>
              {previewError ? (
                <span
                  className="text-destructive"
                  data-testid="template-preview-error"
                >
                  {previewError}
                </span>
              ) : null}
            </div>
            <iframe
              title="预览"
              sandbox=""
              srcDoc={buildPreviewDoc(preview?.renderedHtml ?? "")}
              className="h-[480px] w-full bg-white"
              data-testid="template-preview-iframe"
            />
          </div>
          {preview?.renderedText ? (
            <div className="rounded-md border bg-card">
              <div className="border-b px-3 py-2 text-xs text-muted-foreground">
                纯文本预览
              </div>
              <pre
                className="max-h-48 overflow-auto whitespace-pre-wrap px-3 py-2 text-xs"
                data-testid="template-preview-text"
              >
                {preview.renderedText}
              </pre>
            </div>
          ) : null}
        </div>
      </div>

      {mode === "edit" && initialRecord ? (
        <TestSendDialog
          open={testOpen}
          template={initialRecord}
          locale={activeLocale}
          variables={previewVariables}
          onClose={() => setTestOpen(false)}
        />
      ) : null}

      <ConfirmDialog
        open={confirmDelete}
        title="删除模板"
        description={
          initialRecord
            ? `确认删除「${initialRecord.name}」？被活动引用的模板无法删除。`
            : ""
        }
        confirmLabel="删除"
        destructive
        loading={deleting}
        onOpenChange={(o) => {
          if (!o && !deleting) setConfirmDelete(false);
        }}
        onConfirm={onDelete}
      />

      <ConfirmDialog
        open={confirmCopy !== null}
        title="覆盖现有内容"
        description={
          confirmCopy
            ? `将使用「${LOCALE_LABELS[confirmCopy.from]}」的主题、HTML 和纯文本覆盖「${LOCALE_LABELS[confirmCopy.to]}」当前内容，原文不会自动翻译。`
            : ""
        }
        confirmLabel="覆盖"
        destructive
        onOpenChange={(o) => {
          if (!o) setConfirmCopy(null);
        }}
        onConfirm={async () => {
          if (confirmCopy) {
            performCopy(confirmCopy.from, confirmCopy.to);
          }
          setConfirmCopy(null);
        }}
      />

      <ConfirmDialog
        open={confirmRemove !== null}
        title="移除语言版本"
        description={
          confirmRemove
            ? `保存后会从模板中移除「${LOCALE_LABELS[confirmRemove]}」版本。`
            : ""
        }
        confirmLabel="移除"
        destructive
        onOpenChange={(o) => {
          if (!o) setConfirmRemove(null);
        }}
        onConfirm={async () => {
          if (confirmRemove) {
            performRemove(confirmRemove);
          }
          setConfirmRemove(null);
        }}
      />
    </section>
  );
}

function LocaleTabBar({
  present,
  missing,
  active,
  defaultLocale,
  onSwitch,
  onAdd,
  onRequestRemove,
}: {
  present: Locale[];
  missing: Locale[];
  active: Locale;
  defaultLocale: Locale;
  onSwitch: (locale: Locale) => void;
  onAdd: (locale: Locale) => void;
  onRequestRemove: (locale: Locale) => void;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 px-2 py-1.5"
      role="tablist"
      data-testid="template-locale-tabs"
    >
      {present.map((locale) => {
        const isActive = locale === active;
        const isDefault = locale === defaultLocale;
        const canRemove = !isDefault && present.length > 1;
        return (
          <div
            key={locale}
            className={`flex items-center gap-1 rounded-md border px-2 py-1 text-xs ${isActive
              ? "border-primary bg-primary/10 text-primary"
              : "border-transparent text-muted-foreground hover:border-input"
              }`}
          >
            <button
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => onSwitch(locale)}
              data-testid={`template-locale-tab-${locale}`}
            >
              {LOCALE_LABELS[locale]}
              {isDefault ? <span className="ml-1 text-[10px]">（默认）</span> : null}
            </button>
            {canRemove ? (
              <button
                type="button"
                aria-label={`移除 ${LOCALE_LABELS[locale]}`}
                className="rounded hover:bg-destructive/10 hover:text-destructive"
                onClick={() => onRequestRemove(locale)}
                data-testid={`template-locale-remove-${locale}`}
              >
                ×
              </button>
            ) : null}
          </div>
        );
      })}
      {missing.map((locale) => (
        <Button
          key={locale}
          type="button"
          variant="ghost"
          size="sm"
          className="text-xs"
          onClick={() => onAdd(locale)}
          data-testid={`template-locale-add-${locale}`}
        >
          + {LOCALE_LABELS[locale]}
        </Button>
      ))}
    </div>
  );
}

function buildPreviewDoc(html: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<base target="_blank" />
<style>
  body { margin: 0; padding: 16px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; color: #111; }
  img { max-width: 100%; height: auto; }
  a { color: #2563eb; }
  table { border-collapse: collapse; }
</style>
</head>
<body>${html}</body>
</html>`;
}

function VariablePanel({
  detected,
  usage,
  customVariables,
  values,
  onValueChange,
}: {
  detected: string[];
  usage: VariableUsageEntry[];
  customVariables: string[];
  values: Record<string, string>;
  onValueChange: (name: string, value: string) => void;
}) {
  const builtinUsed = detected.filter((v) => BUILTIN_SET.has(v));
  const sharedEntries = usage.filter((u) => u.status === "shared");
  const currentOnlyEntries = usage.filter((u) => u.status === "current-only");
  const missingEntries = usage.filter(
    (u) => u.status === "missing-in-current",
  );

  return (
    <div className="space-y-3 rounded-md border bg-card p-4">
      <div>
        <Label className="text-xs">检测到的变量</Label>
        <div
          className="mt-2 space-y-2"
          data-testid="template-detected-variables"
        >
          {usage.length === 0 ? (
            <span className="text-xs text-muted-foreground">未检测到变量</span>
          ) : (
            <>
              {sharedEntries.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1">
                  <span className="text-[10px] text-muted-foreground">共享：</span>
                  {sharedEntries.map((u) => (
                    <Badge
                      key={u.name}
                      variant={BUILTIN_SET.has(u.name) ? "secondary" : "outline"}
                      className="text-[10px]"
                      data-testid={`template-variable-shared-${u.name}`}
                    >
                      {`{{${u.name}}}`}
                      {BUILTIN_SET.has(u.name) ? "（内置）" : ""}
                    </Badge>
                  ))}
                </div>
              ) : null}
              {currentOnlyEntries.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1">
                  <span className="text-[10px] text-muted-foreground">仅当前语言：</span>
                  {currentOnlyEntries.map((u) => (
                    <Badge
                      key={u.name}
                      variant={BUILTIN_SET.has(u.name) ? "secondary" : "outline"}
                      className="text-[10px]"
                      data-testid={`template-variable-current-only-${u.name}`}
                    >
                      {`{{${u.name}}}`}
                      {BUILTIN_SET.has(u.name) ? "（内置）" : ""}
                    </Badge>
                  ))}
                </div>
              ) : null}
              {missingEntries.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1">
                  <span className="text-[10px] text-amber-600">
                    在其它语言出现但当前语言缺失：
                  </span>
                  {missingEntries.map((u) => (
                    <Badge
                      key={u.name}
                      variant="outline"
                      className="border-amber-400 bg-amber-50 text-[10px] text-amber-700"
                      data-testid={`template-variable-missing-${u.name}`}
                      title={`已在 ${u.presentLocales.map((l) => LOCALE_LABELS[l]).join(" / ")} 中出现`}
                    >
                      {`{{${u.name}}}`}
                    </Badge>
                  ))}
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
      {customVariables.length > 0 ? (
        <div className="space-y-2">
          <Label className="text-xs">自定义变量预览值</Label>
          <div className="grid gap-2 sm:grid-cols-2">
            {customVariables.map((v) => (
              <div key={v} className="space-y-1">
                <span className="text-[11px] text-muted-foreground">{`{{${v}}}`}</span>
                <Input
                  value={values[v] ?? ""}
                  onChange={(e) => onValueChange(v, e.target.value)}
                  data-testid={`template-var-${v}`}
                  placeholder={`示例值（${v}）`}
                />
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {builtinUsed.length > 0 ? (
        <p className="text-[11px] text-muted-foreground">
          内置变量在预览中自动注入示例值，发送时由系统填充。
        </p>
      ) : null}
      <AvailableVariablesRef />
    </div>
  );
}

const BUILTIN_DESCRIPTIONS: Record<string, string> = {
  unsubscribe_url: "退订链接 URL",
  unsubscribe_link: "退订链接（HTML <a> 标签）",
  unsubscribe_topic_url: "主题退订链接 URL",
  unsubscribe_topic_link: "主题退订链接（HTML <a> 标签）",
  user_email: "收件人邮箱",
  user_name: "收件人姓名",
  campaign_name: "活动名称",
  current_year: "当前年份",
};

function AvailableVariablesRef() {
  const [expanded, setExpanded] = useState(false);
  const { data } = useSWR<{ data: Array<{ key: string; value: string; description: string | null }> }>(
    swrKeys.environmentVariables(),
    swrFetcher,
  );
  const envVars = data?.data ?? [];

  return (
    <div className="border-t pt-3">
      <button
        type="button"
        className="flex w-full items-center justify-between text-xs font-medium text-muted-foreground hover:text-foreground"
        onClick={() => setExpanded(!expanded)}
      >
        可用变量参考
        <span className="text-[10px]">{expanded ? "收起" : "展开"}</span>
      </button>
      {expanded ? (
        <div className="mt-2 space-y-3">
          <div>
            <span className="text-[10px] font-medium text-muted-foreground">内置变量</span>
            <div className="mt-1 space-y-0.5">
              {BUILTIN_VARIABLE_NAMES.map((name) => (
                <VarRefItem key={name} name={name} description={BUILTIN_DESCRIPTIONS[name]} />
              ))}
            </div>
          </div>
          {envVars.length > 0 ? (
            <div>
              <span className="text-[10px] font-medium text-muted-foreground">环境变量</span>
              <div className="mt-1 space-y-0.5">
                {envVars.map((v) => (
                  <VarRefItem key={v.key} name={v.key} description={v.description ?? undefined} />
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function VarRefItem({ name, description }: { name: string; description?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div
      className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-muted"
      onClick={() => {
        navigator.clipboard.writeText(`{{${name}}}`);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      title="点击复制"
    >
      <code className="text-[10px] font-medium">{`{{${name}}}`}</code>
      {description ? (
        <span className="text-[10px] text-muted-foreground">{description}</span>
      ) : null}
      {copied ? (
        <span className="text-[10px] text-green-600">已复制</span>
      ) : null}
    </div>
  );
}

interface UserOption {
  id: string;
  email: string;
  name: string | null;
}

function TestSendDialog({
  open,
  template,
  locale,
  variables,
  onClose,
}: {
  open: boolean;
  template: TemplateRecord;
  locale: Locale;
  variables: Record<string, string>;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [to, setTo] = useState("");
  const [channelId, setChannelId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [userSearch, setUserSearch] = useState("");
  const debouncedUserSearch = useDebouncedValue(userSearch, 300);

  const { data: channelsData } = useSWR<{ data: Array<{ id: string; name: string; providerType: string; status: string }> }>(
    open ? "/api/sending-channels" : null,
    swrFetcher,
  );
  const channels = (channelsData?.data ?? []).filter((c) => c.status === "ACTIVE");

  const { data: usersData } = useSWR<{ data: UserOption[] }>(
    open && debouncedUserSearch.length >= 1
      ? `/api/users?q=${encodeURIComponent(debouncedUserSearch)}&pageSize=10`
      : null,
    swrFetcher,
  );
  const userOptions = usersData?.data ?? [];

  useEffect(() => {
    if (!open) {
      setTo("");
      setChannelId("");
      setUserSearch("");
      setSubmitting(false);
    }
  }, [open]);

  async function onSubmit(): Promise<void> {
    if (!to.trim()) {
      toast({ title: "请填写收件人", variant: "destructive" });
      return;
    }
    setSubmitting(true);
    try {
      await apiPost(`/api/templates/${template.id}/test-send`, {
        to: to.trim(),
        locale,
        variables,
        ...(channelId ? { channelId } : {}),
      });
      toast({
        title: "已发送",
        description: `${to.trim()}（${LOCALE_LABELS[locale]}）`,
      });
      onClose();
    } catch (e) {
      toast({
        title: "发送失败",
        description: asMessage(e),
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>测试发送</DialogTitle>
          <DialogDescription>
            当前预览所用变量值会按 {LOCALE_LABELS[locale]} 版本一同发送。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="test-send-to">收件人</Label>
            <Input
              id="test-send-to"
              type="email"
              value={to}
              onChange={(e) => { setTo(e.target.value); setUserSearch(e.target.value); }}
              placeholder="搜索用户或输入邮箱"
              data-testid="template-test-send-to"
            />
            {userOptions.length > 0 && userSearch.length >= 1 && to === userSearch && (
              <ul className="max-h-40 overflow-y-auto rounded-md border bg-popover text-sm shadow-md">
                {userOptions.map((u) => (
                  <li key={u.id}>
                    <button
                      type="button"
                      className="w-full px-3 py-1.5 text-left hover:bg-accent"
                      onClick={() => { setTo(u.email); setUserSearch(""); }}
                    >
                      <span className="font-medium">{u.email}</span>
                      {u.name ? <span className="ml-2 text-muted-foreground">{u.name}</span> : null}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="test-send-channel">发信渠道</Label>
            <Select
              id="test-send-channel"
              value={channelId}
              onChange={(e) => setChannelId(e.target.value)}
              data-testid="template-test-send-channel"
            >
              <option value="">系统默认</option>
              {channels.map((ch) => (
                <option key={ch.id} value={ch.id}>
                  {ch.name} ({ch.providerType})
                </option>
              ))}
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={submitting}
            data-testid="template-test-send-cancel"
          >
            取消
          </Button>
          <Button
            type="button"
            onClick={onSubmit}
            disabled={submitting}
            data-testid="template-test-send-submit"
          >
            {submitting ? "发送中..." : "发送"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface BlockListItem {
  id: string;
  name: string;
  category: string | null;
  locale: Locale;
}

interface BlockListResp {
  data: BlockListItem[];
}

/**
 * 编辑器内"插入片段"下拉。
 *
 * - 仅按 activeLocale 拉取 templateBlock 列表，避免误插他 locale。
 * - 选中后由父组件以 `{{> name}}` 形式追加进 htmlContent；这是最小可用形态，
 *   不做光标定位（与 RichTextEditor / Textarea 双模式兼容）。
 * - 列表为空 → 渲染 disabled 占位，提示去片段管理页创建。
 */
function BlockInserter({
  locale,
  onInsert,
}: {
  locale: Locale;
  onInsert: (name: string) => void;
}) {
  const { data, isLoading } = useSWR<BlockListResp>(
    `/api/template-blocks?locale=${locale}&pageSize=200`,
    swrFetcher,
  );
  const items = data?.data ?? [];
  return (
    <select
      className="rounded-md border bg-background px-2 py-1 text-xs"
      value=""
      onChange={(e) => {
        const v = e.target.value;
        if (!v) return;
        onInsert(v);
        e.target.value = "";
      }}
      disabled={isLoading || items.length === 0}
      data-testid={`template-block-inserter-${locale}`}
    >
      <option value="">
        {isLoading
          ? "加载片段..."
          : items.length === 0
            ? "（暂无片段）"
            : "插入片段..."}
      </option>
      {items.map((b) => (
        <option key={b.id} value={b.name}>
          {b.category ? `${b.category} / ${b.name}` : b.name}
        </option>
      ))}
    </select>
  );
}
