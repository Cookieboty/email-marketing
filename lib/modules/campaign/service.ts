/**
 * Campaign 业务服务。
 *
 * 职责边界：
 *  - CRUD：创建/读取/更新/删除（受状态约束）。
 *  - 生命周期：schedule / send / pause / resume / cancel / retry，全部走状态机
 *    + 乐观锁（updateMany + where status=expected）。
 *  - 不在此层执行：收件人快照、变体复制、worker 触发——这些放到 6.2/6.5/6.7。
 *    但 transitionStatus 留出 extra 字段，便于后续扩展时间戳/失败原因。
 *
 * 隐式规则：
 *  - update：仅 DRAFT/SCHEDULED 允许；其他状态返回 ValidationError。
 *  - delete：仅 DRAFT 允许（已 SCHEDULED 应先 cancel）。
 *  - schedule：DRAFT → SCHEDULED；同时设置 scheduledAt。
 *  - send：DRAFT/SCHEDULED → SENDING（A/B → AB_TESTING）。无 scheduledAt 时立即发送，
 *    有 scheduledAt 时实际等价于 schedule（保持兼容）。
 *  - cancel：所有非终态。
 *  - retry：仅 FAILED → SENDING。
 */

import { Prisma, type Campaign, type CampaignStatus, type Locale } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { isValidFromHeader } from "@/lib/email-utils";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { templateService, freezeBlocksForSnapshot } from "@/lib/modules/template/service";
import { buildTemplateSnapshot } from "@/lib/modules/template/snapshot";
import { compileSegmentCondition } from "@/lib/modules/segment/compiler";
import {
  computeLocaleCoverage,
  type LocaleCoverageResult,
} from "./locale-coverage";
import { campaignRepository, type ListCampaignsResult } from "./repository";
import { snapshotRecipients } from "./snapshot";
import {
  assertTransition,
  isTerminal,
  type CampaignTransitionReason,
} from "./state-machine";
import {
  type CreateCampaignInput,
  type ListCampaignsQuery,
  type ScheduleCampaignInput,
  type SendCampaignInput,
  type UpdateCampaignInput,
} from "./schema";

interface ActorContext {
  actorType: "ADMIN" | "SYSTEM" | "WEBHOOK";
  req?: { headers: Headers } | null;
}

/** FAILED 状态下仅允许修正这些与发送相关的字段（不影响已生成的收件人快照）。 */
const FAILED_EDITABLE_FIELDS = new Set<string>([
  "fromEmail",
  "replyTo",
  "sendingChannelId",
]);

interface ChannelFromShape {
  fromEmail: string | null;
  fromName: string | null;
  smtpConfig?: { fromEmail: string; fromName: string | null } | null;
}

/**
 * 解析发送渠道的 From 头：优先渠道级 fromEmail/fromName，其次回退到 SMTP 配置级
 * （Resend 配置没有 from 字段，必须在渠道级配置）。无可用地址时返回 null。
 */
function resolveChannelFromHeader(channel: ChannelFromShape): string | null {
  const email = channel.fromEmail ?? channel.smtpConfig?.fromEmail ?? null;
  if (!email) return null;
  const name = channel.fromName ?? channel.smtpConfig?.fromName ?? null;
  return name ? `${name} <${email}>` : email;
}

/**
 * 解析活动最终使用的发件人，顺序：
 *  1. 显式传入的 fromEmail（运营在表单填写）；
 *  2. 所选发送渠道的发件人（渠道级 → SMTP 配置级）；
 *  3. EMAIL_FROM 环境变量兜底。
 * 这样"留空发件人"时会使用当前渠道的发件人，而不是环境变量的占位地址。
 */
