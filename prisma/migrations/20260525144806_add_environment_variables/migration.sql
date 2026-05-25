/*
  Warnings:

  - You are about to drop the column `sending_channel_id` on the `campaigns` table. All the data in the column will be lost.
  - You are about to drop the column `api_key_cipher` on the `resend_configs` table. All the data in the column will be lost.
  - You are about to drop the column `api_key_hint` on the `resend_configs` table. All the data in the column will be lost.
  - You are about to drop the column `created_at` on the `resend_configs` table. All the data in the column will be lost.
  - You are about to drop the column `updated_at` on the `resend_configs` table. All the data in the column will be lost.
  - You are about to drop the column `created_at` on the `sending_channels` table. All the data in the column will be lost.
  - You are about to drop the column `from_email` on the `sending_channels` table. All the data in the column will be lost.
  - You are about to drop the column `from_name` on the `sending_channels` table. All the data in the column will be lost.
  - You are about to drop the column `is_system_default` on the `sending_channels` table. All the data in the column will be lost.
  - You are about to drop the column `provider_type` on the `sending_channels` table. All the data in the column will be lost.
  - You are about to drop the column `reply_to` on the `sending_channels` table. All the data in the column will be lost.
  - You are about to drop the column `resend_config_id` on the `sending_channels` table. All the data in the column will be lost.
  - You are about to drop the column `smtp_config_id` on the `sending_channels` table. All the data in the column will be lost.
  - You are about to drop the column `updated_at` on the `sending_channels` table. All the data in the column will be lost.
  - Added the required column `apiKeyCipher` to the `resend_configs` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `resend_configs` table without a default value. This is not possible if the table is not empty.
  - Added the required column `fromEmail` to the `sending_channels` table without a default value. This is not possible if the table is not empty.
  - Added the required column `providerType` to the `sending_channels` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `sending_channels` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "campaigns" DROP CONSTRAINT "campaigns_sending_channel_id_fkey";

-- DropForeignKey
ALTER TABLE "sending_channels" DROP CONSTRAINT "sending_channels_resend_config_id_fkey";

-- DropForeignKey
ALTER TABLE "sending_channels" DROP CONSTRAINT "sending_channels_smtp_config_id_fkey";

-- DropIndex
DROP INDEX "campaigns_sending_channel_id_idx";

-- DropIndex
DROP INDEX "sending_channels_is_system_default_idx";

-- DropIndex
DROP INDEX "sending_channels_provider_type_status_idx";

-- AlterTable
ALTER TABLE "campaigns" DROP COLUMN "sending_channel_id",
ADD COLUMN     "sendingChannelId" TEXT;

-- AlterTable
ALTER TABLE "resend_configs" DROP COLUMN "api_key_cipher",
DROP COLUMN "api_key_hint",
DROP COLUMN "created_at",
DROP COLUMN "updated_at",
ADD COLUMN     "apiKeyCipher" TEXT NOT NULL,
ADD COLUMN     "apiKeyHint" TEXT,
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- AlterTable
ALTER TABLE "sending_channels" DROP COLUMN "created_at",
DROP COLUMN "from_email",
DROP COLUMN "from_name",
DROP COLUMN "is_system_default",
DROP COLUMN "provider_type",
DROP COLUMN "reply_to",
DROP COLUMN "resend_config_id",
DROP COLUMN "smtp_config_id",
DROP COLUMN "updated_at",
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "fromEmail" TEXT NOT NULL,
ADD COLUMN     "fromName" TEXT,
ADD COLUMN     "isSystemDefault" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "providerType" "MailProviderType" NOT NULL,
ADD COLUMN     "replyTo" TEXT,
ADD COLUMN     "resendConfigId" TEXT,
ADD COLUMN     "smtpConfigId" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- CreateTable
CREATE TABLE "environment_variables" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "environment_variables_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "environment_variables_key_key" ON "environment_variables"("key");

-- CreateIndex
CREATE INDEX "campaigns_sendingChannelId_idx" ON "campaigns"("sendingChannelId");

-- CreateIndex
CREATE INDEX "sending_channels_providerType_status_idx" ON "sending_channels"("providerType", "status");

-- CreateIndex
CREATE INDEX "sending_channels_isSystemDefault_idx" ON "sending_channels"("isSystemDefault");

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_sendingChannelId_fkey" FOREIGN KEY ("sendingChannelId") REFERENCES "sending_channels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sending_channels" ADD CONSTRAINT "sending_channels_smtpConfigId_fkey" FOREIGN KEY ("smtpConfigId") REFERENCES "smtp_configs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sending_channels" ADD CONSTRAINT "sending_channels_resendConfigId_fkey" FOREIGN KEY ("resendConfigId") REFERENCES "resend_configs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
