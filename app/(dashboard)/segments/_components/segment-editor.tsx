"use client";

/**
 * 分群编辑器（创建/编辑共用）。
 *
 * 数据流：
 *  - 父页面提供 initial（创建时为空树；编辑时来自 GET /api/segments/:id）
 *  - 提交时：创建 → POST /api/segments；编辑 → PATCH /api/segments/:id；
 *    成功后跳回 /segments 列表
 *  - 实时预估命中数：表单 value 变化后 debounce → POST /api/segments/validate；
 *    400 直接显示 error 文本（与后端校验同源）
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { apiPatch, apiPost, type ApiClientError } from "@/lib/api-client";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import {
  countLeafConditions,
  getConditionDepth,
  isGroupCondition,
  type LeafCondition,
  type SegmentCondition,
} from "@/lib/modules/segment/conditions";
import SegmentBuilder, { EMPTY_SEGMENT_TREE } from "./segment-builder";
import SegmentMatchPreview from "./segment-match-preview";

interface SegmentEditorProps {
  mode: "create" | "edit";
  segmentId?: string;
  initialName?: string;
  initialDescription?: string;
  initialConditions?: SegmentCondition;
}

interface ValidateOk {
  valid: true;
  estimatedUserCount: number;
}

function asMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return "操作失败";
}

function hasIncompleteLeaf(cond: SegmentCondition): boolean {
  if (isGroupCondition(cond)) {
    return cond.conditions.some(hasIncompleteLeaf);
  }
  const leaf = cond as LeafCondition;
  if (leaf.value === "" || leaf.value === null || leaf.value === undefined) return true;
  if (Array.isArray(leaf.value) && leaf.value.length === 0) return true;
  if (Array.isArray(leaf.value) && leaf.value.some((v) => v === "" || v === null || v === undefined)) return true;
  return false;
}

export default function SegmentEditor({
  mode,
  segmentId,
  initialName = "",
  initialDescription = "",
  initialConditions,
}: SegmentEditorProps) {
  const router = useRouter();
  const { toast } = useToast();

  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [conditions, setConditions] = useState<SegmentCondition>(
    initialConditions ?? EMPTY_SEGMENT_TREE,
  );
  const [submitting, setSubmitting] = useState(false);

  const debouncedConditions = useDebouncedValue(conditions, 400);
  const [estimate, setEstimate] = useState<number | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const stats = useMemo(
    () => ({
      depth: getConditionDepth(conditions),
      leafCount: countLeafConditions(conditions),
    }),
    [conditions],
  );

  useEffect(() => {
    if (hasIncompleteLeaf(debouncedConditions)) {
      setEstimate(null);
      setValidationError(null);
      setEstimating(false);
      return;
    }
    let cancelled = false;
    async function run() {
      setEstimating(true);
      setValidationError(null);
      try {
        const r = (await apiPost("/api/segments/validate", {
          conditions: debouncedConditions,
        })) as ValidateOk;
        if (!cancelled) setEstimate(r.estimatedUserCount);
      } catch (e) {
        if (!cancelled) {
          setEstimate(null);
          setValidationError(asMessage(e));
        }
      } finally {
        if (!cancelled) setEstimating(false);
      }
    }
    run();
    return () => {
      cancelled = true;
    };
  }, [debouncedConditions]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      toast({ title: "请输入分群名称", variant: "destructive" });
      return;
    }
    if (validationError) {
      toast({
        title: "条件不合法",
        description: validationError,
        variant: "destructive",
      });
      return;
    }
    setSubmitting(true);
    try {
      if (mode === "create") {
        await apiPost("/api/segments", {
          name: name.trim(),
          description: description.trim() ? description.trim() : null,
          conditions,
        });
        toast({ title: "已创建" });
      } else if (segmentId) {
        await apiPatch(`/api/segments/${segmentId}`, {
          name: name.trim(),
          description: description.trim() ? description.trim() : null,
          conditions,
        });
        toast({ title: "已保存" });
      }
      router.push("/segments");
      router.refresh();
    } catch (err) {
      const e = err as ApiClientError;
      toast({
        title: "保存失败",
        description: asMessage(e),
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>基本信息</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="seg-name">名称</Label>
            <Input
              id="seg-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              required
              data-testid="segment-form-name"
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="seg-desc">描述（可选）</Label>
            <Textarea
              id="seg-desc"
              rows={2}
              maxLength={500}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              data-testid="segment-form-desc"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>条件</CardTitle>
          <div className="flex items-center gap-2 text-xs">
            <Badge variant="outline">深度 {stats.depth} / 5</Badge>
            <Badge variant="outline">叶子 {stats.leafCount} / 20</Badge>
          </div>
        </CardHeader>
        <CardContent>
          <SegmentBuilder
            value={conditions}
            onChange={(next) => {
              setConditions(
                isGroupCondition(next) ? next : { logic: "AND", conditions: [next] },
              );
            }}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>实时预估</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {validationError ? (
            <p className="text-destructive" data-testid="segment-validate-error">
              {validationError}
            </p>
          ) : estimating ? (
            <p className="text-muted-foreground">计算中…</p>
          ) : estimate !== null ? (
            <p data-testid="segment-validate-estimate">
              预计命中 <strong>{estimate.toLocaleString()}</strong> 位用户
            </p>
          ) : (
            <p className="text-muted-foreground">编辑条件后将自动估算</p>
          )}
        </CardContent>
      </Card>

      {mode === "edit" && segmentId ? (
        <SegmentMatchPreview segmentId={segmentId} />
      ) : null}

      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => router.push("/segments")}
          data-testid="segment-form-cancel"
        >
          取消
        </Button>
        <Button
          type="submit"
          disabled={submitting || estimating || !!validationError}
          data-testid="segment-form-submit"
        >
          {submitting
            ? "保存中..."
            : mode === "create"
              ? "创建分群"
              : "保存修改"}
        </Button>
      </div>
    </form>
  );
}
