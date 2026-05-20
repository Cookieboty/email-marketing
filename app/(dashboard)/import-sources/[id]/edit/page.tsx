"use client";

import { useParams } from "next/navigation";
import useSWR from "swr";
import { swrFetcher } from "@/lib/api-client";
import { swrKeys } from "@/lib/swr-keys";
import { ImportSourceForm } from "../../_components/import-source-form";
import type { ImportSourceRow } from "../../_components/types";

export default function EditImportSourcePage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const { data, error, isLoading } = useSWR<ImportSourceRow>(
    id ? swrKeys.importSource(id) : null,
    swrFetcher,
  );

  if (!id) return null;
  if (isLoading) {
    return <p className="text-sm text-muted-foreground">加载中…</p>;
  }
  if (error || !data) {
    return <p className="text-sm text-destructive">加载失败或不存在。</p>;
  }

  return (
    <section className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">编辑数据源</h1>
        <p className="text-sm text-muted-foreground">
          修改配置后保存。修改凭据请取消「保留现有凭据」勾选并填入新值。
        </p>
      </header>
      <ImportSourceForm mode="edit" initial={data} />
    </section>
  );
}
