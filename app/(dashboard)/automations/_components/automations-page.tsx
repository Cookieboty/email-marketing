"use client";

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import type { ColumnDef } from "@tanstack/react-table";
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
import { useToast } from "@/components/ui/toast";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DataTable } from "@/components/data-table";
import { Pagination } from "@/components/pagination";
import {
  apiDelete,
  apiPatch,
  apiPost,
  swrFetcher,
} from "@/lib/api-client";
import { swrKeys } from "@/lib/swr-keys";
import {
  LOCALE_LABELS,
  type Locale,
} from "@/app/(dashboard)/templates/_components/types";
import {
  buildCreateAutomationPayload,
  buildUpdateAutomationPayload,
  forcedLocaleOptions,
  recordToFormValues,
  subjectInputLocales,
  summarizeSubjects,
  type AutomationFormValues,
  type AutomationRecord,
  type AutomationTriggerType,
  type LocaleStrategy,
  type TemplateOption,
} from "./automation-multilingual-helpers";

const TRIGGER_TYPE_LABELS: Record<AutomationTriggerType, string> = {
  USER_CREATED: "用户创建",
  TAG_CHANGED: "标签变更",
  BIRTHDAY: "生日",
  REENGAGEMENT: "唤回",
  CUSTOM_EVENT: "自定义事件",
};

const STATUS_LABELS: Record<string, string> = {
  ENABLED: "启用",
  DISABLED: "停用",
};

const TRIGGER_TYPES: AutomationTriggerType[] = [
  "USER_CREATED",
  "TAG_CHANGED",
  "BIRTHDAY",
  "REENGAGEMENT",
  "CUSTOM_EVENT",
];

interface ListResp {
  data: AutomationRecord[];
  total: number;
  page: number;
  pageSize: number;
}

function asMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return "操作失败";
}

function emptyValues(): AutomationFormValues {
  return {
    name: "",
    triggerType: "USER_CREATED",
    templateId: "",
    subjects: {},
    localeStrategy: "AUTO",
    forcedLocale: "",
    delayMinutes: 0,
  };
}

