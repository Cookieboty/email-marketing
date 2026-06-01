"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { apiPost, apiPatch, apiDelete, swrFetcher } from "@/lib/api-client";
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

interface ChannelOption {
  id: string;
  name: string;
  providerType: string;
  fromEmail: string | null;
  status: string;
}

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
  sendingChannelId: string | null;
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
  const [testSendOpen, setTestSendOpen] = useState(false);
  const [testSendTo, setTestSendTo] = useState("");
  const [testSendLocale, setTestSendLocale] = useState<"zh" | "en">("zh");
  const [testSending, setTestSending] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleAt, setScheduleAt] = useState("");
  const [scheduling, setScheduling] = useState(false);
  // 重试需要两次确认：1 = 第一次确认，2 = 第二次确认，0 = 关闭。
  const [retryStep, setRetryStep] = useState<0 | 1 | 2>(0);
  const [editOpen, setEditOpen] = useState(false);
  const [editChannelId, setEditChannelId] = useState("");
  const [editFromEmail, setEditFromEmail] = useState("");
  const [editReplyTo, setEditReplyTo] = useState("");
  const [editSaving, setEditSaving] = useState(false);

  const { data: c, isLoading, mutate } = useSWR<CampaignDetail>(
    swrKeys.campaign(id),
    swrFetcher,
    {
      refreshInterval: (data) =>
        data?.status === "SENDING" || data?.status === "AB_TESTING" ? 10000 : 0,
    },
  );

  const { data: channelsData } = useSWR<{ data: ChannelOption[] }>(
    "/api/sending-channels",
    swrFetcher,
  );
  const activeChannels =
    channelsData?.data?.filter((ch) => ch.status === "ACTIVE") ?? [];

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

  async function handleTestSend() {
    if (!testSendTo.trim()) {
      toast({ title: "请填写收件人", variant: "destructive" });
      return;
    }
    setTestSending(true);
    try {
      await apiPost(`/api/campaigns/${id}/test-send`, {
        to: testSendTo.trim(),
        locale: testSendLocale,
      });
      toast({ title: "已发送", description: `${testSendTo.trim()}（${testSendLocale === "zh" ? "中文" : "English"}）` });
      setTestSendOpen(false);
      setTestSendTo("");
    } catch (e) {
      toast({ title: "测试发送失败", description: asMessage(e), variant: "destructive" });
    } finally {
      setTestSending(false);
    }
  }

  async function handleSchedule() {
    if (!scheduleAt) {
      toast({ title: "请选择发送时间", variant: "destructive" });
      return;
    }
    const when = new Date(scheduleAt);
    if (when.getTime() <= Date.now() + 60_000) {
      toast({ title: "发送时间需至少在 1 分钟之后", variant: "destructive" });
      return;
    }
    setScheduling(true);
    try {
      await apiPost(`/api/campaigns/${id}/schedule`, { scheduledAt: when.toISOString() });
      toast({ title: "已设置定时发送", description: when.toLocaleString() });
      setScheduleOpen(false);
      setScheduleAt("");
      await mutate();
    } catch (e) {
      toast({ title: "定时发送设置失败", description: asMessage(e), variant: "destructive" });
    } finally {
      setScheduling(false);
    }
  }

  function openEdit() {
    if (!c) return;
    setEditChannelId(c.sendingChannelId ?? "");
    setEditFromEmail(c.fromEmail ?? "");
    setEditReplyTo(c.replyTo ?? "");
    setEditOpen(true);
  }

  async function handleEditSave() {
    if (!editChannelId) {
      toast({ title: "请选择发送渠道", variant: "destructive" });
      return;
    }
    setEditSaving(true);
    try {
      const payload: {
        sendingChannelId: string;
        fromEmail?: string;
        replyTo?: string;
      } = { sendingChannelId: editChannelId };
      // 发件人留空 => 不提交该字段，后端按所选渠道默认发件人重新解析。
      if (editFromEmail.trim()) payload.fromEmail = editFromEmail.trim();
      if (editReplyTo.trim()) payload.replyTo = editReplyTo.trim();
      await apiPatch(`/api/campaigns/${id}`, payload);
      toast({ title: "已保存发送设置" });
      setEditOpen(false);
      await mutate();
    } catch (e) {
      toast({ title: "保存失败", description: asMessage(e), variant: "destructive" });
    } finally {
      setEditSaving(false);
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
          {c.status !== "COMPLETED" && c.status !== "CANCELLED" && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => setTestSendOpen(true)}
              data-testid="action-test-send"
            >
              测试发送
            </Button>
          )}
          {c.status === "DRAFT" && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => setScheduleOpen(true)}
              data-testid="action-schedule"
            >
              定时发送
            </Button>
          )}
          {c.status === "FAILED" && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={openEdit}
              data-testid="action-edit"
            >
              编辑发送设置
            </Button>
          )}
          {actions.map((a) => (
            <Button
              key={a.action}
              variant={a.destructive ? "destructive" : "default"}
              size="sm"
              disabled={busy}
              onClick={() => {
                if (a.action === "retry") {
                  setRetryStep(1);
                } else if (a.destructive) {
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

      <ConfirmDialog
        open={retryStep === 1}
        title="重试发送"
        description={`将把 ${c.failedCount} 个发送失败的收件人重新加入发送队列。确认继续？`}
        confirmLabel="继续"
        onOpenChange={(o) => { if (!o) setRetryStep(0); }}
        onConfirm={async () => {
          setRetryStep(2);
        }}
      />

      <ConfirmDialog
        open={retryStep === 2}
        title="再次确认重试"
        description="确定后将立即开始重新发送，无法撤销。是否立即发送？"
        confirmLabel="立即发送"
        loading={busy}
        onOpenChange={(o) => { if (!o && !busy) setRetryStep(0); }}
        onConfirm={async () => {
          await runAction("retry");
          setRetryStep(0);
        }}
      />

      <Dialog
        open={editOpen}
        onOpenChange={(o) => { if (!o) setEditOpen(false); }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑发送设置</DialogTitle>
            <DialogDescription>
              修正发送渠道与发件人后即可重试发送（不会改变收件人列表）。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="edit-channel">发送渠道</Label>
              <Select
                id="edit-channel"
                value={editChannelId}
                onChange={(e) => setEditChannelId(e.target.value)}
                data-testid="campaign-edit-channel"
              >
                <option value="">请选择发送渠道</option>
                {activeChannels.map((ch) => (
                  <option key={ch.id} value={ch.id}>
                    {ch.name}（{ch.providerType}
                    {ch.fromEmail ? ` - ${ch.fromEmail}` : ""}）
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-from">发件人邮箱</Label>
              <Input
                id="edit-from"
                value={editFromEmail}
                onChange={(e) => setEditFromEmail(e.target.value)}
                placeholder="留空则使用所选渠道的默认发件人"
                data-testid="campaign-edit-from"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-reply-to">回复邮箱</Label>
              <Input
                id="edit-reply-to"
                type="email"
                value={editReplyTo}
                onChange={(e) => setEditReplyTo(e.target.value)}
                placeholder="可选"
                data-testid="campaign-edit-reply-to"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setEditOpen(false)}
              disabled={editSaving}
            >
              取消
            </Button>
            <Button
              onClick={handleEditSave}
              disabled={editSaving}
              data-testid="campaign-edit-submit"
            >
              {editSaving ? "保存中..." : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={testSendOpen}
        onOpenChange={(o) => {
          if (!o) {
            setTestSendTo("");
            setTestSendOpen(false);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>测试发送</DialogTitle>
            <DialogDescription>
              收件人必须配置在 <code>ADMIN_TEST_EMAILS</code> 白名单中。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="test-send-to">收件人</Label>
              <Input
                id="test-send-to"
                type="email"
                value={testSendTo}
                onChange={(e) => setTestSendTo(e.target.value)}
                placeholder="admin@example.com"
                autoFocus
                data-testid="campaign-test-send-to"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="test-send-locale">语言</Label>
              <Select
                id="test-send-locale"
                value={testSendLocale}
                onChange={(e) => setTestSendLocale(e.target.value as "zh" | "en")}
                data-testid="campaign-test-send-locale"
              >
                <option value="zh">中文</option>
                <option value="en">English</option>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setTestSendOpen(false)}
              disabled={testSending}
            >
              取消
            </Button>
            <Button
              onClick={handleTestSend}
              disabled={testSending}
              data-testid="campaign-test-send-submit"
            >
              {testSending ? "发送中..." : "发送"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={scheduleOpen}
        onOpenChange={(o) => {
          if (!o) {
            setScheduleAt("");
            setScheduleOpen(false);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>定时发送</DialogTitle>
            <DialogDescription>
              到点后由后台任务自动发送，触发精度约 1 分钟。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="schedule-at">发送时间</Label>
            <Input
              id="schedule-at"
              type="datetime-local"
              value={scheduleAt}
              onChange={(e) => setScheduleAt(e.target.value)}
              data-testid="campaign-schedule-at"
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setScheduleOpen(false)}
              disabled={scheduling}
            >
              取消
            </Button>
            <Button
              onClick={handleSchedule}
              disabled={scheduling}
              data-testid="campaign-schedule-submit"
            >
              {scheduling ? "设置中..." : "确认定时"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
