"use client";

import { useState } from "react";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { apiDelete, apiPost, apiPatch, swrFetcher } from "@/lib/api-client";
import { swrKeys } from "@/lib/swr-keys";
import { ResendConfigDialog } from "./resend-config-dialog";
import { ChannelFormDialog } from "./channel-form-dialog";

interface ResendConfig {
  id: string;
  name: string;
  apiKeyHint: string | null;
  status: string;
  createdAt: string;
}

interface SendingChannel {
  id: string;
  name: string;
  providerType: "RESEND" | "SMTP";
  fromEmail: string;
  fromName: string | null;
  replyTo: string | null;
  isSystemDefault: boolean;
  status: string;
  smtpConfig: { id: string; name: string; host: string; port: number; status: string } | null;
  resendConfig: { id: string; name: string; apiKeyHint: string | null; status: string } | null;
  createdAt: string;
}

function asMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return "操作失败";
}

export default function ChannelsPage() {
  const { toast } = useToast();
  const { data: resendData, mutate: mutateResend } = useSWR<{ data: ResendConfig[] }>(
    swrKeys.resendConfigs(),
    swrFetcher,
  );
  const { data: channelData, mutate: mutateChannels } = useSWR<{ data: SendingChannel[] }>(
    swrKeys.sendingChannels(),
    swrFetcher,
  );

  const [showResendDialog, setShowResendDialog] = useState(false);
  const [editingResend, setEditingResend] = useState<ResendConfig | null>(null);
  const [showChannelDialog, setShowChannelDialog] = useState(false);
  const [editingChannel, setEditingChannel] = useState<SendingChannel | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ type: "resend" | "channel"; id: string; name: string } | null>(null);

  const resendConfigs = resendData?.data ?? [];
  const channels = channelData?.data ?? [];

  async function handleDeleteConfirm() {
    if (!deleteTarget) return;
    try {
      if (deleteTarget.type === "resend") {
        await apiDelete(`/api/resend-configs/${deleteTarget.id}`);
        mutateResend();
      } else {
        await apiDelete(`/api/sending-channels/${deleteTarget.id}`);
        mutateChannels();
      }
      toast({ title: "已删除", variant: "default" });
    } catch (err) {
      toast({ title: asMessage(err), variant: "destructive" });
    }
    setDeleteTarget(null);
  }

  async function handleSetDefault(id: string) {
    try {
      await apiPost(`/api/sending-channels/${id}/set-default`);
      mutateChannels();
      toast({ title: "已设为系统默认", variant: "default" });
    } catch (err) {
      toast({ title: asMessage(err), variant: "destructive" });
    }
  }

  async function handleToggleChannelStatus(channel: SendingChannel) {
    const newStatus = channel.status === "ACTIVE" ? "DISABLED" : "ACTIVE";
    try {
      await apiPatch(`/api/sending-channels/${channel.id}`, { status: newStatus });
      mutateChannels();
    } catch (err) {
      toast({ title: asMessage(err), variant: "destructive" });
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">发件通道管理</h1>
        <p className="text-muted-foreground mt-1">管理 Resend API 配置和发件通道。每个 Campaign 发送前需选择一个通道。</p>
      </div>

      {/* Resend Configs */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Resend 配置</h2>
          <Button size="sm" onClick={() => setShowResendDialog(true)}>新建 Resend 配置</Button>
        </div>
        {resendConfigs.length === 0 ? (
          <p className="text-muted-foreground text-sm">暂无 Resend 配置。</p>
        ) : (
          <div className="border rounded-md divide-y">
            {resendConfigs.map((rc) => (
              <div key={rc.id} className="flex items-center justify-between px-4 py-3">
                <div>
                  <span className="font-medium">{rc.name}</span>
                  <span className="ml-2 text-sm text-muted-foreground">{rc.apiKeyHint}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={rc.status === "ACTIVE" ? "default" : "secondary"}>{rc.status}</Badge>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setEditingResend(rc)}
                  >
                    编辑
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setDeleteTarget({ type: "resend", id: rc.id, name: rc.name })}
                  >
                    删除
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Sending Channels */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">发件通道</h2>
          <Button size="sm" onClick={() => setShowChannelDialog(true)}>新建通道</Button>
        </div>
        {channels.length === 0 ? (
          <p className="text-muted-foreground text-sm">暂无通道。请先创建 Resend 或 SMTP 配置，然后创建通道。</p>
        ) : (
          <div className="border rounded-md divide-y">
            {channels.map((ch) => (
              <div key={ch.id} className="flex items-center justify-between px-4 py-3">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{ch.name}</span>
                    <Badge variant="outline">{ch.providerType}</Badge>
                    {ch.isSystemDefault && <Badge>系统默认</Badge>}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {ch.fromEmail}
                    {ch.providerType === "SMTP" && ch.smtpConfig && ` (${ch.smtpConfig.host}:${ch.smtpConfig.port})`}
                    {ch.providerType === "RESEND" && ch.resendConfig && ` (${ch.resendConfig.apiKeyHint})`}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={ch.status === "ACTIVE" ? "default" : "secondary"}>{ch.status}</Badge>
                  {!ch.isSystemDefault && (
                    <Button size="sm" variant="outline" onClick={() => handleSetDefault(ch.id)}>
                      设为默认
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => setEditingChannel(ch)}>
                    编辑
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => handleToggleChannelStatus(ch)}>
                    {ch.status === "ACTIVE" ? "禁用" : "启用"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setDeleteTarget({ type: "channel", id: ch.id, name: ch.name })}
                  >
                    删除
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {showResendDialog && (
        <ResendConfigDialog
          onClose={() => setShowResendDialog(false)}
          onSuccess={() => { mutateResend(); setShowResendDialog(false); }}
        />
      )}

      {editingResend && (
        <ResendConfigDialog
          existing={editingResend}
          onClose={() => setEditingResend(null)}
          onSuccess={() => { mutateResend(); setEditingResend(null); }}
        />
      )}

      {showChannelDialog && (
        <ChannelFormDialog
          onClose={() => setShowChannelDialog(false)}
          onSuccess={() => { mutateChannels(); setShowChannelDialog(false); }}
        />
      )}

      {editingChannel && (
        <ChannelFormDialog
          existing={editingChannel}
          onClose={() => setEditingChannel(null)}
          onSuccess={() => { mutateChannels(); setEditingChannel(null); }}
        />
      )}

      {deleteTarget && (
        <ConfirmDialog
          open={!!deleteTarget}
          title={`确认删除 "${deleteTarget.name}"？`}
          description="此操作不可撤销。"
          destructive
          onConfirm={handleDeleteConfirm}
          onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        />
      )}
    </div>
  );
}
