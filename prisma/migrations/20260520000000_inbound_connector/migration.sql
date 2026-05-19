-- Phase 9: Inbound 连接器（ApiClient + 幂等请求日志）
-- 关联 spec：specs/modules/inbound-connector.md
-- 关联 plan：plans/phases/phase-9-inbound-connector.md

-- 1) ApiClient 状态枚举
CREATE TYPE "ApiClientStatus" AS ENUM ('ACTIVE', 'DISABLED', 'REVOKED');

-- 2) ApiClient 主表（凭证 + 范围 + IP 白名单 + 限流配置）
CREATE TABLE "api_clients" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "status" "ApiClientStatus" NOT NULL DEFAULT 'ACTIVE',
  "tokenHash" TEXT NOT NULL,
  "tokenPrefix" TEXT NOT NULL,
  "hmacSecretHash" TEXT,
  "hmacSecretEncrypted" TEXT,
  "previousTokenHash" TEXT,
  "previousTokenExpiresAt" TIMESTAMP(3),
  "scopes" TEXT[],
  "ipWhitelist" TEXT[] NOT NULL DEFAULT '{}',
  "rpsLimit" INTEGER,
  "rphLimit" INTEGER,
  "metadata" JSONB,
  "lastUsedAt" TIMESTAMP(3),
  "createdBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "api_clients_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "api_clients_tokenHash_key" ON "api_clients"("tokenHash");
CREATE INDEX "api_clients_status_idx" ON "api_clients"("status");
CREATE INDEX "api_clients_tokenPrefix_idx" ON "api_clients"("tokenPrefix");

-- 3) Inbound 请求幂等日志（按 apiClientId + idempotencyKey 复合唯一）
CREATE TABLE "inbound_request_logs" (
  "id" TEXT NOT NULL,
  "apiClientId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "endpoint" TEXT NOT NULL,
  "method" TEXT NOT NULL,
  "responseStatus" INTEGER NOT NULL,
  "responseBody" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "inbound_request_logs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "inbound_request_logs_apiClientId_idempotencyKey_key"
  ON "inbound_request_logs"("apiClientId", "idempotencyKey");
CREATE INDEX "inbound_request_logs_expiresAt_idx" ON "inbound_request_logs"("expiresAt");

ALTER TABLE "inbound_request_logs"
  ADD CONSTRAINT "inbound_request_logs_apiClientId_fkey"
  FOREIGN KEY ("apiClientId") REFERENCES "api_clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
