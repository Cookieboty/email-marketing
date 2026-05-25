/**
 * 数据迁移：将现有配置迁移到 SendingChannel 体系。
 *
 * 运行时机：schema migration 20260525000000_sending_channels 执行后。
 * 可重复运行（幂等）：已存在的数据不会重复创建。
 *
 * 迁移逻辑：
 * 1. 若 RESEND_API_KEY 环境变量存在 → 创建 ResendConfig + 对应 SendingChannel
 * 2. 所有已有 SmtpConfig → 各创建一个 SendingChannel
 * 3. 基于 MailProviderSetting 决定哪个 channel 标记 isSystemDefault
 * 4. 已有 campaigns 的 sendingChannelId 填充为 system default channel
 */

import { PrismaClient } from "@prisma/client";
import { encryptResendApiKey, buildApiKeyHint } from "../lib/modules/smtp/crypto";

const prisma = new PrismaClient();

async function main() {
  console.log("[migration] Starting sending channel data migration...");

  const existingChannels = await prisma.sendingChannel.count();
  if (existingChannels > 0) {
    console.log("[migration] SendingChannels already exist, skipping migration.");
    return;
  }

  const resendApiKey = process.env.RESEND_API_KEY;
  let resendChannelId: string | null = null;

  // 1. Migrate Resend API Key from env
  if (resendApiKey) {
    console.log("[migration] Found RESEND_API_KEY, creating ResendConfig...");
    const existing = await prisma.resendConfig.findFirst();
    let resendConfigId: string;

    if (existing) {
      resendConfigId = existing.id;
      console.log("[migration] ResendConfig already exists, reusing:", resendConfigId);
    } else {
      const cipher = encryptResendApiKey(resendApiKey);
      const hint = buildApiKeyHint(resendApiKey);
      const rc = await prisma.resendConfig.create({
        data: { name: "Default Resend", apiKeyCipher: cipher, apiKeyHint: hint },
      });
      resendConfigId = rc.id;
      console.log("[migration] Created ResendConfig:", resendConfigId);
    }

    const resendChannel = await prisma.sendingChannel.create({
      data: {
        name: "Resend (migrated)",
        providerType: "RESEND",
        resendConfigId,
        fromEmail: process.env.EMAIL_FROM ?? null,
        isSystemDefault: false,
      },
    });
    resendChannelId = resendChannel.id;
    console.log("[migration] Created SendingChannel for Resend:", resendChannelId);
  }

  // 2. Migrate existing SmtpConfigs
  const smtpConfigs = await prisma.smtpConfig.findMany();
  const smtpChannelMap = new Map<string, string>();
  for (const smtp of smtpConfigs) {
    const ch = await prisma.sendingChannel.create({
      data: {
        name: `SMTP: ${smtp.name}`,
        providerType: "SMTP",
        smtpConfigId: smtp.id,
        fromEmail: smtp.fromEmail,
        fromName: smtp.fromName,
        replyTo: smtp.replyTo,
        isSystemDefault: false,
      },
    });
    smtpChannelMap.set(smtp.id, ch.id);
    console.log("[migration] Created SendingChannel for SMTP:", smtp.name, "→", ch.id);
  }

  // 3. Set system default based on MailProviderSetting
  const setting = await prisma.mailProviderSetting.findUnique({ where: { id: "singleton" } });
  let defaultChannelId: string | null = null;

  if (setting?.activeProvider === "SMTP" && setting.activeSmtpId) {
    defaultChannelId = smtpChannelMap.get(setting.activeSmtpId) ?? null;
  }
  if (!defaultChannelId && resendChannelId) {
    defaultChannelId = resendChannelId;
  }
  if (!defaultChannelId && smtpChannelMap.size > 0) {
    defaultChannelId = [...smtpChannelMap.values()][0]!;
  }

  if (defaultChannelId) {
    await prisma.sendingChannel.update({
      where: { id: defaultChannelId },
      data: { isSystemDefault: true },
    });
    console.log("[migration] Set system default channel:", defaultChannelId);

    // 4. Backfill existing campaigns
    const result = await prisma.campaign.updateMany({
      where: { sendingChannelId: null },
      data: { sendingChannelId: defaultChannelId },
    });
    console.log("[migration] Backfilled", result.count, "campaigns with default channel");
  } else {
    console.warn("[migration] No channel created — no RESEND_API_KEY and no SmtpConfig found.");
    console.warn("[migration] You must create a SendingChannel manually before sending emails.");
  }

  console.log("[migration] Done.");
}

main()
  .catch((err) => {
    console.error("[migration] Failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
