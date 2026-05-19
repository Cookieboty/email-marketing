"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { apiPatch, swrFetcher } from "@/lib/api-client";
import { swrKeys } from "@/lib/swr-keys";

interface UserSubscriptionView {
  category: {
    id: string;
    name: string;
    slug: string;
    description: string | null;
    isDefault: boolean;
    isTransactional: boolean;
  };
  subscribed: boolean;
  persisted: boolean;
}

function asMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return "操作失败";
}

/**
 * 用户订阅分类编辑卡片。
 *
 * - 数据源 GET /api/users/:id/subscriptions（含未落库分类按 isDefault 推导值）
 * - 提交走 PATCH，传入差异条目；交易类不可退订（前端 disable + 后端再次拒绝双保险）
 * - 仅展示 changed 数量，避免误触整体保存
 */
export default function UserSubscriptionsCard({ userId }: { userId: string }) {
  const { toast } = useToast();
  const key = swrKeys.userSubscriptions(userId);
  const { data, isLoading, mutate } = useSWR<UserSubscriptionView[]>(key, swrFetcher);

  const [draft, setDraft] = useState<Map<string, boolean>>(new Map());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!data) return;
    const next = new Map<string, boolean>();
    for (const row of data) next.set(row.category.id, row.subscribed);
    setDraft(next);
  }, [data]);

  if (isLoading || !data) {
    return (
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>订阅分类</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-24 w-full" />
        </CardContent>
      </Card>
    );
  }

  const changes = data.filter((row) => draft.get(row.category.id) !== row.subscribed);
  const dirty = changes.length > 0;

  async function save() {
    if (!dirty) return;
    setSaving(true);
    try {
      await apiPatch(`/api/users/${userId}/subscriptions`, {
        subscriptions: changes.map((c) => ({
          categoryId: c.category.id,
          subscribed: draft.get(c.category.id) ?? c.subscribed,
        })),
      });
      toast({ title: "订阅状态已更新" });
      await mutate();
    } catch (e) {
      toast({
        title: "保存失败",
        description: asMessage(e),
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }

  function reset() {
    if (!data) return;
    const next = new Map<string, boolean>();
    for (const row of data) next.set(row.category.id, row.subscribed);
    setDraft(next);
  }

  return (
    <Card className="lg:col-span-2" data-testid="user-subscriptions-card">
      <CardHeader>
        <CardTitle>订阅分类</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {data.length === 0 ? (
          <p className="text-sm text-muted-foreground">尚未配置订阅分类。</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {data.map((row) => {
              const checked = draft.get(row.category.id) ?? row.subscribed;
              const locked = row.category.isTransactional;
              return (
                <li
                  key={row.category.id}
                  className="flex items-start justify-between gap-4 p-3"
                  data-testid={`user-sub-row-${row.category.slug}`}
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{row.category.name}</span>
                      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                        {row.category.slug}
                      </code>
                      {locked ? (
                        <Badge variant="destructive">交易类（不可退订）</Badge>
                      ) : null}
                      {row.category.isDefault ? <Badge variant="outline">默认订阅</Badge> : null}
                      {!row.persisted ? (
                        <Badge variant="outline" title="未显式记录，按默认值推导">
                          推导
                        </Badge>
                      ) : null}
                    </div>
                    {row.category.description ? (
                      <p className="text-xs text-muted-foreground">{row.category.description}</p>
                    ) : null}
                  </div>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={locked}
                      onChange={(e) => {
                        const next = new Map(draft);
                        next.set(row.category.id, e.target.checked);
                        setDraft(next);
                      }}
                      data-testid={`user-sub-toggle-${row.category.slug}`}
                    />
                    <span className={locked ? "text-muted-foreground" : ""}>订阅</span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            {dirty ? `有 ${changes.length} 项变更未保存` : "无变更"}
          </span>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={reset}
              disabled={!dirty || saving}
              data-testid="user-sub-reset"
            >
              重置
            </Button>
            <Button
              type="button"
              onClick={save}
              disabled={!dirty || saving}
              data-testid="user-sub-save"
            >
              {saving ? "保存中..." : "保存订阅"}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
