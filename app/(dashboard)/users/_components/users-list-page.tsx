"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import type { ColumnDef, RowSelectionState } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { DataTable } from "@/components/data-table";
import { Pagination } from "@/components/pagination";
import { TagPicker } from "@/components/tag-picker";
import { apiPost, swrFetcher } from "@/lib/api-client";
import { useToast } from "@/components/ui/toast";
import { swrKeys } from "@/lib/swr-keys";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";

// 与后端 BATCH_TAG_FILTER_LIMIT 保持一致：filter 模式批量打标的上限。
const BATCH_TAG_FILTER_LIMIT = 1000;
import type { Locale } from "@/app/(dashboard)/templates/_components/types";
import { formatUserLocaleShort } from "./user-locale-helpers";

const moneyFormatter = new Intl.NumberFormat("zh-CN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const integerFormatter = new Intl.NumberFormat("zh-CN");

function formatMoney(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === "") return "—";
  const n = typeof v === "string" ? Number(v) : v;
  if (!Number.isFinite(n)) return "—";
  return moneyFormatter.format(n);
}

function formatInt(v: number | string | null | undefined): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "string") {
    if (!/^-?\d+$/.test(v.trim())) return "—";
    try {
      return integerFormatter.format(BigInt(v));
    } catch {
      return "—";
    }
  }
  if (!Number.isFinite(v)) return "—";
  return integerFormatter.format(v);
}

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  unsubscribed: boolean;
  optInStatus: string;
  totalSpend: string | number | null;
  orderCount: number;
  balance: number | string | null;
  usedQuota: number | string | null;
  requestCount: number | string | null;
  locale: Locale | null;
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
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [selectAll, setSelectAll] = useState(false);
  const [batchMode, setBatchMode] = useState<"add" | "remove" | null>(null);
  const [batchTagIds, setBatchTagIds] = useState<string[]>([]);
  const [batchLoading, setBatchLoading] = useState(false);
  const { toast } = useToast();

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
        id: "select",
        size: 40,
        header: ({ table }) => (
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-gray-300"
            checked={table.getIsAllPageRowsSelected()}
            onChange={(e) => table.toggleAllPageRowsSelected(e.target.checked)}
          />
        ),
        cell: ({ row }) => (
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-gray-300"
            checked={row.getIsSelected()}
            onChange={(e) => row.toggleSelected(e.target.checked)}
            onClick={(e) => e.stopPropagation()}
          />
        ),
      },
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
        accessorKey: "locale",
        header: "语言",
        cell: ({ row }) => (
          <span
            className="text-sm tabular-nums"
            data-testid={`user-locale-${row.original.id}`}
          >
            {formatUserLocaleShort(row.original.locale)}
          </span>
        ),
      },
      {
        accessorKey: "totalSpend",
        header: "充值/消费金额",
        cell: ({ row }) => (
          <span
            className="tabular-nums"
            data-testid={`user-total-spend-${row.original.id}`}
          >
            {formatMoney(row.original.totalSpend)}
          </span>
        ),
      },
      {
        accessorKey: "balance",
        header: "AI Token 余额",
        cell: ({ row }) => (
          <span
            className="tabular-nums"
            data-testid={`user-balance-${row.original.id}`}
          >
            {formatInt(row.original.balance)}
          </span>
        ),
      },
      {
        accessorKey: "usedQuota",
        header: "AI 已用 Token",
        cell: ({ row }) => (
          <span
            className="tabular-nums"
            data-testid={`user-used-quota-${row.original.id}`}
          >
            {formatInt(row.original.usedQuota)}
          </span>
        ),
      },
      {
        accessorKey: "requestCount",
        header: "请求数",
        cell: ({ row }) => (
          <span
            className="tabular-nums"
            data-testid={`user-request-count-${row.original.id}`}
          >
            {formatInt(row.original.requestCount)}
          </span>
        ),
      },
      {
        accessorKey: "orderCount",
        header: "订单数",
        cell: ({ row }) => (
          <span className="tabular-nums">{formatInt(row.original.orderCount)}</span>
        ),
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

  const selectedCount = selectAll ? total : Object.keys(rowSelection).length;

  const getRowId = useCallback((row: UserRow) => row.id, []);

  function resetSelection() {
    setRowSelection({});
    setSelectAll(false);
    setBatchMode(null);
    setBatchTagIds([]);
  }

  async function executeBatch() {
    if (!batchMode || batchTagIds.length === 0) return;
    setBatchLoading(true);
    try {
      const body: Record<string, unknown> = { mode: batchMode, tagIds: batchTagIds };
      if (selectAll) {
        body.filter = {
          ...(debouncedQ ? { q: debouncedQ } : {}),
          ...(tagIds.length > 0 ? { tagIds, tagFilterMode } : {}),
          ...(unsubscribed ? { unsubscribed: unsubscribed === "true" } : {}),
        };
      } else {
        body.userIds = Object.keys(rowSelection);
      }
      const result = await apiPost<{ affected: number }>("/api/users/tags/batch", body);
      await mutate();
      resetSelection();
      toast({
        title: batchMode === "add" ? "已添加标签" : "已移除标签",
        description: `影响 ${result.affected} 位用户`,
      });
    } catch (err) {
      toast({
        variant: "destructive",
        title: "批量操作失败",
        description: err instanceof Error ? err.message : "请稍后重试",
      });
    } finally {
      setBatchLoading(false);
    }
  }

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

      {selectedCount > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/50 p-3">
          <span className="text-sm font-medium">
            已选 {selectedCount} 位用户
          </span>
          {!selectAll && total > pageSize && total <= BATCH_TAG_FILTER_LIMIT && (
            <Button variant="link" size="sm" onClick={() => setSelectAll(true)}>
              选择全部 {total} 个符合条件的用户
            </Button>
          )}
          {!selectAll && total > BATCH_TAG_FILTER_LIMIT && (
            <span className="text-xs text-muted-foreground">
              符合条件 {total} 人，超过 {BATCH_TAG_FILTER_LIMIT} 上限，请缩小筛选范围后再整体操作
            </span>
          )}
          {selectAll && (
            <Button variant="link" size="sm" onClick={() => setSelectAll(false)}>
              仅选当前页
            </Button>
          )}
          <span className="mx-1 h-4 w-px bg-border" />
          {batchMode === null ? (
            <>
              <Button size="sm" variant="outline" onClick={() => setBatchMode("add")}>
                添加标签
              </Button>
              <Button size="sm" variant="outline" onClick={() => setBatchMode("remove")}>
                移除标签
              </Button>
              <Button size="sm" variant="ghost" onClick={resetSelection}>
                取消
              </Button>
            </>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted-foreground">
                {batchMode === "add" ? "添加" : "移除"}标签：
              </span>
              <TagPicker value={batchTagIds} onChange={setBatchTagIds} />
              <Button
                size="sm"
                disabled={batchTagIds.length === 0 || batchLoading}
                onClick={executeBatch}
              >
                {batchLoading ? "处理中..." : "确认"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { setBatchMode(null); setBatchTagIds([]); }}>
                返回
              </Button>
            </div>
          )}
        </div>
      )}

      <DataTable
        columns={columns}
        data={rows}
        loading={isLoading}
        emptyText="未匹配到用户"
        rowSelection={rowSelection}
        onRowSelectionChange={setRowSelection}
        getRowId={getRowId}
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
