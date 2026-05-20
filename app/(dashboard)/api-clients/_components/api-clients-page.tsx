"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import type { ColumnDef } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DataTable } from "@/components/data-table";
import { Pagination } from "@/components/pagination";
import {
  apiDelete,
  apiPatch,
  apiPost,
  swrFetcher,
} from "@/lib/api-client";
import { swrKeys } from "@/lib/swr-keys";
import { ApiClientFormDialog } from "./api-client-form-dialog";
import { ApiClientRowActions } from "./list-row-actions";
import { CredentialRevealDialog } from "./credential-reveal-dialog";
import {
  STATUS_LABELS,
  type ApiClientCreatedResponse,
  type ApiClientListResponse,
  type ApiClientRotatedResponse,
  type ApiClientRow,
  type ApiClientStatus,
} from "./types";

function asMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return "操作失败";
}

export default function ApiClientsPage() {
  const { toast } = useToast();
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState<"" | ApiClientStatus>("");

  const params = useMemo(() => {
    const r: Record<string, string | number> = { page, pageSize };
    if (q.trim()) r.q = q.trim();
    if (statusFilter) r.status = statusFilter;
    return r;
  }, [page, pageSize, q, statusFilter]);

  const key = swrKeys.apiClients(params);
  const { data, isLoading, mutate } = useSWR<ApiClientListResponse>(
    key,
    swrFetcher,
    { keepPreviousData: true },
  );

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<ApiClientRow | null>(null);
  const [revoking, setRevoking] = useState<ApiClientRow | null>(null);
  const [rotating, setRotating] = useState<ApiClientRow | null>(null);
  const [rotatingPending, setRotatingPending] = useState(false);
  const [credential, setCredential] = useState<{
    title: string;
    description?: string;
    token: string;
    hmacSecret?: string;
    previousTokenExpiresAt?: string | null;
  } | null>(null);

  async function toggleStatus(row: ApiClientRow) {
    const next = row.status === "ACTIVE" ? "DISABLED" : "ACTIVE";
    try {
      await apiPatch(`/api/api-clients/${row.id}`, { status: next });
      toast({ title: next === "ACTIVE" ? "已启用" : "已停用" });
      await mutate();
    } catch (e) {
      toast({ title: "操作失败", description: asMessage(e), variant: "destructive" });
    }
  }

  async function rotate(row: ApiClientRow) {
    if (rotatingPending) return;
    setRotatingPending(true);
    try {
      const res = await apiPost<ApiClientRotatedResponse>(
        `/api/api-clients/${row.id}/rotate`,
      );
      setCredential({
        title: "Token 已轮转",
        description: "请使用新的 Token 替换调用方配置；旧 Token 将在宽限期后失效。",
        token: res.token,
        previousTokenExpiresAt: res.previousTokenExpiresAt,
      });
      await mutate();
    } catch (e) {
      toast({ title: "轮转失败", description: asMessage(e), variant: "destructive" });
    } finally {
      setRotatingPending(false);
      setRotating(null);
    }
  }

  const columns: ColumnDef<ApiClientRow>[] = [
    {
      accessorKey: "name",
      header: "名称",
      cell: ({ row }) => (
        <div className="space-y-0.5">
          <Link
            href={`/api-clients/${row.original.id}`}
            className="font-medium hover:underline"
          >
            {row.original.name}
          </Link>
          {row.original.description ? (
            <div className="text-xs text-muted-foreground line-clamp-1">
              {row.original.description}
            </div>
          ) : null}
        </div>
      ),
    },
    {
      accessorKey: "tokenPrefix",
      header: "Token 前缀",
      cell: ({ row }) => (
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
          {row.original.tokenPrefix}…
        </code>
      ),
    },
    {
      accessorKey: "scopes",
      header: "权限",
      cell: ({ row }) => (
        <div className="flex flex-wrap gap-1">
          {row.original.scopes.slice(0, 3).map((s) => (
            <Badge key={s} variant="outline" className="text-[10px]">
              {s}
            </Badge>
          ))}
          {row.original.scopes.length > 3 ? (
            <Badge variant="secondary" className="text-[10px]">
              +{row.original.scopes.length - 3}
            </Badge>
          ) : null}
        </div>
      ),
    },
    {
      accessorKey: "status",
      header: "状态",
      cell: ({ row }) => (
        <Badge
          variant={
            row.original.status === "ACTIVE"
              ? "default"
              : row.original.status === "DISABLED"
                ? "secondary"
                : "destructive"
          }
        >
          {STATUS_LABELS[row.original.status]}
        </Badge>
      ),
    },
    {
      accessorKey: "lastUsedAt",
      header: "最近调用",
      cell: ({ row }) =>
        row.original.lastUsedAt ? (
          <span className="text-xs text-muted-foreground">
            {new Date(row.original.lastUsedAt).toLocaleString()}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
    {
      id: "actions",
      header: "操作",
      cell: ({ row }) => (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setEditing(row.original)}
            disabled={row.original.status === "REVOKED"}
            data-testid="row-edit"
          >
            编辑
          </Button>
          <ApiClientRowActions
            row={row.original}
            onToggleStatus={toggleStatus}
            onRotate={(r) => setRotating(r)}
            onRevoke={(r) => setRevoking(r)}
          />
        </div>
      ),
    },
  ];

  const total = data?.total ?? 0;
  const rows = data?.data ?? [];

  return (
    <section className="space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">API Clients</h1>
          <p className="text-sm text-muted-foreground">
            为外部系统签发 Bearer Token，控制权限范围、限流与 IP 白名单。
          </p>
        </div>
        <Button type="button" onClick={() => setCreateOpen(true)}>
          新建 API Client
        </Button>
      </header>

      <div className="grid gap-3 rounded-md border bg-card p-4 sm:grid-cols-3">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">名称搜索</label>
          <Input
            value={q}
            placeholder="按名称模糊搜索"
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
            data-testid="filter-q"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">状态</label>
          <Select
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value as "" | ApiClientStatus);
              setPage(1);
            }}
            data-testid="filter-status"
          >
            <option value="">全部</option>
            <option value="ACTIVE">启用</option>
            <option value="DISABLED">停用</option>
            <option value="REVOKED">已吊销</option>
          </Select>
        </div>
      </div>

      <DataTable
        columns={columns}
        data={rows}
        loading={isLoading}
        emptyText="暂无 API Client"
      />
      <Pagination
        page={page}
        pageSize={pageSize}
        total={total}
        onPageChange={(p) => setPage(p)}
      />

      <ApiClientFormDialog
        open={createOpen}
        mode="create"
        onOpenChange={setCreateOpen}
        onSubmit={async (payload) => {
          const res = await apiPost<ApiClientCreatedResponse>(
            "/api/api-clients",
            payload,
          );
          toast({ title: "已创建" });
          setCredential({
            title: "API Client 创建成功",
            description: "请立即保存以下凭据；关闭后无法再次查看。",
            token: res.token,
            hmacSecret: res.hmacSecret,
          });
          await mutate();
        }}
      />

      <ApiClientFormDialog
        open={editing !== null}
        mode="edit"
        defaults={editing}
        onOpenChange={(o) => {
          if (!o) setEditing(null);
        }}
        onSubmit={async (payload) => {
          if (!editing) return;
          const patch = { ...payload };
          delete patch.enableHmac;
          await apiPatch(`/api/api-clients/${editing.id}`, patch);
          toast({ title: "已保存" });
          await mutate();
        }}
      />

      <ConfirmDialog
        open={rotating !== null}
        title="轮转 Token"
        description={
          rotating
            ? `将为「${rotating.name}」生成新 Token，旧 Token 在宽限期内仍可使用。是否继续？`
            : ""
        }
        confirmLabel="轮转"
        loading={rotatingPending}
        onOpenChange={(o) => {
          if (!o) setRotating(null);
        }}
        onConfirm={async () => {
          if (rotating) await rotate(rotating);
        }}
      />

      <ConfirmDialog
        open={revoking !== null}
        title="吊销 API Client"
        description={
          revoking
            ? `「${revoking.name}」将立即失效，且无法恢复。是否继续？`
            : ""
        }
        confirmLabel="吊销"
        destructive
        onOpenChange={(o) => {
          if (!o) setRevoking(null);
        }}
        onConfirm={async () => {
          if (!revoking) return;
          try {
            await apiDelete(`/api/api-clients/${revoking.id}`);
            toast({ title: "已吊销" });
            await mutate();
          } catch (e) {
            toast({
              title: "操作失败",
              description: asMessage(e),
              variant: "destructive",
            });
          } finally {
            setRevoking(null);
          }
        }}
      />

      <CredentialRevealDialog
        open={credential !== null}
        title={credential?.title ?? ""}
        description={credential?.description}
        token={credential?.token ?? ""}
        hmacSecret={credential?.hmacSecret}
        previousTokenExpiresAt={credential?.previousTokenExpiresAt ?? null}
        onOpenChange={(o) => {
          if (!o) setCredential(null);
        }}
      />
    </section>
  );
}
