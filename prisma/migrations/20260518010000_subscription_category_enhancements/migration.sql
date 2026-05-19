-- 5.2a 订阅分类增强：新增 sortOrder + isPreset 字段
-- 对齐 specs/modules/preference-center.md 数据模型与"预置分类不可删除"约束。

ALTER TABLE "subscription_categories"
  ADD COLUMN "isPreset" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "subscription_categories_sortOrder_idx" ON "subscription_categories"("sortOrder");

-- seed 中四个预置分类回填 isPreset = true（如果存在）
UPDATE "subscription_categories"
SET "isPreset" = true
WHERE "slug" IN ('marketing', 'newsletter', 'product-updates', 'transactional');
