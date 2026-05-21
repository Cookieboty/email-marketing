import type { CampaignStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { sendBatch, sendSingle, type SendEmailInput } from "@/lib/resend";
import { logger } from "@/lib/logger";
import { isSuppressed } from "@/lib/modules/suppression/check";
import { isOverLimit } from "@/lib/modules/frequency/check";
import { evaluateDeliverability } from "@/lib/modules/subscription-category/unsubscribe";
import { renderSnapshotContent, type TemplateVariantContent } from "@/lib/modules/template/render";
import type { TemplateSnapshot } from "@/lib/modules/template/snapshot";
import { campaignService } from "./service";
import { snapshotRecipients } from "./snapshot";
import { transformHtml } from "./html-transform";

const log = logger.child("worker-jobs");
const SYSTEM_CTX = { actorType: "SYSTEM" as const, req: null };
const SEND_BATCH_SIZE = 100;
const INTER_BATCH_DELAY_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Phase 6 Jobs ──

export async function scheduledCampaignTrigger(): Promise<void> {
  const campaigns = await prisma.campaign.findMany({
    where: { status: "SCHEDULED", scheduledAt: { lte: new Date() } },
    include: { segment: true, variants: true },
  });

  for (const campaign of campaigns) {
    try {
      await prisma.$transaction(async (tx) => {
        await snapshotRecipients(campaign, tx);
      });
      const next: CampaignStatus = campaign.isAbTest ? "AB_TESTING" : "SENDING";
      const reason = campaign.isAbTest ? "ab_test_start" : "send";
      await campaignService._transition(
        campaign.id,
        "SCHEDULED",
        next,
        reason as Parameters<typeof campaignService._transition>[3],
        {},
        SYSTEM_CTX,
      );
      log.info("scheduled campaign triggered", { campaignId: campaign.id, next });
    } catch (err) {
      log.error("scheduled campaign trigger failed", {
        campaignId: campaign.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export async function processSendQueue(): Promise<void> {
  const campaigns = await prisma.campaign.findMany({
    where: { status: "SENDING" },
    orderBy: { createdAt: "asc" },
    take: 1,
    include: { variants: true, topic: true },
  });

  if (campaigns.length === 0) return;
  const campaign = campaigns[0]!;
  const e = env();
  const appUrl = e.APP_URL ?? "";
  const secret = e.SESSION_SECRET ?? "";

  const snapshot = campaign.templateSnapshot as unknown as TemplateSnapshot | null;
  if (!snapshot) {
    log.error("campaign missing templateSnapshot", { campaignId: campaign.id });
    return;
  }

  const subscriptionCategory = campaign.subscriptionCategory
    ? await prisma.subscriptionCategory.findUnique({
      where: { slug: campaign.subscriptionCategory },
      select: { isTransactional: true },
    })
    : null;

  const utmParams = campaign.utmParams as Record<string, string> | null;

  const claimed = await prisma.$queryRaw<Array<{ id: string }>>`
    UPDATE campaign_recipients
    SET status = 'SENDING', locked_at = NOW()
    WHERE id IN (
      SELECT id FROM campaign_recipients
      WHERE campaign_id = ${campaign.id} AND status = 'PENDING' AND locked_by IS NULL
      ORDER BY id
      LIMIT ${SEND_BATCH_SIZE}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id
  `;

  if (claimed.length === 0) return;

  const recipients = await prisma.campaignRecipient.findMany({
    where: { id: { in: claimed.map((c) => c.id) } },
    include: {
      user: { select: { id: true, email: true, name: true, unsubscribeToken: true } },
      variant: true,
    },
  });

  const emails: SendEmailInput[] = [];
  const recipientMap: Array<{ recipientId: string; userId: string }> = [];

  for (const r of recipients) {
    try {
      const unsubscribeUrl = `${appUrl}/api/unsubscribe?token=${r.user.unsubscribeToken}`;
      const unsubscribeTopicUrl = campaign.topic
        ? `${appUrl}/api/unsubscribe?token=${r.user.unsubscribeToken}&topic=${encodeURIComponent(campaign.topic.slug)}`
        : "";
      const builtin = {
        unsubscribeUrl,
        unsubscribeTopicUrl,
        userEmail: r.user.email,
        userName: r.user.name ?? "",
        campaignName: campaign.name,
      };
      const rendered = renderSnapshotContent({
        snapshot,
        resolvedLocale: r.resolvedLocale,
        subjects: campaign.subjects as Record<string, string> | undefined,
        variant: r.variant
          ? ({
            subjects: r.variant.subjects as Record<string, string>,
            htmlContents: r.variant.htmlContents as Record<string, string>,
            textContents: r.variant.textContents as Record<string, string | null> | undefined,
          } satisfies TemplateVariantContent)
          : null,
        builtin,
      });
      const finalHtml = transformHtml(rendered.html, {
        campaignId: campaign.id,
        recipientId: r.id,
        appUrl,
        sessionSecret: secret,
        utmParams,
      });

      const headers: Record<string, string> = {};
      if (!subscriptionCategory?.isTransactional) {
        const listUnsubUrl = unsubscribeTopicUrl || unsubscribeUrl;
        headers["List-Unsubscribe"] = `<${listUnsubUrl}>`;
        headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
      }

      emails.push({
        from: campaign.fromEmail,
        to: r.user.email,
        subject: rendered.subject,
        html: finalHtml,
        ...(rendered.text ? { text: rendered.text } : {}),
        headers: Object.keys(headers).length > 0 ? headers : undefined,
        tags: [
          { name: "campaign_id", value: campaign.id },
          ...(r.variantId ? [{ name: "variant_id", value: r.variantId }] : []),
        ],
      });
      recipientMap.push({ recipientId: r.id, userId: r.user.id });
    } catch (err) {
      await prisma.campaignRecipient.update({
        where: { id: r.id },
        data: {
          status: "FAILED",
          failedAt: new Date(),
          metadata: {
            error: err instanceof Error ? err.message : "render_failed",
          },
        },
      });
      await prisma.campaign.update({
        where: { id: campaign.id },
        data: { failedCount: { increment: 1 } },
      });
      log.error("campaign recipient render failed", {
        campaignId: campaign.id,
        recipientId: r.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (emails.length === 0) return;

  const results = await sendBatch(emails);

  for (let i = 0; i < results.length; i++) {
    const result = results[i]!;
    const { recipientId, userId } = recipientMap[i]!;
    try {
      if (result.ok) {
        await prisma.campaignRecipient.update({
          where: { id: recipientId },
          data: {
            resendEmailId: result.id,
            status: "SENT",
            sentAt: new Date(),
            lockedBy: null,
            lockedAt: null,
          },
        });
        await prisma.user.update({
          where: { id: userId },
          data: { lastEmailSentAt: new Date() },
        });
      } else {
        const current = await prisma.campaignRecipient.findUnique({
          where: { id: recipientId },
          select: { retryCount: true },
        });
        const retryCount = (current?.retryCount ?? 0) + 1;
        await prisma.campaignRecipient.update({
          where: { id: recipientId },
          data: {
            status: retryCount >= 3 ? "FAILED" : "PENDING",
            ...(retryCount >= 3 ? { failedAt: new Date() } : {}),
            retryCount,
            lockedBy: null,
            lockedAt: null,
          },
        });
      }
    } catch (err) {
      log.error("failed to update recipient after send", {
        recipientId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await sleep(INTER_BATCH_DELAY_MS);
}

export async function abTestEvaluator(): Promise<void> {
  const campaigns = await prisma.campaign.findMany({
    where: { status: "AB_TESTING", isAbTest: true },
    include: { variants: true },
  });

  for (const campaign of campaigns) {
    try {
      const config = campaign.abTestConfig as {
        waitHours?: number;
        winnerCriteria?: string;
        autoSend?: boolean;
      } | null;
      if (!config?.waitHours) continue;

      const waitUntil = new Date(campaign.updatedAt.getTime() + config.waitHours * 3600_000);
      if (new Date() < waitUntil) continue;

      const variantStats = await Promise.all(
        campaign.variants.map(async (v) => {
          const [total, opened, clicked] = await Promise.all([
            prisma.campaignRecipient.count({ where: { campaignId: campaign.id, variantId: v.id } }),
            prisma.campaignRecipient.count({ where: { campaignId: campaign.id, variantId: v.id, status: { in: ["OPENED", "CLICKED"] } } }),
            prisma.campaignRecipient.count({ where: { campaignId: campaign.id, variantId: v.id, status: "CLICKED" } }),
          ]);
          return { variantId: v.id, total, openRate: total > 0 ? opened / total : 0, clickRate: total > 0 ? clicked / total : 0 };
        }),
      );

      const metric = config.winnerCriteria === "CLICK_RATE" ? "clickRate" : "openRate";
      variantStats.sort((a, b) => b[metric] - a[metric]);
      const winnerId = variantStats[0]?.variantId;

      for (const vs of variantStats) {
        await prisma.campaignVariant.update({
          where: { id: vs.variantId },
          data: { status: vs.variantId === winnerId ? "WINNER" : "LOSER" },
        });
      }

      if (config.autoSend && winnerId) {
        await prisma.campaignRecipient.updateMany({
          where: { campaignId: campaign.id, variantId: null, status: "PENDING" },
          data: { variantId: winnerId },
        });
        await campaignService._transition(campaign.id, "AB_TESTING", "SENDING", "ab_test_winner_send", {}, SYSTEM_CTX);
        log.info("A/B test winner auto-send", { campaignId: campaign.id, winnerId });
      } else {
        await campaignService._transition(campaign.id, "AB_TESTING", "COMPLETED", "ab_test_winner_complete", {}, SYSTEM_CTX);
        log.info("A/B test completed", { campaignId: campaign.id, winnerId });
      }
    } catch (err) {
      log.error("A/B test evaluation failed", {
        campaignId: campaign.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export async function softBounceRetry(): Promise<void> {
  const result = await prisma.campaignRecipient.updateMany({
    where: { status: "SOFT_BOUNCED", retryCount: { lt: 3 }, nextRetryAt: { lte: new Date() } },
    data: { status: "PENDING", lockedBy: null, lockedAt: null },
  });
  if (result.count > 0) log.info("soft bounce retry reset", { count: result.count });
}

export async function leaseRecover(): Promise<void> {
  const fiveMinAgo = new Date(Date.now() - 5 * 60_000);
  const result = await prisma.campaignRecipient.updateMany({
    where: { lockedAt: { lt: fiveMinAgo }, lockedBy: { not: null }, status: { in: ["PENDING", "SENDING"] } },
    data: { lockedBy: null, lockedAt: null, status: "PENDING" },
  });
  if (result.count > 0) log.info("lease recovered", { count: result.count });
}

export async function campaignCompleter(): Promise<void> {
  const sendingCampaigns = await prisma.campaign.findMany({
    where: { status: "SENDING" },
    select: { id: true },
  });
  for (const c of sendingCampaigns) {
    const pending = await prisma.campaignRecipient.count({
      where: { campaignId: c.id, status: { in: ["PENDING", "SENDING"] } },
    });
    if (pending === 0) {
      try {
        await campaignService._transition(c.id, "SENDING", "COMPLETED", "complete", {}, SYSTEM_CTX);
        log.info("campaign completed", { campaignId: c.id });
      } catch (err) {
        log.error("campaign complete failed", { campaignId: c.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
}

// ── Phase 7 Jobs ──

export async function automationRunProcessor(): Promise<void> {
  const runs = await prisma.automationRun.findMany({
    where: { status: "SCHEDULED", scheduledAt: { lte: new Date() } },
    include: {
      automation: { include: { template: true, topic: true } },
      user: { select: { id: true, email: true, name: true, unsubscribed: true, totalBounceCount: true, unsubscribeToken: true } },
    },
    take: 50,
  });

  for (const run of runs) {
    try {
      if (run.user.totalBounceCount >= 3) {
        await prisma.automationRun.update({ where: { id: run.id }, data: { status: "SKIPPED", failureReason: "user_ineligible" } });
        continue;
      }
      const deliverability = await evaluateDeliverability(run.user.id, {
        topicId: run.automation.topicId ?? null,
      });
      if (!deliverability.allowed) {
        await prisma.automationRun.update({
          where: { id: run.id },
          data: { status: "SKIPPED", failureReason: deliverability.reason ?? "ineligible" },
        });
        continue;
      }
      if (await isSuppressed(run.user.email)) {
        await prisma.automationRun.update({ where: { id: run.id }, data: { status: "SKIPPED", failureReason: "suppressed" } });
        continue;
      }
      if (await isOverLimit(run.user.id)) {
        await prisma.automationRun.update({ where: { id: run.id }, data: { status: "SKIPPED", failureReason: "frequency_limit" } });
        continue;
      }

      const e = env();
      const unsubscribeUrl = `${e.APP_URL}/api/unsubscribe?token=${run.user.unsubscribeToken}`;
      const unsubscribeTopicUrl = run.automation.topic
        ? `${e.APP_URL}/api/unsubscribe?token=${run.user.unsubscribeToken}&topic=${encodeURIComponent(run.automation.topic.slug)}`
        : "";
      const builtin = {
        unsubscribeUrl,
        unsubscribeTopicUrl,
        userEmail: run.user.email,
        userName: run.user.name ?? "",
        campaignName: run.automation.name,
      };
      // spec §25：严格只读发送快照。Automation.subjects 的覆盖已在 scheduleRun
      // 时烘焙进 templateSnapshot，这里不再回查 live automation.subjects。
      const rendered = renderSnapshotContent({
        snapshot: run.templateSnapshot as unknown as TemplateSnapshot,
        resolvedLocale: run.resolvedLocale,
        builtin,
      });

      const result = await sendSingle({
        from: e.EMAIL_FROM ?? "",
        to: run.user.email,
        subject: rendered.subject,
        html: rendered.html,
        ...(rendered.text ? { text: rendered.text } : {}),
        headers: { "List-Unsubscribe": `<${unsubscribeTopicUrl || unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
        tags: [{ name: "automation_id", value: run.automationId }],
      });

      if (result.ok) {
        await prisma.automationRun.update({ where: { id: run.id }, data: { status: "SENT", sentAt: new Date(), resendEmailId: result.id } });
      } else {
        await prisma.automationRun.update({ where: { id: run.id }, data: { status: "FAILED", failureReason: result.error } });
      }
    } catch (err) {
      log.error("automation run failed", { runId: run.id, error: err instanceof Error ? err.message : String(err) });
      await prisma.automationRun.update({ where: { id: run.id }, data: { status: "FAILED", failureReason: err instanceof Error ? err.message : "unknown" } }).catch(() => { });
    }
  }
}

export async function birthdayChecker(): Promise<void> {
  const { automationService: svc, SCHEDULE_RUN_INCLUDE } = await import(
    "@/lib/modules/automation/service"
  );
  const automations = await prisma.automation.findMany({
    where: { status: "ENABLED", triggerType: "BIRTHDAY" },
    include: SCHEDULE_RUN_INCLUDE,
  });
  if (automations.length === 0) return;

  const today = new Date();
  const month = today.getMonth() + 1;
  const day = today.getDate();

  const users = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM users
    WHERE birth_date IS NOT NULL
      AND EXTRACT(MONTH FROM birth_date) = ${month}
      AND EXTRACT(DAY FROM birth_date) = ${day}
      AND unsubscribed = false
      AND total_bounce_count < 3
  `;

  for (const auto of automations) {
    for (const user of users) {
      try { await svc.scheduleRun(auto, user.id, auto.delayMinutes); } catch (err) {
        log.error("birthday schedule failed", { automationId: auto.id, userId: user.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  log.info("birthday check done", { automationCount: automations.length, userCount: users.length });
}

export async function reEngagementChecker(): Promise<void> {
  const { automationService: svc, SCHEDULE_RUN_INCLUDE } = await import(
    "@/lib/modules/automation/service"
  );
  const automations = await prisma.automation.findMany({
    where: { status: "ENABLED", triggerType: "REENGAGEMENT" },
    include: SCHEDULE_RUN_INCLUDE,
  });

  for (const auto of automations) {
    try {
      const config = auto.triggerConfig as { inactiveDays?: number } | null;
      const since = new Date(Date.now() - (config?.inactiveDays ?? 90) * 24 * 3600_000);
      const users = await prisma.user.findMany({
        where: {
          unsubscribed: false, totalBounceCount: { lt: 3 },
          OR: [{ lastEmailOpenedAt: { lt: since } }, { lastEmailOpenedAt: null, lastEmailSentAt: { lt: since } }],
        },
        select: { id: true },
        take: 500,
      });
      for (const user of users) await svc.scheduleRun(auto, user.id, auto.delayMinutes);
      log.info("re-engagement check done", { automationId: auto.id, userCount: users.length });
    } catch (err) {
      log.error("re-engagement check failed", { automationId: auto.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

export async function campaignStatsAggregator(): Promise<void> {
  const campaigns = await prisma.campaign.findMany({
    where: { status: { in: ["SENDING", "AB_TESTING", "COMPLETED"] } },
    select: { id: true },
  });
  for (const c of campaigns) {
    try {
      const stats = await prisma.campaignRecipient.groupBy({ by: ["status"], where: { campaignId: c.id }, _count: true });
      const counts: Record<string, number> = {};
      for (const s of stats) counts[s.status] = s._count;

      await prisma.campaign.update({
        where: { id: c.id },
        data: {
          sentCount: (counts["SENT"] ?? 0) + (counts["DELIVERED"] ?? 0) + (counts["OPENED"] ?? 0) + (counts["CLICKED"] ?? 0),
          deliveredCount: (counts["DELIVERED"] ?? 0) + (counts["OPENED"] ?? 0) + (counts["CLICKED"] ?? 0),
          openCount: (counts["OPENED"] ?? 0) + (counts["CLICKED"] ?? 0),
          clickCount: counts["CLICKED"] ?? 0,
          bouncedCount: (counts["BOUNCED"] ?? 0) + (counts["SOFT_BOUNCED"] ?? 0),
          complainCount: counts["COMPLAINED"] ?? 0,
          unsubscribeCount: counts["UNSUBSCRIBED"] ?? 0,
          failedCount: counts["FAILED"] ?? 0,
        },
      });
    } catch (err) {
      log.error("campaign stats aggregation failed", { campaignId: c.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

export async function domainStatAggregator(): Promise<void> {
  const results = await prisma.$queryRaw<
    Array<{ domain: string; total_sent: bigint; total_delivered: bigint; total_bounced: bigint; total_complained: bigint }>
  >`
    SELECT
      SPLIT_PART(u.email, '@', 2) AS domain,
      COUNT(*) FILTER (WHERE cr.status IN ('SENT','DELIVERED','OPENED','CLICKED')) AS total_sent,
      COUNT(*) FILTER (WHERE cr.status IN ('DELIVERED','OPENED','CLICKED')) AS total_delivered,
      COUNT(*) FILTER (WHERE cr.status IN ('BOUNCED','SOFT_BOUNCED')) AS total_bounced,
      COUNT(*) FILTER (WHERE cr.status = 'COMPLAINED') AS total_complained
    FROM campaign_recipients cr
    JOIN users u ON u.id = cr.user_id
    WHERE cr.status NOT IN ('PENDING','SENDING')
    GROUP BY SPLIT_PART(u.email, '@', 2)
    HAVING COUNT(*) > 0
  `;
  for (const r of results) {
    const totalSent = Number(r.total_sent);
    const bounceRate = totalSent > 0 ? Number(r.total_bounced) / totalSent : 0;
    const complaintRate = totalSent > 0 ? Number(r.total_complained) / totalSent : 0;
    await prisma.domainStat.upsert({
      where: { domain: r.domain },
      update: { totalSent, totalDelivered: Number(r.total_delivered), totalBounced: Number(r.total_bounced), totalComplained: Number(r.total_complained), bounceRate, complaintRate, lastCalculatedAt: new Date() },
      create: { domain: r.domain, totalSent, totalDelivered: Number(r.total_delivered), totalBounced: Number(r.total_bounced), totalComplained: Number(r.total_complained), bounceRate, complaintRate, lastCalculatedAt: new Date() },
    });
  }
  log.info("domain stats aggregated", { domains: results.length });
}

export async function deliverabilityAlertChecker(): Promise<void> {
  const BOUNCE_THRESHOLD = 0.05;
  const COMPLAINT_THRESHOLD = 0.001;

  const sendingCampaigns = await prisma.campaign.findMany({
    where: { status: "SENDING" },
    select: { id: true, sentCount: true, bouncedCount: true, complainCount: true },
  });

  for (const c of sendingCampaigns) {
    if (c.sentCount < 100) continue;
    const bounceRate = c.bouncedCount / c.sentCount;
    const complaintRate = c.complainCount / c.sentCount;

    if (bounceRate > BOUNCE_THRESHOLD) {
      const existing = await prisma.deliverabilityAlert.findFirst({ where: { campaignId: c.id, type: "HIGH_BOUNCE_RATE", resolved: false } });
      if (!existing) {
        await prisma.deliverabilityAlert.create({ data: { type: "HIGH_BOUNCE_RATE", campaignId: c.id, threshold: BOUNCE_THRESHOLD, actualValue: bounceRate, action: "auto_paused" } });
        try { await campaignService._transition(c.id, "SENDING", "PAUSED", "pause", {}, SYSTEM_CTX); } catch { /* may already be paused */ }
        log.warn("campaign auto-paused (bounce rate)", { campaignId: c.id, bounceRate });
      }
    }
    if (complaintRate > COMPLAINT_THRESHOLD) {
      const existing = await prisma.deliverabilityAlert.findFirst({ where: { campaignId: c.id, type: "HIGH_COMPLAINT_RATE", resolved: false } });
      if (!existing) {
        await prisma.deliverabilityAlert.create({ data: { type: "HIGH_COMPLAINT_RATE", campaignId: c.id, threshold: COMPLAINT_THRESHOLD, actualValue: complaintRate, action: "auto_paused" } });
        try { await campaignService._transition(c.id, "SENDING", "PAUSED", "pause", {}, SYSTEM_CTX); } catch { /* may already be paused */ }
        log.warn("campaign auto-paused (complaint rate)", { campaignId: c.id, complaintRate });
      }
    }
  }
}

export async function sendTimePreferenceCalculator(): Promise<void> {
  const rows = await prisma.$queryRaw<Array<{ user_id: string; best_hour: number }>>`
    SELECT DISTINCT ON (cr.user_id)
      cr.user_id,
      EXTRACT(HOUR FROM ee.processed_at)::int AS best_hour
    FROM email_events ee
    JOIN campaign_recipients cr ON cr.id = ee.campaign_recipient_id
    WHERE ee.type IN ('opened', 'clicked')
      AND ee.processed_at > NOW() - INTERVAL '90 days'
    GROUP BY cr.user_id, EXTRACT(HOUR FROM ee.processed_at)
    ORDER BY cr.user_id, COUNT(*) DESC
  `;
  for (const r of rows) {
    await prisma.sendTimePreference.upsert({
      where: { userId: r.user_id },
      update: { bestSendHour: r.best_hour },
      create: { userId: r.user_id, bestSendHour: r.best_hour },
    });
  }
  log.info("send time preferences calculated", { users: rows.length });
}
