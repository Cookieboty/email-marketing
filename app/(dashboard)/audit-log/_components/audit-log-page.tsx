"use client";

import { useState } from "react";
import useSWR from "swr";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Pagination } from "@/components/pagination";
import { swrFetcher } from "@/lib/api-client";
import { swrKeys } from "@/lib/swr-keys";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";

interface AuditLogItem {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  actorType: string;
  details: unknown;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
}

interface ListResp {
  data: AuditLogItem[];
  total: number;
  page: number;
  pageSize: number;
}

export default function AuditLogPage() {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [action, setAction] = useState("");
  const [entityType, setEntityType] = useState("");
  const [actorType, setActorType] = useState("");
  const debouncedAction = useDebouncedValue(action, 300);
  const debouncedEntityType = useDebouncedValue(entityType, 300);

  const key = swrKeys.auditLog({
    action: debouncedAction || undefined,
    entityType: debouncedEntityType || undefined,
    actorType: actorType || undefined,
    page,
    pageSize,
  });

  const { data, isLoading, mutate } = useSWR<ListResp>(key, swrFetcher, {
    keepPreviousData: true,
  });

  const total = data?.total ?? 0;
  const items = data?.data ?? [];

  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight" data-testid="audit-log-heading">
        审计日志
      </h1>

      <div className="grid gap-3 rounded-md border bg-card p-4 sm:grid-cols-4">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">操作</label>
          <Input
            placeholder="例如 campaign.create"
            value={action}
            onChange={(e) => { setAction(e.target.value); setPage(1); }}
            data-testid="audit-filter-action"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">实体类型</label>
          <Input
            placeholder="例如 Campaign"
            value={entityType}
            onChange={(e) => { setEntityType(e.target.value); setPage(1); }}
            data-testid="audit-filter-entity-type"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">操作者</label>
          <Select
            value={actorType}
            onChange={(e) => { setActorType(e.target.value); setPage(1); }}
            data-testid="audit-filter-actor-type"
          >
            <option value="">全部</option>
            <option value="ADMIN">ADMIN</option>
            <option value="SYSTEM">SYSTEM</option>
            <option value="WEBHOOK">WEBHOOK</option>
          </Select>
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">每页</label>
          <Select
            value={String(pageSize)}
            onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}
            data-testid="audit-page-size"
          >
            <option value="20">20</option>
            <option value="50">50</option>
            <option value="100">100</option>
          </Select>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-2" data-testid="audit-loading">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div
          className="flex h-40 items-center justify-center rounded-md border bg-muted/20 text-sm text-muted-foreground"
          data-testid="audit-empty"
        >
          暂无日志记录
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm" data-testid="audit-table">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-4 py-2 text-left font-medium">时间</th>
                <th className="px-4 py-2 text-left font-medium">操作</th>
                <th className="px-4 py-2 text-left font-medium">实体类型</th>
                <th className="px-4 py-2 text-left font-medium">实体 ID</th>
                <th className="px-4 py-2 text-left font-medium">操作者</th>
                <th className="px-4 py-2 text-left font-medium">IP</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="border-b last:border-0">
                  <td className="whitespace-nowrap px-4 py-2 text-muted-foreground">
                    {new Date(item.createdAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">{item.action}</td>
                  <td className="px-4 py-2">{item.entityType}</td>
                  <td className="max-w-[120px] truncate px-4 py-2 font-mono text-xs" title={item.entityId}>
                    {item.entityId}
                  </td>
                  <td className="px-4 py-2">
                    <Badge variant="outline">{item.actorType}</Badge>
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">{item.ipAddress ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pagination
        page={page}
        pageSize={pageSize}
        total={total}
        onPageChange={(p) => { setPage(p); mutate(); }}
      />
    </section>
  );
}
