import { NextResponse } from "next/server";
import { withAuth, parseJsonBody } from "@/lib/api-helpers";
import { verifyOrigin } from "@/lib/auth/origin";
import { ForbiddenError } from "@/lib/errors";
import { PreviewTemplateSchema } from "@/lib/modules/template/schema";
import {
  blockErrorToValidationError,
  buildPreviewResolver,
  templateService,
  uniqueBlockRefs,
} from "@/lib/modules/template/service";
import { withLocalizedBuiltinText } from "@/lib/modules/template/render";
import {
  BlockExpansionError,
  expandBlocks,
  extractAllVariables,
  render,
} from "@/lib/template-engine";
import { environmentVariableService } from "@/lib/modules/environment-variable/service";

export const runtime = "nodejs";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * 持久化模板的预览（plan §4.4）：以模板当前内容为基底，
 * 允许 body 覆盖 subject/htmlContent/textContent 与变量进行临时预览。
 *
 * 片段渲染策略（与 14.7 spec）：
 *  - 实时按 resolvedLocale 预取片段（不走 snapshot）
 *  - missing='keep'：unknown ref 保留 `{{> name }}` 字面量，便于编辑器联想/纠错
 *  - 响应附加 `unknownBlocks: string[]`，前端可显示警告徽章
 *  - CYCLE/DEPTH/SIZE 仍抛 ValidationError（与测试发送同源转译）
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

  // 1. 收集顶层引用并按 resolvedLocale 预取片段
  const resolvedLocale = baseLocale.locale;
  const refNames = uniqueBlockRefs([subject, html, text]);
  const resolver = await buildPreviewResolver(resolvedLocale, refNames);

  // 2. Stage-1：先把片段展开为字面（missing='keep' 留下未知引用做提示）
  let expandedSubject: string;
  let expandedHtml: string;
  let expandedText: string;
  try {
    expandedSubject = expandBlocks(subject, resolver, { missing: "keep" });
    expandedHtml = expandBlocks(html, resolver, { missing: "keep" });
    expandedText = text ? expandBlocks(text, resolver, { missing: "keep" }) : "";
  } catch (err) {
    if (err instanceof BlockExpansionError) {
      throw blockErrorToValidationError(err);
    }
    throw err;
  }

  // 3. Stage-2：在已展开的字面里渲染变量
  const opts = { missing: input.missingStrategy, builtin };
  const renderedSubject = render(expandedSubject, vars, opts);
  const renderedHtml = render(expandedHtml, vars, opts);
  const renderedText = expandedText ? render(expandedText, vars, opts) : null;

  // 4. unknown refs：keep 模式下未被替换的 `{{> name }}` 字面量
  //    （Stage-1 后 stage-2 不会重新解析片段语法，所以这里安全收集）
  const unknownBlocks = uniqueBlockRefs([
    expandedSubject,
    expandedHtml,
    expandedText,
  ]);

  // 5. detectedVariables 改用 extractAllVariables，递归到片段内部
  const detectedVariables = Array.from(
    new Set([
      ...extractAllVariables(subject, resolver),
      ...extractAllVariables(html, resolver),
      ...extractAllVariables(text, resolver),
    ]),
  );

  return NextResponse.json({
    renderedSubject,
    renderedHtml,
    renderedText,
    detectedVariables,
    ...(unknownBlocks.length > 0 ? { unknownBlocks } : {}),
  });
});
