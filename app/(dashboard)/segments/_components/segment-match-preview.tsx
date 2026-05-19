"use client";

/**
 * 分群命中用户预览面板。
 *
 * 使用方式：
 *  - 编辑已有分群时（mode = "saved"）：给 segmentId，组件按 swrKeys.segmentUsers 拉
 *    /api/segments/:id/users，展示后端落库后的命中样例
 *  - 编辑未保存草稿时（mode = "draft"）：给 conditions，组件 debounce 调
 *    POST /api/segments/preview
 *  目前后端只暴露了 saved 路径，所以先支持 mode="saved"，draft 模式由父组件
 *  使用 /api/segments/validate 的命中估算自行展示，避免重复实现。
 */

import useSWR from "swr";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { swrFetcher } from "@/lib/api-client";
import { swrKeys } from "@/lib/swr-keys";

interface PreviewUser {
  id: string;
  email: string;
  name: string | null;
  userLevel: string | null;
  createdAt: string;
}

interface PreviewResponse {
  total: number;
  users: PreviewUser[];
}

interface SegmentMatchPreviewProps {
  segmentId?: string;
  limit?: number;
}

export default function SegmentMatchPreview({
  segmentId,
  limit = 10,
}: SegmentMatchPreviewProps) {
  const { data, error, isLoading } = useSWR<PreviewResponse>(
    segmentId ? swrKeys.segmentUsers(segmentId, limit) : null,
    swrFetcher,
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>命中用户预览</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {!segmentId ? (
          <p className="text-muted-foreground">
            保存分群后，可在此查看实际命中的用户样例。
          </p>
        ) : isLoading ? (
          <p className="text-muted-foreground">加载中…</p>
        ) : error ? (
          <p className="text-destructive">加载失败，请稍后重试</p>
        ) : !data || data.users.length === 0 ? (
          <p className="text-muted-foreground">暂无命中用户</p>
        ) : (
          <>
            <p className="text-muted-foreground">
              共 <strong className="text-foreground">{data.total.toLocaleString()}</strong> 位用户，
              下方展示前 {Math.min(limit, data.users.length)} 条
            </p>
            <ul className="divide-y rounded-md border">
              {data.users.map((u) => (
                <li
                  key={u.id}
                  className="flex items-center justify-between gap-2 p-2"
                >
                  <div className="min-w-0 space-y-0.5">
                    <div className="truncate font-medium">
                      {u.name?.trim() || u.email}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {u.email}
                      {u.userLevel ? ` · ${u.userLevel}` : ""}
                    </div>
                  </div>
                  <Link
                    href={`/users/${u.id}`}
                    className="text-xs text-primary underline-offset-2 hover:underline"
                  >
                    查看
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}
