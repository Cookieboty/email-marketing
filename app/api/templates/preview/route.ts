import { NextResponse } from "next/server";
import { withAuth, parseJsonBody } from "@/lib/api-helpers";
import { verifyOrigin } from "@/lib/auth/origin";
import { ForbiddenError } from "@/lib/errors";
import { PreviewTemplateSchema } from "@/lib/modules/template/schema";
import { sanitizeHtml } from "@/lib/modules/template/service";
import { extractVariables, render } from "@/lib/template-engine";

export const runtime = "nodejs";

/**
 * 实时预览端点（specs §242）：不持久化，纯计算。
 * 入参中的 htmlContent 会先剥离 script，再渲染；与保存路径行为一致。
 */
export const POST = withAuth(async (_session, request: Request) => {
  if (!verifyOrigin(request.headers)) throw new ForbiddenError("Forbidden origin");
  const input = await parseJsonBody(request, PreviewTemplateSchema);
  const subject = input.subject ?? "";
  const html = input.htmlContent ? sanitizeHtml(input.htmlContent) : "";
  const text = input.textContent ?? "";
  const renderedSubject = render(subject, input.variables ?? {}, {
    missing: input.missingStrategy,
  });
  const renderedHtml = render(html, input.variables ?? {}, {
    missing: input.missingStrategy,
  });
  const renderedText = text
    ? render(text, input.variables ?? {}, { missing: input.missingStrategy })
    : null;
  const detectedVariables = Array.from(
    new Set([
      ...extractVariables(subject),
      ...extractVariables(html),
      ...extractVariables(text),
    ]),
  );
  return NextResponse.json({
    renderedSubject,
    renderedHtml,
    renderedText,
    detectedVariables,
  });
});
