import { NextResponse } from "next/server";
import { withAuth, parseJsonBody } from "@/lib/api-helpers";
import { verifyOrigin } from "@/lib/auth/origin";
import { ForbiddenError } from "@/lib/errors";
import { PreviewTemplateSchema } from "@/lib/modules/template/schema";
import { withLocalizedBuiltinText } from "@/lib/modules/template/render";
import { sanitizeHtml } from "@/lib/modules/template/service";
import { extractVariables, render } from "@/lib/template-engine";
import { environmentVariableService } from "@/lib/modules/environment-variable/service";

export const runtime = "nodejs";

/**
 * 实时预览端点（specs §242）：不持久化，纯计算。
 * 入参中的 htmlContent 会先剥离 script，再渲染；与保存路径行为一致。
 */
export const POST = withAuth(async (_session, request: Request) => {
  if (!verifyOrigin(request.headers)) throw new ForbiddenError("Forbidden origin");
  const input = await parseJsonBody(request, PreviewTemplateSchema);
  const envVars = await environmentVariableService.getVariablesMap();
  const vars = { ...envVars, ...(input.variables ?? {}) };
  const subject = input.subject ?? "";
  const html = input.htmlContent ? sanitizeHtml(input.htmlContent) : "";
  const text = input.textContent ?? "";
  const builtin = withLocalizedBuiltinText(input.locale, {
    unsubscribeUrl: input.unsubscribeUrl,
    unsubscribeTopicUrl: input.unsubscribeTopicUrl,
  });
  const renderedSubject = render(subject, vars, {
    missing: input.missingStrategy,
    builtin,
  });
  const renderedHtml = render(html, vars, {
    missing: input.missingStrategy,
    builtin,
  });
  const renderedText = text
    ? render(text, vars, { missing: input.missingStrategy, builtin })
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
