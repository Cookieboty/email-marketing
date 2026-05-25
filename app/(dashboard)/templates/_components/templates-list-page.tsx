"use client";

import Link from "next/link";
import { useState } from "react";
import useSWR from "swr";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
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
import { Pagination } from "@/components/pagination";
import {
  apiDelete,
  apiGet,
  apiPost,
  swrFetcher,
} from "@/lib/api-client";
import { swrKeys } from "@/lib/swr-keys";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import {
  LOCALE_LABELS,
  TEMPLATE_LOCALES,
  type Locale,
  type TemplateListItem,
  type TemplateRecord,
} from "./types";

interface SendingChannelOption {
  id: string;
  name: string;
  providerType: "RESEND" | "SMTP";
  status: string;
}

interface UserOption {
  id: string;
  email: string;
  name: string | null;
}

interface ListResp {
  data: TemplateListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export type LocaleFilter = "all" | "zh" | "en" | "bilingual" | "single";

const LOCALE_FILTER_OPTIONS: ReadonlyArray<{
  value: LocaleFilter;
  label: string;
}> = [
    { value: "all", label: "全部" },
    { value: "zh", label: "包含中文" },
    { value: "en", label: "包含英文" },
    { value: "bilingual", label: "中英双语" },
    { value: "single", label: "仅单语言" },
  ];

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
  const [localeFilter, setLocaleFilter] = useState<LocaleFilter>("all");
  const debouncedQ = useDebouncedValue(q, 300);

  const key = swrKeys.templates({
    q: debouncedQ || undefined,
    includeArchived: includeArchived ? "true" : undefined,
    localeFilter: localeFilter === "all" ? undefined : localeFilter,
    page,
    pageSize,
  });

  const { data, isLoading, mutate } = useSWR<ListResp>(key, swrFetcher, {
    keepPreviousData: true,
  });

  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<TemplateListItem | null>(null);

  const [testTarget, setTestTarget] = useState<TemplateListItem | null>(null);
  const [testTo, setTestTo] = useState("");
  const [testLocale, setTestLocale] = useState<Locale>("zh");
  const [testChannelId, setTestChannelId] = useState("");
  const [testSending, setTestSending] = useState(false);
  const [testUserSearch, setTestUserSearch] = useState("");
  const debouncedTestUserSearch = useDebouncedValue(testUserSearch, 300);

  const { data: channelsData } = useSWR<{ data: SendingChannelOption[] }>(
    testTarget ? "/api/sending-channels" : null,
    swrFetcher,
  );
  const channels = (channelsData?.data ?? []).filter((c) => c.status === "ACTIVE");

  const { data: testUsersData } = useSWR<{ data: UserOption[] }>(
    testTarget && debouncedTestUserSearch.length >= 1
      ? `/api/users?q=${encodeURIComponent(debouncedTestUserSearch)}&pageSize=10`
      : null,
    swrFetcher,
  );
  const testUserOptions = testUsersData?.data ?? [];

  async function onTestSend() {
    if (!testTarget || !testTo.trim()) return;
    setTestSending(true);
    try {
      await apiPost(`/api/templates/${testTarget.id}/test-send`, {
        to: testTo.trim(),
        locale: testLocale,
        ...(testChannelId ? { channelId: testChannelId } : {}),
      });
      toast({ title: "测试邮件已发送" });
      setTestTarget(null);
    } catch (e) {
      toast({
        title: "发送失败",
        description: asMessage(e),
        variant: "destructive",
      });
    } finally {
      setTestSending(false);
    }
  }

  const total = data?.total ?? 0;
  const items = data?.data ?? [];

