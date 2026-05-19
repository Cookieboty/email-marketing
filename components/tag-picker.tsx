"use client";

import useSWR from "swr";
import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { swrFetcher } from "@/lib/api-client";
import { swrKeys } from "@/lib/swr-keys";
import { cn } from "@/lib/utils";

interface TagBrief {
  id: string;
  name: string;
  color?: string | null;
}

interface ListTagsResponse {
  data: TagBrief[];
  total: number;
}

export interface TagPickerProps {
  value: string[];
  onChange: (next: string[]) => void;
  className?: string;
  disabled?: boolean;
  emptyText?: string;
}

export function TagPicker({ value, onChange, className, disabled, emptyText }: TagPickerProps) {
  const { data, isLoading } = useSWR<ListTagsResponse>(swrKeys.tags(), swrFetcher);
  const tags = data?.data ?? [];
  const selected = useMemo(() => new Set(value), [value]);

  function toggle(id: string) {
    if (disabled) return;
    if (selected.has(id)) onChange(value.filter((v) => v !== id));
    else onChange([...value, id]);
  }

  if (isLoading) {
    return (
      <div className={cn("text-sm text-muted-foreground", className)}>加载标签中...</div>
    );
  }
  if (tags.length === 0) {
    return (
      <div className={cn("text-sm text-muted-foreground", className)} data-testid="tag-picker-empty">
        {emptyText ?? "暂无标签，先到「标签」页创建"}
      </div>
    );
  }

  return (
    <div className={cn("flex flex-wrap gap-2", className)} data-testid="tag-picker">
      {tags.map((t) => {
        const active = selected.has(t.id);
        return (
          <Button
            key={t.id}
            type="button"
            variant={active ? "default" : "outline"}
            size="sm"
            disabled={disabled}
            onClick={() => toggle(t.id)}
            data-testid={`tag-picker-item-${t.id}`}
            className="h-7"
          >
            {t.name}
            {active ? <Badge variant="secondary" className="ml-2">已选</Badge> : null}
          </Button>
        );
      })}
    </div>
  );
}
