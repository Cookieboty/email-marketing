import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-helpers";
import { verifyOrigin } from "@/lib/auth/origin";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { templateService } from "@/lib/modules/template/service";
import type { Locale } from "@prisma/client";

export const runtime = "nodejs";

interface Ctx {
  params: Promise<{ id: string; locale: string }>;
}

function parseLocale(locale: string): Locale {
  if (locale === "zh" || locale === "en") return locale;
  throw new ValidationError("Invalid locale");
}

export const DELETE = withAuth(async (_session, request: Request, ctx: Ctx) => {
  if (!verifyOrigin(request.headers)) throw new ForbiddenError("Forbidden origin");
  const { id, locale } = await ctx.params;
  const tpl = await templateService.deleteLocale(id, parseLocale(locale), {
    actorType: "ADMIN",
    req: { headers: request.headers },
  });
  return NextResponse.json(tpl);
});
