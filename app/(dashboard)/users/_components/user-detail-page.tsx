"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { TagPicker } from "@/components/tag-picker";
import { apiDelete, apiPatch, apiPost, swrFetcher, type ApiClientError } from "@/lib/api-client";
import { swrKeys } from "@/lib/swr-keys";
import UserSubscriptionsCard from "./user-subscriptions-card";
import type { Locale } from "@/app/(dashboard)/templates/_components/types";
import {
  diffUserLocale,
  parseLocaleFormValue,
  type UserLocale,
} from "./user-locale-helpers";

interface UserDetail {
  id: string;
  email: string;
  externalId: string | null;
  name: string | null;
  source: string | null;
  userLevel: string | null;
  totalSpend: string | null;
  orderCount: number;
  unsubscribed: boolean;
  optInStatus: string;
  locale: Locale | null;
  createdAt: string;
  updatedAt: string;
  tags: { id: string; name: string; color?: string | null }[];
}

const Schema = z.object({
  name: z.string().max(255).optional(),
  source: z.string().max(64).optional(),
  userLevel: z.string().max(64).optional(),
  totalSpend: z
    .string()
    .optional()
    .refine((v) => v === undefined || v === "" || Number(v) >= 0, "金额需 ≥ 0"),
  orderCount: z
    .string()
    .optional()
    .refine(
      (v) => v === undefined || v === "" || (Number.isInteger(Number(v)) && Number(v) >= 0),
      "需为非负整数",
    ),
  locale: z.enum(["", "zh", "en"]).optional(),
});
type FormValues = z.infer<typeof Schema>;

function asMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return "请求失败";
}

