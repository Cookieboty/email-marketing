import { NextResponse } from "next/server";
import { withAuth, parseJsonBody } from "@/lib/api-helpers";
import { verifyOrigin } from "@/lib/auth/origin";
import { ForbiddenError } from "@/lib/errors";
import { PreviewTemplateSchema } from "@/lib/modules/template/schema";
import { withLocalizedBuiltinText } from "@/lib/modules/template/render";
import {
  blockErrorToValidationError,
  buildPreviewResolver,
  sanitizeHtml,
  uniqueBlockRefs,
} from "@/lib/modules/template/service";
import {
  BlockExpansionError,
  expandBlocks,
  extractAllVariables,
  render,
} from "@/lib/template-engine";
import { environmentVariableService } from "@/lib/modules/environment-variable/service";

export const runtime = "nodejs";

/**
 * 实时预览端点（specs §242）：不持久化，纯计算。
 * 入参中的 htmlContent 会先剥离 script，再渲染；与保存路径行为一致。
 *
 * 片段渲染策略：与 [id]/preview 一致 —— missing='keep' + unknownBlocks 提示。
 * 不持久化的临时预览仍允许引用真实片段表，按 `input.locale` 实时取片段；
 * 这样编辑器键入 `{{> footer}}` 即可立即看到效果。
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

  const refNames = uniqueBlockRefs([subject, html, text]);
  const resolver = await buildPreviewResolver(input.locale, refNames);

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

  const renderedSubject = render(expandedSubject, vars, {
    missing: input.missingStrategy,
    builtin,
  });
  const renderedHtml = render(expandedHtml, vars, {
    missing: input.missingStrategy,
    builtin,
  });
  const renderedText = expandedText
    ? render(expandedText, vars, { missing: input.missingStrategy, builtin })
    : null;

  const unknownBlocks = uniqueBlockRefs([
    expandedSubject,
    expandedHtml,
    expandedText,
  ]);

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
