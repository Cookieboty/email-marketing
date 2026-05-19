import { NextResponse } from "next/server";
import { withAuth, parseJsonBody } from "@/lib/api-helpers";
import { verifyOrigin } from "@/lib/auth/origin";
import { ForbiddenError } from "@/lib/errors";
import { PreviewTemplateSchema } from "@/lib/modules/template/schema";
import { templateService } from "@/lib/modules/template/service";
import { extractVariables, render } from "@/lib/template-engine";

export const runtime = "nodejs";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * 持久化模板的预览（plan §4.4）：以模板当前内容为基底，
 * 允许 body 覆盖 subject/htmlContent/textContent 与变量进行临时预览。
 */
export const POST = withAuth(async (_session, request: Request, ctx: Ctx) => {
  if (!verifyOrigin(request.headers)) throw new ForbiddenError("Forbidden origin");
  const { id } = await ctx.params;
  const tpl = await templateService.getById(id);
  const input = await parseJsonBody(request, PreviewTemplateSchema);

  const subject = input.subject ?? tpl.subject;
  const html = input.htmlContent ?? tpl.htmlContent;
  const text = input.textContent ?? tpl.textContent ?? "";
  const opts = { missing: input.missingStrategy } as const;
  const renderedSubject = render(subject, input.variables ?? {}, opts);
  const renderedHtml = render(html, input.variables ?? {}, opts);
  const renderedText = text ? render(text, input.variables ?? {}, opts) : null;

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
