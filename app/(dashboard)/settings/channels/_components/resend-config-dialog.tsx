"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { apiPost, apiPatch } from "@/lib/api-client";

interface ResendConfigData {
  id: string;
  name: string;
  apiKeyHint: string | null;
  status: string;
}

interface Props {
  existing?: ResendConfigData;
  onClose: () => void;
  onSuccess: () => void;
}

export function ResendConfigDialog({ existing, onClose, onSuccess }: Props) {
  const { toast } = useToast();
  const isEdit = !!existing;
  const [name, setName] = useState(existing?.name ?? "");
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState(existing?.status ?? "ACTIVE");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    if (!isEdit && !apiKey.trim()) return;
    setLoading(true);
    try {
      if (isEdit) {
        const payload: Record<string, string> = { name: name.trim(), status };
        if (apiKey.trim()) payload.apiKey = apiKey.trim();
        await apiPatch(`/api/resend-configs/${existing.id}`, payload);
        toast({ title: "Resend 配置已更新" });
      } else {
        await apiPost("/api/resend-configs", { name: name.trim(), apiKey: apiKey.trim() });
        toast({ title: "Resend 配置已创建" });
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
      <div className="bg-background border rounded-lg p-6 w-full max-w-md shadow-lg">
        <h3 className="text-lg font-semibold mb-4">{isEdit ? "编辑 Resend 配置" : "新建 Resend 配置"}</h3>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="text-sm font-medium">名称</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：主账号" />
          </div>
          <div>
            <label className="text-sm font-medium">API Key</label>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={isEdit ? `当前：${existing.apiKeyHint ?? "***"}（留空不修改）` : "re_..."}
            />
          </div>
          {isEdit && (
            <div>
              <label className="text-sm font-medium">状态</label>
              <Select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="ACTIVE">启用</option>
                <option value="DISABLED">禁用</option>
              </Select>
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={onClose}>取消</Button>
            <Button type="submit" disabled={loading || !name.trim() || (!isEdit && !apiKey.trim())}>
              {loading ? (isEdit ? "保存中..." : "创建中...") : (isEdit ? "保存" : "创建")}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
