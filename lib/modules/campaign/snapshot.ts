import type { Locale, LocaleStrategy, Prisma } from "@prisma/client";
import { env } from "@/lib/env";
import { ValidationError } from "@/lib/errors";
import { compileSegmentCondition } from "@/lib/modules/segment/compiler";
import { isSuppressed } from "@/lib/modules/suppression/check";
import { frequencyRepository } from "@/lib/modules/frequency/repository";
import { resolveLocale } from "@/lib/modules/template/render";
import type { TemplateSnapshot } from "@/lib/modules/template/snapshot";
import type { PrismaTx } from "../user/repository";

interface CampaignForSnapshot {
  id: string;
  tagFilter: string[];
  tagFilterMode: string | null;
  segmentId: string | null;
  subscriptionCategory: string | null;
  topicId: string | null;
  isAbTest: boolean;
  localeStrategy: LocaleStrategy;
  forcedLocale: Locale | null;
  templateSnapshot: Prisma.JsonValue;
  segment: { id: string; conditions: Prisma.JsonValue } | null;
  variants: Array<{ id: string; samplePercentage: number }>;
}

interface EligibleUser {
  id: string;
  email: string;
  locale: Locale | null;
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
  // 幂等：若该活动已存在收件人快照（例如定时触发重试、并发重复进入），
  // 直接返回已有数量，避免重复插入与重复发送。
  const existingCount = await tx.campaignRecipient.count({
    where: { campaignId: campaign.id },
  });
  if (existingCount > 0) {
    return { totalRecipients: existingCount };
  }

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
    select: { id: true, email: true, locale: true },
  });

  // 频次上限：单条 active 配置取一次；窗口内计数按整批 groupBy 一次查询，
  // 替代逐用户 count，消除 N+1。无配置时跳过频次过滤。
  const cap = await frequencyRepository.findActive(tx);
  const freqSince = cap
    ? new Date(Date.now() - cap.periodDays * 24 * 60 * 60 * 1000)
    : null;

  const filtered: EligibleUser[] = [];
  const BATCH_SIZE = 500;
  for (let i = 0; i < users.length; i += BATCH_SIZE) {
    const batch = users.slice(i, i + BATCH_SIZE);

    const overLimitIds = new Set<string>();
    if (cap && freqSince) {
      const grouped = await tx.campaignRecipient.groupBy({
        by: ["userId"],
        where: { userId: { in: batch.map((u) => u.id) }, sentAt: { gte: freqSince } },
        _count: true,
      });
      for (const g of grouped) {
        if (g._count >= cap.maxEmails) overLimitIds.add(g.userId);
      }
    }

    const results = await Promise.all(
      batch.map(async (u) => {
        if (overLimitIds.has(u.id)) return null;
        if (await isSuppressed(u.email)) return null;
        return u;
      }),
    );
    for (const r of results) {
      if (r) filtered.push({ id: r.id, email: r.email, locale: r.locale, variantId: null });
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
  const snapshot = campaign.templateSnapshot as unknown as TemplateSnapshot;
  const availableLocales = Object.keys(snapshot.locales) as Locale[];
  for (let i = 0; i < filtered.length; i += INSERT_BATCH) {
    const batch = filtered.slice(i, i + INSERT_BATCH);
    await tx.campaignRecipient.createMany({
      data: batch.map((u) => ({
        campaignId: campaign.id,
        userId: u.id,
        variantId: u.variantId ?? null,
        resolvedLocale: resolveLocale({
          strategy: campaign.localeStrategy,
          forcedLocale: campaign.forcedLocale,
          userLocale: u.locale,
          defaultLocale: snapshot.defaultLocale,
          availableLocales,
        }),
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
