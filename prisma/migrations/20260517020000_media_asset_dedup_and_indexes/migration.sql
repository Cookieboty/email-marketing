-- Phase 4C: 媒体资源去重 + 上传人 + 索引（specs/modules/media-library.md §27-31, §382）
-- sha256 唯一去重；createdBy 记录上传管理员；mimeType/createdAt/tags 索引按 spec 要求补全。

ALTER TABLE "media_assets" ADD COLUMN "sha256" TEXT;
ALTER TABLE "media_assets" ADD COLUMN "createdBy" TEXT;

CREATE UNIQUE INDEX "media_assets_sha256_key" ON "media_assets"("sha256");
CREATE INDEX "media_assets_mimeType_idx" ON "media_assets"("mimeType");
CREATE INDEX "media_assets_createdAt_idx" ON "media_assets"("createdAt");
CREATE INDEX "media_assets_tags_idx" ON "media_assets" USING GIN ("tags");
