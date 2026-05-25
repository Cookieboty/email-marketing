-- CreateEnum
CREATE TYPE "ResendConfigStatus" AS ENUM ('ACTIVE', 'DISABLED');
CREATE TYPE "SendingChannelStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateTable: resend_configs
CREATE TABLE "resend_configs" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "api_key_cipher" TEXT NOT NULL,
    "api_key_hint" TEXT,
    "status" "ResendConfigStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "resend_configs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "resend_configs_status_idx" ON "resend_configs"("status");

-- CreateTable: sending_channels
CREATE TABLE "sending_channels" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "provider_type" "MailProviderType" NOT NULL,
    "smtp_config_id" TEXT,
    "resend_config_id" TEXT,
    "from_email" TEXT,
    "from_name" TEXT,
    "reply_to" TEXT,
    "is_system_default" BOOLEAN NOT NULL DEFAULT false,
    "status" "SendingChannelStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sending_channels_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "sending_channels_provider_type_status_idx" ON "sending_channels"("provider_type", "status");
CREATE INDEX "sending_channels_is_system_default_idx" ON "sending_channels"("is_system_default");

-- Partial unique: at most one isSystemDefault=true row
CREATE UNIQUE INDEX "sending_channels_system_default_unique" ON "sending_channels"("is_system_default") WHERE "is_system_default" = true;

-- AddColumn: campaigns.sending_channel_id
ALTER TABLE "campaigns" ADD COLUMN "sending_channel_id" TEXT;

CREATE INDEX "campaigns_sending_channel_id_idx" ON "campaigns"("sending_channel_id");

-- AddForeignKeys
ALTER TABLE "sending_channels" ADD CONSTRAINT "sending_channels_smtp_config_id_fkey" FOREIGN KEY ("smtp_config_id") REFERENCES "smtp_configs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sending_channels" ADD CONSTRAINT "sending_channels_resend_config_id_fkey" FOREIGN KEY ("resend_config_id") REFERENCES "resend_configs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_sending_channel_id_fkey" FOREIGN KEY ("sending_channel_id") REFERENCES "sending_channels"("id") ON DELETE SET NULL ON UPDATE CASCADE;
