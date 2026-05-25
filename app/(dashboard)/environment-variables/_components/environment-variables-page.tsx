"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import type { ColumnDef } from "@tanstack/react-table";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
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
import { useToast } from "@/components/ui/toast";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DataTable } from "@/components/data-table";
import {
  apiDelete,
  apiPatch,
  apiPost,
  swrFetcher,
  type ApiClientError,
} from "@/lib/api-client";
import { swrKeys } from "@/lib/swr-keys";

interface EnvVarRow {
  id: string;
  key: string;
  value: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ListResp {
  data: EnvVarRow[];
}

const FormSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1, "请输入变量名")
    .max(64)
    .regex(/^[A-Za-z][A-Za-z0-9_]*$/, "仅支持字母开头，字母、数字、下划线"),
  value: z.string().min(1, "请输入变量值"),
  description: z.string().max(256).optional(),
});
type FormValues = z.infer<typeof FormSchema>;

function asMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return "操作失败";
}

export default function EnvironmentVariablesPage() {
  const { toast } = useToast();
  const { data, isLoading, mutate } = useSWR<ListResp>(
    swrKeys.environmentVariables(),
    swrFetcher,
  );

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<EnvVarRow | null>(null);
  const [deleting, setDeleting] = useState<EnvVarRow | null>(null);

  const columns = useMemo<ColumnDef<EnvVarRow>[]>(
    () => [
      {
        accessorKey: "key",
        header: "变量名",
        cell: ({ row }) => (
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium">
            {`{{${row.original.key}}}`}
          </code>
        ),
      },
      {
        accessorKey: "value",
        header: "值",
        cell: ({ row }) => (
          <span className="max-w-[200px] truncate text-sm">
            {row.original.value}
          </span>
        ),
      },
      {
        accessorKey: "description",
        header: "说明",
        cell: ({ row }) =>
          row.original.description ? (
            <span className="text-sm text-muted-foreground">
              {row.original.description}
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

  const rows = data?.data ?? [];

  return (
    <section className="space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">环境变量</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            定义全局模板变量，可在所有模板和模板片段中通过{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">{"{{key}}"}</code>{" "}
            引用，发送时自动替换。
          </p>
        </div>
        <Button type="button" onClick={() => setCreateOpen(true)}>
          新增变量
        </Button>
      </header>

      <DataTable columns={columns} data={rows} loading={isLoading} emptyText="暂无环境变量" />

      <EnvVarFormDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="新增环境变量"
        description="定义一个可在模板中使用的全局变量"
        submit={async (v) => {
          await apiPost("/api/environment-variables", {
            key: v.key,
            value: v.value,
            description: v.description || undefined,
          });
          toast({ title: "已创建" });
          await mutate();
        }}
      />

      <EnvVarFormDialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title="编辑环境变量"
        description={editing ? `修改 ${editing.key} 的值或说明` : ""}
        defaults={
          editing
            ? { key: editing.key, value: editing.value, description: editing.description ?? "" }
            : undefined
        }
        editMode
        submit={async (v) => {
          if (!editing) return;
          const payload: Record<string, unknown> = {};
          if (v.value !== editing.value) payload.value = v.value;
          if ((v.description ?? "") !== (editing.description ?? "")) {
            payload.description = v.description || null;
          }
          if (Object.keys(payload).length === 0) {
            toast({ title: "未做修改" });
            return;
          }
          await apiPatch(`/api/environment-variables/${editing.id}`, payload);
          toast({ title: "已保存" });
          await mutate();
        }}
      />

      <ConfirmDialog
        open={deleting !== null}
        title="删除环境变量"
        description={
          deleting
            ? `确认删除「${deleting.key}」？使用该变量的模板在发送时将不再被替换。`
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
            await apiDelete(`/api/environment-variables/${deleting.id}`);
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

function EnvVarFormDialog({
  open,
  onClose,
  title,
  description,
  defaults,
  editMode,
  submit,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  defaults?: FormValues;
  editMode?: boolean;
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
    values: defaults ?? { key: "", value: "", description: "" },
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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="envvar-key">变量名</Label>
            <Input
              id="envvar-key"
              autoFocus={!editMode}
              placeholder="如 company_name"
              disabled={editMode}
              {...register("key")}
            />
            {errors.key && <p className="text-xs text-destructive">{errors.key.message}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="envvar-value">值</Label>
            <Input
              id="envvar-value"
              autoFocus={editMode}
              placeholder="发送时替换为此值"
              {...register("value")}
            />
            {errors.value && <p className="text-xs text-destructive">{errors.value.message}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="envvar-desc">说明（可选）</Label>
            <Input
              id="envvar-desc"
              placeholder="用途备注"
              {...register("description")}
            />
            {errors.description && (
              <p className="text-xs text-destructive">{errors.description.message}</p>
            )}
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
