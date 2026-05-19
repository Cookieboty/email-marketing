import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth, parseJsonBody } from "@/lib/api-helpers";
import { verifyOrigin } from "@/lib/auth/origin";
import { ForbiddenError } from "@/lib/errors";
import { AddTagsSchema, SetTagsSchema } from "@/lib/modules/user/schema";
import { userService } from "@/lib/modules/user/service";

export const runtime = "nodejs";

interface Ctx {
  params: Promise<{ id: string }>;
}

const SingleTagSchema = z.object({ tagId: z.string().min(1) });

const AddPayloadSchema = z.union([SingleTagSchema, AddTagsSchema]);

export const POST = withAuth(async (_session, request: Request, ctx: Ctx) => {
  if (!verifyOrigin(request.headers)) throw new ForbiddenError("Forbidden origin");
  const { id } = await ctx.params;
  const input = await parseJsonBody(request, AddPayloadSchema);
  const tagIds = "tagId" in input ? [input.tagId] : input.tagIds;
  const user = await userService.addTags(id, tagIds, {
    actorType: "ADMIN",
    req: { headers: request.headers },
  });
  return NextResponse.json(user, { status: 201 });
});

export const PUT = withAuth(async (_session, request: Request, ctx: Ctx) => {
  if (!verifyOrigin(request.headers)) throw new ForbiddenError("Forbidden origin");
  const { id } = await ctx.params;
  const input = await parseJsonBody(request, SetTagsSchema);
  const user = await userService.setTags(id, input.tagIds, {
    actorType: "ADMIN",
    req: { headers: request.headers },
  });
  return NextResponse.json(user);
});

export const DELETE = withAuth(async (_session, request: Request, ctx: Ctx) => {
  if (!verifyOrigin(request.headers)) throw new ForbiddenError("Forbidden origin");
  const { id } = await ctx.params;
  const url = new URL(request.url);
  const tagId = url.searchParams.get("tagId");
  if (!tagId) {
    return NextResponse.json(
      { ok: false, error: "tagId is required", code: "validation_error" },
      { status: 400 },
    );
  }
  await userService.removeTag(id, tagId, {
    actorType: "ADMIN",
    req: { headers: request.headers },
  });
  return new NextResponse(null, { status: 204 });
});
