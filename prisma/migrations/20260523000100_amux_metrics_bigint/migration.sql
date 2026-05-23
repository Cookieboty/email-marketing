-- Phase 10.x: amux 类数据源的 quota / used_quota / request_count 单值可超过 INT4 上限 (2,147,483,647)
-- 例如：49,554,480,228 token。无损扩宽 INT4 -> INT8。
ALTER TABLE "users" ALTER COLUMN "balance"      TYPE BIGINT USING "balance"::BIGINT;
ALTER TABLE "users" ALTER COLUMN "usedQuota"    TYPE BIGINT USING "usedQuota"::BIGINT;
ALTER TABLE "users" ALTER COLUMN "requestCount" TYPE BIGINT USING "requestCount"::BIGINT;
