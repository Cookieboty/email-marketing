-- SMTP configuration module
-- Adds two tables (smtp_configs, mail_provider_settings) and four enums
-- (SmtpSecureMode, SmtpConfigStatus, SmtpTestStatus, MailProviderType).
-- A singleton row is inserted into mail_provider_settings to represent
-- the current active mail provider (default: RESEND).

-- 1) Enums
CREATE TYPE "SmtpSecureMode" AS ENUM ('NONE', 'STARTTLS', 'TLS');
CREATE TYPE "SmtpConfigStatus" AS ENUM ('ACTIVE', 'DISABLED', 'REVOKED');
CREATE TYPE "SmtpTestStatus" AS ENUM (
  'OK',
  'AUTH_FAILED',
  'CONN_FAILED',
  'TLS_FAILED',
  'TIMEOUT',
  'SEND_FAILED',
  'UNKNOWN'
);
CREATE TYPE "MailProviderType" AS ENUM ('RESEND', 'SMTP');

-- 2) smtp_configs
CREATE TABLE "smtp_configs" (
  "id"                  TEXT NOT NULL,
  "name"                TEXT NOT NULL,
  "description"         TEXT,

  "host"                TEXT NOT NULL,
  "port"                INTEGER NOT NULL,
  "secure"              "SmtpSecureMode" NOT NULL DEFAULT 'STARTTLS',
  "username"            TEXT,
  "passwordCipher"      TEXT,
  "passwordHint"        TEXT,

  "fromEmail"           TEXT NOT NULL,
  "fromName"            TEXT,
  "replyTo"             TEXT,

  "maxConnections"      INTEGER NOT NULL DEFAULT 5,
  "maxMessagesPerConn"  INTEGER NOT NULL DEFAULT 100,
  "rateLimitPerSec"     INTEGER,
  "connectionTimeoutMs" INTEGER NOT NULL DEFAULT 30000,
  "greetingTimeoutMs"   INTEGER NOT NULL DEFAULT 30000,
  "socketTimeoutMs"     INTEGER NOT NULL DEFAULT 60000,

  "rejectUnauthorized"  BOOLEAN NOT NULL DEFAULT true,
  "requireTls"          BOOLEAN NOT NULL DEFAULT true,

  "status"              "SmtpConfigStatus" NOT NULL DEFAULT 'ACTIVE',
  "isDefault"           BOOLEAN NOT NULL DEFAULT false,

  "lastTestAt"          TIMESTAMP(3),
  "lastTestStatus"      "SmtpTestStatus",
  "lastTestError"       TEXT,
  "lastSendAt"          TIMESTAMP(3),
  "recentFailures"      INTEGER NOT NULL DEFAULT 0,

  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL,
  "createdBy"           TEXT,
  "updatedBy"           TEXT,

  CONSTRAINT "smtp_configs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "smtp_configs_port_check"           CHECK ("port" BETWEEN 1 AND 65535),
  CONSTRAINT "smtp_configs_max_conn_check"       CHECK ("maxConnections" >= 1),
  CONSTRAINT "smtp_configs_max_msg_check"        CHECK ("maxMessagesPerConn" >= 1),
  CONSTRAINT "smtp_configs_rate_limit_check"     CHECK ("rateLimitPerSec" IS NULL OR "rateLimitPerSec" >= 1),
  CONSTRAINT "smtp_configs_recent_failures_check" CHECK ("recentFailures" >= 0)
);

-- Treat NULL username as empty string for uniqueness so that the same
-- (host, port) cannot host two unauthenticated configs.
CREATE UNIQUE INDEX "smtp_configs_host_port_username_key"
  ON "smtp_configs" ("host", "port", COALESCE("username", ''));
CREATE INDEX "smtp_configs_status_idx"    ON "smtp_configs" ("status");
CREATE INDEX "smtp_configs_isDefault_idx" ON "smtp_configs" ("isDefault");

-- 3) mail_provider_settings (singleton row enforced by application code)
CREATE TABLE "mail_provider_settings" (
  "id"             TEXT NOT NULL,
  "activeProvider" "MailProviderType" NOT NULL DEFAULT 'RESEND',
  "activeSmtpId"   TEXT,
  "fallback"       "MailProviderType",

  "updatedAt"      TIMESTAMP(3) NOT NULL,
  "updatedBy"      TEXT,

  CONSTRAINT "mail_provider_settings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "mail_provider_settings_active_provider_consistency_check"
    CHECK (
      ("activeProvider" = 'SMTP'   AND "activeSmtpId" IS NOT NULL) OR
      ("activeProvider" = 'RESEND' AND "activeSmtpId" IS NULL)
    )
);

ALTER TABLE "mail_provider_settings"
  ADD CONSTRAINT "mail_provider_settings_activeSmtpId_fkey"
  FOREIGN KEY ("activeSmtpId") REFERENCES "smtp_configs"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- 4) Singleton row
INSERT INTO "mail_provider_settings" ("id", "activeProvider", "activeSmtpId", "updatedAt")
VALUES ('singleton', 'RESEND', NULL, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
