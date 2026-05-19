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

interface TagRow {
  id: string;
  name: string;
  color: string | null;
  userCount: number;
  createdAt: string;
  updatedAt: string;
}

interface ListResp {
  data: TagRow[];
  total: number;
  page: number;
  pageSize: number;
}

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const FormSchema = z.object({
  name: z.string().trim().min(1, "请输入名称").max(64),
  color: z
    .string()
    .trim()
    .refine((v) => v === "" || HEX_RE.test(v), {
      message: "颜色须为 #RGB 或 #RRGGBB",
    })
    .optional(),
});
type FormValues = z.infer<typeof FormSchema>;

function asMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return "操作失败";
}

export default function TagsPage() {
  const { toast } = useToast();
  const [page, setPage] = useState(1);
  const [pageSize] = useState(50);
  const [q, setQ] = useState("");
  const debouncedQ = useDebouncedValue(q, 300);

  const key = `${swrKeys.tags()}?${new URLSearchParams({
    ...(debouncedQ ? { q: debouncedQ } : {}),
    page: String(page),
    pageSize: String(pageSize),
  }).toString()}`;

  const { data, isLoading, mutate } = useSWR<ListResp>(key, swrFetcher, {
    keepPreviousData: true,
  });

  const [editing, setEditing] = useState<TagRow | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleting, setDeleting] = useState<TagRow | null>(null);

  const columns = useMemo<ColumnDef<TagRow>[]>(
    () => [
      {
        accessorKey: "name",
        header: "名称",
        cell: ({ row }) => (
          <div className="flex items-center gap-2" data-testid={`tag-row-${row.original.id}`}>
            <span
              aria-hidden
              className="inline-block h-3 w-3 rounded-full border"
              style={{
                backgroundColor: row.original.color ?? "transparent",
              }}
            />
            <span className="font-medium">{row.original.name}</span>
            {row.original.color ? (
              <Badge variant="outline" className="font-mono text-[10px]">
                {row.original.color}
              </Badge>
            ) : null}
          </div>
        ),
      },
      {
        accessorKey: "userCount",
        header: "用户数",
        cell: ({ row }) => row.original.userCount,
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
              data-testid={`tag-edit-${row.original.id}`}
            >
              编辑
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={() => setDeleting(row.original)}
              data-testid={`tag-delete-${row.original.id}`}
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
        <h1 className="text-2xl font-semibold tracking-tight" data-testid="tags-page-heading">
          标签
        </h1>
        <Button
          type="button"
          onClick={() => setCreateOpen(true)}
          data-testid="tags-create-button"
        >
          新增标签
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
            data-testid="tags-search"
          />
        </div>
      </div>

      <DataTable columns={columns} data={rows} loading={isLoading} emptyText="暂无标签" />
      <Pagination
        page={page}
        pageSize={pageSize}
        total={total}
        onPageChange={(p) => {
          setPage(p);
          mutate();
        }}
      />

      <TagFormDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="新增标签"
        description="输入名称（必填）和颜色（可选）"
        submit={async (v) => {
          await apiPost("/api/tags", {
            name: v.name,
            color: v.color ? v.color : null,
          });
          toast({ title: "已创建" });
          await mutate();
        }}
      />

      <TagFormDialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title="编辑标签"
        description="修改名称或颜色"
        defaults={
          editing
            ? { name: editing.name, color: editing.color ?? "" }
            : undefined
        }
        submit={async (v) => {
          if (!editing) return;
          const payload: Record<string, unknown> = {};
          if (v.name !== editing.name) payload.name = v.name;
          if ((v.color ?? "") !== (editing.color ?? "")) {
            payload.color = v.color ? v.color : null;
          }
          if (Object.keys(payload).length === 0) {
            toast({ title: "未做修改" });
            return;
          }
          await apiPatch(`/api/tags/${editing.id}`, payload);
          toast({ title: "已保存" });
          await mutate();
        }}
      />

      <ConfirmDialog
        open={deleting !== null}
        title="删除标签"
        description={
          deleting
            ? `确认删除「${deleting.name}」？该标签当前有 ${deleting.userCount} 个用户引用。`
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
            await apiDelete(`/api/tags/${deleting.id}`);
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

function TagFormDialog({
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
    values: defaults ?? { name: "", color: "" },
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
            <Label htmlFor="tag-name">名称</Label>
            <Input
              id="tag-name"
              autoFocus
              {...register("name")}
              data-testid="tag-form-name"
            />
            {errors.name ? (
              <p className="text-xs text-destructive">{errors.name.message}</p>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tag-color">颜色（#RRGGBB）</Label>
            <Input
              id="tag-color"
              placeholder="#1d4ed8"
              {...register("color")}
              data-testid="tag-form-color"
            />
            {errors.color ? (
              <p className="text-xs text-destructive">{errors.color.message}</p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                reset();
                onClose();
              }}
              data-testid="tag-form-cancel"
            >
              取消
            </Button>
            <Button
              type="submit"
              disabled={isSubmitting}
              data-testid="tag-form-submit"
            >
              {isSubmitting ? "保存中..." : "保存"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