export default function AutomationsPage() {
  const { toast } = useToast();
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [statusFilter, setStatusFilter] = useState<string>("");

  const params: Record<string, string> = {
    page: String(page),
    pageSize: String(pageSize),
  };
  if (statusFilter) params.status = statusFilter;

  const key = swrKeys.automations(params);
  const { data, isLoading, mutate } = useSWR<ListResp>(key, swrFetcher, {
    keepPreviousData: true,
  });

  const { data: templates } = useSWR<{ data: TemplateOption[] }>(
    "/api/templates?pageSize=100",
    swrFetcher,
  );

  const [editing, setEditing] = useState<AutomationRecord | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleting, setDeleting] = useState<AutomationRecord | null>(null);

  async function toggleStatus(row: AutomationRecord) {
    const next = row.status === "ENABLED" ? "DISABLED" : "ENABLED";
    try {
      await apiPatch(`/api/automations/${row.id}`, { status: next });
      toast({ title: next === "ENABLED" ? "已启用" : "已停用" });
      await mutate();
    } catch (e) {
      toast({
        title: "操作失败",
        description: asMessage(e),
        variant: "destructive",
      });
    }
  }

  const columns: ColumnDef<AutomationRecord>[] = [
    {
      accessorKey: "name",
      header: "名称",
      cell: ({ row }) => (
        <span className="font-medium">{row.original.name}</span>
      ),
    },
    {
      accessorKey: "triggerType",
      header: "触发类型",
      cell: ({ row }) => (
        <Badge variant="outline">
          {TRIGGER_TYPE_LABELS[row.original.triggerType] ??
            row.original.triggerType}
        </Badge>
      ),
    },
    {
      id: "subjects",
      header: "邮件主题",
      cell: ({ row }) => {
        const summary = summarizeSubjects(row.original.subjects);
        if (summary) {
          return (
            <span
              className="max-w-[260px] truncate text-sm"
              data-testid={`automation-subjects-${row.original.id}`}
            >
              {summary}
            </span>
          );
        }
        if (row.original.templateId) {
          return (
            <span className="text-xs text-muted-foreground">
              使用模板内容
            </span>
          );
        }
        return <span className="text-xs text-muted-foreground">-</span>;
      },
    },
    {
      id: "localeStrategy",
      header: "语言策略",
      cell: ({ row }) => {
        if (row.original.localeStrategy === "FORCE") {
          return (
            <Badge variant="secondary">
              FORCE ·{" "}
              {row.original.forcedLocale
                ? LOCALE_LABELS[row.original.forcedLocale]
                : "-"}
            </Badge>
          );
        }
        return <Badge variant="outline">AUTO</Badge>;
      },
    },
    {
      accessorKey: "delayMinutes",
      header: "延迟",
      cell: ({ row }) => {
        const m = row.original.delayMinutes;
        if (m === 0) return <span className="text-muted-foreground">立即</span>;
        if (m < 60) return `${m} 分钟`;
        if (m < 1440) return `${Math.round(m / 60)} 小时`;
        return `${Math.round(m / 1440)} 天`;
      },
    },
    {
      accessorKey: "status",
      header: "状态",
      cell: ({ row }) => (
        <Badge
          variant={row.original.status === "ENABLED" ? "default" : "secondary"}
        >
          {STATUS_LABELS[row.original.status] ?? row.original.status}
        </Badge>
      ),
    },
    {
      id: "actions",
      header: "操作",
      cell: ({ row }) => (
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => toggleStatus(row.original)}
          >
            {row.original.status === "ENABLED" ? "停用" : "启用"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setEditing(row.original)}
          >
            编辑
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={() => setDeleting(row.original)}
          >
            删除
          </Button>
        </div>
      ),
    },
  ];

  const total = data?.total ?? 0;
  const rows = data?.data ?? [];

  return (
    <section className="space-y-4">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">自动化</h1>
        <Button type="button" onClick={() => setCreateOpen(true)}>
          新增自动化
        </Button>
      </header>

      <div className="grid gap-3 rounded-md border bg-card p-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">
            状态筛选
          </label>
          <Select
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setPage(1);
            }}
          >
            <option value="">全部</option>
            <option value="ENABLED">启用</option>
            <option value="DISABLED">停用</option>
          </Select>
        </div>
      </div>

      <DataTable
        columns={columns}
        data={rows}
        loading={isLoading}
        emptyText="暂无自动化规则"
      />
      <Pagination
        page={page}
        pageSize={pageSize}
        total={total}
        onPageChange={(p) => {
          setPage(p);
          mutate();
        }}
      />

      <AutomationFormDialog
        open={createOpen}
        mode="create"
        templates={templates?.data ?? []}
        initialValues={emptyValues()}
        onClose={() => setCreateOpen(false)}
        onSubmit={async (values, template) => {
          const { payload, errors } = buildCreateAutomationPayload(
            values,
            template,
          );
          if (!payload) {
            toast({
              title: "请检查表单",
              description: errors[0]?.message ?? "存在校验错误",
              variant: "destructive",
            });
            return false;
          }
          try {
            await apiPost("/api/automations", payload);
            toast({ title: "已创建" });
            await mutate();
            return true;
          } catch (e) {
            toast({
              title: "创建失败",
              description: asMessage(e),
              variant: "destructive",
            });
            return false;
          }
        }}
      />

      <AutomationFormDialog
        open={editing !== null}
        mode="edit"
        templates={templates?.data ?? []}
        initialValues={editing ? recordToFormValues(editing) : emptyValues()}
        onClose={() => setEditing(null)}
        onSubmit={async (values, template) => {
          if (!editing) return false;
          const { payload, errors, hasChanges } = buildUpdateAutomationPayload(
            values,
            editing,
            template,
          );
          if (!hasChanges) {
            toast({ title: "未做修改" });
            return true;
          }
          if (!payload) {
            toast({
              title: "请检查表单",
              description: errors[0]?.message ?? "存在校验错误",
              variant: "destructive",
            });
            return false;
          }
          try {
            await apiPatch(`/api/automations/${editing.id}`, payload);
            toast({ title: "已保存" });
            await mutate();
            return true;
          } catch (e) {
            toast({
              title: "保存失败",
              description: asMessage(e),
              variant: "destructive",
            });
            return false;
          }
        }}
      />

      <ConfirmDialog
        open={deleting !== null}
        title="删除自动化"
        description={
          deleting
            ? `确认删除「${deleting.name}」？关联的运行记录也会被清除。`
            : ""
        }
        confirmLabel="删除"
        destructive
        onOpenChange={(o) => {
          if (!o) setDeleting(null);
        }}
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await apiDelete(`/api/automations/${deleting.id}`);
            toast({ title: "已删除" });
            await mutate();
          } catch (e) {
            toast({
              title: "删除失败",
              description: asMessage(e),
              variant: "destructive",
            });
          } finally {
            setDeleting(null);
          }
        }}
      />
    </section>
  );
}

