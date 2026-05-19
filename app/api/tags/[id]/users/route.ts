import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-helpers";
import { TagUsersQuerySchema } from "@/lib/modules/tag/schema";
import { tagService } from "@/lib/modules/tag/service";

export const runtime = "nodejs";

interface Ctx {
  params: Promise<{ id: string }>;
}

export const GET = withAuth(async (_session, request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const url = new URL(request.url);
  const parsed = TagUsersQuerySchema.parse({
    page: url.searchParams.get("page") ?? undefined,
    pageSize: url.searchParams.get("pageSize") ?? undefined,
  });
  const result = await tagService.listUsers(id, parsed);
  return NextResponse.json(result);
});