  async function onArchive(t: TemplateListItem) {
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

  async function onDuplicate(t: TemplateListItem) {
    setBusyId(t.id);
    try {
      const full = await apiGet<TemplateRecord>(`/api/templates/${t.id}`);
      const { defaultLocale, locales } = buildDuplicatePayload(full);
      for (let attempt = 1; attempt < 50; attempt += 1) {
        const candidate = nextDuplicateName(t.name, attempt);
        try {
          await apiPost("/api/templates", {
            name: candidate,
            defaultLocale,
            locales,
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

      <div className="grid gap-3 rounded-md border bg-card p-4 sm:grid-cols-4">
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
          <label className="text-xs font-medium text-muted-foreground">语言</label>
          <Select
            value={localeFilter}
            onChange={(e) => {
              setLocaleFilter(e.target.value as LocaleFilter);
              setPage(1);
            }}
            data-testid="templates-filter-locale"
          >
            {LOCALE_FILTER_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </Select>
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
                <div className="flex flex-wrap items-center gap-2">
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
                  <LocaleBadges
                    templateId={t.id}
                    defaultLocale={t.defaultLocale}
                    availableLocales={t.availableLocales}
                  />
                  {t.isArchived ? (
                    <Badge variant="secondary" className="shrink-0 text-[10px]">
                      已归档
                    </Badge>
                  ) : null}
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
                  onClick={() => {
                    setTestTarget(t);
                    setTestTo("");
                    setTestLocale(t.defaultLocale);
                    setTestChannelId("");
                    setTestUserSearch("");
                  }}
                  data-testid={`template-test-send-${t.id}`}
                >
                  测试发送
                </Button>
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

      <Dialog
        open={testTarget !== null}
        onOpenChange={(o) => { if (!o) setTestTarget(null); }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>测试发送</DialogTitle>
            <DialogDescription>
              向白名单收件人发送「{testTarget?.name}」的测试邮件。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="tpl-test-to">收件人</Label>
              <Input
                id="tpl-test-to"
                type="email"
                value={testTo}
                onChange={(e) => { setTestTo(e.target.value); setTestUserSearch(e.target.value); }}
                placeholder="搜索用户或输入邮箱"
              />
              {testUserOptions.length > 0 && testUserSearch.length >= 1 && testTo === testUserSearch && (
                <ul className="max-h-40 overflow-y-auto rounded-md border bg-popover text-sm shadow-md">
                  {testUserOptions.map((u) => (
                    <li key={u.id}>
                      <button
                        type="button"
                        className="w-full px-3 py-1.5 text-left hover:bg-accent"
                        onClick={() => { setTestTo(u.email); setTestUserSearch(""); }}
                      >
                        <span className="font-medium">{u.email}</span>
                        {u.name ? <span className="ml-2 text-muted-foreground">{u.name}</span> : null}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tpl-test-locale">语言版本</Label>
              <Select
                id="tpl-test-locale"
                value={testLocale}
                onChange={(e) => setTestLocale(e.target.value as Locale)}
              >
                {(testTarget?.availableLocales ?? TEMPLATE_LOCALES).map((l) => (
                  <option key={l} value={l}>{LOCALE_LABELS[l]}</option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tpl-test-channel">发信渠道</Label>
              <Select
                id="tpl-test-channel"
                value={testChannelId}
                onChange={(e) => setTestChannelId(e.target.value)}
              >
                <option value="">系统默认</option>
                {channels.map((ch) => (
                  <option key={ch.id} value={ch.id}>
                    {ch.name} ({ch.providerType})
                  </option>
                ))}
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setTestTarget(null)}
              disabled={testSending}
            >
              取消
            </Button>
            <Button
              onClick={onTestSend}
              disabled={testSending || !testTo.trim()}
            >
              {testSending ? "发送中..." : "发送"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function LocaleBadges({
  templateId,
  defaultLocale,
  availableLocales,
}: {
  templateId: string;
  defaultLocale: Locale;
  availableLocales: Locale[];
}) {
  const ordered = TEMPLATE_LOCALES.filter((locale) =>
    availableLocales.includes(locale),
  );
  if (ordered.length === 0) return null;
  return (
    <span
      className="flex flex-wrap gap-1"
      data-testid={`template-locales-${templateId}`}
    >
      {ordered.map((locale) => {
        const isDefault = locale === defaultLocale;
        return (
          <Badge
            key={locale}
            variant={isDefault ? "default" : "outline"}
            className="shrink-0 text-[10px]"
            data-testid={`template-locale-badge-${templateId}-${locale}`}
            data-default={isDefault ? "true" : "false"}
            title={isDefault ? `${LOCALE_LABELS[locale]}（默认）` : LOCALE_LABELS[locale]}
          >
            {locale}
            {isDefault ? " ★" : ""}
          </Badge>
        );
      })}
    </span>
  );
}

export { LocaleBadges, LOCALE_FILTER_OPTIONS };

export function buildDuplicatePayload(full: TemplateRecord): {
  defaultLocale: Locale;
  locales: Record<Locale, { subject: string; htmlContent: string; textContent?: string }>;
} {
  const locales: Record<
    Locale,
    { subject: string; htmlContent: string; textContent?: string }
  > = {} as never;
  for (const row of full.locales) {
    locales[row.locale] = {
      subject: row.subject,
      htmlContent: row.htmlContent,
      ...(row.textContent ? { textContent: row.textContent } : {}),
    };
  }
  return { defaultLocale: full.defaultLocale, locales };
}

export function nextDuplicateName(originalName: string, attempt: number): string {
  const base = originalName.replace(/\s*\(副本(?: \d+)?\)$/u, "");
  if (attempt <= 1) return `${base} (副本)`;
  return `${base} (副本 ${attempt})`;
}
