import { z } from "zod";
import { NextResponse } from "next/server";
import { withAuth, parseJsonBody } from "@/lib/api-helpers";
import { verifyOrigin } from "@/lib/auth/origin";
import { ForbiddenError } from "@/lib/errors";
import { segmentService } from "@/lib/modules/segment/service";

export const runtime = "nodejs";

/**
 * 编辑器中的实时校验：传入条件树，返回 { valid, estimatedUserCount }。
 * 校验失败由 ValidationError 统一转 400；详细错误在 details 字段。
 */
const ValidateBodySchema = z
  .object({
    // 不在此用 SegmentConditionSchema parse，service.validate 内部会再 parse 并把错误统一转为 ValidationError
    conditions: z.unknown(),
  })
  .strict();

export const POST = withAuth(async (_session, request: Request) => {
  if (!verifyOrigin(request.headers)) throw new ForbiddenError("Forbidden origin");
  const { conditions } = await parseJsonBody(request, ValidateBodySchema);
  const result = await segmentService.validate(conditions);
  return NextResponse.json(result);
});