export default function UserDetailPage({ id }: { id: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const detailKey = swrKeys.user(id);
  const { data, isLoading, mutate, error } = useSWR<UserDetail>(detailKey, swrFetcher);

  const [tagIds, setTagIds] = useState<string[]>([]);
  const [tagSaving, setTagSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [resending, setResending] = useState(false);

  const form = useForm<FormValues>({ resolver: zodResolver(Schema) });
  const { register, handleSubmit, reset, formState } = form;

  useEffect(() => {
    if (!data) return;
    reset({
      name: data.name ?? "",
      source: data.source ?? "",
      userLevel: data.userLevel ?? "",
      totalSpend: data.totalSpend != null ? String(data.totalSpend) : "",
      orderCount: String(data.orderCount ?? 0),
      locale: (data.locale ?? "") as "" | "zh" | "en",
    });
    setTagIds(data.tags.map((t) => t.id));
  }, [data, reset]);

  if (error) {
    return (
      <div className="space-y-3" data-testid="user-detail-error">
        <h1 className="text-xl font-semibold">用户加载失败</h1>
        <p className="text-sm text-muted-foreground">{asMessage(error)}</p>
        <Button variant="outline" onClick={() => router.push("/users")}>返回列表</Button>
      </div>
    );
  }

  if (isLoading || !data) {
    return (
      <div className="space-y-4" data-testid="user-detail-loading">
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  async function onSubmit(v: FormValues) {
    const payload: Record<string, unknown> = {};
    if (v.name !== undefined) payload.name = v.name === "" ? null : v.name;
    if (v.source !== undefined) payload.source = v.source === "" ? null : v.source;
    if (v.userLevel !== undefined) payload.userLevel = v.userLevel === "" ? null : v.userLevel;
    if (v.totalSpend !== undefined && v.totalSpend !== "") payload.totalSpend = v.totalSpend;
    if (v.orderCount !== undefined && v.orderCount !== "") payload.orderCount = Number(v.orderCount);
    if (v.locale !== undefined) {
      const nextLocale: UserLocale = parseLocaleFormValue(v.locale);
      const original: UserLocale = data?.locale ?? null;
      const diff = diffUserLocale(nextLocale, original);
      if (diff.changed) payload.locale = diff.value;
    }
    try {
      await apiPatch(`/api/users/${id}`, payload);
      toast({ title: "已保存" });
      await mutate();
    } catch (e) {
      toast({ title: "保存失败", description: asMessage(e), variant: "destructive" });
    }
  }

  async function saveTags() {
    setTagSaving(true);
    try {
      await apiFetchPut(`/api/users/${id}/tags`, { tagIds });
      toast({ title: "标签已更新" });
      await mutate();
    } catch (e) {
      toast({ title: "更新失败", description: asMessage(e), variant: "destructive" });
    } finally {
      setTagSaving(false);
    }
  }

  async function resendOptIn() {
    setResending(true);
    try {
      await apiPost(`/api/users/${id}/resend-opt-in`);
      toast({ title: "确认邮件已重发" });
      await mutate();
    } catch (e) {
      const err = e as ApiClientError;
      const desc =
        err?.status === 429 ? "操作过于频繁，请稍后再试" : asMessage(e);
      toast({ title: "重发失败", description: desc, variant: "destructive" });
    } finally {
      setResending(false);
    }
  }

  async function doDelete() {
    setDeleting(true);
    try {
      await apiDelete(`/api/users/${id}`);
      toast({ title: "用户已删除" });
      router.push("/users");
    } catch (e) {
      toast({ title: "删除失败", description: asMessage(e), variant: "destructive" });
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  return (
    <section className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <Link href="/users" className="text-sm text-muted-foreground hover:underline">
            ← 返回用户列表
          </Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight" data-testid="user-detail-heading">
            {data.email}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <Badge variant="outline">id:{data.id.slice(0, 8)}</Badge>
            {data.externalId ? <Badge variant="outline">extId:{data.externalId}</Badge> : null}
            <span>创建于 {new Date(data.createdAt).toLocaleString()}</span>
          </div>
        </div>
        <div className="flex gap-2">
          {data.optInStatus !== "NOT_REQUIRED" && data.optInStatus !== "CONFIRMED" ? (
            <Button
              variant="outline"
              disabled={resending}
              onClick={resendOptIn}
              data-testid="user-resend-opt-in"
            >
              {resending ? "发送中..." : "重发确认邮件"}
            </Button>
          ) : null}
          <Button
            variant="destructive"
            onClick={() => setConfirmDelete(true)}
            data-testid="user-delete-btn"
          >
            删除用户
          </Button>
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>基本信息</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" data-testid="user-edit-form">
              <div className="space-y-1.5">
                <Label htmlFor="email">Email（不可修改）</Label>
                <Input id="email" value={data.email} disabled />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="name">姓名</Label>
                  <Input id="name" {...register("name")} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="source">来源</Label>
                  <Input id="source" {...register("source")} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="userLevel">用户等级</Label>
                  <Input id="userLevel" {...register("userLevel")} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="totalSpend">累计消费</Label>
                  <Input id="totalSpend" inputMode="decimal" {...register("totalSpend")} />
                  {formState.errors.totalSpend ? (
                    <p className="text-xs text-destructive">{formState.errors.totalSpend.message}</p>
                  ) : null}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="orderCount">订单数</Label>
                  <Input id="orderCount" inputMode="numeric" {...register("orderCount")} />
                  {formState.errors.orderCount ? (
                    <p className="text-xs text-destructive">{formState.errors.orderCount.message}</p>
                  ) : null}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="user-locale">语言偏好</Label>
                  <select
                    id="user-locale"
                    data-testid="user-locale-select"
                    className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    {...register("locale")}
                  >
                    <option value="">未指定</option>
                    <option value="zh">中文</option>
                    <option value="en">English</option>
                  </select>
                  <p className="text-xs text-muted-foreground">
                    用于多语言模板的自动语言决策；未指定则使用模板默认语言。
                  </p>
                </div>
              </div>
              <Button type="submit" disabled={formState.isSubmitting} data-testid="user-edit-submit">
                {formState.isSubmitting ? "保存中..." : "保存"}
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>状态与订阅</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <span>退订状态</span>
              {data.unsubscribed ? (
                <Badge variant="destructive">已退订</Badge>
              ) : (
                <Badge variant="outline">订阅中</Badge>
              )}
            </div>
            <div className="flex items-center justify-between">
              <span>Opt-in 状态</span>
              <Badge>{data.optInStatus}</Badge>
            </div>
            <div className="flex items-center justify-between text-muted-foreground">
              <span>更新时间</span>
              <span>{new Date(data.updatedAt).toLocaleString()}</span>
            </div>
            <p className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
              退订状态由用户主动退订或 Webhook 标记，后台不直接修改。如需重置请联系运维处理。
            </p>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>标签</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <TagPicker value={tagIds} onChange={setTagIds} />
            <div className="flex items-center gap-2">
              <Button onClick={saveTags} disabled={tagSaving} data-testid="user-tags-save">
                {tagSaving ? "保存中..." : "保存标签"}
              </Button>
              <Button
                variant="ghost"
                onClick={() => setTagIds(data.tags.map((t) => t.id))}
                disabled={tagSaving}
              >
                重置
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>商业字段</CardTitle>
          </CardHeader>
          <CardContent>
            <Textarea
              readOnly
              rows={4}
              value={JSON.stringify(
                {
                  totalSpend: data.totalSpend,
                  orderCount: data.orderCount,
                  userLevel: data.userLevel,
                  source: data.source,
                },
                null,
                2,
              )}
              className="font-mono text-xs"
            />
          </CardContent>
        </Card>

        <UserSubscriptionsCard userId={data.id} />
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="确认删除该用户？"
        description={`将永久删除 ${data.email}，操作不可逆。关联的标签关系会一并清除。`}
        confirmLabel="删除"
        destructive
        loading={deleting}
        onConfirm={doDelete}
      />
    </section>
  );
}

async function apiFetchPut(url: string, body: unknown) {
  const res = await fetch(url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
  });
  if (!res.ok) {
    let payload: unknown = null;
    try {
      payload = await res.json();
    } catch {
      /* noop */
    }
    const err = new Error(
      (payload as { error?: string } | null)?.error ?? `HTTP ${res.status}`,
    ) as ApiClientError;
    err.status = res.status;
    err.payload = payload;
    throw err;
  }
  return res.json().catch(() => null);
}
