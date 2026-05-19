/**
 * 媒体资源业务服务。
 *
 * 职责：
 *  - 上传：validateUpload → sha256 去重 → DB create → 落盘 → AuditLog
 *    （顺序：先写 DB 再落盘；DB 唯一冲突时早返）
 *  - 详情/列表：直接代理 repository
 *  - PATCH：仅允许改 alt / tags
 *  - 删除：DB delete → 物理文件 unlink（容忍 ENOENT）→ AuditLog
 *
 * 错误转换：
 *  - storage 抛 UploadValidationError → ValidationError（status 400）
 *  - sha256 已存在 → 直接返回旧记录（specs §382 实质保留旧文件，不视作错误）
 */

import type { MediaAsset, Prisma } from "@prisma/client";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { mediaRepository } from "./repository";
import type {
  ListMediaQuery,
  UpdateMediaInput,
  UploadMediaMetadata,
} from "./schema";
import {
  type AllowedMime,
  buildPublicUrl,
  deleteUpload,
  readUpload,
  validateUpload,
  writeUpload,
  UploadValidationError,
} from "./storage";

interface ActorContext {
  actorType: "ADMIN" | "SYSTEM" | "WEBHOOK";
  adminId?: string;
  req?: { headers: Headers } | null;
}

function normalizeTags(tags: string[] | undefined): string[] {
  if (!tags || tags.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const t = raw.trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

export interface UploadResult {
  asset: MediaAsset;
  /** true 表示触发 sha256 去重，未实际落盘新文件。 */
  deduped: boolean;
}

export const mediaService = {
  list(query: ListMediaQuery) {
    return mediaRepository.list(query);
  },

  async getById(id: string): Promise<MediaAsset> {
    const m = await mediaRepository.findById(id);
    if (!m) throw new NotFoundError("媒体资源不存在");
    return m;
  },

  async readFile(id: string): Promise<{ asset: MediaAsset; buffer: Buffer }> {
    const asset = await this.getById(id);
    const buffer = await readUpload(env().UPLOAD_DIR, asset.id, asset.mimeType as AllowedMime);
    return { asset, buffer };
  },

  async upload(
    input: { filename: string; declaredMime?: string; buffer: Buffer },
    metadata: UploadMediaMetadata,
    ctx: ActorContext,
  ): Promise<UploadResult> {
    let validated;
    try {
      validated = validateUpload({ buffer: input.buffer, declaredMime: input.declaredMime });
    } catch (err) {
      if (err instanceof UploadValidationError) throw new ValidationError(err.message);
      throw err;
    }
    const existing = await mediaRepository.findBySha256(validated.sha256);
    if (existing) {
      audit({
        action: "media.upload",
        entityType: "MediaAsset",
        entityId: existing.id,
        actorType: ctx.actorType,
        details: { dedup: true, sha256: validated.sha256, filename: input.filename },
        req: ctx.req ?? null,
      });
      return { asset: existing, deduped: true };
    }
    const tags = normalizeTags(metadata.tags);
    const data: Prisma.MediaAssetUncheckedCreateInput = {
      filename: input.filename.slice(0, 255),
      mimeType: validated.mime,
      size: validated.size,
      url: "", // 占位；先建记录拿 id，再回填
      width: validated.width,
      height: validated.height,
      alt: metadata.alt ?? null,
      tags,
      sha256: validated.sha256,
      createdBy: ctx.adminId ?? null,
    };
    const created = await mediaRepository.create(data);
    try {
      await writeUpload(env().UPLOAD_DIR, created.id, validated.mime, validated.buffer);
    } catch (err) {
      // 落盘失败：撤销 DB 记录，避免 orphan
      await mediaRepository.delete(created.id).catch(() => {});
      throw err;
    }
    const url = buildPublicUrl(created.id);
    const asset = await mediaRepository.update(created.id, { url });
    audit({
      action: "media.upload",
      entityType: "MediaAsset",
      entityId: asset.id,
      actorType: ctx.actorType,
      details: {
        filename: asset.filename,
        mimeType: asset.mimeType,
        size: asset.size,
        sha256: validated.sha256,
      },
      req: ctx.req ?? null,
    });
    return { asset, deduped: false };
  },

  async update(id: string, input: UpdateMediaInput, ctx: ActorContext): Promise<MediaAsset> {
    const existing = await mediaRepository.findById(id);
    if (!existing) throw new NotFoundError("媒体资源不存在");
    const data: Prisma.MediaAssetUncheckedUpdateInput = {};
    if (input.alt !== undefined) data.alt = input.alt ?? null;
    if (input.tags !== undefined) data.tags = { set: normalizeTags(input.tags) };
    const asset = await mediaRepository.update(id, data);
    audit({
      action: "media.update",
      entityType: "MediaAsset",
      entityId: id,
      actorType: ctx.actorType,
      details: { fields: Object.keys(input) },
      req: ctx.req ?? null,
    });
    return asset;
  },

  async delete(id: string, ctx: ActorContext): Promise<void> {
    const existing = await mediaRepository.findById(id);
    if (!existing) throw new NotFoundError("媒体资源不存在");
    await mediaRepository.delete(id);
    try {
      await deleteUpload(env().UPLOAD_DIR, existing.id, existing.mimeType as AllowedMime);
    } catch (err) {
      // 物理删除失败仅记日志，不阻塞业务（已无 DB 引用）
      logger.warn("media physical file delete failed", {
        id: existing.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    audit({
      action: "media.delete",
      entityType: "MediaAsset",
      entityId: id,
      actorType: ctx.actorType,
      details: { filename: existing.filename, sha256: existing.sha256 },
      req: ctx.req ?? null,
    });
  },
};

export type MediaService = typeof mediaService;
