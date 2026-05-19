"use client";

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import useSWR from "swr";
import { Skeleton } from "@/components/ui/skeleton";
import { swrFetcher } from "@/lib/api-client";
import { swrKeys } from "@/lib/swr-keys";
import SegmentEditor from "../../_components/segment-editor";
import { parseSegmentCondition } from "@/lib/modules/segment/conditions";

interface SegmentDetail {
  id: string;
  name: string;
  description: string | null;
  conditions: unknown;
  isSystem: boolean;
  userCount: number;
  lastCalculatedAt: string | null;
}

export default function EditSegmentPage() {
  const params = useParams();
  const router = useRouter();
  const segmentId = Array.isArray(params.id) ? params.id[0] : params.id;

  const { data: segment, error, isLoading } = useSWR<SegmentDetail>(
    segmentId ? swrKeys.segment(segmentId) : null,
    swrFetcher,
  );

  useEffect(() => {
    if (error && !isLoading) {
      // 404 或其他错误时返回列表页
      router.push("/segments");
    }
  }, [error, isLoading, router]);

  if (isLoading) {
    return (
      <section className="space-y-4">
        <Skeleton className="h-8 w-64" />
        {[...Array(3)].map((_, i) => (
          <Skeleton key={i} className="h-64 w-full" />
        ))}
      </section>
    );
  }

  if (!segment) return null;

  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">编辑分群</h1>
      <SegmentEditor
        mode="edit"
        segmentId={segmentId}
        initialName={segment.name}
        initialDescription={segment.description ?? ""}
        initialConditions={parseSegmentCondition(segment.conditions)}
      />
    </section>
  );
}
