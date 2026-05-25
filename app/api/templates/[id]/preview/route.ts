import { NextResponse } from "next/server";
import { withAuth, parseJsonBody } from "@/lib/api-helpers";
import { verifyOrigin } from "@/lib/auth/origin";
import { ForbiddenError } from "@/lib/errors";
import { PreviewTemplateSchema } from "@/lib/modules/template/schema";
import { templateService } from "@/lib/modules/template/service";
import { withLocalizedBuiltinText } from "@/lib/modules/template/render";
import { extractVariables, render } from "@/lib/template-engine";
import { environmentVariableService } from "@/lib/modules/environment-variable/service";

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
  const baseLocale =
    tpl.locales.find((locale) => locale.locale === input.locale) ??
    tpl.locales.find((locale) => locale.locale === tpl.defaultLocale);
  if (!baseLocale) {
    return NextResponse.json({ error: "MissingLocaleContent" }, { status: 400 });
  }

  const envVars = await environmentVariableService.getVariablesMap();
  const vars = { ...envVars, ...(input.variables ?? {}) };
  const subject = input.subject ?? baseLocale.subject;
  const html = input.htmlContent ?? baseLocale.htmlContent;
  const text = input.textContent ?? baseLocale.textContent ?? "";
  const builtin = withLocalizedBuiltinText(input.locale, {
    unsubscribeUrl: input.unsubscribeUrl,
    unsubscribeTopicUrl: input.unsubscribeTopicUrl,
  });
  const opts = { missing: input.missingStrategy, builtin };
  const renderedSubject = render(subject, vars, opts);
  const renderedHtml = render(html, vars, opts);
  const renderedText = text ? render(text, vars, opts) : null;

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
