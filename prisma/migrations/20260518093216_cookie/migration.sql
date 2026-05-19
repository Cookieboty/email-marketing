-- DropIndex
DROP INDEX "media_assets_tags_idx";

-- CreateIndex
CREATE INDEX "media_assets_tags_idx" ON "media_assets"("tags");
