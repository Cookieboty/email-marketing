"use client";

/**
 * 偏好中心客户端组件。
 *
 * 数据流：
 *  1. GET /api/preferences/[token] → 用户屏蔽信息 + 全部分类视图 + 全部主题视图
 *  2. 本地 draft Map 反映用户勾选意图；提交差异到 PATCH
 *  3. PATCH 同时支持 resubscribeAll 一键重新订阅（仅在用户曾全局退订时显示按钮）
 *
 * 安全性提醒：
 *  - 任何错误（404/429/5xx）只显示通用文案，不向公开页面泄露内部错误
 *  - 不显示 token 本身；URL 即凭证，由用户保管
 */

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";

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

interface UserTopicView {
  topic: {
    id: string;
    slug: string;
    name: string;
    description: string | null;
  };
  subscribed: boolean;
}

interface PreferencesResponse {
  ok: boolean;
  user: {
    id: string;
    emailMasked: string;
    unsubscribed: boolean;
    unsubscribedAt: string | null;
  };
  subscriptions: UserSubscriptionView[];
  topics: UserTopicView[];
}

async function fetchJson(url: string): Promise<PreferencesResponse> {
  const res = await fetch(url, { credentials: "omit", cache: "no-store" });
  if (!res.ok) {
    if (res.status === 404) throw new Error("链接已失效或不存在");
    if (res.status === 429) throw new Error("操作过于频繁，请稍后再试");
    throw new Error("加载失败，请稍后再试");
  }
  return (await res.json()) as PreferencesResponse;
}

