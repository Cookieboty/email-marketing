-- Phase 10.x: 给 ImportSource 增加 sourceKey 字段
-- 用于在导入时区分数据来源（free-form），后续可基于该 key 做差异化策略
-- （字段映射默认值、限速、退订处理等）。同时把它写入被导入用户的
-- User.source 字段，便于下游分析。

ALTER TABLE "import_sources" ADD COLUMN "sourceKey" TEXT;

CREATE INDEX "import_sources_sourceKey_idx" ON "import_sources"("sourceKey");
