"use client";

import Link from "next/link";
import { useState } from "react";
import useSWR from "swr";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Pagination } from "@/components/pagination";
import { apiDelete, swrFetcher } from "@/lib/api-client";
import { swrKeys } from "@/lib/swr-keys";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";

const STATUS_CONFIG: Record<string, { label: string; variant: "default" | "secondary" | "outline" | "destructive" }> = {
  DRAFT: { label: "草稿", variant: "secondary" },
  SCHEDULED: { label: "已计划", variant: "outline" },
  SENDING: { label: "发送中", variant: "default" },
  AB_TESTING: { label: "A/B 测试中", variant: "outline" },
  PAUSED: { label: "已暂停", variant: "secondary" },
  COMPLETED: { label: "已完成", variant: "default" },
  FAILED: { label: "失败", variant: "destructive" },
  CANCELLED: { label: "已取消", variant: "secondary" },
};

interface CampaignItem {
  id: string;
  name: string;
  subject: string;
  status: string;
  fromEmail: string;
  isAbTest: boolean;
  totalRecipients: number;
  sentCount: number;
  deliveredCount: number;
  openCount: number;
  clickCount: number;
  bouncedCount: number;
  scheduledAt: string | null;
  createdAt: string;
  updatedAt: string;
  template: { id: string; name: string } | null;
}

interface ListResp {
  data: CampaignItem[];
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

export default function CampaignsListPage() {
  const { toast } = useToast();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const debouncedQ = useDebouncedValue(q, 300);

  const key = swrKeys.campaigns({
    q: debouncedQ || undefined,
    status: status || undefined,
    page,
    pageSize,
  });

  const { data, isLoading, mutate } = useSWR<ListResp>(key, swrFetcher, {
    keepPreviousData: true,
  });

  const [deleting, setDeleting] = useState<CampaignItem | null>(null);

  const total = data?.total ?? 0;
  const items = data?.data ?? [];

  return (
    <section className="space-y-4">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight" data-testid="campaigns-page-heading">
          邮件活动
        </h1>
        <Link
          href="/campaigns/new"
          className={buttonVariants({ variant: "default" })}
          data-testid="campaigns-new-button"
        >
          新建活动
        </Link>
      </header>

      <div className="grid gap-3 rounded-md border bg-card p-4 sm:grid-cols-3">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">搜索</label>
          <Input
            placeholder="按名称或主题搜索"
            value={q}
            onChange={(e) => { setQ(e.target.value); setPage(1); }}
            data-testid="campaigns-search"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">状态</label>
          <Select
            value={status}
            onChange={(e) => { setStatus(e.target.value); setPage(1); }}
            data-testid="campaigns-filter-status"
          >
            <option value="">全部状态</option>
            {Object.entries(STATUS_CONFIG).map(([val, cfg]) => (
              <option key={val} value={val}>{cfg.label}</option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">每页</label>
          <Select
            value={String(pageSize)}
            onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}
            data-testid="campaigns-page-size"
          >
            <option value="10">10</option>
            <option value="20">20</option>
            <option value="50">50</option>
          </Select>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-2" data-testid="campaigns-loading">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div
          className="flex h-40 items-center justify-center rounded-md border bg-muted/20 text-sm text-muted-foreground"
          data-testid="campaigns-empty"
        >
          暂无活动
        </div>
      ) : (
        <ul className="space-y-2" data-testid="campaigns-list">
          {items.map((c) => {
            const cfg = STATUS_CONFIG[c.status] ?? { label: c.status, variant: "outline" as const };
            return (
              <li
                key={c.id}
                className="flex flex-wrap items-center gap-3 rounded-md border bg-card px-4 py-3 text-sm shadow-sm"
                data-testid={`campaign-item-${c.id}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/campaigns/${c.id}`}
                      className="truncate font-medium hover:underline"
                    >
                      {c.name}
                    </Link>
                    <Badge variant={cfg.variant}>{cfg.label}</Badge>
                    {c.isAbTest && <Badge variant="outline">A/B</Badge>}
                  </div>
                  <div className="mt-1 truncate text-xs text-muted-foreground" title={c.subject}>
                    {c.subject}
                  </div>
                  <div className="mt-1.5 flex gap-4 text-xs text-muted-foreground">
                    <span>收件人 {c.totalRecipients}</span>
                    <span>已发 {c.sentCount}</span>
                    <span>打开 {c.openCount}</span>
                    <span>点击 {c.clickCount}</span>
                    {c.template && <span>模板: {c.template.name}</span>}
                  </div>
                </div>
                <div className="hidden text-right text-[11px] text-muted-foreground sm:block">
                  {c.scheduledAt ? (
                    <>
                      <div>计划发送</div>
                      <div>{new Date(c.scheduledAt).toLocaleString()}</div>
                    </>
                  ) : (
                    <>
                      <div>创建于</div>
                      <div>{new Date(c.createdAt).toLocaleString()}</div>
                    </>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Link
                    href={`/campaigns/${c.id}`}
                    className={buttonVariants({ variant: "outline", size: "sm" })}
                  >
                    详情
                  </Link>
                  {c.status === "DRAFT" && (
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      onClick={() => setDeleting(c)}
                      data-testid={`campaign-delete-${c.id}`}
                    >
                      删除
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Pagination
        page={page}
        pageSize={pageSize}
        total={total}
        onPageChange={(p) => { setPage(p); mutate(); }}
      />

      <ConfirmDialog
        open={deleting !== null}
        title="删除活动"
        description={deleting ? `确认删除「${deleting.name}」？此操作不可恢复。` : ""}
        confirmLabel="删除"
        destructive
        onOpenChange={(o) => { if (!o) setDeleting(null); }}
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await apiDelete(`/api/campaigns/${deleting.id}`);
            toast({ title: "已删除" });
            await mutate();
          } catch (e) {
            toast({ title: "删除失败", description: asMessage(e), variant: "destructive" });
          } finally {
            setDeleting(null);
          }
        }}
      />
    </section>
  );
}