async function resolveCampaignFromEmail(
  explicit: string | undefined,
  sendingChannelId: string | null,
): Promise<string | undefined> {
  const trimmed = explicit?.trim();
  if (trimmed) return trimmed;
  if (sendingChannelId) {
    const channel = await prisma.sendingChannel.findUnique({
      where: { id: sendingChannelId },
      include: { smtpConfig: true },
    });
    if (channel) {
      const resolved = resolveChannelFromHeader(channel);
      if (resolved) return resolved;
    }
  }
  return env().EMAIL_FROM ?? undefined;
}

/**
 * 规整 Campaign.subjects 覆盖 JSON。语义：
 *  - 输入对象**整体替换**已有 subjects（非按 locale 合并）；UI 表单始终带全部 locale
 *    字段，PATCH 含义即"当前可见状态"，所以替换是契合 UI 的最简语义。
 *  - 空字符串视为未覆盖（spec §492），trim 后去掉该 key。
 *  - 全部 key 都被剔除时写 SQL NULL（清除所有 override）。
 *  - 模板未配置的 locale 直接拒绝（spec §491）。
 */
function cleanSubjectOverrides(
  subjects: Partial<Record<Locale, string>> | undefined,
  availableLocales: Set<Locale>,
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (!subjects) return Prisma.DbNull;
  const out: Partial<Record<Locale, string>> = {};
  for (const [locale, value] of Object.entries(subjects) as Array<[Locale, string]>) {
    if (!availableLocales.has(locale)) {
      throw new ValidationError(`Subject override locale ${locale} is not available`);
    }
    const trimmed = value.trim();
    if (trimmed) out[locale] = trimmed;
  }
  return Object.keys(out).length > 0 ? out : Prisma.DbNull;
}

interface VariantLocaleShape {
  subjects: Partial<Record<Locale, string>>;
  htmlContents: Partial<Record<Locale, string>>;
}

/**
 * spec §237-§239：variant 可用 locale 必须是模板 locale 的子集，且必须包含模板的
 * defaultLocale，否则收件人 resolvedLocale 为该 defaultLocale 时会绕过 variant
 * 直接 fall back 主模板，导致 variant 实际无人接收。
 */
function assertVariantLocales(
  variantName: string,
  variant: VariantLocaleShape,
  availableLocales: Set<Locale>,
  defaultLocale: Locale,
): void {
  const presentLocales = new Set(
    (Object.keys(variant.htmlContents) as Locale[]).filter(
      (k) => variant.htmlContents[k] !== undefined,
    ),
  );
  if (presentLocales.size === 0) {
    throw new ValidationError(
      `Variant ${variantName} must declare at least one locale`,
    );
  }
  for (const locale of presentLocales) {
    if (!availableLocales.has(locale)) {
      throw new ValidationError(
        `Variant ${variantName} locale ${locale} is not present in template`,
      );
    }
  }
  if (!presentLocales.has(defaultLocale)) {
    throw new ValidationError(
      `Variant ${variantName} must include template default locale ${defaultLocale}`,
    );
  }
}