interface AutomationFormDialogProps {
  open: boolean;
  mode: "create" | "edit";
  templates: TemplateOption[];
  initialValues: AutomationFormValues;
  onClose: () => void;
  onSubmit: (
    values: AutomationFormValues,
    template: TemplateOption | null,
  ) => Promise<boolean>;
}

function AutomationFormDialog({
  open,
  mode,
  templates,
  initialValues,
  onClose,
  onSubmit,
}: AutomationFormDialogProps) {
  const [values, setValues] = useState<AutomationFormValues>(initialValues);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) setValues(initialValues);
  }, [open, initialValues]);

  const selectedTemplate = useMemo<TemplateOption | null>(() => {
    if (!values.templateId) return null;
    return templates.find((t) => t.id === values.templateId) ?? null;
  }, [templates, values.templateId]);

  const allowedLocales = useMemo(
    () => forcedLocaleOptions(selectedTemplate),
    [selectedTemplate],
  );

  const subjectLocales = useMemo(
    () => subjectInputLocales(values, selectedTemplate),
    [values, selectedTemplate],
  );

  useEffect(() => {
    if (
      values.localeStrategy === "FORCE" &&
      values.forcedLocale &&
      !allowedLocales.includes(values.forcedLocale as Locale)
    ) {
      setValues((prev) => ({
        ...prev,
        forcedLocale: allowedLocales[0] ?? "",
      }));
    }
  }, [allowedLocales, values.localeStrategy, values.forcedLocale]);

  function upd(patch: Partial<AutomationFormValues>) {
    setValues((prev) => ({ ...prev, ...patch }));
  }

  function updateSubject(locale: Locale, value: string) {
    setValues((prev) => ({
      ...prev,
      subjects: { ...prev.subjects, [locale]: value },
    }));
  }

  async function handleSave() {
    setSubmitting(true);
    try {
      const ok = await onSubmit(values, selectedTemplate);
      if (ok) onClose();
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
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {mode === "create" ? "新增自动化" : "编辑自动化"}
          </DialogTitle>
          <DialogDescription>
            配置触发条件、模板与多语言邮件主题。
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void handleSave();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="auto-name">名称</Label>
            <Input
              id="auto-name"
              autoFocus
              value={values.name}
              onChange={(e) => upd({ name: e.target.value })}
              data-testid="automation-input-name"
            />
          </div>

          <div className="space-y-1.5">
            <Label>触发类型</Label>
            <Select
              value={values.triggerType}
              onChange={(e) =>
                upd({
                  triggerType: e.target.value as AutomationTriggerType,
                })
              }
              data-testid="automation-select-trigger"
            >
              {TRIGGER_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TRIGGER_TYPE_LABELS[t]}
                </option>
              ))}
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>模板</Label>
            <Select
              value={values.templateId}
              onChange={(e) => upd({ templateId: e.target.value })}
              data-testid="automation-select-template"
            >
              <option value="">不关联模板（直接使用主题）</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}（
                  {t.availableLocales
                    .map((loc) => LOCALE_LABELS[loc])
                    .join(" / ")}
                  ）
                </option>
              ))}
            </Select>
            {selectedTemplate ? (
              <p
                className="text-xs text-muted-foreground"
                data-testid="automation-template-summary"
              >
                默认语言：{LOCALE_LABELS[selectedTemplate.defaultLocale]} ·
                可用语言：
                {selectedTemplate.availableLocales
                  .map((loc) => LOCALE_LABELS[loc])
                  .join(" / ")}
              </p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label>语言策略</Label>
            <div className="flex flex-wrap gap-3 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="auto-locale-strategy"
                  value="AUTO"
                  checked={values.localeStrategy === "AUTO"}
                  onChange={() =>
                    upd({ localeStrategy: "AUTO", forcedLocale: "" })
                  }
                  data-testid="automation-radio-auto"
                />
                按收件人语言自动选择 (AUTO)
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="auto-locale-strategy"
                  value="FORCE"
                  checked={values.localeStrategy === "FORCE"}
                  onChange={() =>
                    upd({
                      localeStrategy: "FORCE" as LocaleStrategy,
                      forcedLocale:
                        (values.forcedLocale as Locale | "") ||
                        allowedLocales[0] ||
                        "",
                    })
                  }
                  data-testid="automation-radio-force"
                />
                强制使用指定语言 (FORCE)
              </label>
            </div>
            {values.localeStrategy === "FORCE" && (
              <div className="space-y-1.5">
                <Label>强制语言</Label>
                <Select
                  value={values.forcedLocale}
                  onChange={(e) =>
                    upd({ forcedLocale: e.target.value as Locale | "" })
                  }
                  data-testid="automation-select-forced-locale"
                >
                  <option value="">选择语言</option>
                  {allowedLocales.map((loc) => (
                    <option key={loc} value={loc}>
                      {LOCALE_LABELS[loc]}
                    </option>
                  ))}
                </Select>
                {selectedTemplate && allowedLocales.length === 0 && (
                  <p className="text-xs text-destructive">
                    所选模板未配置任何语言，无法启用强制策略。
                  </p>
                )}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <Label>邮件主题</Label>
            <p className="text-xs text-muted-foreground">
              {values.templateId
                ? "留空则使用模板对应语言的主题。"
                : "未选择模板时，至少填写一个语言的主题。"}
            </p>
            <div className="space-y-2">
              {subjectLocales.map((loc) => (
                <div
                  key={loc}
                  className="space-y-1"
                  data-testid={`automation-subject-${loc}`}
                >
                  <Label className="text-xs text-muted-foreground">
                    {LOCALE_LABELS[loc]} 主题
                  </Label>
                  <Input
                    value={values.subjects[loc] ?? ""}
                    onChange={(e) => updateSubject(loc, e.target.value)}
                    placeholder={`${LOCALE_LABELS[loc]} subject`}
                    data-testid={`automation-input-subject-${loc}`}
                  />
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="auto-delay">延迟（分钟）</Label>
            <Input
              id="auto-delay"
              type="number"
              min={0}
              value={values.delayMinutes}
              onChange={(e) =>
                upd({ delayMinutes: Number(e.target.value) || 0 })
              }
              data-testid="automation-input-delay"
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              取消
            </Button>
            <Button
              type="submit"
              disabled={submitting}
              data-testid="automation-submit"
            >
              {submitting ? "保存中..." : "保存"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
