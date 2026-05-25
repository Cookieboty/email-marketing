"use client";

import { useState } from "react";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { apiPost, apiPatch, swrFetcher } from "@/lib/api-client";
import { swrKeys } from "@/lib/swr-keys";

interface SmtpConfigOption {
  id: string;
  name: string;
  host: string;
  port: number;
  status: string;
}

interface ResendConfigOption {
  id: string;
  name: string;
  apiKeyHint: string | null;
  status: string;
}

interface ChannelData {
  id: string;
  name: string;
  providerType: "RESEND" | "SMTP";
  smtpConfigId?: string | null;
  resendConfigId?: string | null;
  fromEmail: string | null;
  fromName: string | null;
  replyTo: string | null;
  isSystemDefault: boolean;
  status: string;
}

interface Props {
  existing?: ChannelData;
  onClose: () => void;
  onSuccess: () => void;
}

export function ChannelFormDialog({ existing, onClose, onSuccess }: Props) {
  const { toast } = useToast();
  const isEdit = !!existing;

  const { data: smtpData } = useSWR<{ data: SmtpConfigOption[] }>(
    swrKeys.smtpConfigs(),
    swrFetcher,
  );
  const { data: resendData } = useSWR<{ data: ResendConfigOption[] }>(
    swrKeys.resendConfigs(),
    swrFetcher,
  );

  const [name, setName] = useState(existing?.name ?? "");
  const [providerType, setProviderType] = useState<"RESEND" | "SMTP">(existing?.providerType ?? "RESEND");
  const [configId, setConfigId] = useState(
    existing?.providerType === "SMTP" ? (existing.smtpConfigId ?? "") : (existing?.resendConfigId ?? ""),
  );
  const [fromEmail, setFromEmail] = useState(existing?.fromEmail ?? "");
  const [fromName, setFromName] = useState(existing?.fromName ?? "");
  const [replyTo, setReplyTo] = useState(existing?.replyTo ?? "");
  const [isDefault, setIsDefault] = useState(existing?.isSystemDefault ?? false);
  const [loading, setLoading] = useState(false);

  const smtpOptions = smtpData?.data?.filter((s) => s.status === "ACTIVE") ?? [];
  const resendOptions = resendData?.data?.filter((r) => r.status === "ACTIVE") ?? [];
  const configOptions = providerType === "SMTP" ? smtpOptions : resendOptions;

  const canSubmit = name.trim() && (isEdit || configId) && (providerType === "RESEND" || fromEmail.trim());

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setLoading(true);
    try {
      if (isEdit) {
        await apiPatch(`/api/sending-channels/${existing.id}`, {
          name: name.trim(),
          fromEmail: fromEmail.trim() || null,
          fromName: fromName.trim() || null,
          replyTo: replyTo.trim() || null,
        });
        toast({ title: "通道已更新" });
      } else {
        await apiPost("/api/sending-channels", {
          name: name.trim(),
          providerType,
          ...(providerType === "SMTP" ? { smtpConfigId: configId } : { resendConfigId: configId }),
          ...(fromEmail.trim() ? { fromEmail: fromEmail.trim() } : {}),
          fromName: fromName.trim() || undefined,
          replyTo: replyTo.trim() || undefined,
          isSystemDefault: isDefault,
        });
        toast({ title: "通道已创建" });
      }
      onSuccess();
    } catch (err) {
      const msg = err instanceof Error ? err.message : isEdit ? "更新失败" : "创建失败";
      toast({ title: msg, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-background border rounded-lg p-6 w-full max-w-lg shadow-lg">
        <h3 className="text-lg font-semibold mb-4">{isEdit ? "编辑发件通道" : "新建发件通道"}</h3>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="text-sm font-medium">通道名称</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：营销邮件通道" />
          </div>
          {!isEdit && (
            <>
              <div>
                <label className="text-sm font-medium">类型</label>
                <Select
                  value={providerType}
                  onChange={(e) => { setProviderType(e.target.value as "RESEND" | "SMTP"); setConfigId(""); }}
                >
                  <option value="RESEND">Resend</option>
                  <option value="SMTP">SMTP</option>
                </Select>
              </div>
              <div>
                <label className="text-sm font-medium">{providerType === "SMTP" ? "SMTP 配置" : "Resend 配置"}</label>
                <Select value={configId} onChange={(e) => setConfigId(e.target.value)}>
                  <option value="">请选择</option>
                  {configOptions.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.name} {providerType === "SMTP" ? `(${(opt as SmtpConfigOption).host})` : `(${(opt as ResendConfigOption).apiKeyHint})`}
                    </option>
                  ))}
                </Select>
              </div>
            </>
          )}
          <div>
            <label className="text-sm font-medium">
              发件人邮箱{providerType === "RESEND" && !isEdit ? "（可选，留空由 Campaign 指定）" : isEdit ? "" : " *"}
            </label>
            <Input value={fromEmail} onChange={(e) => setFromEmail(e.target.value)} placeholder="news@example.com" />
          </div>
          <div>
            <label className="text-sm font-medium">发件人名称（可选）</label>
            <Input value={fromName} onChange={(e) => setFromName(e.target.value)} placeholder="Marketing Team" />
          </div>
          <div>
            <label className="text-sm font-medium">Reply-To（可选）</label>
            <Input value={replyTo} onChange={(e) => setReplyTo(e.target.value)} placeholder="support@example.com" />
          </div>
          {!isEdit && (
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="isDefault"
                checked={isDefault}
                onChange={(e) => setIsDefault(e.target.checked)}
                className="rounded"
              />
              <label htmlFor="isDefault" className="text-sm">设为系统默认通道</label>
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={onClose}>取消</Button>
            <Button type="submit" disabled={loading || !canSubmit}>
              {loading ? (isEdit ? "保存中..." : "创建中...") : (isEdit ? "保存" : "创建")}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
