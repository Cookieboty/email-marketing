"use client";

import Link from "next/link";
import { useState } from "react";
import useSWR from "swr";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Pagination } from "@/components/pagination";
import {
  apiDelete,
  apiPost,
  swrFetcher,
} from "@/lib/api-client";
import { swrKeys } from "@/lib/swr-keys";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";

interface TemplateItem {
  id: string;
  name: string;
  subject: string;
  htmlContent: string;
  textContent: string | null;
  variables: string[];
  version: number;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ListResp {
  data: TemplateItem[];
  total: number;
  page: number;
  pageSize: number;
}

function asMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return "操作失败";
}

export default function TemplatesListPage() {
  const { toast } = useToast();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [q, setQ] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const debouncedQ = useDebouncedValue(q, 300);

  const key = swrKeys.templates({
    q: debouncedQ || undefined,
    includeArchived: includeArchived ? "true" : undefined,
    page,
    pageSize,
  });

  const { data, isLoading, mutate } = useSWR<ListResp>(key, swrFetcher, {
    keepPreviousData: true,
  });

  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<TemplateItem | null>(null);

  const total = data?.total ?? 0;
  const items = data?.data ?? [];

  async function onArchive(t: TemplateItem) {
    setBusyId(t.id);
    try {
      const url = t.isArchived
        ? `/api/templates/${t.id}/unarchive`
        : `/api/templates/${t.id}/archive`;
      await apiPost(url);
      toast({ title: t.isArchived ? "已取消归档" : "已归档" });
      await mutate();
    } catch (e) {
      toast({
        title: "操作失败",
        description: asMessage(e),
        variant: "destructive",
      });
    } finally {
      setBusyId(null);
    }
  }

  async function onDuplicate(t: TemplateItem) {
    setBusyId(t.id);
    try {
      const baseName = t.name.replace(/\s*\(副本(?: \d+)?\)$/u, "");
      let candidate = `${baseName} (副本)`;
      for (let i = 2; i < 50; i += 1) {
        try {
          await apiPost("/api/templates", {
            name: candidate,
            subject: t.subject,
            htmlContent: t.htmlContent,
            textContent: t.textContent ?? undefined,
          });
          toast({ title: "已复制", description: candidate });
          await mutate();
          return;
        } catch (e) {
          const status =
            e && typeof e === "object" && "status" in e
              ? (e as { status?: number }).status
              : undefined;
          if (status !== 409) throw e;
          candidate = `${baseName} (副本 ${i})`;
        }
      }
      toast({
        title: "复制失败",
        description: "已存在过多同名副本，请手动重命名后再试",
        variant: "destructive",
      });
    } catch (e) {
      toast({
        title: "复制失败",
        description: asMessage(e),
        variant: "destructive",
      });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="space-y-4">
      <header className="flex items-center justify-between">
        <h1
          className="text-2xl font-semibold tracking-tight"
          data-testid="templates-page-heading"
        >
          邮件模板
        </h1>
        <Link
          href="/templates/new"
          className={buttonVariants({ variant: "default" })}
          data-testid="templates-new-button"
        >
          新建模板
        </Link>
      </header>

      <div className="grid gap-3 rounded-md border bg-card p-4 sm:grid-cols-3">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">搜索</label>
          <Input
            placeholder="按名称搜索"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
            data-testid="templates-search"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">归档</label>
          <Select
            value={includeArchived ? "1" : "0"}
            onChange={(e) => {
              setIncludeArchived(e.target.value === "1");
              setPage(1);
            }}
            data-testid="templates-filter-archived"
          >
            <option value="0">仅显示有效</option>
            <option value="1">包含归档</option>
          </Select>
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">每页</label>
          <Select
            value={String(pageSize)}
            onChange={(e) => {
              setPageSize(Number(e.target.value));
              setPage(1);
            }}
            data-testid="templates-page-size"
          >
            <option value="10">10</option>
            <option value="20">20</option>
            <option value="50">50</option>
          </Select>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-2" data-testid="templates-loading">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div
          className="flex h-40 items-center justify-center rounded-md border bg-muted/20 text-sm text-muted-foreground"
          data-testid="templates-empty"
        >
          暂无模板
        </div>
      ) : (
        <ul className="space-y-2" data-testid="templates-list">
          {items.map((t) => (
            <li
              key={t.id}
              className="flex flex-wrap items-center gap-3 rounded-md border bg-card px-4 py-3 text-sm shadow-sm"
              data-testid={`template-item-${t.id}`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Link
                    href={`/templates/${t.id}/edit`}
                    className="truncate font-medium hover:underline"
                    data-testid={`template-name-${t.id}`}
                    title={t.name}
                  >
                    {t.name}
                  </Link>
                  <Badge variant="outline" className="shrink-0 text-[10px]">
                    v{t.version}
                  </Badge>
                  {t.isArchived ? (
                    <Badge variant="secondary" className="shrink-0 text-[10px]">
                      已归档
                    </Badge>
                  ) : null}
                </div>
                <div
                  className="mt-1 truncate text-xs text-muted-foreground"
                  title={t.subject}
                >
                  {t.subject}
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {t.variables.length === 0 ? (
                    <span className="text-[11px] text-muted-foreground">无变量</span>
                  ) : (
                    <>
                      {t.variables.slice(0, 6).map((v) => (
                        <Badge key={v} variant="outline" className="text-[10px]">
                          {`{{${v}}}`}
                        </Badge>
                      ))}
                      {t.variables.length > 6 ? (
                        <Badge variant="outline" className="text-[10px]">
                          +{t.variables.length - 6}
                        </Badge>
                      ) : null}
                    </>
                  )}
                </div>
              </div>
              <div className="hidden text-right text-[11px] text-muted-foreground sm:block">
                <div>更新于</div>
                <div>{new Date(t.updatedAt).toLocaleString()}</div>
              </div>
              <div className="flex items-center gap-2">
                <Link
                  href={`/templates/${t.id}/edit`}
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                  data-testid={`template-edit-${t.id}`}
                >
                  编辑
                </Link>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busyId === t.id}
                  onClick={() => onDuplicate(t)}
                  data-testid={`template-duplicate-${t.id}`}
                >
                  复制
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busyId === t.id}
                  onClick={() => onArchive(t)}
                  data-testid={`template-archive-${t.id}`}
                >
                  {t.isArchived ? "取消归档" : "归档"}
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  disabled={busyId === t.id}
                  onClick={() => setDeleting(t)}
                  data-testid={`template-delete-${t.id}`}
                >
                  删除
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Pagination
        page={page}
        pageSize={pageSize}
        total={total}
        onPageChange={(p) => {
          setPage(p);
          mutate();
        }}
      />

      <ConfirmDialog
        open={deleting !== null}
        title="删除模板"
        description={
          deleting
            ? `确认删除「${deleting.name}」？被活动引用的模板无法删除。`
            : ""
        }
        confirmLabel="删除"
        destructive
        onOpenChange={(o) => {
          if (!o) setDeleting(null);
        }}
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await apiDelete(`/api/templates/${deleting.id}`);
            toast({ title: "已删除" });
            await mutate();
          } catch (e) {
            toast({
              title: "删除失败",
              description: asMessage(e),
              variant: "destructive",
            });
          } finally {
            setDeleting(null);
          }
        }}
      />
    </section>
  );
}
