/**
 * POST /api/inbound/users/[id]/tags
 *
 * 三种模式 replace / append / remove。
 *
 * 关联 spec：specs/modules/inbound-connector.md §132-160
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { withApiClient } from "@/lib/modules/api-client/middleware";
import { prisma } from "@/lib/prisma";
import { userRepository } from "@/lib/modules/user/repository";
import { resolveTagIds } from "@/lib/modules/user/service";
import { onTagChanged } from "@/lib/modules/automation/service";

export const runtime = "nodejs";

const Body = z.object({
  mode: z.enum(["replace", "append", "remove"]),
  tags: z.array(z.string().trim().min(1).max(64)).min(1).max(50),
});

export const POST = withApiClient(
  ["tag:write"],
  async (ctx, request) => {
    const url = new URL(request.url);
    // /api/inbound/users/<id>/tags
    const segments = url.pathname.split("/").filter(Boolean);
    const tagsIdx = segments.lastIndexOf("tags");
    const userId = tagsIdx > 0 ? segments[tagsIdx - 1] : "";
    if (!userId) throw new ValidationError("User id is required");

    const existing = await userRepository.findById(userId);
    if (!existing) throw new NotFoundError("User not found");

    const parsed = Body.safeParse(ctx.parsedBody);
    if (!parsed.success) {
      throw new ValidationError("Validation failed", parsed.error.issues);
    }
    const { mode, tags } = parsed.data;

    await prisma.$transaction(async (tx) => {
      const tagIds = await resolveTagIds({ tagNames: tags }, tx);
      if (mode === "replace") {
        await userRepository.setTags(userId, tagIds, tx);
      } else if (mode === "append") {
        await userRepository.addTags(userId, tagIds, tx);
      } else {
        for (const tagId of tagIds) {
          await userRepository.removeTag(userId, tagId, tx);
        }
      }
    });

    const updated = await userRepository.findById(userId);
    if (!updated) throw new NotFoundError("User not found");

    audit({
      action: "inbound.user_tag",
      entityType: "User",
      entityId: userId,
      actorType: "WEBHOOK",
      details: {
        email: updated.email,
        mode,
        tags,
        apiClientId: ctx.apiClient.id,
        idempotencyKey: ctx.idempotencyKey,
      },
      req: { headers: request.headers },
    });

    onTagChanged(userId, updated.tags.map((t) => t.name));

    const body = {
      ok: true as const,
      user: {
        id: updated.id,
        email: updated.email,
        tags: updated.tags.map((t) => t.name),
      },
      mode,
    };
    await ctx.finalize(200, body);
    return NextResponse.json(body, { status: 200 });
  },
);
