-- Phase 8: 主题级退订（Topic-level Unsubscribe）
-- 关联 spec：specs/modules/unsubscribe-topic-level.md
-- 关联 plan：plans/phases/phase-8-topic-unsubscribe.md

-- 1) Topic 主表
CREATE TABLE "topics" (
  "id" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "externalRef" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "topics_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "topics_slug_key" ON "topics"("slug");
CREATE UNIQUE INDEX "topics_externalRef_key" ON "topics"("externalRef");

-- 2) 用户-主题退订关系（复合主键保证幂等）
CREATE TABLE "user_topic_unsubscribes" (
  "userId" TEXT NOT NULL,
  "topicId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "user_topic_unsubscribes_pkey" PRIMARY KEY ("userId", "topicId")
);

CREATE INDEX "user_topic_unsubscribes_topicId_idx" ON "user_topic_unsubscribes"("topicId");

ALTER TABLE "user_topic_unsubscribes"
  ADD CONSTRAINT "user_topic_unsubscribes_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_topic_unsubscribes"
  ADD CONSTRAINT "user_topic_unsubscribes_topicId_fkey"
  FOREIGN KEY ("topicId") REFERENCES "topics"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 3) Campaign 增加 topicId（可空，SetNull）
ALTER TABLE "campaigns" ADD COLUMN "topicId" TEXT;
CREATE INDEX "campaigns_topicId_idx" ON "campaigns"("topicId");
ALTER TABLE "campaigns"
  ADD CONSTRAINT "campaigns_topicId_fkey"
  FOREIGN KEY ("topicId") REFERENCES "topics"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 4) Automation 增加 topicId（可空，SetNull）
ALTER TABLE "automations" ADD COLUMN "topicId" TEXT;
CREATE INDEX "automations_topicId_idx" ON "automations"("topicId");
ALTER TABLE "automations"
  ADD CONSTRAINT "automations_topicId_fkey"
  FOREIGN KEY ("topicId") REFERENCES "topics"("id") ON DELETE SET NULL ON UPDATE CASCADE;
