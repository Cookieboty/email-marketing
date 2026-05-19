"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
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
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { RichTextEditor } from "@/components/rich-text-editor";
import {
  apiDelete,
  apiPatch,
  apiPost,
} from "@/lib/api-client";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import {
  BUILTIN_VARIABLE_NAMES,
  extractVariables,
} from "@/lib/template-engine";

export interface TemplateRecord {
  id: string;
  name: string;
  subject: string;
  htmlContent: string;
  textContent: string | null;
  variables: string[];
  version: number;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
}

interface PreviewResp {
  renderedSubject: string;
  renderedHtml: string;
  renderedText: string | null;
  detectedVariables: string[];
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
  const [subject, setSubject] = useState(initial?.subject ?? "");
  const [htmlContent, setHtmlContent] = useState(initial?.htmlContent ?? "");
  const [textContent, setTextContent] = useState(initial?.textContent ?? "");
  const [editorMode, setEditorMode] = useState<"rich" | "html">("rich");
  const [showText, setShowText] = useState(Boolean(initial?.textContent));
  const [version, setVersion] = useState(initial?.version ?? 1);
  const [isArchived, setIsArchived] = useState(initial?.isArchived ?? false);
  const [saving, setSaving] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [testOpen, setTestOpen] = useState(false);

  const detectedVariables = useMemo(() => {
    const set = new Set<string>();
    for (const v of extractVariables(subject)) set.add(v);
    for (const v of extractVariables(htmlContent)) set.add(v);
    for (const v of extractVariables(textContent)) set.add(v);
    return Array.from(set);
  }, [subject, htmlContent, textContent]);

  const customVariables = useMemo(
    () => detectedVariables.filter((v) => !BUILTIN_SET.has(v)),
    [detectedVariables],
  );

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

  const debouncedSubject = useDebouncedValue(subject, 300);
  const debouncedHtml = useDebouncedValue(htmlContent, 300);
  const debouncedText = useDebouncedValue(textContent, 300);
  const debouncedVars = useDebouncedValue(previewVariables, 300);

  const [preview, setPreview] = useState<PreviewResp | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const previewSeqRef = useRef(0);

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
  }, [debouncedSubject, debouncedHtml, debouncedText, debouncedVars]);

  function switchMode(next: "rich" | "html") {
    if (next === editorMode) return;
    setEditorMode(next);
  }

  async function onSave(): Promise<void> {
    if (!name.trim()) {
      toast({ title: "请填写模板名称", variant: "destructive" });
      return;
    }
    if (!subject.trim()) {
      toast({ title: "请填写主题", variant: "destructive" });
      return;
    }
    if (!htmlContent.trim()) {
      toast({ title: "请填写 HTML 内容", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      if (mode === "create") {
        const created = await apiPost<TemplateRecord>("/api/templates", {
          name: name.trim(),
          subject: subject.trim(),
          htmlContent,
          textContent: textContent.trim() ? textContent : undefined,
        });
        toast({ title: "已创建" });
        router.push(`/templates/${created.id}/edit`);
      } else if (initial) {
        const updated = await apiPatch<TemplateRecord>(
          `/api/templates/${initial.id}`,
          {
            name: name.trim(),
            subject: subject.trim(),
            htmlContent,
            textContent: textContent.trim() ? textContent : null,
          },
        );
        setVersion(updated.version);
        setIsArchived(updated.isArchived);
        toast({ title: "已保存", description: `v${updated.version}` });
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
    if (!initial) return;
    setArchiving(true);
    try {
      const url = isArchived
        ? `/api/templates/${initial.id}/unarchive`
        : `/api/templates/${initial.id}/archive`;
      const tpl = await apiPost<TemplateRecord>(url);
      setIsArchived(tpl.isArchived);
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
    if (!initial) return;
    setDeleting(true);
    try {
      await apiDelete(`/api/templates/${initial.id}`);
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
          {mode === "edit" && initial ? (
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
            <Label htmlFor="template-subject">
              主题（支持 {`{{variable}}`}）
            </Label>
            <Input
              id="template-subject"
              value={subject}
              maxLength={512}
              onChange={(e) => setSubject(e.target.value)}
              data-testid="template-subject"
              placeholder="欢迎 {{user_name}}！"
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>正文 HTML</Label>
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
            {editorMode === "rich" ? (
              <RichTextEditor
                value={htmlContent}
                onChange={setHtmlContent}
                testId="template-rich-editor"
              />
            ) : (
              <Textarea
                value={htmlContent}
                onChange={(e) => setHtmlContent(e.target.value)}
                rows={16}
                className="font-mono text-xs"
                data-testid="template-html-textarea"
                spellCheck={false}
              />
            )}
            <p className="text-[11px] text-muted-foreground">
              {new Blob([htmlContent]).size.toLocaleString()} bytes / 1 MB 限制
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
                value={textContent}
                onChange={(e) => setTextContent(e.target.value)}
                rows={6}
                className="font-mono text-xs"
                data-testid="template-text-textarea"
                spellCheck={false}
                placeholder="为不支持 HTML 的客户端提供降级版本"
              />
            ) : null}
          </div>

          <VariablePanel
            detected={detectedVariables}
            customVariables={customVariables}
            values={variableValues}
            onValueChange={(name, value) =>
              setVariableValues((prev) => ({ ...prev, [name]: value }))
            }
          />
        </div>

        {/* 右栏：预览 */}
        <div className="space-y-3">
          <div className="rounded-md border bg-card">
            <div className="border-b px-3 py-2 text-xs text-muted-foreground">
              主题预览
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

      {mode === "edit" && initial ? (
        <TestSendDialog
          open={testOpen}
          template={initial}
          variables={previewVariables}
          onClose={() => setTestOpen(false)}
        />
      ) : null}

      <ConfirmDialog
        open={confirmDelete}
        title="删除模板"
        description={
          initial
            ? `确认删除「${initial.name}」？被活动引用的模板无法删除。`
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
    </section >
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
  customVariables,
  values,
  onValueChange,
}: {
  detected: string[];
  customVariables: string[];
  values: Record<string, string>;
  onValueChange: (name: string, value: string) => void;
}) {
  const builtinUsed = detected.filter((v) => BUILTIN_SET.has(v));

  return (
    <div className="space-y-3 rounded-md border bg-card p-4">
      <div>
        <Label className="text-xs">检测到的变量</Label>
        <div
          className="mt-2 flex flex-wrap gap-1"
          data-testid="template-detected-variables"
        >
          {detected.length === 0 ? (
            <span className="text-xs text-muted-foreground">未检测到变量</span>
          ) : (
            detected.map((v) => (
              <Badge
                key={v}
                variant={BUILTIN_SET.has(v) ? "secondary" : "outline"}
                className="text-[10px]"
              >
                {`{{${v}}}`}
                {BUILTIN_SET.has(v) ? "（内置）" : ""}
              </Badge>
            ))
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
    </div>
  );
}

function TestSendDialog({
  open,
  template,
  variables,
  onClose,
}: {
  open: boolean;
  template: TemplateRecord;
  variables: Record<string, string>;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [to, setTo] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      setTo("");
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
        variables,
      });
      toast({ title: "已发送", description: to.trim() });
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
            收件人必须配置在 <code>ADMIN_TEST_EMAILS</code> 白名单中。当前预览所用变量值会一同发送。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="test-send-to">收件人</Label>
            <Input
              id="test-send-to"
              type="email"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="admin@example.com"
              data-testid="template-test-send-to"
            />
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
