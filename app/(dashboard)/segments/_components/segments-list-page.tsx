"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import useSWR from "swr";
import type { ColumnDef } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DataTable } from "@/components/data-table";
import { Pagination } from "@/components/pagination";
import { apiDelete, apiPost, swrFetcher } from "@/lib/api-client";
import { swrKeys } from "@/lib/swr-keys";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";

interface SegmentRow {
  id: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  userCount: number;
  lastCalculatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ListResp {
  data: SegmentRow[];
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

export default function SegmentsListPage() {
  const { toast } = useToast();
  const [page, setPage] = useState(1);
  const [pageSize] = useState(50);
  const [q, setQ] = useState("");
  const debouncedQ = useDebouncedValue(q, 300);

  const key = swrKeys.segments({
    ...(debouncedQ ? { q: debouncedQ } : {}),
    page,
    pageSize,
  });

  const { data, isLoading, mutate } = useSWR<ListResp>(key, swrFetcher, {
    keepPreviousData: true,
  });

  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<SegmentRow | null>(null);

  const columns = useMemo<ColumnDef<SegmentRow>[]>(
    () => [
      {
        accessorKey: "name",
        header: "名称",
        cell: ({ row }) => (
          <div className="space-y-0.5" data-testid={`segment-row-${row.original.id}`}>
            <div className="flex items-center gap-2 font-medium">
              {row.original.name}
              {row.original.isSystem ? <Badge variant="outline">系统</Badge> : null}
            </div>
            {row.original.description ? (
              <div className="text-xs text-muted-foreground">
                {row.original.description}
              </div>
            ) : null}
          </div>
        ),
      },
      {
        accessorKey: "userCount",
        header: "命中用户数",
        cell: ({ row }) => row.original.userCount.toLocaleString(),
      },
      {
        accessorKey: "lastCalculatedAt",
        header: "最后计算",
        cell: ({ row }) =>
          row.original.lastCalculatedAt
            ? new Date(row.original.lastCalculatedAt).toLocaleString()
            : "—",
      },
      {
        id: "actions",
        header: "操作",
        cell: ({ row }) => {
          const r = row.original;
          return (
            <div className="flex flex-wrap gap-2">
              <Link
                href={`/segments/${r.id}/edit`}
                className={buttonVariants({ variant: "outline", size: "sm" })}
                data-testid={`segment-edit-${r.id}`}
              >
                编辑
              </Link>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={refreshing === r.id}
                onClick={async () => {
                  setRefreshing(r.id);
                  try {
                    await apiPost(`/api/segments/${r.id}/refresh`, {});
                    toast({ title: "已重新计算" });
                    await mutate();
                  } catch (e) {
                    toast({
                      title: "刷新失败",
                      description: asMessage(e),
                      variant: "destructive",
                    });
                  } finally {
                    setRefreshing(null);
                  }
                }}
                data-testid={`segment-refresh-${r.id}`}
              >
                {refreshing === r.id ? "刷新中..." : "刷新"}
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={r.isSystem}
                title={r.isSystem ? "系统分群不可删除" : undefined}
                onClick={() => setDeleting(r)}
                data-testid={`segment-delete-${r.id}`}
              >
                删除
              </Button>
            </div>
          );
        },
      },
    ],
    [refreshing, mutate, toast],
  );

  const total = data?.total ?? 0;
  const rows = data?.data ?? [];

  return (
    <section className="space-y-4">
      <header className="flex items-center justify-between">
        <div className="space-y-1">
          <h1
            className="text-2xl font-semibold tracking-tight"
            data-testid="segments-page-heading"
          >
            分群
          </h1>
          <p className="text-sm text-muted-foreground">
            通过条件树定义动态用户分群，可作为 Campaign 收件人范围。
          </p>
        </div>
        <Link
          href="/segments/new"
          className={buttonVariants({ variant: "default" })}
          data-testid="segments-create-button"
        >
          新建分群
        </Link>
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
            data-testid="segments-search"
          />
        </div>
      </div>

      <DataTable columns={columns} data={rows} loading={isLoading} emptyText="暂无分群" />
      <Pagination
        page={page}
        pageSize={pageSize}
        total={total}
        onPageChange={(p) => {
          setPage(p);
          mutate();
        }}
      />

      <ConfirmDialog
        open={deleting !== null}
        title="删除分群"
        description={
          deleting
            ? `确认删除「${deleting.name}」？被 Campaign 引用的分群无法删除。`
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
            await apiDelete(`/api/segments/${deleting.id}`);
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