export const campaignService = {
  list(query: ListCampaignsQuery): Promise<ListCampaignsResult> {
    return campaignRepository.list(query);
  },

  async getById(id: string) {
    const c = await campaignRepository.findById(id);
    if (!c) throw new NotFoundError("Campaign not found");
    return c;
  },

  async create(input: CreateCampaignInput, ctx: ActorContext): Promise<Campaign> {
    const tpl = await templateService.getById(input.templateId);
    templateService.assertUsableForNewCampaign(tpl);
    const availableLocales = new Set(tpl.locales.map((locale) => locale.locale));
    if (
      input.localeStrategy === "FORCE" &&
      (!input.forcedLocale || !availableLocales.has(input.forcedLocale))
    ) {
      throw new ValidationError("forcedLocale content is missing from template");
    }

    const fromEmail = await resolveCampaignFromEmail(
      input.fromEmail,
      input.sendingChannelId ?? null,
    );
    if (!fromEmail) {
      throw new ValidationError(
        "fromEmail is required: provide it explicitly, configure the sending channel's fromEmail, or set EMAIL_FROM env",
      );
    }
    if (!isValidFromHeader(fromEmail)) {
      throw new ValidationError(
        "Resolved fromEmail is not a valid email/header",
      );
    }

    if (input.isAbTest && input.variants?.length) {
      const totalSample = input.variants.reduce((s, v) => s + v.samplePercentage, 0);
      if (totalSample > 50) {
        throw new ValidationError("Sum of variant samplePercentage must be <= 50");
      }
      for (const variant of input.variants) {
        assertVariantLocales(
          variant.variantName,
          variant,
          availableLocales,
          tpl.defaultLocale as Locale,
        );
      }
    }

    const blocksPerLocale = await freezeBlocksForSnapshot(tpl);

    const data: Prisma.CampaignUncheckedCreateInput = {
      name: input.name,
      subjects: cleanSubjectOverrides(input.subjects, availableLocales),
      localeStrategy: input.localeStrategy,
      forcedLocale: input.forcedLocale ?? null,
      fromEmail,
      replyTo: input.replyTo ?? null,
      sendingChannelId: input.sendingChannelId ?? null,
      templateId: tpl.id,
      templateSnapshot: buildTemplateSnapshot(tpl, blocksPerLocale) as unknown as Prisma.InputJsonValue,
      segmentId: input.segmentId ?? null,
      tagFilter: input.tagFilter ?? [],
      tagFilterMode: input.tagFilterMode ?? "ANY",
      subscriptionCategory: input.subscriptionCategory ?? null,
      isAbTest: input.isAbTest ?? false,
      abTestConfig: input.abTestConfig ? (input.abTestConfig as Prisma.InputJsonValue) : Prisma.DbNull,
      utmParams: input.utmParams ? (input.utmParams as Prisma.InputJsonValue) : Prisma.DbNull,
      status: "DRAFT",
    };

    const created = await prisma.$transaction(async (tx) => {
      const campaign = await campaignRepository.create(data, tx);
      if (input.isAbTest && input.variants?.length) {
        await tx.campaignVariant.createMany({
          data: input.variants.map((v) => ({
            campaignId: campaign.id,
            variantName: v.variantName,
            subjects: v.subjects as Prisma.InputJsonValue,
            htmlContents: v.htmlContents as Prisma.InputJsonValue,
            textContents: v.textContents ? (v.textContents as Prisma.InputJsonValue) : Prisma.DbNull,
            samplePercentage: v.samplePercentage,
            status: "PENDING",
          })),
        });
      }
      return campaign;
    });

    audit({
      action: "campaign.create",
      entityType: "Campaign",
      entityId: created.id,
      actorType: ctx.actorType,
      details: { name: created.name, templateId: tpl.id, isAbTest: created.isAbTest },
      req: ctx.req ?? null,
    });
    return created;
  },

  async update(
    id: string,
    input: UpdateCampaignInput,
    ctx: ActorContext,
  ): Promise<Campaign> {
    const existing = await campaignRepository.findById(id);
    if (!existing) throw new NotFoundError("Campaign not found");
    if (existing.status !== "DRAFT" && existing.status !== "SCHEDULED") {
      if (existing.status === "FAILED") {
        // 发送失败后，允许在重试前修正发送相关设置（发件人/回复地址/发送渠道）。
        // 这些字段不影响已生成的收件人快照，可安全修改。
        const illegal = Object.keys(input).filter(
          (k) => !FAILED_EDITABLE_FIELDS.has(k),
        );
        if (illegal.length > 0) {
          throw new ValidationError(
            `Campaign in FAILED status only allows editing ${[...FAILED_EDITABLE_FIELDS].join(", ")} (got: ${illegal.join(", ")})`,
          );
        }
      } else {
        throw new ValidationError(
          `Campaign cannot be edited in status ${existing.status}`,
        );
      }
    }
    const tpl = await templateService.getById(existing.templateId);
    const availableLocales = new Set(tpl.locales.map((locale) => locale.locale));
    const nextLocaleStrategy = input.localeStrategy ?? existing.localeStrategy;
    const nextForcedLocale =
      input.forcedLocale === undefined ? existing.forcedLocale : input.forcedLocale;
    if (
      nextLocaleStrategy === "FORCE" &&
      (!nextForcedLocale || !availableLocales.has(nextForcedLocale))
    ) {
      throw new ValidationError("forcedLocale content is missing from template");
    }

    const data: Prisma.CampaignUncheckedUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.subjects !== undefined) {
      data.subjects = cleanSubjectOverrides(input.subjects, availableLocales);
    }
    if (input.localeStrategy !== undefined) data.localeStrategy = input.localeStrategy;
    if (input.forcedLocale !== undefined) data.forcedLocale = input.forcedLocale ?? null;
    if (input.fromEmail !== undefined) data.fromEmail = input.fromEmail;
    if (input.replyTo !== undefined) data.replyTo = input.replyTo ?? null;
    if (input.sendingChannelId !== undefined) data.sendingChannelId = input.sendingChannelId ?? null;
    if (input.tagFilter !== undefined) data.tagFilter = input.tagFilter;
    if (input.tagFilterMode !== undefined) data.tagFilterMode = input.tagFilterMode;
    if (input.segmentId !== undefined) data.segmentId = input.segmentId ?? null;
    if (input.subscriptionCategory !== undefined) {
      data.subscriptionCategory = input.subscriptionCategory ?? null;
    }
    if (input.utmParams !== undefined) {
      data.utmParams = input.utmParams ? (input.utmParams as Prisma.InputJsonValue) : Prisma.DbNull;
    }

    // 切换发送渠道但未显式填写发件人时，按新渠道的默认发件人重新解析，
    // 与创建活动时"留空使用通道默认"语义保持一致。
    if (input.sendingChannelId !== undefined && input.fromEmail === undefined) {
      const resolved = await resolveCampaignFromEmail(
        undefined,
        input.sendingChannelId ?? null,
      );
      if (resolved && isValidFromHeader(resolved)) {
        data.fromEmail = resolved;
      }
    }

    const updated = await campaignRepository.update(id, data);
    audit({
      action: "campaign.update",
      entityType: "Campaign",
      entityId: id,
      actorType: ctx.actorType,
      details: { fields: Object.keys(input) },
      req: ctx.req ?? null,
    });
    return updated;
  },

  async delete(id: string, ctx: ActorContext): Promise<void> {
    const existing = await campaignRepository.findById(id);
    if (!existing) throw new NotFoundError("Campaign not found");
    if (existing.status !== "DRAFT") {
      throw new ValidationError(
        `Only DRAFT campaigns can be deleted; current status is ${existing.status}`,
      );
    }
    await campaignRepository.delete(id);
    audit({
      action: "campaign.delete",
      entityType: "Campaign",
      entityId: id,
      actorType: ctx.actorType,
      details: { name: existing.name },
      req: ctx.req ?? null,
    });
  },

  /**
   * 通用状态切换：state-machine 校验 + 乐观锁 updateMany。
   * count===0 时说明并发改动，抛 409。
   */
  async _transition(
    id: string,
    expected: CampaignStatus,
    next: CampaignStatus,
    reason: CampaignTransitionReason,
    extra: Prisma.CampaignUpdateManyMutationInput = {},
    ctx: ActorContext,
  ): Promise<Campaign> {
    assertTransition(expected, next, reason);
    const count = await campaignRepository.transitionStatus(
      id,
      expected,
      next,
      extra,
    );
    if (count === 0) {
      throw new ConflictError(
        `Campaign status changed concurrently (expected ${expected})`,
      );
    }
    const fresh = await campaignRepository.findById(id);
    if (!fresh) throw new NotFoundError("Campaign not found after transition");
    // 防御：在 updateMany 与 findById 之间若被其他 transition 覆盖，
    // 状态会与本次写入的 next 不一致，应视为并发冲突。
    if (fresh.status !== next) {
      throw new ConflictError(
        `Campaign status raced after transition (expected ${next}, got ${fresh.status})`,
      );
    }
    audit({
      action: `campaign.${reason}`,
      entityType: "Campaign",
      entityId: id,
      actorType: ctx.actorType,
      details: { from: expected, to: next },
      req: ctx.req ?? null,
    });
    return fresh;
  },

  async schedule(
    id: string,
    input: ScheduleCampaignInput,
    ctx: ActorContext,
  ): Promise<Campaign> {
    const existing = await campaignRepository.findById(id);
    if (!existing) throw new NotFoundError("Campaign not found");
    if (existing.status !== "DRAFT") {
      throw new ValidationError(
        `Only DRAFT campaigns can be scheduled; current status is ${existing.status}`,
      );
    }
    return this._transition(
      id,
      "DRAFT",
      "SCHEDULED",
      "schedule",
      { scheduledAt: input.scheduledAt },
      ctx,
    );
  },

  async send(
    id: string,
    input: SendCampaignInput,
    ctx: ActorContext,
  ): Promise<Campaign> {
    const existing = await campaignRepository.findById(id);
    if (!existing) throw new NotFoundError("Campaign not found");

    if (!existing.sendingChannelId) {
      throw new ValidationError("sendingChannelId is required before sending");
    }

    // 带 scheduledAt 时按 schedule 处理（仅 DRAFT 适用，简化语义）
    if (input.scheduledAt) {
      if (existing.status !== "DRAFT") {
        throw new ValidationError(
          `Cannot schedule from status ${existing.status}`,
        );
      }
      return this._transition(
        id,
        "DRAFT",
        "SCHEDULED",
        "schedule",
        { scheduledAt: input.scheduledAt },
        ctx,
      );
    }

    if (existing.status !== "DRAFT" && existing.status !== "SCHEDULED") {
      throw new ValidationError(
        `Campaign cannot be sent from status ${existing.status}`,
      );
    }
    const next: CampaignStatus = existing.isAbTest ? "AB_TESTING" : "SENDING";
    const reason: CampaignTransitionReason = existing.isAbTest
      ? "ab_test_start"
      : "send";

    const campaign = await prisma.campaign.findUnique({
      where: { id },
      include: { segment: true, variants: true },
    });
    if (!campaign) throw new NotFoundError("Campaign not found");

    await prisma.$transaction(async (tx) => {
      await snapshotRecipients(campaign, tx);
      const count = await campaignRepository.transitionStatus(
        id,
        existing.status,
        next,
        {},
        tx,
      );
      if (count === 0) {
        throw new ConflictError(
          `Campaign status changed concurrently (expected ${existing.status})`,
        );
      }
    });

    const fresh = await campaignRepository.findById(id);
    if (!fresh) throw new NotFoundError("Campaign not found after transition");

    audit({
      action: `campaign.${reason}`,
      entityType: "Campaign",
      entityId: id,
      actorType: ctx.actorType,
      details: { from: existing.status, to: next },
      req: ctx.req ?? null,
    });
    return fresh;
  },

  async pause(id: string, ctx: ActorContext): Promise<Campaign> {
    return this._transition(id, "SENDING", "PAUSED", "pause", {}, ctx);
  },

  async resume(id: string, ctx: ActorContext): Promise<Campaign> {
    return this._transition(id, "PAUSED", "SENDING", "resume", {}, ctx);
  },

  async cancel(id: string, ctx: ActorContext): Promise<Campaign> {
    const existing = await campaignRepository.findById(id);
    if (!existing) throw new NotFoundError("Campaign not found");
    if (isTerminal(existing.status)) {
      throw new ValidationError(
        `Campaign already in terminal status ${existing.status}`,
      );
    }
    return this._transition(
      id,
      existing.status,
      "CANCELLED",
      "cancel",
      {},
      ctx,
    );
  },

  /**
   * 重试发送失败的活动：把失败 / 软退信的收件人重置为待发（清空重试计数与锁），
   * 并将活动从 FAILED 切回 SENDING，由 worker 重新认领发送。
   * 已成功（SENT/DELIVERED/OPENED/CLICKED）、硬退信、退订的收件人保持不变，
   * 避免重复投递。
   */
  async retry(id: string, ctx: ActorContext): Promise<Campaign> {
    const existing = await campaignRepository.findById(id);
    if (!existing) throw new NotFoundError("Campaign not found");
    if (existing.status !== "FAILED") {
      throw new ValidationError(
        `Only FAILED campaigns can be retried; current status is ${existing.status}`,
      );
    }
    assertTransition("FAILED", "SENDING", "retry");

    await prisma.$transaction(async (tx) => {
      await tx.campaignRecipient.updateMany({
        where: {
          campaignId: id,
          status: { in: ["FAILED", "SOFT_BOUNCED"] },
        },
        data: {
          status: "PENDING",
          retryCount: 0,
          lockedBy: null,
          lockedAt: null,
          failedAt: null,
          nextRetryAt: null,
        },
      });
      const count = await campaignRepository.transitionStatus(
        id,
        "FAILED",
        "SENDING",
        { failedCount: 0 },
        tx,
      );
      if (count === 0) {
        throw new ConflictError(
          "Campaign status changed concurrently (expected FAILED)",
        );
      }
    });

    const fresh = await campaignRepository.findById(id);
    if (!fresh) throw new NotFoundError("Campaign not found after retry");
    audit({
      action: "campaign.retry",
      entityType: "Campaign",
      entityId: id,
      actorType: ctx.actorType,
      details: { from: "FAILED", to: "SENDING" },
      req: ctx.req ?? null,
    });
    return fresh;
  },

  async getLocaleCoverage(id: string): Promise<LocaleCoverageResult> {
    const campaign = await prisma.campaign.findUnique({
      where: { id },
      include: { segment: true, variants: true },
    });
    if (!campaign) throw new NotFoundError("Campaign not found");

    const snapshot = campaign.templateSnapshot as unknown as {
      defaultLocale: Locale;
      locales: Partial<Record<Locale, unknown>>;
    };
    const availableLocales = Object.keys(snapshot.locales) as Locale[];
    const where: Prisma.UserWhereInput = {
      unsubscribed: false,
      totalBounceCount: { lt: 3 },
    };
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
      if (Object.keys(segmentWhere).length > 0) andClauses.push(segmentWhere);
    }
    if (campaign.subscriptionCategory) {
      // 与 snapshotRecipients 保持同一套 SQL 粗筛口径（spec §484-§489 "Pre-send
      // 检查 = 预估"）：把分类粗筛纳入估算，避免对带分类的活动严重高估。
      const category = await prisma.subscriptionCategory.findUnique({
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
    if (campaign.topicId) {
      andClauses.push({ topicUnsubscribes: { none: { topicId: campaign.topicId } } });
    }
    if (andClauses.length > 0) where.AND = andClauses;

    // 注意：本方法是发送前的"预估"，未包含 isSuppressed / isOverLimit 等单点动
    // 态因子（spec §484-§489），实际 snapshotRecipients 后的人数会略少于此值。
    const users = await prisma.user.findMany({ where, select: { locale: true } });
    return computeLocaleCoverage({
      localeStrategy: campaign.localeStrategy,
      forcedLocale: campaign.forcedLocale,
      defaultLocale: snapshot.defaultLocale,
      availableLocales,
      users,
      variants: campaign.variants.map((variant) => ({
        htmlLocales: Object.keys(
          (variant.htmlContents ?? {}) as Record<string, unknown>,
        ) as Locale[],
      })),
    });
  },
};

export type CampaignService = typeof campaignService;
