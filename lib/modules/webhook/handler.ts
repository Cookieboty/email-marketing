import type { RecipientStatus, BounceType, EmailEventType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { audit } from "@/lib/audit";
import { isSuppressed } from "@/lib/modules/suppression/check";
import { suppressionRepository } from "@/lib/modules/suppression/repository";

const log = logger.child("webhook");

const RECIPIENT_STATUS_ORDER: Record<RecipientStatus, number> = {
  PENDING: 0,
  SENDING: 1,
  SENT: 2,
  DELIVERED: 3,
  OPENED: 4,
  CLICKED: 5,
  BOUNCED: 10,
  SOFT_BOUNCED: 9,
  COMPLAINED: 11,
  UNSUBSCRIBED: 12,
  FAILED: 8,
};

const EVENT_TO_STATUS: Record<string, RecipientStatus> = {
  sent: "SENT",
  delivered: "DELIVERED",
  opened: "OPENED",
  clicked: "CLICKED",
  bounced: "BOUNCED",
  complained: "COMPLAINED",
  failed: "FAILED",
};

const EVENT_TIMESTAMP_FIELD: Record<string, TimestampField> = {
  sent: "sentAt",
  delivered: "deliveredAt",
  opened: "openedAt",
  clicked: "clickedAt",
  bounced: "bouncedAt",
  complained: "complainedAt",
  failed: "failedAt",
};

type TimestampField =
  | "sentAt"
  | "deliveredAt"
  | "openedAt"
  | "clickedAt"
  | "bouncedAt"
  | "complainedAt"
  | "failedAt";

function canAdvance(current: RecipientStatus, next: RecipientStatus): boolean {
  return RECIPIENT_STATUS_ORDER[next]! > RECIPIENT_STATUS_ORDER[current]!;
}

function getNewStatus(
  current: RecipientStatus,
  eventType: string,
  bounceType?: string | null,
): RecipientStatus | null {
  if (eventType === "bounced" && bounceType === "SOFT") {
    const next: RecipientStatus = "SOFT_BOUNCED";
    return canAdvance(current, next) ? next : null;
  }
  const next = EVENT_TO_STATUS[eventType];
  if (!next) return null;
  return canAdvance(current, next) ? next : null;
}

export interface WebhookEvent {
  type: string;
  data: {
    email_id?: string;
    created_at?: string;
    to?: string | string[];
    bounce_type?: string;
    [key: string]: unknown;
  };
}

export interface ProcessResult {
  processed: boolean;
  idempotencyKey: string;
  reason?: string;
}

export async function processWebhookEvent(event: WebhookEvent): Promise<ProcessResult> {
  const resendId = event.data.email_id;
  const eventType = event.type as EmailEventType;
  const idempotencyKey = `${resendId ?? "unknown"}-${eventType}`;

  if (!resendId) {
    return { processed: false, idempotencyKey, reason: "missing email_id" };
  }

  const existing = await prisma.emailEvent.findUnique({
    where: { idempotencyKey },
  });
  if (existing) {
    return { processed: false, idempotencyKey, reason: "duplicate" };
  }

  const recipient = await prisma.campaignRecipient.findUnique({
    where: { resendEmailId: resendId },
    include: { user: { select: { id: true, email: true, totalBounceCount: true, unsubscribed: true } } },
  });

  if (!recipient) {
    log.warn("webhook recipient not found", { resendId, eventType });
    return { processed: false, idempotencyKey, reason: "recipient_not_found" };
  }

  const bounceTypeValue = event.data.bounce_type?.toUpperCase() as BounceType | undefined;
  const newStatus = getNewStatus(recipient.status, event.type, bounceTypeValue);
  const tsField = EVENT_TIMESTAMP_FIELD[event.type];

  try {
    await prisma.$transaction(async (tx) => {
      await tx.emailEvent.create({
        data: {
          resendId,
          campaignRecipientId: recipient.id,
          campaignId: recipient.campaignId,
          type: eventType,
          bounceType: event.type === "bounced" ? (bounceTypeValue ?? "HARD") : null,
          payload: event.data as object,
          idempotencyKey,
        },
      });

      if (newStatus) {
        const updateData: Record<string, unknown> = { status: newStatus };
        if (tsField) updateData[tsField] = new Date(event.data.created_at ?? Date.now());
        if (event.type === "bounced") updateData.bounceType = bounceTypeValue ?? "HARD";
        await tx.campaignRecipient.update({
          where: { id: recipient.id },
          data: updateData,
        });
      }

      if (event.type === "complained" && !recipient.user.unsubscribed) {
        await tx.user.update({
          where: { id: recipient.user.id },
          data: { unsubscribed: true, unsubscribedAt: new Date() },
        });
        const alreadySuppressed = await isSuppressed(recipient.user.email);
        if (!alreadySuppressed) {
          await suppressionRepository.create(
            { type: "EMAIL", value: recipient.user.email, reason: "complaint", source: "webhook" },
            tx,
          );
        }
      }

      if (event.type === "bounced" && (!bounceTypeValue || bounceTypeValue === "HARD")) {
        const newCount = recipient.user.totalBounceCount + 1;
        await tx.user.update({
          where: { id: recipient.user.id },
          data: { totalBounceCount: newCount },
        });
        if (newCount >= 3) {
          const alreadySuppressed = await isSuppressed(recipient.user.email);
          if (!alreadySuppressed) {
            await suppressionRepository.create(
              { type: "EMAIL", value: recipient.user.email, reason: "hard_bounce_threshold", source: "webhook" },
              tx,
            );
          }
        }
      }
    });

    audit({
      action: "webhook.process",
      entityType: "CampaignRecipient",
      entityId: recipient.id,
      actorType: "WEBHOOK",
      details: { eventType, resendId, newStatus, campaignId: recipient.campaignId },
    });

    return { processed: true, idempotencyKey };
  } catch (err) {
    if (
      err instanceof Error &&
      err.message.includes("Unique constraint") &&
      err.message.includes("idempotencyKey")
    ) {
      return { processed: false, idempotencyKey, reason: "duplicate" };
    }
    throw err;
  }
}
