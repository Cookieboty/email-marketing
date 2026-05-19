/**
 * 公开确认接口（specs/modules/user-management.md §456-485, phase-4 §4.2）。
 *
 *  GET  /api/confirm?token=xxx — 渲染极简确认页面（HTML），用户在邮件中点击进入
 *  POST /api/confirm           — JSON body { token } 完成确认（幂等）
 *
 * 公开路由：middleware 已放行 /api/confirm；不写 cookie，无需 CSRF（设计上 token 即凭证）。
 *
 * 状态映射：
 *   confirmed         200 { ok: true }            HTML: 已确认成功页
 *   already_confirmed 200 { ok: true, already }   HTML: 已确认成功页（幂等）
 *   expired           410 { ok: false, code }     HTML: 链接已过期
 *   not_found         404 { ok: false, code }     HTML: 链接无效
 */

import { NextResponse } from "next/server";
import { z, ZodError } from "zod";
import { confirmOptInByToken } from "@/lib/modules/user/opt-in";
import { handleApiError, ValidationError } from "@/lib/errors";

export const runtime = "nodejs";

const ConfirmInputSchema = z.object({
  token: z.string().min(1, "token is required").max(128),
});

function htmlPage(title: string, body: string, status: number): NextResponse {
  const doc = [
    "<!doctype html><html><head><meta charset=\"utf-8\">",
    `<title>${title}</title>`,
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">",
    "<style>body{font-family:system-ui,-apple-system,'Segoe UI',Arial,sans-serif;background:#f6f7f9;margin:0;padding:48px 16px;color:#222}",
    ".card{max-width:480px;margin:0 auto;background:#fff;border-radius:8px;padding:32px;box-shadow:0 1px 3px rgba(0,0,0,.1)}",
    "h1{margin:0 0 16px;font-size:20px}p{line-height:1.6;margin:8px 0}</style>",
    "</head><body><div class=\"card\">",
    body,
    "</div></body></html>",
  ].join("");
  const res = new NextResponse(doc, { status });
  res.headers.set("Content-Type", "text/html; charset=utf-8");
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") ?? "";
  if (!token) {
    return htmlPage(
      "确认链接无效",
      "<h1>确认链接无效</h1><p>缺少必要的 token 参数。请检查邮件中的链接是否完整。</p>",
      400,
    );
  }
  try {
    const outcome = await confirmOptInByToken(token, { req: { headers: request.headers } });
    if (outcome.status === "confirmed" || outcome.status === "already_confirmed") {
      return htmlPage(
        "订阅已确认",
        "<h1>订阅已确认</h1><p>感谢确认订阅，您将开始收到我们的邮件。如需退订，可使用每封邮件底部的退订链接。</p>",
        200,
      );
    }
    if (outcome.status === "expired") {
      return htmlPage(
        "确认链接已过期",
        "<h1>确认链接已过期</h1><p>该链接已超过 48 小时有效期。请联系发件方重新发送确认邮件。</p>",
        410,
      );
    }
    return htmlPage(
      "确认链接无效",
      "<h1>确认链接无效</h1><p>未找到匹配的订阅记录。请检查邮件中的链接，或重新申请订阅。</p>",
      404,
    );
  } catch (err) {
    if (err instanceof ValidationError) {
      return htmlPage("参数错误", "<h1>参数错误</h1><p>请求参数不合法。</p>", 400);
    }
    throw err;
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return handleApiError(new ValidationError("Invalid JSON body"));
  }
  let parsed: { token: string };
  try {
    parsed = ConfirmInputSchema.parse(raw);
  } catch (e) {
    if (e instanceof ZodError) return handleApiError(new ValidationError("Validation failed", e.issues));
    throw e;
  }
  try {
    const outcome = await confirmOptInByToken(parsed.token, { req: { headers: request.headers } });
    switch (outcome.status) {
      case "confirmed":
        return NextResponse.json({ ok: true, message: "订阅确认成功" });
      case "already_confirmed":
        return NextResponse.json({ ok: true, message: "订阅已确认（幂等）", already: true });
      case "expired":
        return NextResponse.json(
          { ok: false, error: "Confirmation link expired", code: "opt_in_expired" },
          { status: 410 },
        );
      case "not_found":
      default:
        return NextResponse.json(
          { ok: false, error: "Token not found", code: "not_found" },
          { status: 404 },
        );
    }
  } catch (err) {
    return handleApiError(err);
  }
}
