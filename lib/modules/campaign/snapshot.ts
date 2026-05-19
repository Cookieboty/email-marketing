import type { Prisma } from "@prisma/client";
import { env } from "@/lib/env";
import { ValidationError } from "@/lib/errors";
import { compileSegmentCondition } from "@/lib/modules/segment/compiler";
import { isSuppressed } from "@/lib/modules/suppression/check";
import { isOverLimit } from "@/lib/modules/frequency/check";
import type { PrismaTx } from "../user/repository";

interface CampaignForSnapshot {
  id: string;
  tagFilter: string[];
  tagFilterMode: string | null;
  segmentId: string | null;
  subscriptionCategory: string | null;
  topicId: string | null;
  isAbTest: boolean;
  segment: { id: string; conditions: Prisma.JsonValue } | null;
  variants: Array<{ id: string; samplePercentage: number }>;
}

interface EligibleUser {
  id: string;
  email: string;
  variantId?: string | null;
}

function fisherYatesShuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

export async function snapshotRecipients(
  campaign: CampaignForSnapshot,
  tx: PrismaTx,
): Promise<{ totalRecipients: number }> {
  const where: Prisma.UserWhereInput = {
    unsubscribed: false,
    totalBounceCount: { lt: 3 },
  };

  if (env().DOUBLE_OPT_IN_ENABLED) {
    where.optInStatus = { in: ["CONFIRMED", "NOT_REQUIRED"] };
  }

  const andClauses: Prisma.UserWhereInput[] = [];

  if (campaign.tagFilter.length > 0) {
    if (campaign.tagFilterMode === "ALL") {
      for (const tagName of campaign.tagFilter) {
        andClauses.push({ userTags: { some: { tag: { name: tagName } } } });
      }
    } else {
      andClauses.push({
        userTags: { some: { tag: { name: { in: campaign.tagFilter } } } },
      });
    }
  }

  if (campaign.segment) {
    const segmentWhere = compileSegmentCondition(
      campaign.segment.conditions as Parameters<typeof compileSegmentCondition>[0],
    );
    if (Object.keys(segmentWhere).length > 0) {
      andClauses.push(segmentWhere);
    }
  }

  if (campaign.subscriptionCategory) {
    const category = await tx.subscriptionCategory.findUnique({
      where: { slug: campaign.subscriptionCategory },
      select: { id: true, isDefault: true },
    });
    if (category) {
      andClauses.push({
        OR: [
          { subscriptions: { some: { categoryId: category.id, subscribed: true } } },
          ...(category.isDefault
            ? [{ subscriptions: { none: { categoryId: category.id } } }]
            : []),
        ],
      });
    }
  }

  // 主题级粗筛：排除已退订该主题的用户（spec/unsubscribe-topic-level.md）
  if (campaign.topicId) {
    andClauses.push({
      topicUnsubscribes: { none: { topicId: campaign.topicId } },
    });
  }

  if (andClauses.length > 0) {
    where.AND = andClauses;
  }

  const users = await tx.user.findMany({
    where,
    select: { id: true, email: true },
  });

  const filtered: EligibleUser[] = [];
  const BATCH_SIZE = 500;
  for (let i = 0; i < users.length; i += BATCH_SIZE) {
    const batch = users.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (u) => {
        if (await isSuppressed(u.email)) return null;
        if (await isOverLimit(u.id)) return null;
        return u;
      }),
    );
    for (const r of results) {
      if (r) filtered.push({ id: r.id, email: r.email, variantId: null });
    }
  }

  if (filtered.length === 0) {
    throw new ValidationError("No eligible recipients found for this campaign");
  }

  if (campaign.isAbTest && campaign.variants.length > 0) {
    fisherYatesShuffle(filtered);
    let offset = 0;
    for (const variant of campaign.variants) {
      const count = Math.floor((variant.samplePercentage / 100) * filtered.length);
      for (let i = offset; i < offset + count && i < filtered.length; i++) {
        filtered[i]!.variantId = variant.id;
      }
      offset += count;
    }
  }

  const INSERT_BATCH = 1000;
  for (let i = 0; i < filtered.length; i += INSERT_BATCH) {
    const batch = filtered.slice(i, i + INSERT_BATCH);
    await tx.campaignRecipient.createMany({
      data: batch.map((u) => ({
        campaignId: campaign.id,
        userId: u.id,
        variantId: u.variantId ?? null,
        status: "PENDING" as const,
      })),
      skipDuplicates: true,
    });
  }

  await tx.campaign.update({
    where: { id: campaign.id },
    data: { totalRecipients: filtered.length },
  });

  return { totalRecipients: filtered.length };
}