export default function PreferencesClient({ token }: { token: string }) {
  const url = `/api/preferences/${encodeURIComponent(token)}`;
  const { data, error, isLoading, mutate } = useSWR<PreferencesResponse>(url, fetchJson);

  const [draft, setDraft] = useState<Map<string, boolean>>(new Map());
  const [topicDraft, setTopicDraft] = useState<Map<string, boolean>>(new Map());
  const [saving, setSaving] = useState(false);
  const [tip, setTip] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    if (!data) return;
    const next = new Map<string, boolean>();
    for (const row of data.subscriptions) next.set(row.category.id, row.subscribed);
    setDraft(next);
    const tnext = new Map<string, boolean>();
    for (const row of data.topics) tnext.set(row.topic.id, row.subscribed);
    setTopicDraft(tnext);
  }, [data]);

  const changes = useMemo(
    () =>
      data
        ? data.subscriptions.filter((r) => draft.get(r.category.id) !== r.subscribed)
        : [],
    [data, draft],
  );

  const topicChanges = useMemo(
    () =>
      data ? data.topics.filter((r) => topicDraft.get(r.topic.id) !== r.subscribed) : [],
    [data, topicDraft],
  );

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">加载中…</p>;
  }

  if (error || !data) {
    return (
      <div className="rounded-md border bg-card p-6">
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "无法加载偏好信息"}
        </p>
      </div>
    );
  }

  async function patch(payload: {
    subscriptions?: { categoryId: string; subscribed: boolean }[];
    topics?: { topicId: string; subscribed: boolean }[];
    resubscribeAll?: boolean;
  }) {
    setSaving(true);
    setTip(null);
    try {
      const res = await fetch(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "omit",
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        if (res.status === 404) throw new Error("链接已失效或不存在");
        if (res.status === 403) throw new Error("交易类邮件不可关闭");
        if (res.status === 429) throw new Error("操作过于频繁，请稍后再试");
        throw new Error("保存失败，请稍后再试");
      }
      await mutate();
      setTip({ kind: "ok", text: "已保存您的偏好设置" });
    } catch (e) {
      setTip({
        kind: "err",
        text: e instanceof Error ? e.message : "保存失败",
      });
    } finally {
      setSaving(false);
    }
  }

  function reset() {
    if (!data) return;
    const next = new Map<string, boolean>();
    for (const row of data.subscriptions) next.set(row.category.id, row.subscribed);
    setDraft(next);
    const tnext = new Map<string, boolean>();
    for (const row of data.topics) tnext.set(row.topic.id, row.subscribed);
    setTopicDraft(tnext);
    setTip(null);
  }

  const totalChanges = changes.length + topicChanges.length;

  return (
    <div className="space-y-6">
      <section className="rounded-md border bg-card p-4 text-sm">
        <p>
          当前邮箱：<span className="font-mono">{data.user.emailMasked}</span>
        </p>
        {data.user.unsubscribed ? (
          <div className="mt-3 rounded-md bg-amber-50 p-3 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            <p className="font-medium">您已全局退订</p>
            <p className="mt-1 text-xs">
              当前不会收到任何营销邮件。如需重新接收，请点击下方按钮恢复订阅。
            </p>
            <button
              type="button"
              onClick={() => patch({ resubscribeAll: true })}
              disabled={saving}
              className="mt-3 inline-flex items-center rounded-md border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-50 disabled:opacity-60 dark:bg-amber-900/40 dark:text-amber-100"
            >
              {saving ? "处理中…" : "恢复订阅"}
            </button>
          </div>
        ) : null}
      </section>

      <section>
        <h2 className="mb-2 text-base font-medium">订阅分类</h2>
        {data.subscriptions.length === 0 ? (
          <p className="text-sm text-muted-foreground">尚未配置可订阅的分类。</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {data.subscriptions.map((row) => {
              const checked = draft.get(row.category.id) ?? row.subscribed;
              const locked = row.category.isTransactional || data.user.unsubscribed;
              return (
                <li
                  key={row.category.id}
                  className="flex items-start justify-between gap-4 p-3"
                >
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{row.category.name}</span>
                      {row.category.isTransactional ? (
                        <span className="rounded bg-rose-100 px-1.5 py-0.5 text-[10px] text-rose-700 dark:bg-rose-900/40 dark:text-rose-200">
                          交易类（不可退订）
                        </span>
                      ) : null}
                      {row.category.isDefault ? (
                        <span className="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          默认订阅
                        </span>
                      ) : null}
                    </div>
                    {row.category.description ? (
                      <p className="text-xs text-muted-foreground">
                        {row.category.description}
                      </p>
                    ) : null}
                  </div>
                  <label className="flex shrink-0 items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={locked}
                      onChange={(e) => {
                        const next = new Map(draft);
                        next.set(row.category.id, e.target.checked);
                        setDraft(next);
                        setTip(null);
                      }}
                    />
                    <span className={locked ? "text-muted-foreground" : ""}>
                      订阅
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-base font-medium">活动主题</h2>
        <p className="mb-2 text-xs text-muted-foreground">
          您可以单独退订某个营销活动或定时提醒系列。退订主题不会影响其他主题或分类邮件。
        </p>
        {data.topics.length === 0 ? (
          <p className="text-sm text-muted-foreground">暂无可管理的活动主题。</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {data.topics.map((row) => {
              const checked = topicDraft.get(row.topic.id) ?? row.subscribed;
              const locked = data.user.unsubscribed;
              return (
                <li
                  key={row.topic.id}
                  className="flex items-start justify-between gap-4 p-3"
                >
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{row.topic.name}</span>
                      <span className="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {row.topic.slug}
                      </span>
                    </div>
                    {row.topic.description ? (
                      <p className="text-xs text-muted-foreground">
                        {row.topic.description}
                      </p>
                    ) : null}
                  </div>
                  <label className="flex shrink-0 items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={locked}
                      onChange={(e) => {
                        const next = new Map(topicDraft);
                        next.set(row.topic.id, e.target.checked);
                        setTopicDraft(next);
                        setTip(null);
                      }}
                    />
                    <span className={locked ? "text-muted-foreground" : ""}>
                      订阅
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {totalChanges > 0 ? `有 ${totalChanges} 项变更未保存` : "无变更"}
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={reset}
            disabled={totalChanges === 0 || saving}
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
          >
            重置
          </button>
          <button
            type="button"
            onClick={() =>
              patch({
                subscriptions:
                  changes.length > 0
                    ? changes.map((c) => ({
                      categoryId: c.category.id,
                      subscribed: draft.get(c.category.id) ?? c.subscribed,
                    }))
                    : undefined,
                topics:
                  topicChanges.length > 0
                    ? topicChanges.map((c) => ({
                      topicId: c.topic.id,
                      subscribed: topicDraft.get(c.topic.id) ?? c.subscribed,
                    }))
                    : undefined,
              })
            }
            disabled={totalChanges === 0 || saving}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {saving ? "保存中…" : "保存偏好"}
          </button>
        </div>
      </section>

      {tip ? (
        <p
          className={`text-sm ${tip.kind === "ok" ? "text-emerald-600" : "text-destructive"
            }`}
        >
          {tip.text}
        </p>
      ) : null}

      <footer className="border-t pt-4 text-xs text-muted-foreground">
        如希望完全停止接收所有营销邮件，请使用邮件底部「退订」链接。
      </footer>
    </div>
  );
}
