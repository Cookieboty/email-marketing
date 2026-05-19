"use client";

import { use } from "react";
import useSWR from "swr";
import { Skeleton } from "@/components/ui/skeleton";
import { swrFetcher } from "@/lib/api-client";
import TemplateEditorPage, {
  type TemplateRecord,
} from "../../_components/template-editor-page";

export default function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { data, error, isLoading } = useSWR<TemplateRecord>(
    id ? `/api/templates/${id}` : null,
    swrFetcher,
  );

  if (isLoading) {
    return (
      <section className="space-y-3" data-testid="template-edit-loading">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-32" />
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-[480px] w-full" />
          <Skeleton className="h-[480px] w-full" />
        </div>
      </section>
    );
  }

  if (error || !data) {
    return (
      <section className="space-y-2" data-testid="template-edit-error">
        <h1 className="text-xl font-semibold">无法加载模板</h1>
        <p className="text-sm text-muted-foreground">
          {error instanceof Error ? error.message : "请检查链接或返回列表"}
        </p>
      </section>
    );
  }

  return <TemplateEditorPage mode="edit" initial={data} />;
}
