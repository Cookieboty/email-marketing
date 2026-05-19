"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { apiPost, apiDelete, swrFetcher } from "@/lib/api-client";
import { swrKeys } from "@/lib/swr-keys";
import { useState } from "react";

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

interface CampaignVariant {
  id: string;
  variantName: string;
  status: string;
  samplePercentage: number;
  sentCount: number;
  openCount: number;
  clickCount: number;
}

interface CampaignDetail {
  id: string;
  name: string;
  subject: string;
  status: string;
  fromEmail: string;
  replyTo: string | null;
  templateId: string;
  segmentId: string | null;
  tagFilter: string[];
  isAbTest: boolean;
  abTestConfig: unknown;
  utmParams: unknown;
  scheduledAt: string | null;
  totalRecipients: number;
  sentCount: number;
  deliveredCount: number;
  openCount: number;
  clickCount: number;
  bouncedCount: number;
  complainCount: number;
  unsubscribeCount: number;
  failedCount: number;
  createdAt: string;
  updatedAt: string;
  template: { id: string; name: string } | null;
  variants: CampaignVariant[];
}

function asMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return "操作失败";
}

function pct(num: number, den: number): string {
  if (den === 0) return "0.0%";
  return ((num / den) * 100).toFixed(1) + "%";
}

export default function CampaignDetailPage({ id }: { id: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{ label: string; action: string; destructive?: boolean } | null>(null);

  const { data: c, isLoading, mutate } = useSWR<CampaignDetail>(
    swrKeys.campaign(id),
    swrFetcher,
    {
      refreshInterval: (data) =>
        data?.status === "SENDING" || data?.status === "AB_TESTING" ? 10000 : 0,
    },
  );

  async function runAction(action: string) {
    setBusy(true);
    try {
      if (action === "delete") {
        await apiDelete(`/api/campaigns/${id}`);
        toast({ title: "已删除" });
        router.push("/campaigns");
        return;
      }
      await apiPost(`/api/campaigns/${id}/${action}`);
      toast({ title: "操作成功" });
      await mutate();
    } catch (e) {
      toast({ title: "操作失败", description: asMessage(e), variant: "destructive" });
    } finally {
      setBusy(false);
      setConfirmAction(null);
    }
  }

  if (isLoading || !c) {
    return (
      <section className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      </section>
    );
  }

  const cfg = STATUS_CONFIG[c.status] ?? { label: c.status, variant: "outline" as const };

  const actions: Array<{ label: string; action: string; destructive?: boolean }> = [];
  switch (c.status) {
    case "DRAFT":
      actions.push({ label: "发送", action: "send" });
      actions.push({ label: "删除", action: "delete", destructive: true });
      break;
    case "SCHEDULED":
      actions.push({ label: "取消定时", action: "cancel", destructive: true });
      break;
    case "SENDING":
      actions.push({ label: "暂停", action: "pause" });
      actions.push({ label: "取消", action: "cancel", destructive: true });
      break;
    case "PAUSED":
      actions.push({ label: "恢复", action: "resume" });
      actions.push({ label: "取消", action: "cancel", destructive: true });
      break;
    case "FAILED":
      actions.push({ label: "重试", action: "retry" });
      actions.push({ label: "取消", action: "cancel", destructive: true });
      break;
  }

  const stats = [
    { title: "总收件人", value: c.totalRecipients },
    { title: "已发送", value: c.sentCount },
    { title: "已送达", value: c.deliveredCount },
    { title: "打开", value: `${c.openCount} (${pct(c.openCount, c.deliveredCount)})` },
    { title: "点击", value: `${c.clickCount} (${pct(c.clickCount, c.deliveredCount)})` },
    { title: "退信", value: c.bouncedCount },
    { title: "投诉", value: c.complainCount },
    { title: "失败", value: c.failedCount },
  ];

  return (
    <section className="space-y-6" data-testid="campaign-detail">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{c.name}</h1>
        <Badge variant={cfg.variant}>{cfg.label}</Badge>
        {c.isAbTest && <Badge variant="outline">A/B 测试</Badge>}
        <div className="ml-auto flex gap-2">
          {actions.map((a) => (
            <Button
              key={a.action}
              variant={a.destructive ? "destructive" : "default"}
              size="sm"
              disabled={busy}
              onClick={() => {
                if (a.destructive) {
                  setConfirmAction(a);
                } else {
                  void runAction(a.action);
                }
              }}
              data-testid={`action-${a.action}`}
            >
              {a.label}
            </Button>
          ))}
        </div>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.title}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">{s.title}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-xl font-bold">{s.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {c.isAbTest && c.variants.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-lg font-medium">A/B 变体</h2>
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-4 py-2 text-left font-medium">变体</th>
                  <th className="px-4 py-2 text-right font-medium">样本%</th>
                  <th className="px-4 py-2 text-right font-medium">已发</th>
                  <th className="px-4 py-2 text-right font-medium">打开</th>
                  <th className="px-4 py-2 text-right font-medium">点击</th>
                  <th className="px-4 py-2 text-right font-medium">状态</th>
                </tr>
              </thead>
              <tbody>
                {c.variants.map((v) => (
                  <tr key={v.id} className="border-b last:border-0">
                    <td className="px-4 py-2 font-medium">{v.variantName}</td>
                    <td className="px-4 py-2 text-right">{v.samplePercentage}%</td>
                    <td className="px-4 py-2 text-right">{v.sentCount}</td>
                    <td className="px-4 py-2 text-right">{v.openCount}</td>
                    <td className="px-4 py-2 text-right">{v.clickCount}</td>
                    <td className="px-4 py-2 text-right">
                      <Badge variant="outline">{v.status}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="space-y-3">
        <h2 className="text-lg font-medium">活动信息</h2>
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <div className="flex gap-2">
            <dt className="w-24 shrink-0 text-muted-foreground">主题</dt>
            <dd className="truncate">{c.subject}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-24 shrink-0 text-muted-foreground">发件人</dt>
            <dd>{c.fromEmail}</dd>
          </div>
          {c.replyTo && (
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 text-muted-foreground">回复地址</dt>
              <dd>{c.replyTo}</dd>
            </div>
          )}
          {c.template && (
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 text-muted-foreground">模板</dt>
              <dd>{c.template.name}</dd>
            </div>
          )}
          {c.tagFilter.length > 0 && (
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 text-muted-foreground">标签</dt>
              <dd>{c.tagFilter.join(", ")}</dd>
            </div>
          )}
          {c.scheduledAt && (
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 text-muted-foreground">计划发送</dt>
              <dd>{new Date(c.scheduledAt).toLocaleString()}</dd>
            </div>
          )}
          <div className="flex gap-2">
            <dt className="w-24 shrink-0 text-muted-foreground">创建时间</dt>
            <dd>{new Date(c.createdAt).toLocaleString()}</dd>
          </div>
        </dl>
      </div>

      <Link
        href={`/campaigns/${id}/recipients`}
        className={buttonVariants({ variant: "outline" })}
        data-testid="link-recipients"
      >
        查看收件人列表
      </Link>

      <ConfirmDialog
        open={confirmAction !== null}
        title={confirmAction?.label ?? ""}
        description={`确认${confirmAction?.label ?? ""}此活动？`}
        confirmLabel={confirmAction?.label ?? "确认"}
        destructive={confirmAction?.destructive}
        onOpenChange={(o) => { if (!o) setConfirmAction(null); }}
        onConfirm={async () => {
          if (confirmAction) await runAction(confirmAction.action);
        }}
      />
    </section>
  );
}
