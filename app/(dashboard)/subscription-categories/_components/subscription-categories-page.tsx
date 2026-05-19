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
import {
  apiDelete,
  apiPatch,
  apiPost,
  swrFetcher,
  type ApiClientError,
} from "@/lib/api-client";
import { swrKeys } from "@/lib/swr-keys";

interface CategoryRow {
  id: string;
  name: string;
  description: string | null;
  slug: string;
  isDefault: boolean;
  isTransactional: boolean;
  isPreset: boolean;
  sortOrder: number;
  subscriberCount: number;
  createdAt: string;
  updatedAt: string;
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

const CreateSchema = z.object({
  name: z.string().trim().min(1, "请输入名称").max(64),
  slug: z
    .string()
    .trim()
    .min(1, "请输入 slug")
    .max(64)
    .regex(SLUG_RE, "仅小写字母、数字、连字符；首尾不可为连字符"),
  description: z.string().trim().max(500).optional(),
  isDefault: z.boolean().optional(),
  isTransactional: z.boolean().optional(),
  sortOrder: z
    .string()
    .optional()
    .refine(
      (v) => v === undefined || v === "" || (/^-?\d+$/.test(v) && Number(v) >= 0 && Number(v) <= 9999),
      "需为 0-9999 整数",
    ),
});
type CreateValues = z.infer<typeof CreateSchema>;

const EditSchema = z.object({
  name: z.string().trim().min(1, "请输入名称").max(64),
  description: z.string().trim().max(500).optional(),
  isDefault: z.boolean().optional(),
  sortOrder: z
    .string()
    .optional()
    .refine(
      (v) => v === undefined || v === "" || (/^-?\d+$/.test(v) && Number(v) >= 0 && Number(v) <= 9999),
      "需为 0-9999 整数",
    ),
});
type EditValues = z.infer<typeof EditSchema>;

function asMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return "操作失败";
}

