-- Phase 4.2: Double Opt-in 字段补齐
-- specs/modules/user-management.md §41 要求 optInSentAt 字段记录确认邮件发送时间。
-- 历史 init 迁移遗漏；本迁移仅补一列，无回填。

ALTER TABLE "users" ADD COLUMN "optInSentAt" TIMESTAMP(3);
