"use client";

import { useState } from "react";
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
  type ApiClientError,
} from "@/lib/api-client";
import { swrKeys } from "@/lib/swr-keys";

const TRIGGER_TYPE_LABELS: Record<string, string> = {
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

interface AutomationRow {
  id: string;
  name: string;
  triggerType: string;
  subject: string;
  delayMinutes: number;
  status: string;
  templateId: string | null;
  triggerConfig: Record<string, unknown>;
  conditions: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

interface ListResp {
  data: AutomationRow[];
  total: number;
  page: number;
  pageSize: number;
}

const TRIGGER_TYPES = ["USER_CREATED", "TAG_CHANGED", "BIRTHDAY", "REENGAGEMENT", "CUSTOM_EVENT"] as const;

const FormSchema = z.object({
  name: z.string().trim().min(1, "请输入名称").max(120),
  triggerType: z.enum(TRIGGER_TYPES, { required_error: "请选择触发类型" }),
  subject: z.string().trim().min(1, "请输入邮件主题").max(255),
  delayMinutes: z.coerce.number().int().min(0).max(525600).default(0),
  templateId: z.string().optional(),
});
type FormValues = z.infer<typeof FormSchema>;

function asMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return "操作失败";
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

  const [editing, setEditing] = useState<AutomationRow | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleting, setDeleting] = useState<AutomationRow | null>(null);

  async function toggleStatus(row: AutomationRow) {
    const next = row.status === "ENABLED" ? "DISABLED" : "ENABLED";
    try {
      await apiPatch(`/api/automations/${row.id}`, { status: next });
      toast({ title: next === "ENABLED" ? "已启用" : "已停用" });
      await mutate();
    } catch (e) {
      toast({ title: "操作失败", description: asMessage(e), variant: "destructive" });
    }
  }

  const columns: ColumnDef<AutomationRow>[] = [
      {
        accessorKey: "name",
        header: "名称",
        cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
      },
      {
        accessorKey: "triggerType",
        header: "触发类型",
        cell: ({ row }) => (
          <Badge variant="outline">
            {TRIGGER_TYPE_LABELS[row.original.triggerType] ?? row.original.triggerType}
          </Badge>
        ),
      },
      {
        accessorKey: "subject",
        header: "邮件主题",
        cell: ({ row }) => (
          <span className="max-w-[200px] truncate text-sm">{row.original.subject}</span>
        ),
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
          <Badge variant={row.original.status === "ENABLED" ? "default" : "secondary"}>
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
          <label className="text-xs font-medium text-muted-foreground">状态筛选</label>
          <Select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}>
            <option value="">全部</option>
            <option value="ENABLED">启用</option>
            <option value="DISABLED">停用</option>
          </Select>
        </div>
      </div>

      <DataTable columns={columns} data={rows} loading={isLoading} emptyText="暂无自动化规则" />
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
        onClose={() => setCreateOpen(false)}
        title="新增自动化"
        description="配置自动化触发条件和邮件"
        submit={async (v) => {
          await apiPost("/api/automations", {
            name: v.name,
            triggerType: v.triggerType,
            triggerConfig: {},
            subject: v.subject,
            delayMinutes: v.delayMinutes,
            templateId: v.templateId || undefined,
          });
          toast({ title: "已创建" });
          await mutate();
        }}
      />

      <AutomationFormDialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title="编辑自动化"
        description="修改自动化配置"
        defaults={
          editing
            ? {
                name: editing.name,
                triggerType: editing.triggerType as FormValues["triggerType"],
                subject: editing.subject,
                delayMinutes: editing.delayMinutes,
                templateId: editing.templateId ?? "",
              }
            : undefined
        }
        submit={async (v) => {
          if (!editing) return;
          const payload: Record<string, unknown> = {};
          if (v.name !== editing.name) payload.name = v.name;
          if (v.triggerType !== editing.triggerType) payload.triggerType = v.triggerType;
          if (v.subject !== editing.subject) payload.subject = v.subject;
          if (v.delayMinutes !== editing.delayMinutes) payload.delayMinutes = v.delayMinutes;
          if ((v.templateId ?? "") !== (editing.templateId ?? "")) {
            payload.templateId = v.templateId || null;
          }
          if (Object.keys(payload).length === 0) {
            toast({ title: "未做修改" });
            return;
          }
          await apiPatch(`/api/automations/${editing.id}`, payload);
          toast({ title: "已保存" });
          await mutate();
        }}
      />

      <ConfirmDialog
        open={deleting !== null}
        title="删除自动化"
        description={deleting ? `确认删除「${deleting.name}」？关联的运行记录也会被清除。` : ""}
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

function AutomationFormDialog({
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
    setValue,
    watch,
  } = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    values: defaults ?? { name: "", triggerType: "USER_CREATED", subject: "", delayMinutes: 0, templateId: "" },
  });

  const triggerType = watch("triggerType");

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
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="auto-name">名称</Label>
            <Input id="auto-name" autoFocus {...register("name")} />
            {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
          </div>

          <div className="space-y-1.5">
            <Label>触发类型</Label>
            <Select
              value={triggerType}
              onChange={(e) => setValue("triggerType", e.target.value as FormValues["triggerType"])}
            >
              {TRIGGER_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TRIGGER_TYPE_LABELS[t] ?? t}
                </option>
              ))}
            </Select>
            {errors.triggerType && <p className="text-xs text-destructive">{errors.triggerType.message}</p>}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="auto-subject">邮件主题</Label>
            <Input id="auto-subject" {...register("subject")} />
            {errors.subject && <p className="text-xs text-destructive">{errors.subject.message}</p>}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="auto-delay">延迟（分钟）</Label>
            <Input id="auto-delay" type="number" min={0} {...register("delayMinutes")} />
            {errors.delayMinutes && <p className="text-xs text-destructive">{errors.delayMinutes.message}</p>}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="auto-template">模板 ID（可选）</Label>
            <Input id="auto-template" placeholder="留空则不关联模板" {...register("templateId")} />
          </div>

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