export default function SubscriptionCategoriesPage() {
  const { toast } = useToast();
  const { data, isLoading, mutate } = useSWR<CategoryRow[]>(
    swrKeys.subscriptionCategories(),
    swrFetcher,
    { keepPreviousData: true },
  );

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<CategoryRow | null>(null);
  const [deleting, setDeleting] = useState<CategoryRow | null>(null);

  const columns = useMemo<ColumnDef<CategoryRow>[]>(
    () => [
      {
        accessorKey: "name",
        header: "名称",
        cell: ({ row }) => (
          <div className="space-y-0.5" data-testid={`subcat-row-${row.original.id}`}>
            <div className="font-medium">{row.original.name}</div>
            {row.original.description ? (
              <div className="text-xs text-muted-foreground">{row.original.description}</div>
            ) : null}
          </div>
        ),
      },
      {
        accessorKey: "slug",
        header: "slug",
        cell: ({ row }) => (
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{row.original.slug}</code>
        ),
      },
      {
        id: "flags",
        header: "属性",
        cell: ({ row }) => (
          <div className="flex flex-wrap gap-1">
            {row.original.isPreset ? <Badge variant="outline">预置</Badge> : null}
            {row.original.isTransactional ? (
              <Badge variant="destructive">交易类</Badge>
            ) : null}
            {row.original.isDefault ? <Badge>默认订阅</Badge> : null}
          </div>
        ),
      },
      {
        accessorKey: "subscriberCount",
        header: "显式订阅人数",
        cell: ({ row }) => row.original.subscriberCount,
      },
      {
        accessorKey: "sortOrder",
        header: "排序",
        cell: ({ row }) => row.original.sortOrder,
      },
      {
        id: "actions",
        header: "操作",
        cell: ({ row }) => {
          const r = row.original;
          return (
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setEditing(r)}
                data-testid={`subcat-edit-${r.id}`}
              >
                编辑
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={r.isPreset}
                title={r.isPreset ? "预置分类不可删除" : undefined}
                onClick={() => setDeleting(r)}
                data-testid={`subcat-delete-${r.id}`}
              >
                删除
              </Button>
            </div>
          );
        },
      },
    ],
    [],
  );

  return (
    <section className="space-y-4">
      <header className="flex items-center justify-between">
        <div className="space-y-1">
          <h1
            className="text-2xl font-semibold tracking-tight"
            data-testid="subcats-page-heading"
          >
            订阅分类
          </h1>
          <p className="text-sm text-muted-foreground">
            管理用户邮件订阅分类。交易类（如订单确认、密码重置）一旦创建不可修改、不可被退订。
          </p>
        </div>
        <Button
          type="button"
          onClick={() => setCreateOpen(true)}
          data-testid="subcats-create-button"
        >
          新增分类
        </Button>
      </header>

      <DataTable
        columns={columns}
        data={data ?? []}
        loading={isLoading}
        emptyText="暂无订阅分类"
      />

      <CreateDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSuccess={async () => {
          toast({ title: "已创建" });
          await mutate();
        }}
      />

      <EditDialog
        category={editing}
        onClose={() => setEditing(null)}
        onSuccess={async () => {
          toast({ title: "已保存" });
          await mutate();
        }}
      />

      <ConfirmDialog
        open={deleting !== null}
        title="删除订阅分类"
        description={
          deleting
            ? `确认删除「${deleting.name}」？被 Campaign 引用或为预置分类时无法删除。`
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
            await apiDelete(`/api/subscription-categories/${deleting.id}`);
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

function CreateDialog({
  open,
  onClose,
  onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  onSuccess: () => Promise<void>;
}) {
  const { toast } = useToast();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    reset,
  } = useForm<CreateValues>({
    resolver: zodResolver(CreateSchema),
    defaultValues: {
      name: "",
      slug: "",
      description: "",
      isDefault: false,
      isTransactional: false,
      sortOrder: "0",
    },
  });

  async function onSubmit(v: CreateValues) {
    try {
      await apiPost("/api/subscription-categories", {
        name: v.name,
        slug: v.slug,
        description: v.description ? v.description : null,
        isDefault: v.isDefault ?? false,
        isTransactional: v.isTransactional ?? false,
        sortOrder: v.sortOrder ? Number(v.sortOrder) : 0,
      });
      reset();
      onClose();
      await onSuccess();
    } catch (e) {
      const err = e as ApiClientError;
      toast({
        title: "创建失败",
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
          <DialogTitle>新增订阅分类</DialogTitle>
          <DialogDescription>
            slug 创建后不可修改；交易类创建后不可切换为非交易类。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="cat-name">名称</Label>
              <Input id="cat-name" autoFocus {...register("name")} data-testid="subcat-form-name" />
              {errors.name ? (
                <p className="text-xs text-destructive">{errors.name.message}</p>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cat-slug">slug</Label>
              <Input id="cat-slug" placeholder="newsletter" {...register("slug")} data-testid="subcat-form-slug" />
              {errors.slug ? (
                <p className="text-xs text-destructive">{errors.slug.message}</p>
              ) : null}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cat-desc">描述（可选）</Label>
            <Textarea id="cat-desc" rows={3} {...register("description")} data-testid="subcat-form-desc" />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" {...register("isDefault")} data-testid="subcat-form-default" />
              默认订阅
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                {...register("isTransactional")}
                data-testid="subcat-form-transactional"
              />
              交易类（不可退订）
            </label>
            <div className="space-y-1.5">
              <Label htmlFor="cat-sort">排序</Label>
              <Input id="cat-sort" inputMode="numeric" {...register("sortOrder")} data-testid="subcat-form-sort" />
              {errors.sortOrder ? (
                <p className="text-xs text-destructive">{errors.sortOrder.message}</p>
              ) : null}
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                reset();
                onClose();
              }}
              data-testid="subcat-form-cancel"
            >
              取消
            </Button>
            <Button type="submit" disabled={isSubmitting} data-testid="subcat-form-submit">
              {isSubmitting ? "创建中..." : "创建"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditDialog({
  category,
  onClose,
  onSuccess,
}: {
  category: CategoryRow | null;
  onClose: () => void;
  onSuccess: () => Promise<void>;
}) {
  const { toast } = useToast();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    reset,
  } = useForm<EditValues>({
    resolver: zodResolver(EditSchema),
    values: category
      ? {
          name: category.name,
          description: category.description ?? "",
          isDefault: category.isDefault,
          sortOrder: String(category.sortOrder),
        }
      : { name: "", description: "", isDefault: false, sortOrder: "0" },
  });

  async function onSubmit(v: EditValues) {
    if (!category) return;
    const payload: Record<string, unknown> = {};
    if (v.name !== category.name) payload.name = v.name;
    if ((v.description ?? "") !== (category.description ?? "")) {
      payload.description = v.description ? v.description : null;
    }
    if ((v.isDefault ?? false) !== category.isDefault) payload.isDefault = v.isDefault ?? false;
    if (v.sortOrder !== undefined && v.sortOrder !== "" && Number(v.sortOrder) !== category.sortOrder) {
      payload.sortOrder = Number(v.sortOrder);
    }
    if (Object.keys(payload).length === 0) {
      toast({ title: "未做修改" });
      onClose();
      return;
    }
    try {
      await apiPatch(`/api/subscription-categories/${category.id}`, payload);
      reset();
      onClose();
      await onSuccess();
    } catch (e) {
      const err = e as ApiClientError;
      toast({
        title: "保存失败",
        description: asMessage(err),
        variant: "destructive",
      });
    }
  }

  const open = category !== null;

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
          <DialogTitle>编辑订阅分类</DialogTitle>
          <DialogDescription>
            slug 与「交易类」属性创建后无法修改。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="ecat-name">名称</Label>
              <Input id="ecat-name" autoFocus {...register("name")} data-testid="subcat-edit-name" />
              {errors.name ? (
                <p className="text-xs text-destructive">{errors.name.message}</p>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <Label>slug（只读）</Label>
              <Input value={category?.slug ?? ""} readOnly disabled />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ecat-desc">描述</Label>
            <Textarea id="ecat-desc" rows={3} {...register("description")} data-testid="subcat-edit-desc" />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" {...register("isDefault")} data-testid="subcat-edit-default" />
              默认订阅
            </label>
            <div className="space-y-1.5">
              <Label htmlFor="ecat-sort">排序</Label>
              <Input id="ecat-sort" inputMode="numeric" {...register("sortOrder")} data-testid="subcat-edit-sort" />
              {errors.sortOrder ? (
                <p className="text-xs text-destructive">{errors.sortOrder.message}</p>
              ) : null}
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                reset();
                onClose();
              }}
              data-testid="subcat-edit-cancel"
            >
              取消
            </Button>
            <Button type="submit" disabled={isSubmitting} data-testid="subcat-edit-submit">
              {isSubmitting ? "保存中..." : "保存"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
