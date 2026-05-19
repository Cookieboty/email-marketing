import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-helpers";
import { SegmentPreviewQuerySchema } from "@/lib/modules/segment/schema";
import { segmentService } from "@/lib/modules/segment/service";

export const runtime = "nodejs";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * 预览分群命中的用户（前 N 条 + 总数）。
 * 命名为 /users 与 specs/segmentation-engine.md §预览分群用户 对齐。
 */
export const GET = withAuth(async (_session, request: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const url = new URL(request.url);
  const query = SegmentPreviewQuerySchema.parse({
    limit: url.searchParams.get("limit") ?? url.searchParams.get("pageSize") ?? undefined,
  });
  const result = await segmentService.preview(id, query);
  return NextResponse.json(result);
});
