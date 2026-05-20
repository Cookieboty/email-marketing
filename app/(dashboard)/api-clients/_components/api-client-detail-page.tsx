"use client";

import { useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  apiDelete,
  apiPatch,
  apiPost,
  swrFetcher,
} from "@/lib/api-client";
import { swrKeys } from "@/lib/swr-keys";
import { ApiClientFormDialog } from "./api-client-form-dialog";
import { CredentialRevealDialog } from "./credential-reveal-dialog";
import {
  STATUS_LABELS,
  SCOPE_LABELS,
  type ApiClientRotatedResponse,
  type ApiClientRow,
} from "./types";

function asMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return "操作失败";
}

export interface ApiClientDetailPageProps {
  id: string;
}

export default function ApiClientDetailPage({ id }: ApiClientDetailPageProps) {
  const { toast } = useToast();
  const key = swrKeys.apiClient(id);
  const { data, isLoading, mutate } = useSWR<ApiClientRow>(key, swrFetcher);

  const [editOpen, setEditOpen] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [rotatingPending, setRotatingPending] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [credential, setCredential] = useState<{
    token: string;
    previousTokenExpiresAt?: string | null;
  } | null>(null);

  if (isLoading) {
    return <div className="text-sm text-muted-foreground">加载中…</div>;
  }
  if (!data) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">未找到该 API Client。</p>
        <Link href="/api-clients" className="text-sm underline">
          返回列表
        </Link>
      </div>
    );
  }

  const revoked = data.status === "REVOKED";

  async function toggleStatus() {
    if (!data) return;
    const next = data.status === "ACTIVE" ? "DISABLED" : "ACTIVE";
    try {
      await apiPatch(`/api/api-clients/${data.id}`, { status: next });
      toast({ title: next === "ACTIVE" ? "已启用" : "已停用" });
      await mutate();
    } catch (e) {
      toast({ title: "操作失败", description: asMessage(e), variant: "destructive" });
    }
  }

  async function rotate() {
    if (rotatingPending) return;
    setRotatingPending(true);
    try {
      const res = await apiPost<ApiClientRotatedResponse>(
        `/api/api-clients/${id}/rotate`,
      );
      setCredential({
        token: res.token,
        previousTokenExpiresAt: res.previousTokenExpiresAt,
      });
      await mutate();
    } catch (e) {
      toast({ title: "轮转失败", description: asMessage(e), variant: "destructive" });
    } finally {
      setRotatingPending(false);
      setRotating(false);
    }
  }

  async function revoke() {
    try {
      await apiDelete(`/api/api-clients/${id}`);
      toast({ title: "已吊销" });
      await mutate();
    } catch (e) {
      toast({ title: "操作失败", description: asMessage(e), variant: "destructive" });
    } finally {
      setRevoking(false);
    }
  }

  return (
    <section className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link
            href="/api-clients"
            className="text-xs text-muted-foreground hover:underline"
          >
            ← 返回列表
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">{data.name}</h1>
          {data.description ? (
            <p className="mt-1 text-sm text-muted-foreground">{data.description}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={revoked}
            onClick={() => setEditOpen(true)}
          >
            编辑
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={revoked}
            onClick={toggleStatus}
          >
            {data.status === "ACTIVE" ? "停用" : "启用"}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={revoked}
            onClick={() => setRotating(true)}
          >
            轮转 Token
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={revoked}
            onClick={() => setRevoking(true)}
          >
            吊销
          </Button>
        </div>
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="基本信息">
          <Field label="状态">
            <Badge
              variant={
                data.status === "ACTIVE"
                  ? "default"
                  : data.status === "DISABLED"
                    ? "secondary"
                    : "destructive"
              }
            >
              {STATUS_LABELS[data.status]}
            </Badge>
          </Field>
          <Field label="Token 前缀">
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
              {data.tokenPrefix}…
            </code>
          </Field>
          <Field label="HMAC 签名">
            {data.hmacEnabled ? (
              <Badge variant="outline">已启用</Badge>
            ) : (
              <span className="text-xs text-muted-foreground">未启用</span>
            )}
          </Field>
          <Field label="宽限期 Token">
            {data.hasGraceToken && data.previousTokenExpiresAt ? (
              <span className="text-xs">
                旧 Token 在 {new Date(data.previousTokenExpiresAt).toLocaleString()} 之前仍可用
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">无</span>
            )}
          </Field>
          <Field label="最近调用">
            <span className="text-xs">
              {data.lastUsedAt ? new Date(data.lastUsedAt).toLocaleString() : "—"}
            </span>
          </Field>
          <Field label="创建时间">
            <span className="text-xs">{new Date(data.createdAt).toLocaleString()}</span>
          </Field>
        </Card>

        <Card title="权限范围">
          <div className="flex flex-wrap gap-2">
            {data.scopes.map((s) => (
              <Badge key={s} variant="outline" className="font-mono text-[10px]">
                {SCOPE_LABELS[s]} <span className="ml-1 opacity-60">{s}</span>
              </Badge>
            ))}
          </div>
        </Card>

        <Card title="限流">
          <Field label="RPS">
            <span className="text-sm">{data.rpsLimit ?? "不限"}</span>
          </Field>
          <Field label="RPH">
            <span className="text-sm">{data.rphLimit ?? "不限"}</span>
          </Field>
        </Card>

        <Card title="IP 白名单">
          {data.ipWhitelist.length === 0 ? (
            <p className="text-xs text-muted-foreground">未限制（任意 IP 可访问）</p>
          ) : (
            <ul className="space-y-1 font-mono text-xs">
              {data.ipWhitelist.map((ip) => (
                <li key={ip}>{ip}</li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div>
        <Link
          href={`/audit-log?entityType=ApiClient&entityId=${id}`}
          className="text-sm text-primary hover:underline"
        >
          查看相关审计日志 →
        </Link>
      </div>

      <ApiClientFormDialog
        open={editOpen}
        mode="edit"
        defaults={data}
        onOpenChange={setEditOpen}
        onSubmit={async (payload) => {
          const patch = { ...payload };
          delete patch.enableHmac;
          await apiPatch(`/api/api-clients/${id}`, patch);
          toast({ title: "已保存" });
          await mutate();
        }}
      />

      <ConfirmDialog
        open={rotating}
        title="轮转 Token"
        description={`将为「${data.name}」生成新 Token，旧 Token 在宽限期内仍可使用。是否继续？`}
        confirmLabel="轮转"
        loading={rotatingPending}
        onOpenChange={(o) => {
          if (!o) setRotating(false);
        }}
        onConfirm={rotate}
      />

      <ConfirmDialog
        open={revoking}
        title="吊销 API Client"
        description={`「${data.name}」将立即失效，且无法恢复。是否继续？`}
        confirmLabel="吊销"
        destructive
        onOpenChange={(o) => {
          if (!o) setRevoking(false);
        }}
        onConfirm={revoke}
      />

      <CredentialRevealDialog
        open={credential !== null}
        title="Token 已轮转"
        description="请立刻把新 Token 同步给调用方；旧 Token 将在宽限期后失效。"
        token={credential?.token ?? ""}
        previousTokenExpiresAt={credential?.previousTokenExpiresAt ?? null}
        onOpenChange={(o) => {
          if (!o) setCredential(null);
        }}
      />
    </section>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3 rounded-md border bg-card p-4">
      <h2 className="text-sm font-semibold">{title}</h2>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="text-right">{children}</div>
    </div>
  );
}
