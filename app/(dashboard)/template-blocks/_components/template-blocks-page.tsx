"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import type { ColumnDef } from "@tanstack/react-table";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
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
import { DataTable } from "@/components/data-table";
import { Pagination } from "@/components/pagination";
import {
  apiDelete,
  apiPatch,
  apiPost,
  swrFetcher,
  type ApiClientError,
} from "@/lib/api-client";
import { swrKeys } from "@/lib/swr-keys";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { BUILTIN_VARIABLE_NAMES } from "@/lib/template-engine";

interface BlockRow {
  id: string;
  name: string;
  category: string | null;
  locale: "zh" | "en";
  htmlContent: string;
  variables: string[];
  isSystem: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ListResp {
  data: BlockRow[];
  total: number;
  page: number;
  pageSize: number;
}

const FormSchema = z.object({
  name: z.string().trim().min(1, "请输入名称").max(128),
  category: z.string().trim().max(64).optional(),
  locale: z.enum(["zh", "en"]),
  htmlContent: z.string().min(1, "请输入 HTML 内容"),
});
type FormValues = z.infer<typeof FormSchema>;

const BLOCK_LOCALE_LABELS: Record<"zh" | "en", string> = {
  zh: "中文",
  en: "English",
};

type LocaleFilter = "all" | "zh" | "en";

function asMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return "操作失败";
}

