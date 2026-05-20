"use client";

import { useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import type { ColumnDef } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DataTable } from "@/components/data-table";
import {
  apiDelete,
  apiPatch,
  swrFetcher,
} from "@/lib/api-client";
import { swrKeys } from "@/lib/swr-keys";
import {
  AUTH_TYPE_LABELS,
  PAGINATION_LABELS,
  type ImportSourceListResp,
  type ImportSourceRow,
} from "./types";

function asMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return "操作失败";
}

export default function ImportSourcesPage() {
  const { toast } = useToast();
  const { data, isLoading, mutate } = useSWR<ImportSourceListResp>(
    swrKeys.importSources(),
    swrFetcher,
  );
  const rows = data?.data ?? [];
  const [deleting, setDeleting] = useState<ImportSourceRow | null>(null);

  async function toggleEnabled(row: ImportSourceRow) {
    try {
      await apiPatch(`/api/import-sources/${row.id}`, { enabled: !row.enabled });
      toast({ title: row.enabled ? "已停用" : "已启用" });
      await mutate();
    } catch (e) {
      toast({ title: "操作失败", description: asMessage(e), variant: "destructive" });
    }
  }

  const columns: ColumnDef<ImportSourceRow>[] = [
    {
      accessorKey: "name",
      header: "名称",
      cell: ({ row }) => (
        <Link
          href={`/import-sources/${row.original.id}`}
          className="font-medium underline-offset-2 hover:underline"
        >
          {row.original.name}
        </Link>
      ),
    },
    {
      accessorKey: "baseUrl",
      header: "数据源 URL",
      cell: ({ row }) => (
        <span className="block max-w-[260px] truncate font-mono text-xs">
          {row.original.baseUrl}
        </span>
      ),
    },
    {
      accessorKey: "authType",
      header: "认证",
      cell: ({ row }) => (
        <Badge variant="outline">
          {AUTH_TYPE_LABELS[row.original.authType] ?? row.original.authType}
          {row.original.authType !== "NONE" && row.original.hasAuth ? " ✓" : ""}
        </Badge>
      ),
    },
    {
      accessorKey: "paginationType",
      header: "分页",
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground">
          {PAGINATION_LABELS[row.original.paginationType] ?? row.original.paginationType}
        </span>
      ),
    },
    {
      accessorKey: "schedule",
      header: "调度",
      cell: ({ row }) =>
        row.original.schedule ? (
          <code className="rounded bg-muted px-1 py-0.5 text-xs">{row.original.schedule}</code>
        ) : (
          <span className="text-xs text-muted-foreground">手动</span>
        ),
    },
    {
      accessorKey: "lastRunAt",
      header: "最近执行",
      cell: ({ row }) =>
        row.original.lastRunAt ? (
          <span className="text-xs">
            {new Date(row.original.lastRunAt).toLocaleString()}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">未运行</span>
        ),
    },
    {
      accessorKey: "enabled",
      header: "状态",
      cell: ({ row }) => (
        <Badge variant={row.original.enabled ? "default" : "secondary"}>
          {row.original.enabled ? "启用" : "停用"}
        </Badge>
      ),
    },
    {
      id: "actions",
      header: "操作",
      cell: ({ row }) => (
        <div className="flex flex-wrap gap-2">
          <Link
            href={`/import-sources/${row.original.id}`}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            详情
          </Link>
          <Link
            href={`/import-sources/${row.original.id}/edit`}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            编辑
          </Link>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => toggleEnabled(row.original)}
          >
            {row.original.enabled ? "停用" : "启用"}
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

  return (
    <section className="space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">数据导入</h1>
          <p className="text-sm text-muted-foreground">
            从外部系统按计划或手动拉取用户数据，自动 upsert 到本地用户表。
          </p>
        </div>
        <Link
          href="/import-sources/new"
          className={buttonVariants({ variant: "default" })}
        >
          新增数据源
        </Link>
      </header>

      <DataTable
        columns={columns}
        data={rows}
        loading={isLoading}
        emptyText="暂无数据源，点击右上角新增。"
      />

      <ConfirmDialog
        open={deleting !== null}
        title="删除数据源"
        description={
          deleting
            ? `确认删除「${deleting.name}」？关联的所有任务与错误记录会被级联删除。`
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
            await apiDelete(`/api/import-sources/${deleting.id}`);
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
