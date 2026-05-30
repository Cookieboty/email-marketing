-- 恢复「最多一条 isSystemDefault=true」的部分唯一索引。
-- 该索引最初由 20260525000000 创建于列 is_system_default，
-- 但 20260525144806 将列改名为 isSystemDefault（DROP+ADD）时索引被一并删除且未重建。
CREATE UNIQUE INDEX "sending_channels_system_default_unique" ON "sending_channels"("isSystemDefault") WHERE "isSystemDefault" = true;