export default function TemplateBlocksPage() {
  const { toast } = useToast();
  const [page, setPage] = useState(1);
  const [pageSize] = useState(50);
  const [q, setQ] = useState("");
  const [localeFilter, setLocaleFilter] = useState<LocaleFilter>("all");
  const debouncedQ = useDebouncedValue(q, 300);

  const key = `${swrKeys.templateBlocks()}?${new URLSearchParams({
    ...(debouncedQ ? { q: debouncedQ } : {}),
    ...(localeFilter !== "all" ? { locale: localeFilter } : {}),
    page: String(page),
    pageSize: String(pageSize),
  }).toString()}`;

  const { data, isLoading, mutate } = useSWR<ListResp>(key, swrFetcher, {
    keepPreviousData: true,
  });

  const [editing, setEditing] = useState<BlockRow | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleting, setDeleting] = useState<BlockRow | null>(null);

  const columns = useMemo<ColumnDef<BlockRow>[]>(
    () => [
      {
        accessorKey: "name",
        header: "名称",
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            <span className="font-medium">{row.original.name}</span>
            {row.original.isSystem && (
              <Badge variant="secondary" className="text-[10px]">系统</Badge>
            )}
          </div>
        ),
      },
      {
        accessorKey: "category",
        header: "分类",
        cell: ({ row }) =>
          row.original.category ? (
            <Badge variant="outline">{row.original.category}</Badge>
          ) : (
            <span className="text-muted-foreground">-</span>
          ),
      },
      {
        accessorKey: "locale",
        header: "语言",
        cell: ({ row }) => (
          <Badge
            variant="secondary"
            className="text-[10px]"
            data-testid={`block-locale-${row.original.id}`}
          >
            {BLOCK_LOCALE_LABELS[row.original.locale]}
          </Badge>
        ),
      },
      {
        accessorKey: "variables",
        header: "变量",
        cell: ({ row }) =>
          row.original.variables.length > 0 ? (
            <span className="text-xs text-muted-foreground">
              {row.original.variables.join(", ")}
            </span>
          ) : (
            <span className="text-muted-foreground">-</span>
          ),
      },
      {
        accessorKey: "updatedAt",
        header: "更新时间",
        cell: ({ row }) => new Date(row.original.updatedAt).toLocaleString(),
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
              onClick={() => setEditing(row.original)}
            >
              编辑
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={row.original.isSystem}
              onClick={() => setDeleting(row.original)}
            >
              删除
            </Button>
          </div>
        ),
      },
    ],
    [],
  );

  const total = data?.total ?? 0;
  const rows = data?.data ?? [];

  return (
    <section className="space-y-4">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">模板片段</h1>
        <Button type="button" onClick={() => setCreateOpen(true)}>
          新增片段
        </Button>
      </header>

      <div className="grid gap-3 rounded-md border bg-card p-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">搜索</label>
          <Input
            placeholder="按名称模糊搜索"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <div className="space-y-1.5">
          <label
            className="text-xs font-medium text-muted-foreground"
            htmlFor="block-locale-filter"
          >
            语言
          </label>
          <select
            id="block-locale-filter"
            data-testid="block-locale-filter"
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            value={localeFilter}
            onChange={(e) => {
              setLocaleFilter(e.target.value as LocaleFilter);
              setPage(1);
            }}
          >
            <option value="all">全部</option>
            <option value="zh">中文</option>
            <option value="en">English</option>
          </select>
        </div>
      </div>

      <DataTable columns={columns} data={rows} loading={isLoading} emptyText="暂无模板片段" />
      <Pagination
        page={page}
        pageSize={pageSize}
        total={total}
        onPageChange={(p) => {
          setPage(p);
          mutate();
        }}
      />

      <BlockFormDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="新增模板片段"
        description="输入名称、分类（可选）、语言和 HTML 内容"
        submit={async (v) => {
          await apiPost("/api/template-blocks", {
            name: v.name,
            category: v.category || null,
            locale: v.locale,
            htmlContent: v.htmlContent,
          });
          toast({ title: "已创建" });
          await mutate();
        }}
      />

      <BlockFormDialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title="编辑模板片段"
        description="修改名称、分类、语言或内容"
        defaults={
          editing
            ? {
              name: editing.name,
              category: editing.category ?? "",
              locale: editing.locale,
              htmlContent: editing.htmlContent,
            }
            : undefined
        }
        submit={async (v) => {
          if (!editing) return;
          const payload: Record<string, unknown> = {};
          if (v.name !== editing.name) payload.name = v.name;
          if ((v.category ?? "") !== (editing.category ?? "")) {
            payload.category = v.category || null;
          }
          if (v.locale !== editing.locale) payload.locale = v.locale;
          if (v.htmlContent !== editing.htmlContent) payload.htmlContent = v.htmlContent;
          if (Object.keys(payload).length === 0) {
            toast({ title: "未做修改" });
            return;
          }
          await apiPatch(`/api/template-blocks/${editing.id}`, payload);
          toast({ title: "已保存" });
          await mutate();
        }}
      />

      <ConfirmDialog
        open={deleting !== null}
        title="删除模板片段"
        description={deleting ? `确认删除「${deleting.name}」？此操作不可恢复。` : ""}
        confirmLabel="删除"
        destructive
        onOpenChange={(o) => {
          if (!o) setDeleting(null);
        }}
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await apiDelete(`/api/template-blocks/${deleting.id}`);
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

function BlockFormDialog({
  open,
  onClose,
  title,
  description,
  defaults,
  submit,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  defaults?: FormValues;
  submit: (v: FormValues) => Promise<void>;
}) {
  const { toast } = useToast();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    reset,
  } = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    values:
      defaults ?? { name: "", category: "", locale: "zh", htmlContent: "" },
  });

  async function onSubmit(v: FormValues) {
    try {
      await submit(v);
      reset();
      onClose();
    } catch (e) {
      const err = e as ApiClientError;
      toast({
        title: "保存失败",
        description: asMessage(err),
        variant: "destructive",
      });
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          reset();
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="block-name">名称</Label>
              <Input id="block-name" autoFocus {...register("name")} />
              {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="block-category">分类</Label>
              <Input id="block-category" placeholder="如：页头、页脚、CTA" {...register("category")} />
              {errors.category && <p className="text-xs text-destructive">{errors.category.message}</p>}
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="block-locale">语言</Label>
              <select
                id="block-locale"
                data-testid="block-form-locale"
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                {...register("locale")}
              >
                <option value="zh">中文</option>
                <option value="en">English</option>
              </select>
              {errors.locale && <p className="text-xs text-destructive">{errors.locale.message}</p>}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="block-html">HTML 内容</Label>
            <Textarea
              id="block-html"
              rows={10}
              className="font-mono text-xs"
              {...register("htmlContent")}
            />
            {errors.htmlContent && <p className="text-xs text-destructive">{errors.htmlContent.message}</p>}
          </div>
          <BlockAvailableVariablesRef />
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                reset();
                onClose();
              }}
            >
              取消
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "保存中..." : "保存"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
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

function BlockAvailableVariablesRef() {
  const [expanded, setExpanded] = useState(false);
  const { data } = useSWR<{ data: Array<{ key: string; description: string | null }> }>(
    swrKeys.environmentVariables(),
    swrFetcher,
  );
  const envVars = data?.data ?? [];

  return (
    <div className="rounded-md border bg-muted/30 p-3">
      <button
        type="button"
        className="flex w-full items-center justify-between text-xs font-medium text-muted-foreground hover:text-foreground"
        onClick={() => setExpanded(!expanded)}
      >
        可用变量参考
        <span className="text-[10px]">{expanded ? "收起" : "展开"}</span>
      </button>
      {expanded ? (
        <div className="mt-2 space-y-2">
          <div>
            <span className="text-[10px] font-medium text-muted-foreground">内置变量</span>
            <div className="mt-1 flex flex-wrap gap-1">
              {BUILTIN_VARIABLE_NAMES.map((name) => (
                <span
                  key={name}
                  className="cursor-pointer rounded bg-muted px-1.5 py-0.5 text-[10px] font-mono hover:bg-accent"
                  title={BUILTIN_DESCRIPTIONS[name] ?? name}
                  onClick={() => navigator.clipboard.writeText(`{{${name}}}`)}
                >
                  {`{{${name}}}`}
                </span>
              ))}
            </div>
          </div>
          {envVars.length > 0 ? (
            <div>
              <span className="text-[10px] font-medium text-muted-foreground">环境变量</span>
              <div className="mt-1 flex flex-wrap gap-1">
                {envVars.map((v) => (
                  <span
                    key={v.key}
                    className="cursor-pointer rounded bg-muted px-1.5 py-0.5 text-[10px] font-mono hover:bg-accent"
                    title={v.description ?? v.key}
                    onClick={() => navigator.clipboard.writeText(`{{${v.key}}}`)}
                  >
                    {`{{${v.key}}}`}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
          <p className="text-[10px] text-muted-foreground">点击变量名可复制到剪贴板</p>
        </div>
      ) : null}
    </div>
  );
}

