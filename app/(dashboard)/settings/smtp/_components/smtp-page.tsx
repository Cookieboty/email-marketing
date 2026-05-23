"use client";

import { useMemo, useState } from "react";
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
import { SmtpFormDialog } from "./smtp-form-dialog";
import { TestSendDialog } from "./test-send-dialog";
import {
  STATUS_LABELS,
  TEST_STATUS_LABELS,
  type MailProviderSettingResponse,
  type SmtpConfigListResponse,
  type SmtpConfigRow,
  type SmtpConfigStatus,
  type SmtpTestConnectionResponse,
  type SmtpTestSendResponse,
} from "./types";

function asMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return "操作失败";
}

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

export default function SmtpPage() {
  const { toast } = useToast();
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState<"" | SmtpConfigStatus>("");

  const params = useMemo(() => {
    const r: Record<string, string | number> = { page, pageSize };
    if (q.trim()) r.q = q.trim();
    if (statusFilter) r.status = statusFilter;
    return r;
  }, [page, pageSize, q, statusFilter]);

  const listKey = swrKeys.smtpConfigs(params);
  const settingKey = swrKeys.mailProviderSetting();

  const { data, isLoading, mutate: mutateList } = useSWR<SmtpConfigListResponse>(
    listKey,
    swrFetcher,
    { keepPreviousData: true },
  );
  const { data: setting, mutate: mutateSetting } =
    useSWR<MailProviderSettingResponse>(settingKey, swrFetcher);

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<SmtpConfigRow | null>(null);
  const [revoking, setRevoking] = useState<SmtpConfigRow | null>(null);
  const [revokingPending, setRevokingPending] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [activatingId, setActivatingId] = useState<string | null>(null);
  const [testSending, setTestSending] = useState<SmtpConfigRow | null>(null);
  const [resendActivating, setResendActivating] = useState(false);

  async function refreshAll() {
    await Promise.all([mutateList(), mutateSetting()]);
  }

  async function testConnection(row: SmtpConfigRow) {
    if (testingId) return;
    setTestingId(row.id);
    try {
      const res = await apiPost<SmtpTestConnectionResponse>(
        `/api/smtp-configs/${row.id}/test`,
      );
      if (res.ok) {
        toast({ title: "连接测试通过" });
      } else {
        toast({
          title: "连接测试失败",
          description: res.error ?? "未知错误",
          variant: "destructive",
        });
      }
      await mutateList();
    } catch (e) {
      toast({ title: "测试失败", description: asMessage(e), variant: "destructive" });
    } finally {
      setTestingId(null);
    }
  }

  async function activateSmtp(row: SmtpConfigRow) {
    if (activatingId) return;
    setActivatingId(row.id);
    try {
      await apiPost("/api/smtp-configs/activate", {
        provider: "SMTP",
        smtpId: row.id,
      });
      toast({ title: `已切换到 SMTP：${row.name}` });
      await refreshAll();
    } catch (e) {
      toast({ title: "激活失败", description: asMessage(e), variant: "destructive" });
    } finally {
      setActivatingId(null);
    }
  }

  async function activateResend() {
    if (resendActivating) return;
    setResendActivating(true);
    try {
      await apiPost("/api/smtp-configs/activate", { provider: "RESEND" });
      toast({ title: "已切换到 Resend 通道" });
      await refreshAll();
    } catch (e) {
      toast({ title: "切换失败", description: asMessage(e), variant: "destructive" });
    } finally {
      setResendActivating(false);
    }
  }

  async function submitTestSend(payload: { to: string; subject: string; html: string }) {
    if (!testSending) return;
    const res = await apiPost<SmtpTestSendResponse>(
      `/api/smtp-configs/${testSending.id}/test-send`,
      payload,
    );
    if (res.ok) {
      toast({
        title: "测试邮件已发送",
        description: res.messageId ? `messageId=${res.messageId}` : undefined,
      });
      await mutateList();
    } else {
      throw new Error(res.error ?? "发送失败");
    }
  }

  const columns: ColumnDef<SmtpConfigRow>[] = [
    {
      accessorKey: "name",
      header: "名称",
      cell: ({ row }) => (
        <div className="space-y-0.5">
          <div className="flex items-center gap-2 font-medium">
            <span>{row.original.name}</span>
            {row.original.isDefault ? (
              <Badge variant="default" className="text-[10px]">
                默认
              </Badge>
            ) : null}
          </div>
          {row.original.description ? (
            <div className="text-xs text-muted-foreground line-clamp-1">
              {row.original.description}
            </div>
          ) : null}
        </div>
      ),
    },
    {
      id: "endpoint",
      header: "服务端点",
      cell: ({ row }) => (
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
          {row.original.host}:{row.original.port} · {row.original.secure}
        </code>
      ),
    },
    {
      accessorKey: "fromEmail",
      header: "发件人",
      cell: ({ row }) => (
        <div className="text-xs">
          <div>{row.original.fromName ?? row.original.fromEmail}</div>
          {row.original.fromName ? (
            <div className="text-muted-foreground">{row.original.fromEmail}</div>
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
      id: "lastTest",
      header: "最近测试",
      cell: ({ row }) => {
        const s = row.original.lastTestStatus;
        if (!s) {
          return <span className="text-xs text-muted-foreground">未测试</span>;
        }
        return (
          <div className="space-y-0.5">
            <Badge
              variant={s === "OK" ? "default" : "destructive"}
              className="text-[10px]"
            >
              {TEST_STATUS_LABELS[s]}
            </Badge>
            <div className="text-[11px] text-muted-foreground">
              {formatDateTime(row.original.lastTestAt)}
            </div>
          </div>
        );
      },
    },
    {
      id: "actions",
      header: "操作",
      cell: ({ row }) => {
        const r = row.original;
        const isActive = setting?.activeProvider === "SMTP" && setting.activeSmtpId === r.id;
        return (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => testConnection(r)}
              disabled={r.status === "REVOKED" || testingId === r.id}
              data-testid="row-test"
            >
              {testingId === r.id ? "测试中..." : "测试连接"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setTestSending(r)}
              disabled={r.status !== "ACTIVE"}
            >
              测试发送
            </Button>
            <Button
              type="button"
              size="sm"
              variant={isActive ? "secondary" : "default"}
              onClick={() => activateSmtp(r)}
              disabled={
                isActive ||
                r.status !== "ACTIVE" ||
                r.lastTestStatus !== "OK" ||
                activatingId === r.id
              }
              data-testid="row-activate"
            >
              {isActive
                ? "当前激活"
                : activatingId === r.id
                  ? "激活中..."
                  : "激活"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setEditing(r)}
              disabled={r.status === "REVOKED"}
              data-testid="row-edit"
            >
              编辑
            </Button>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              onClick={() => setRevoking(r)}
              disabled={r.status === "REVOKED" || isActive}
              data-testid="row-revoke"
            >
              撤销
            </Button>
          </div>
        );
      },
    },
  ];

  const total = data?.total ?? 0;
  const rows = data?.data ?? [];

  return (
    <section className="space-y-4">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">SMTP 配置</h1>
          <p className="text-sm text-muted-foreground">
            管理自建 SMTP 服务器，支持连接测试与发送通道切换；密码使用 AES-256-GCM 加密存储。
          </p>
        </div>
        <Button type="button" onClick={() => setCreateOpen(true)}>
          新建 SMTP 配置
        </Button>
      </header>

      <div className="rounded-md border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-0.5">
            <div className="text-xs font-medium text-muted-foreground">当前发送通道</div>
            <div className="flex items-center gap-2">
              <Badge
                variant={setting?.activeProvider === "SMTP" ? "default" : "secondary"}
              >
                {setting?.activeProvider ?? "—"}
              </Badge>
              {setting?.activeProvider === "SMTP" && setting.activeSmtpId ? (
                <span className="text-sm text-muted-foreground">
                  smtpId: <code className="font-mono text-xs">{setting.activeSmtpId}</code>
                </span>
              ) : null}
              <span className="text-xs text-muted-foreground">
                · 兜底通道：{setting?.fallback ?? "—"}
              </span>
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={activateResend}
            disabled={
              resendActivating || setting?.activeProvider === "RESEND" || !setting
            }
            data-testid="activate-resend"
          >
            {resendActivating
              ? "切换中..."
              : setting?.activeProvider === "RESEND"
                ? "Resend 已激活"
                : "切回 Resend"}
          </Button>
        </div>
      </div>

      <div className="grid gap-3 rounded-md border bg-card p-4 sm:grid-cols-3">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">名称 / 主机搜索</label>
          <Input
            value={q}
            placeholder="按名称或主机模糊搜索"
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
              setStatusFilter(e.target.value as "" | SmtpConfigStatus);
              setPage(1);
            }}
            data-testid="filter-status"
          >
            <option value="">全部</option>
            <option value="ACTIVE">启用</option>
            <option value="DISABLED">停用</option>
            <option value="REVOKED">已撤销</option>
          </Select>
        </div>
      </div>

      <DataTable
        columns={columns}
        data={rows}
        loading={isLoading}
        emptyText="暂无 SMTP 配置"
      />
      <Pagination
        page={page}
        pageSize={pageSize}
        total={total}
        onPageChange={(p) => setPage(p)}
      />

      <SmtpFormDialog
        open={createOpen}
        mode="create"
        onOpenChange={setCreateOpen}
        onSubmit={async (payload) => {
          await apiPost("/api/smtp-configs", payload);
          toast({ title: "已创建" });
          await mutateList();
        }}
      />

      <SmtpFormDialog
        open={editing !== null}
        mode="edit"
        defaults={editing}
        onOpenChange={(o) => {
          if (!o) setEditing(null);
        }}
        onSubmit={async (payload) => {
          if (!editing) return;
          await apiPatch(`/api/smtp-configs/${editing.id}`, payload);
          toast({ title: "已保存" });
          await mutateList();
        }}
      />

      <ConfirmDialog
        open={revoking !== null}
        title="撤销 SMTP 配置"
        description={
          revoking
            ? `「${revoking.name}」将被撤销且不可恢复，且不能用于发送。是否继续？`
            : ""
        }
        confirmLabel="撤销"
        destructive
        loading={revokingPending}
        onOpenChange={(o) => {
          if (!o) setRevoking(null);
        }}
        onConfirm={async () => {
          if (!revoking) return;
          setRevokingPending(true);
          try {
            await apiDelete(`/api/smtp-configs/${revoking.id}`);
            toast({ title: "已撤销" });
            await refreshAll();
          } catch (e) {
            toast({
              title: "操作失败",
              description: asMessage(e),
              variant: "destructive",
            });
          } finally {
            setRevokingPending(false);
            setRevoking(null);
          }
        }}
      />

      <TestSendDialog
        open={testSending !== null}
        config={testSending}
        onOpenChange={(o) => {
          if (!o) setTestSending(null);
        }}
        onSubmit={submitTestSend}
      />
    </section>
  );
}
