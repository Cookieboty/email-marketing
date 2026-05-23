"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import useSWR, { mutate as globalMutate } from "swr";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { apiDelete, apiPatch, apiPost, swrFetcher } from "@/lib/api-client";
import { swrKeys } from "@/lib/swr-keys";
import { JobStatusCell } from "../_components/job-status-cell";
import { TestPreview } from "../_components/test-preview";
import {
  AUTH_TYPE_LABELS,
  PAGINATION_LABELS,
  type ImportJobListResp,
  type ImportJobRow,
  type ImportSourceRow,
  type ImportTestResp,
} from "../_components/types";

function asMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return "操作失败";
}

export default function ImportSourceDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const { toast } = useToast();
  const [testing, setTesting] = useState(false);
  const [triggering, setTriggering] = useState<"" | "DRY" | "RUN" | "RESUME">("");
  const [confirmRunOpen, setConfirmRunOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [testResult, setTestResult] = useState<ImportTestResp | null>(null);

  const { data: source, isLoading, mutate: mutateSource } = useSWR<ImportSourceRow>(
    id ? swrKeys.importSource(id) : null,
    swrFetcher,
  );

  const { data: jobsResp, mutate: mutateJobs } = useSWR<ImportJobListResp>(
    id ? swrKeys.importJobs(id, { pageSize: 20 }) : null,
    swrFetcher,
    {
      refreshInterval: (data) => {
        const rows = data?.data ?? [];
        const active = rows.some((j) => j.status === "PENDING" || j.status === "RUNNING");
        return active ? 3000 : 0;
      },
    },
  );
  const jobs: ImportJobRow[] = jobsResp?.data ?? [];
  const resumableJob = jobs.find((j) => j.status === "FAILED" && j.cursor != null);

  if (!id) return null;
  if (isLoading) return <p className="text-sm text-muted-foreground">加载中…</p>;
  if (!source) return <p className="text-sm text-destructive">数据源不存在。</p>;

  async function runTest() {
    setTesting(true);
    try {
      const res = await apiPost<ImportTestResp>(`/api/import-sources/${id}/test`);
      setTestResult(res);
      toast({ title: "测试完成", description: `共拉取 ${res.fetched} 行` });
    } catch (e) {
      toast({ title: "测试失败", description: asMessage(e), variant: "destructive" });
    } finally {
      setTesting(false);
    }
  }

  async function trigger(kind: "DRY" | "RUN" | "RESUME") {
    setTriggering(kind);
    try {
      await apiPost(`/api/import-sources/${id}/jobs`, {
        dryRun: kind === "DRY",
        resume: kind === "RESUME",
      });
      toast({
        title:
          kind === "DRY"
            ? "已发起 dry-run 任务"
            : kind === "RESUME"
              ? "已续跑任务"
              : "已发起正式同步",
      });
      await mutateJobs();
      await globalMutate(swrKeys.importSource(id));
    } catch (e) {
      toast({ title: "触发失败", description: asMessage(e), variant: "destructive" });
    } finally {
      setTriggering("");
    }
  }

  async function cancel(job: ImportJobRow) {
    try {
      await apiPost(`/api/import-sources/${id}/jobs/${job.id}/cancel`);
      toast({ title: "已请求取消" });
      await mutateJobs();
    } catch (e) {
      toast({ title: "取消失败", description: asMessage(e), variant: "destructive" });
    }
  }

  async function toggleEnabled() {
    if (!source) return;
    try {
      await apiPatch(`/api/import-sources/${id}`, { enabled: !source.enabled });
      toast({ title: source.enabled ? "已停用" : "已启用" });
      await mutateSource();
      await globalMutate(swrKeys.importSources());
    } catch (e) {
      toast({ title: "操作失败", description: asMessage(e), variant: "destructive" });
    }
  }

  async function removeSource() {
    try {
      await apiDelete(`/api/import-sources/${id}`);
      toast({ title: "已删除" });
      window.location.href = "/import-sources";
    } catch (e) {
      toast({ title: "删除失败", description: asMessage(e), variant: "destructive" });
    } finally {
      setDeleteOpen(false);
    }
  }

  return (
    <section className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{source.name}</h1>
          <p className="text-sm text-muted-foreground">
            <code className="font-mono">{source.baseUrl}</code>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href={`/import-sources/${source.id}/edit`}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            编辑
          </Link>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={toggleEnabled}
          >
            {source.enabled ? "停用" : "启用"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => trigger("DRY")}
            disabled={triggering !== ""}
          >
            {triggering === "DRY" ? "发起中…" : "Dry-run"}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => setConfirmRunOpen(true)}
            disabled={triggering !== ""}
          >
            {triggering === "RUN" ? "发起中…" : "正式同步"}
          </Button>
          {resumableJob ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => trigger("RESUME")}
              disabled={triggering !== ""}
            >
              {triggering === "RESUME" ? "发起中…" : "续跑"}
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="destructive"
            onClick={() => setDeleteOpen(true)}
          >
            删除
          </Button>
        </div>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>配置</CardTitle>
          <CardDescription>下列字段为只读。修改请前往「编辑」。</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm md:grid-cols-2">
          <Field label="状态">
            <Badge variant={source.enabled ? "default" : "secondary"}>
              {source.enabled ? "启用" : "停用"}
            </Badge>
          </Field>
          <Field label="认证">
            <Badge variant="outline">
              {AUTH_TYPE_LABELS[source.authType]}
              {source.authType !== "NONE" && source.hasAuth ? " ✓ 已配置" : ""}
            </Badge>
          </Field>
          <Field label="来源 sourceKey">
            {source.sourceKey ? (
              <code className="text-xs">{source.sourceKey}</code>
            ) : (
              <span className="text-xs text-muted-foreground">未设置</span>
            )}
          </Field>
          <Field label="分页">
            <span className="text-xs">{PAGINATION_LABELS[source.paginationType]}</span>
          </Field>
          <Field label="每页大小">
            <span className="text-xs">{source.pageSize}</span>
          </Field>
          <Field label="数据 JSONPath">
            <code className="text-xs">{source.dataJsonPath}</code>
          </Field>
          <Field label="cron">
            {source.schedule ? (
              <code className="text-xs">{source.schedule}</code>
            ) : (
              <span className="text-xs text-muted-foreground">手动</span>
            )}
          </Field>
          <Field label="字段映射" wide>
            <pre className="max-h-40 overflow-auto rounded bg-muted p-2 font-mono text-[11px]">
              {JSON.stringify(source.fieldMapping, null, 2)}
            </pre>
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>测试映射</CardTitle>
            <CardDescription>从远端拉取最多 5 行数据并按字段映射预览。不会写入用户表。</CardDescription>
          </div>
          <Button type="button" size="sm" onClick={runTest} disabled={testing}>
            {testing ? "测试中…" : "运行测试"}
          </Button>
        </CardHeader>
        <CardContent>
          <TestPreview result={testResult} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>任务</CardTitle>
          <CardDescription>
            进行中任务每 3 秒自动刷新；已结束任务保持静态。
          </CardDescription>
        </CardHeader>
        <CardContent>
          {jobs.length === 0 ? (
            <p className="text-sm text-muted-foreground">尚无任务记录。</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-3">状态</th>
                    <th className="py-2 pr-3">已抓 / 创建 / 更新 / 跳过 / 失败</th>
                    <th className="py-2 pr-3">游标 / 页码</th>
                    <th className="py-2 pr-3">起止时间</th>
                    <th className="py-2 pr-3">失败原因</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {jobs.map((j) => (
                    <tr key={j.id}>
                      <td className="py-2 pr-3 align-top">
                        <JobStatusCell job={j} onCancel={cancel} />
                      </td>
                      <td className="py-2 pr-3 align-top font-mono text-xs">
                        {j.totalFetched} / {j.totalCreated} / {j.totalUpdated} /{" "}
                        {j.totalSkipped} / {j.totalErrored}
                      </td>
                      <td className="py-2 pr-3 align-top font-mono text-xs">
                        {j.cursor ?? "-"} / {j.currentPage}
                      </td>
                      <td className="py-2 pr-3 align-top text-xs">
                        {j.startedAt ? new Date(j.startedAt).toLocaleString() : "-"}
                        <br />
                        {j.completedAt
                          ? new Date(j.completedAt).toLocaleString()
                          : "-"}
                      </td>
                      <td className="py-2 pr-3 align-top text-xs text-destructive">
                        {j.failureReason ?? ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmRunOpen}
        title="正式同步"
        description="正式同步会写入本地用户表。确认现在触发？"
        confirmLabel="正式同步"
        loading={triggering === "RUN"}
        onOpenChange={setConfirmRunOpen}
        onConfirm={async () => {
          await trigger("RUN");
          setConfirmRunOpen(false);
        }}
      />
      <ConfirmDialog
        open={deleteOpen}
        title="删除数据源"
        description={`确认删除「${source.name}」？关联任务与错误记录会被级联删除。`}
        confirmLabel="删除"
        destructive
        onOpenChange={setDeleteOpen}
        onConfirm={removeSource}
      />
    </section>
  );
}

function Field({
  label,
  children,
  wide,
}: {
  label: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={wide ? "md:col-span-2 space-y-1" : "space-y-1"}>
      <p className="text-xs uppercase tracking-wider text-muted-foreground">{label}</p>
      <div>{children}</div>
    </div>
  );
}
