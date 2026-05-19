-- Phase 10: Outbound Importer（ImportSource + ImportJob + ImportJobError）
-- 关联 spec：specs/modules/outbound-importer.md
-- 关联 plan：plans/phases/phase-10-outbound-importer.md

-- 1) 枚举
CREATE TYPE "ImportAuthType" AS ENUM ('NONE', 'BEARER', 'BASIC', 'API_KEY_HEADER');
CREATE TYPE "ImportJobStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- 2) ImportSource：外部数据源配置（凭据 AES-256-GCM 加密存储）
CREATE TABLE "import_sources" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "baseUrl" TEXT NOT NULL,
  "authType" "ImportAuthType" NOT NULL DEFAULT 'NONE',
  "authValue" TEXT,
  "authHeader" TEXT,
  "headers" JSONB,
  "paginationType" TEXT NOT NULL DEFAULT 'offset',
  "pageSize" INTEGER NOT NULL DEFAULT 100,
  "pageSizeParam" TEXT,
  "pageParam" TEXT,
  "cursorParam" TEXT,
  "cursorJsonPath" TEXT,
  "dataJsonPath" TEXT NOT NULL DEFAULT '$',
  "fieldMapping" JSONB NOT NULL,
  "schedule" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "lastRunAt" TIMESTAMP(3),
  "createdBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "import_sources_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "import_sources_enabled_lastRunAt_idx" ON "import_sources"("enabled", "lastRunAt");

-- 3) ImportJob：单次导入任务（含进度 + 断点续跑 cursor/currentPage）
CREATE TABLE "import_jobs" (
  "id" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "status" "ImportJobStatus" NOT NULL DEFAULT 'PENDING',
  "isDryRun" BOOLEAN NOT NULL DEFAULT false,
  "totalFetched" INTEGER NOT NULL DEFAULT 0,
  "totalCreated" INTEGER NOT NULL DEFAULT 0,
  "totalUpdated" INTEGER NOT NULL DEFAULT 0,
  "totalSkipped" INTEGER NOT NULL DEFAULT 0,
  "totalErrored" INTEGER NOT NULL DEFAULT 0,
  "cursor" TEXT,
  "currentPage" INTEGER NOT NULL DEFAULT 0,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "failureReason" TEXT,
  "createdBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "import_jobs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "import_jobs_sourceId_status_idx" ON "import_jobs"("sourceId", "status");
CREATE INDEX "import_jobs_status_createdAt_idx" ON "import_jobs"("status", "createdAt");

ALTER TABLE "import_jobs"
  ADD CONSTRAINT "import_jobs_sourceId_fkey"
  FOREIGN KEY ("sourceId") REFERENCES "import_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 4) ImportJobError：每行错误日志（支持 errors.csv 下载）
CREATE TABLE "import_job_errors" (
  "id" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "row" INTEGER NOT NULL,
  "field" TEXT,
  "message" TEXT NOT NULL,
  "rawData" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "import_job_errors_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "import_job_errors_jobId_idx" ON "import_job_errors"("jobId");

ALTER TABLE "import_job_errors"
  ADD CONSTRAINT "import_job_errors_jobId_fkey"
  FOREIGN KEY ("jobId") REFERENCES "import_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
