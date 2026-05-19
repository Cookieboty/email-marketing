"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  apiFetch,
  apiPatch,
  swrFetcher,
} from "@/lib/api-client";
import { swrKeys } from "@/lib/swr-keys";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";

interface MediaAsset {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  url: string;
  width: number | null;
  height: number | null;
  alt: string | null;
  tags: string[];
  sha256: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ListResp {
  data: MediaAsset[];
  total: number;
  page: number;
  pageSize: number;
}

const MIME_OPTIONS: { label: string; value: string }[] = [
  { label: "全部类型", value: "" },
  { label: "PNG", value: "image/png" },
  { label: "JPEG", value: "image/jpeg" },
  { label: "GIF", value: "image/gif" },
  { label: "WEBP", value: "image/webp" },
  { label: "SVG", value: "image/svg+xml" },
];

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function asMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return "操作失败";
}

export default function MediaPage() {
  const { toast } = useToast();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [q, setQ] = useState("");
  const [type, setType] = useState("");
  const debouncedQ = useDebouncedValue(q, 300);

  const key = swrKeys.media({
    q: debouncedQ || undefined,
    type: type || undefined,
    page,
    pageSize,
  });

  const { data, isLoading, mutate } = useSWR<ListResp>(key, swrFetcher, {
    keepPreviousData: true,
  });

  const [uploadOpen, setUploadOpen] = useState(false);
  const [active, setActive] = useState<MediaAsset | null>(null);
  const [deleting, setDeleting] = useState<MediaAsset | null>(null);

  const total = data?.total ?? 0;
  const items = data?.data ?? [];

  return (
    <section className="space-y-4">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight" data-testid="media-page-heading">
          媒体库
        </h1>
        <Button
          type="button"
          onClick={() => setUploadOpen(true)}
          data-testid="media-upload-button"
        >
          上传图片
        </Button>
      </header>

      <div className="grid gap-3 rounded-md border bg-card p-4 sm:grid-cols-3">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">搜索</label>
          <Input
            placeholder="文件名 / alt / 标签"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
            data-testid="media-search"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">类型</label>
          <Select
            value={type}
            onChange={(e) => {
              setType(e.target.value);
              setPage(1);
            }}
            data-testid="media-filter-type"
          >
            {MIME_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
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
            data-testid="media-page-size"
          >
            <option value="20">20</option>
            <option value="40">40</option>
            <option value="80">80</option>
          </Select>
        </div>
      </div>

      {isLoading ? (
        <div
          className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4"
          data-testid="media-loading"
        >
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="aspect-square w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div
          className="flex h-40 items-center justify-center rounded-md border bg-muted/20 text-sm text-muted-foreground"
          data-testid="media-empty"
        >
          暂无媒体资源
        </div>
      ) : (
        <ul
          className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4"
          data-testid="media-grid"
        >
          {items.map((m) => (
            <li
              key={m.id}
              className="group overflow-hidden rounded-md border bg-card text-sm shadow-sm"
              data-testid={`media-item-${m.id}`}
            >
              <button
                type="button"
                onClick={() => setActive(m)}
                className="block w-full"
              >
                <div className="flex aspect-square items-center justify-center overflow-hidden bg-muted">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/media/${m.id}/file`}
                    alt={m.alt ?? m.filename}
                    loading="lazy"
                    className="h-full w-full object-cover transition-transform group-hover:scale-[1.02]"
                  />
                </div>
                <div className="space-y-1 px-3 py-2 text-left">
                  <div className="truncate font-medium" title={m.filename}>
                    {m.filename}
                  </div>
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>{m.mimeType.replace(/^image\//, "")}</span>
                    <span>{formatBytes(m.size)}</span>
                  </div>
                  {m.tags.length > 0 ? (
                    <div className="flex flex-wrap gap-1 pt-1">
                      {m.tags.slice(0, 3).map((t) => (
                        <Badge key={t} variant="secondary" className="text-[10px]">
                          {t}
                        </Badge>
                      ))}
                      {m.tags.length > 3 ? (
                        <Badge variant="outline" className="text-[10px]">
                          +{m.tags.length - 3}
                        </Badge>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </button>
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

      <UploadDialog
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onUploaded={async () => {
          await mutate();
        }}
      />

      <DetailDialog
        asset={active}
        onClose={() => setActive(null)}
        onSaved={async () => {
          await mutate();
        }}
        onDelete={(m) => {
          setActive(null);
          setDeleting(m);
        }}
      />

      <ConfirmDialog
        open={deleting !== null}
        title="删除媒体"
        description={
          deleting
            ? `确认删除「${deleting.filename}」？已经使用该图片的模板将无法再加载它。`
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
            await apiDelete(`/api/media/${deleting.id}`);
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
    </section>
  );
}

function UploadDialog({
  open,
  onClose,
  onUploaded,
}: {
  open: boolean;
  onClose: () => void;
  onUploaded: () => Promise<void>;
}) {
  const { toast } = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [alt, setAlt] = useState("");
  const [tags, setTags] = useState("");
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setFile(null);
    setAlt("");
    setTags("");
    setSubmitting(false);
  }

  async function onSubmit() {
    if (!file) {
      toast({
        title: "请选择文件",
        description: "需要先选择待上传的图片",
        variant: "destructive",
      });
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      toast({
        title: "文件过大",
        description: `单次上传上限 ${formatBytes(MAX_UPLOAD_BYTES)}`,
        variant: "destructive",
      });
      return;
    }
    setSubmitting(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      if (alt.trim()) fd.append("alt", alt.trim());
      if (tags.trim()) fd.append("tags", tags.trim());
      await apiFetch("/api/media", { method: "POST", body: fd });
      toast({ title: "上传成功" });
      reset();
      onClose();
      await onUploaded();
    } catch (e) {
      toast({
        title: "上传失败",
        description: asMessage(e),
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          reset();
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>上传图片</DialogTitle>
          <DialogDescription>
            支持 PNG / JPEG / GIF / WEBP / SVG，单文件不超过 {formatBytes(MAX_UPLOAD_BYTES)}。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="media-file">文件</Label>
            <input
              id="media-file"
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              data-testid="media-upload-file"
              className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-input file:bg-background file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:bg-accent"
            />
            {file ? (
              <p className="text-xs text-muted-foreground">
                {file.name}（{formatBytes(file.size)}）
              </p>
            ) : null}
          </div>
          <div className="space-y-2">
            <Label htmlFor="media-alt">替代文本（alt）</Label>
            <Input
              id="media-alt"
              value={alt}
              maxLength={256}
              onChange={(e) => setAlt(e.target.value)}
              data-testid="media-upload-alt"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="media-tags">标签（逗号分隔）</Label>
            <Input
              id="media-tags"
              value={tags}
              placeholder="logo, brand"
              onChange={(e) => setTags(e.target.value)}
              data-testid="media-upload-tags"
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              reset();
              onClose();
            }}
            data-testid="media-upload-cancel"
          >
            取消
          </Button>
          <Button
            type="button"
            onClick={onSubmit}
            disabled={!file || submitting}
            data-testid="media-upload-submit"
          >
            {submitting ? "上传中..." : "上传"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DetailDialog({
  asset,
  onClose,
  onSaved,
  onDelete,
}: {
  asset: MediaAsset | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onDelete: (m: MediaAsset) => void;
}) {
  const { toast } = useToast();
  const [alt, setAlt] = useState(asset?.alt ?? "");
  const [tags, setTags] = useState((asset?.tags ?? []).join(", "));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setAlt(asset?.alt ?? "");
    setTags((asset?.tags ?? []).join(", "));
  }, [asset]);

  function reset() {
    setAlt("");
    setTags("");
  }

  async function onSave() {
    if (!asset) return;
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {};
      const newAlt = alt.trim();
      const newTags = tags
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (newAlt !== (asset.alt ?? "")) payload.alt = newAlt === "" ? null : newAlt;
      const tagsChanged =
        newTags.length !== asset.tags.length ||
        newTags.some((t, i) => t !== asset.tags[i]);
      if (tagsChanged) payload.tags = newTags;
      if (Object.keys(payload).length === 0) {
        toast({ title: "未做修改" });
        return;
      }
      await apiPatch(`/api/media/${asset.id}`, payload);
      toast({ title: "已保存" });
      await onSaved();
      onClose();
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

  return (
    <Dialog
      open={asset !== null}
      onOpenChange={(o) => {
        if (!o) {
          reset();
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>媒体详情</DialogTitle>
          {asset ? (
            <DialogDescription className="font-mono text-xs">
              {asset.id}
            </DialogDescription>
          ) : null}
        </DialogHeader>
        {asset ? (
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="flex items-center justify-center overflow-hidden rounded-md border bg-muted">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/media/${asset.id}/file`}
                alt={asset.alt ?? asset.filename}
                className="max-h-72 w-full object-contain"
              />
            </div>
            <div className="space-y-3">
              <dl className="grid grid-cols-3 gap-y-2 text-xs">
                <dt className="text-muted-foreground">文件名</dt>
                <dd className="col-span-2 break-all">{asset.filename}</dd>
                <dt className="text-muted-foreground">类型</dt>
                <dd className="col-span-2">{asset.mimeType}</dd>
                <dt className="text-muted-foreground">尺寸</dt>
                <dd className="col-span-2">
                  {asset.width && asset.height
                    ? `${asset.width} × ${asset.height}`
                    : "—"}
                </dd>
                <dt className="text-muted-foreground">大小</dt>
                <dd className="col-span-2">{formatBytes(asset.size)}</dd>
                <dt className="text-muted-foreground">URL</dt>
                <dd className="col-span-2 break-all font-mono text-[11px]">
                  {asset.url}
                </dd>
                <dt className="text-muted-foreground">上传时间</dt>
                <dd className="col-span-2">
                  {new Date(asset.createdAt).toLocaleString()}
                </dd>
              </dl>
              <div className="space-y-2">
                <Label htmlFor="media-detail-alt">alt</Label>
                <Input
                  id="media-detail-alt"
                  value={alt}
                  maxLength={256}
                  onChange={(e) => setAlt(e.target.value)}
                  data-testid="media-detail-alt"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="media-detail-tags">tags（逗号分隔）</Label>
                <Input
                  id="media-detail-tags"
                  value={tags}
                  onChange={(e) => setTags(e.target.value)}
                  data-testid="media-detail-tags"
                />
              </div>
            </div>
          </div>
        ) : null}
        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="destructive"
            onClick={() => asset && onDelete(asset)}
            data-testid="media-detail-delete"
            disabled={!asset || saving}
          >
            删除
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              reset();
              onClose();
            }}
            data-testid="media-detail-cancel"
          >
            关闭
          </Button>
          <Button
            type="button"
            onClick={onSave}
            disabled={!asset || saving}
            data-testid="media-detail-save"
          >
            {saving ? "保存中..." : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
