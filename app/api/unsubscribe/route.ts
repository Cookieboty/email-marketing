/**
 * 公开退订端点（specs/modules/preference-center.md §126-205）。
 *
 * 路由：
 *   GET  /api/unsubscribe?token=...&category=slug   — 渲染 HTML 落地页（用户点击邮件链接）
 *   POST /api/unsubscribe                            — JSON / form 提交（一键退订 + 站内 fetch）
 *
 * 安全：
 *  - 公开路由（middleware 已放行 /api/unsubscribe）
 *  - 不依赖 cookie / origin；token 即凭证
 *  - 限流：以 IP 维度，每 60 秒最多 30 次（防止扫描 token），同时对失败做退避
 *
 * 一键退订 (RFC 8058)：
 *  邮件客户端会发起 `POST` 且 body 为 `List-Unsubscribe=One-Click`，
 *  此时 token / category 必须从 URL query 读取。
 */

import { NextResponse } from "next/server";
import { z, ZodError } from "zod";
import { handleApiError, RateLimitError, ValidationError } from "@/lib/errors";
import { getRateLimiter, getClientIp } from "@/lib/rate-limit";
import { subscriptionUnsubscribeService } from "@/lib/modules/subscription-category/unsubscribe";

export const runtime = "nodejs";

const TokenSchema = z.string().min(1).max(128);
const SlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);

const PostBodySchema = z
  .object({
    token: TokenSchema.optional(),
    category: SlugSchema.optional(),
  })
  .strict()
  .partial();

function unsubscribeRateLimiter() {
  return getRateLimiter("unsubscribe", {
    maxAttempts: 30,
    windowSec: 60,
    lockSec: 120,
  });
}

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

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

function checkRateLimit(headers: Headers): void {
  const rl = unsubscribeRateLimiter();
  const ip = getClientIp(headers);
  const decision = rl.check(ip);
  if (!decision.allowed) {
    throw new RateLimitError(decision.retryAfterSec);
  }
  // 计入一次"使用"，超过阈值即在下一次锁定（防扫描）
  rl.recordFailure(ip);
}

async function readPostInputs(request: Request): Promise<{ token: string; category?: string }> {
  const url = new URL(request.url);
  // 1) 优先 URL query（一键退订 RFC 8058 走 query + form 固定值 body）
  const queryToken = url.searchParams.get("token") ?? undefined;
  const queryCategory = url.searchParams.get("category") ?? undefined;

  // 2) 其次 body（form 或 JSON）
  const ct = request.headers.get("content-type") ?? "";
  let bodyToken: string | undefined;
  let bodyCategory: string | undefined;
  if (ct.includes("application/json")) {
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      raw = {};
    }
    try {
      const parsed = PostBodySchema.parse(raw);
      bodyToken = parsed.token;
      bodyCategory = parsed.category;
    } catch (e) {
      if (e instanceof ZodError)
        throw new ValidationError("Validation failed", e.issues);
      throw e;
    }
  } else if (
    ct.includes("application/x-www-form-urlencoded") ||
    ct.includes("multipart/form-data")
  ) {
    const form = await request.formData();
    const t = form.get("token");
    const c = form.get("category");
    if (typeof t === "string") bodyToken = t;
    if (typeof c === "string") bodyCategory = c;
  }

  const token = queryToken ?? bodyToken;
  const category = queryCategory ?? bodyCategory;
  if (!token) throw new ValidationError("token is required");
  TokenSchema.parse(token);
  if (category) SlugSchema.parse(category);
  return { token, category };
}

export async function GET(request: Request): Promise<NextResponse> {
  try {
    checkRateLimit(request.headers);
  } catch (e) {
    return handleApiError(e);
  }
  const url = new URL(request.url);
  const token = url.searchParams.get("token") ?? "";
  const categoryRaw = url.searchParams.get("category") ?? undefined;
  if (!token) {
    return htmlPage(
      "退订链接无效",
      "<h1>退订链接无效</h1><p>缺少必要的 token 参数。请检查邮件中的链接是否完整。</p>",
      400,
    );
  }
  let category: string | undefined;
  try {
    TokenSchema.parse(token);
    if (categoryRaw) category = SlugSchema.parse(categoryRaw);
  } catch {
    return htmlPage(
      "退订链接无效",
      "<h1>退订链接无效</h1><p>链接格式错误。请检查邮件中的链接是否完整。</p>",
      400,
    );
  }

  try {
    const out = await subscriptionUnsubscribeService.byToken({
      token,
      categorySlug: category ?? null,
      req: { headers: request.headers },
    });
    switch (out.status) {
      case "global_unsubscribed":
        return htmlPage(
          "已退订",
          out.alreadyUnsubscribed
            ? "<h1>您已退订</h1><p>您此前已退订所有邮件，本次操作无变化。</p>"
            : "<h1>退订成功</h1><p>您已成功退订全部邮件，将不再收到我们的任何邮件通知。</p>",
          200,
        );
      case "category_unsubscribed":
        return htmlPage(
          "已退订该分类",
          `<h1>退订成功</h1><p>您已成功退订「${escapeHtml(out.category.name)}」分类，仍可继续接收其他类型的邮件。</p>`,
          200,
        );
      case "category_ignored_transactional":
        return htmlPage(
          "无法退订该分类",
          `<h1>该邮件不可退订</h1><p>「${escapeHtml(out.category.name)}」属于交易类通知（如订单确认、账户安全），按法规和安全要求不可退订。</p>`,
          200,
        );
      case "category_not_found":
        return htmlPage(
          "分类不存在",
          "<h1>分类已下线</h1><p>该订阅分类已被移除，本次操作未生效。如需全局退订，请使用邮件中的「退订所有邮件」链接。</p>",
          404,
        );
      case "user_not_found":
      default:
        return htmlPage(
          "退订链接无效",
          "<h1>退订链接无效</h1><p>未找到匹配的订阅记录，链接可能已失效。</p>",
          404,
        );
    }
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    checkRateLimit(request.headers);
    const { token, category } = await readPostInputs(request);
    const out = await subscriptionUnsubscribeService.byToken({
      token,
      categorySlug: category ?? null,
      req: { headers: request.headers },
    });
    switch (out.status) {
      case "global_unsubscribed":
        return NextResponse.json({
          ok: true,
          status: "global_unsubscribed",
          already: out.alreadyUnsubscribed,
        });
      case "category_unsubscribed":
        return NextResponse.json({
          ok: true,
          status: "category_unsubscribed",
          slug: out.category.slug,
        });
      case "category_ignored_transactional":
        // RFC 一致性：交易类邮件本就不该带 List-Unsubscribe，这里仍返回 200 防止邮件客户端反复重试
        return NextResponse.json({
          ok: true,
          status: "transactional_ignored",
          slug: out.category.slug,
        });
      case "category_not_found":
        return NextResponse.json(
          { ok: false, status: "category_not_found", slug: out.slug },
          { status: 404 },
        );
      case "user_not_found":
      default:
        return NextResponse.json(
          { ok: false, status: "user_not_found", code: "not_found" },
          { status: 404 },
        );
    }
  } catch (err) {
    return handleApiError(err);
  }
}
