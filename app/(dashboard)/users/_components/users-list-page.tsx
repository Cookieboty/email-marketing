"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import type { ColumnDef } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { DataTable } from "@/components/data-table";
import { Pagination } from "@/components/pagination";
import { TagPicker } from "@/components/tag-picker";
import { swrFetcher } from "@/lib/api-client";
import { swrKeys } from "@/lib/swr-keys";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  unsubscribed: boolean;
  optInStatus: string;
  totalSpend: string | number | null;
  orderCount: number;
  createdAt: string;
  tags: { id: string; name: string; color?: string | null }[];
}

interface ListResp {
  data: UserRow[];
  total: number;
  page: number;
  pageSize: number;
}

export default function UsersListPage() {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [q, setQ] = useState("");
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [unsubscribed, setUnsubscribed] = useState<"" | "true" | "false">("");
  const [tagFilterMode, setTagFilterMode] = useState<"all" | "any">("all");

  const debouncedQ = useDebouncedValue(q, 300);

  const key = swrKeys.users({
    q: debouncedQ || undefined,
    tagIds: tagIds.length > 0 ? tagIds.join(",") : undefined,
    tagFilterMode: tagIds.length > 1 ? tagFilterMode : undefined,
    unsubscribed: unsubscribed || undefined,
    page,
    pageSize,
  });

  const { data, isLoading, mutate } = useSWR<ListResp>(key, swrFetcher, {
    keepPreviousData: true,
  });

  const columns = useMemo<ColumnDef<UserRow>[]>(
    () => [
      {
        accessorKey: "email",
        header: "Email",
        cell: ({ row }) => (
          <Link
            href={`/users/${row.original.id}`}
            className="text-primary hover:underline"
            data-testid={`user-row-${row.original.id}`}
          >
            {row.original.email}
          </Link>
        ),
      },
      {
        accessorKey: "name",
        header: "姓名",
        cell: ({ row }) => row.original.name ?? "—",
      },
      {
        id: "tags",
        header: "标签",
        cell: ({ row }) =>
          row.original.tags.length === 0 ? (
            <span className="text-muted-foreground">—</span>
          ) : (
            <div className="flex flex-wrap gap-1">
              {row.original.tags.map((t) => (
                <Badge key={t.id} variant="secondary">
                  {t.name}
                </Badge>
              ))}
            </div>
          ),
      },
      {
        accessorKey: "optInStatus",
        header: "Opt-in",
        cell: ({ row }) => {
          const s = row.original.optInStatus;
          if (s === "CONFIRMED") return <Badge>已确认</Badge>;
          if (s === "PENDING") return <Badge variant="secondary">待确认</Badge>;
          if (s === "EXPIRED") return <Badge variant="destructive">已过期</Badge>;
          return <Badge variant="outline">无需</Badge>;
        },
      },
      {
        accessorKey: "unsubscribed",
        header: "状态",
        cell: ({ row }) =>
          row.original.unsubscribed ? (
            <Badge variant="destructive">已退订</Badge>
          ) : (
            <Badge variant="outline">订阅中</Badge>
          ),
      },
      {
        accessorKey: "orderCount",
        header: "订单数",
      },
      {
        accessorKey: "createdAt",
        header: "创建时间",
        cell: ({ row }) =>
          new Date(row.original.createdAt).toLocaleDateString(),
      },
    ],
    [],
  );

  const total = data?.total ?? 0;
  const rows = data?.data ?? [];

  return (
    <section className="space-y-4">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight" data-testid="users-page-heading">
          用户
        </h1>
        <div className="flex gap-2">
          <Link
            href="/users/import"
            data-testid="users-import-link"
            className="inline-flex h-9 items-center justify-center rounded-md border border-input bg-background px-4 text-sm font-medium shadow-sm hover:bg-accent hover:text-accent-foreground"
          >
            批量导入
          </Link>
        </div>
      </header>

      <div className="grid gap-3 rounded-md border bg-card p-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">搜索</label>
          <Input
            placeholder="email / name / externalId"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
            data-testid="users-search"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">退订状态</label>
          <Select
            value={unsubscribed}
            onChange={(e) => {
              setUnsubscribed(e.target.value as "" | "true" | "false");
              setPage(1);
            }}
            data-testid="users-filter-unsub"
          >
            <option value="">全部</option>
            <option value="false">订阅中</option>
            <option value="true">已退订</option>
          </Select>
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">每页</label>
          <Select
            value={String(pageSize)}
            onChange={(e) => {
              setPageSize(Number(e.target.value));
              setPage(1);
            }}
            data-testid="users-page-size"
          >
            <option value="20">20</option>
            <option value="50">50</option>
            <option value="100">100</option>
          </Select>
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">标签匹配</label>
          <Select
            value={tagFilterMode}
            disabled={tagIds.length <= 1}
            onChange={(e) => {
              setTagFilterMode(e.target.value as "all" | "any");
              setPage(1);
            }}
            data-testid="users-filter-tag-mode"
          >
            <option value="all">全部满足 (AND)</option>
            <option value="any">任一满足 (OR)</option>
          </Select>
        </div>
        <div className="sm:col-span-2 lg:col-span-4">
          <label className="text-xs font-medium text-muted-foreground">按标签过滤</label>
          <TagPicker
            value={tagIds}
            onChange={(next) => {
              setTagIds(next);
              setPage(1);
            }}
            className="mt-2"
            emptyText="暂无标签可过滤"
          />
        </div>
      </div>

      <DataTable
        columns={columns}
        data={rows}
        loading={isLoading}
        emptyText="未匹配到用户"
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
    </section>
  );
}
