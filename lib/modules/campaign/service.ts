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

import { Prisma, type Campaign, type CampaignStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { isValidFromHeader } from "@/lib/email-utils";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { templateService } from "@/lib/modules/template/service";
import { campaignRepository, type ListCampaignsResult } from "./repository";
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

function buildTemplateSnapshot(tpl: {
  subject: string;
  htmlContent: string;
  textContent: string | null;
  version: number;
}): Prisma.JsonObject {
  return {
    subject: tpl.subject,
    htmlContent: tpl.htmlContent,
    textContent: tpl.textContent ?? null,
    version: tpl.version,
  };
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

    const fromEmail = input.fromEmail ?? env().EMAIL_FROM;
    if (!fromEmail) {
      throw new ValidationError(
        "fromEmail is required (no EMAIL_FROM env configured)",
      );
    }
    if (!isValidFromHeader(fromEmail)) {
      throw new ValidationError(
        "fromEmail (or EMAIL_FROM env) is not a valid email/header",
      );
    }

    if (input.isAbTest && input.variants?.length) {
      const totalSample = input.variants.reduce((s, v) => s + v.samplePercentage, 0);
      if (totalSample > 50) {
        throw new ValidationError("Sum of variant samplePercentage must be <= 50");
      }
    }

    const data: Prisma.CampaignUncheckedCreateInput = {
      name: input.name,
      subject: input.subject ?? tpl.subject,
      fromEmail,
      replyTo: input.replyTo ?? null,
      templateId: tpl.id,
      templateSnapshot: buildTemplateSnapshot(tpl),
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
            subject: v.subject,
            htmlContent: v.htmlContent,
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
      throw new ValidationError(
        `Campaign cannot be edited in status ${existing.status}`,
      );
    }

    const data: Prisma.CampaignUncheckedUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.subject !== undefined) data.subject = input.subject;
    if (input.fromEmail !== undefined) data.fromEmail = input.fromEmail;
    if (input.replyTo !== undefined) data.replyTo = input.replyTo ?? null;
    if (input.tagFilter !== undefined) data.tagFilter = input.tagFilter;
    if (input.tagFilterMode !== undefined) data.tagFilterMode = input.tagFilterMode;
    if (input.segmentId !== undefined) data.segmentId = input.segmentId ?? null;
    if (input.subscriptionCategory !== undefined) {
      data.subscriptionCategory = input.subscriptionCategory ?? null;
    }
    if (input.utmParams !== undefined) {
      data.utmParams = input.utmParams ? (input.utmParams as Prisma.InputJsonValue) : Prisma.DbNull;
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
    return this._transition(id, existing.status, next, reason, {}, ctx);
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

  async retry(id: string, ctx: ActorContext): Promise<Campaign> {
    return this._transition(id, "FAILED", "SENDING", "retry", {}, ctx);
  },
};

export type CampaignService = typeof campaignService;
