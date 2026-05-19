"use client";

import Link from "next/link";
import { useState } from "react";
import useSWR from "swr";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Pagination } from "@/components/pagination";
import { swrFetcher } from "@/lib/api-client";
import { swrKeys } from "@/lib/swr-keys";

const RECIPIENT_STATUS: Record<string, { label: string; variant: "default" | "secondary" | "outline" | "destructive" }> = {
  PENDING: { label: "待发送", variant: "secondary" },
  SENDING: { label: "发送中", variant: "outline" },
  SENT: { label: "已发送", variant: "outline" },
  DELIVERED: { label: "已送达", variant: "default" },
  OPENED: { label: "已打开", variant: "default" },
  CLICKED: { label: "已点击", variant: "default" },
  BOUNCED: { label: "硬退信", variant: "destructive" },
  SOFT_BOUNCED: { label: "软退信", variant: "secondary" },
  COMPLAINED: { label: "投诉", variant: "destructive" },
  UNSUBSCRIBED: { label: "已退订", variant: "secondary" },
  FAILED: { label: "失败", variant: "destructive" },
};

interface RecipientItem {
  id: string;
  userId: string;
  status: string;
  variantId: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  openedAt: string | null;
  clickedAt: string | null;
  bouncedAt: string | null;
  createdAt: string;
  user: { id: string; email: string; name: string | null };
}

interface ListResp {
  data: RecipientItem[];
  total: number;
  page: number;
  pageSize: number;
}

export default function RecipientsPage({ campaignId }: { campaignId: string }) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [status, setStatus] = useState("");

  const key = swrKeys.campaignRecipients(campaignId, {
    status: status || undefined,
    page,
    pageSize,
  });

  const { data, isLoading, mutate } = useSWR<ListResp>(key, swrFetcher, {
    keepPreviousData: true,
    refreshInterval: 15000,
  });

  const total = data?.total ?? 0;
  const items = data?.data ?? [];

  return (
    <section className="space-y-4">
      <header className="flex items-center gap-3">
        <Link
          href={`/campaigns/${campaignId}`}
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          ← 返回活动
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight" data-testid="recipients-heading">
          收件人列表
        </h1>
      </header>

      <div className="grid gap-3 rounded-md border bg-card p-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">状态筛选</label>
          <Select
            value={status}
            onChange={(e) => { setStatus(e.target.value); setPage(1); }}
            data-testid="recipients-filter-status"
          >
            <option value="">全部状态</option>
            {Object.entries(RECIPIENT_STATUS).map(([val, cfg]) => (
              <option key={val} value={val}>{cfg.label}</option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">每页</label>
          <Select
            value={String(pageSize)}
            onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}
            data-testid="recipients-page-size"
          >
            <option value="20">20</option>
            <option value="50">50</option>
            <option value="100">100</option>
          </Select>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-2" data-testid="recipients-loading">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div
          className="flex h-40 items-center justify-center rounded-md border bg-muted/20 text-sm text-muted-foreground"
          data-testid="recipients-empty"
        >
          暂无收件人
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm" data-testid="recipients-table">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-4 py-2 text-left font-medium">邮箱</th>
                <th className="px-4 py-2 text-left font-medium">姓名</th>
                <th className="px-4 py-2 text-left font-medium">状态</th>
                <th className="px-4 py-2 text-left font-medium">发送时间</th>
                <th className="px-4 py-2 text-left font-medium">打开时间</th>
                <th className="px-4 py-2 text-left font-medium">点击时间</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => {
                const sCfg = RECIPIENT_STATUS[r.status] ?? { label: r.status, variant: "outline" as const };
                return (
                  <tr key={r.id} className="border-b last:border-0">
                    <td className="px-4 py-2">{r.user.email}</td>
                    <td className="px-4 py-2 text-muted-foreground">{r.user.name ?? "-"}</td>
                    <td className="px-4 py-2">
                      <Badge variant={sCfg.variant}>{sCfg.label}</Badge>
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">
                      {r.sentAt ? new Date(r.sentAt).toLocaleString() : "-"}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">
                      {r.openedAt ? new Date(r.openedAt).toLocaleString() : "-"}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">
                      {r.clickedAt ? new Date(r.clickedAt).toLocaleString() : "-"}
                    </td>
                  </tr>
                );
              })}
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
