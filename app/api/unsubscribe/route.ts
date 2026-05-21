/**
 * 公开退订端点（specs/modules/preference-center.md §126-205 + specs/modules/unsubscribe-topic-level.md）。
 *
 * 路由：
 *   GET  /api/unsubscribe?token=...&category=slug   — 渲染 HTML 落地页（用户点击邮件链接）
 *   GET  /api/unsubscribe?token=...&topic=slug      — 主题退订落地页
 *   POST /api/unsubscribe                            — JSON / form 提交（一键退订 + 站内 fetch）
 *
 * 安全：
 *  - 公开路由（middleware 已放行 /api/unsubscribe）
 *  - 不依赖 cookie / origin；token 即凭证
 *  - 限流：以 IP 维度，每 60 秒最多 30 次（防止扫描 token），同时对失败做退避
 *
 * 优先级：同时传 topic 和 category 时，topic 优先（更细粒度）。
 *
 * 一键退订 (RFC 8058)：
 *  邮件客户端会发起 `POST` 且 body 为 `List-Unsubscribe=One-Click`，
 *  此时 token / category / topic 必须从 URL query 读取。
 */

import { NextResponse } from "next/server";
import { z, ZodError } from "zod";
import { handleApiError, RateLimitError, ValidationError } from "@/lib/errors";
import { getRateLimiter, getClientIp } from "@/lib/rate-limit";
import { subscriptionUnsubscribeService } from "@/lib/modules/subscription-category/unsubscribe";
import {
  getUnsubscribeDict,
  type UnsubscribeLocale,
} from "@/lib/modules/subscription-category/unsubscribe-i18n";

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
    topic: SlugSchema.optional(),
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

interface PostInputs {
  token: string;
  category?: string;
  topic?: string;
}

async function readPostInputs(request: Request): Promise<PostInputs> {
  const url = new URL(request.url);
  // 1) 优先 URL query（一键退订 RFC 8058 走 query + form 固定值 body）
  const queryToken = url.searchParams.get("token") ?? undefined;
  const queryCategory = url.searchParams.get("category") ?? undefined;
  const queryTopic = url.searchParams.get("topic") ?? undefined;

  // 2) 其次 body（form 或 JSON）
  const ct = request.headers.get("content-type") ?? "";
  let bodyToken: string | undefined;
  let bodyCategory: string | undefined;
  let bodyTopic: string | undefined;
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
      bodyTopic = parsed.topic;
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
    const tp = form.get("topic");
    if (typeof t === "string") bodyToken = t;
    if (typeof c === "string") bodyCategory = c;
    if (typeof tp === "string") bodyTopic = tp;
  }

  const token = queryToken ?? bodyToken;
  const category = queryCategory ?? bodyCategory;
  const topic = queryTopic ?? bodyTopic;
  if (!token) throw new ValidationError("token is required");
  TokenSchema.parse(token);
  if (category) SlugSchema.parse(category);
  if (topic) SlugSchema.parse(topic);
  return { token, category, topic };
}

function localeDict(user: { locale: UnsubscribeLocale | null } | null | undefined) {
  return getUnsubscribeDict(user?.locale ?? null);
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
  const topicRaw = url.searchParams.get("topic") ?? undefined;
  // spec §605：退订页按用户 locale 渲染；token 解析失败前没有 user 信息，落回
  // 默认 locale 即可（fallback 见 unsubscribe-i18n.ts）。
  const fallback = getUnsubscribeDict(null);
  if (!token) {
    return htmlPage(
      fallback.invalidTitle,
      `<h1>${fallback.invalidTitle}</h1><p>${fallback.invalidMissingToken}</p>`,
      400,
    );
  }
  let category: string | undefined;
  let topic: string | undefined;
  try {
    TokenSchema.parse(token);
    if (categoryRaw) category = SlugSchema.parse(categoryRaw);
    if (topicRaw) topic = SlugSchema.parse(topicRaw);
  } catch {
    return htmlPage(
      fallback.invalidTitle,
      `<h1>${fallback.invalidTitle}</h1><p>${fallback.invalidBody}</p>`,
      400,
    );
  }

  try {
    if (topic) {
      const out = await subscriptionUnsubscribeService.unsubscribeByTopic({
        token,
        topicSlug: topic,
        req: { headers: request.headers },
      });
      const dict = localeDict("user" in out ? out.user : null);
      switch (out.status) {
        case "topic_unsubscribed": {
          const name = escapeHtml(out.topic.name);
          return htmlPage(
            out.alreadyUnsubscribed ? dict.topicAlreadyTitle : dict.topicSuccessTitle,
            out.alreadyUnsubscribed
              ? `<h1>${dict.topicAlreadyTitle}</h1><p>${dict.topicAlreadyBody(name)}</p>`
              : `<h1>${dict.topicSuccessTitle}</h1><p>${dict.topicSuccessBody(name)}</p>`,
            200,
          );
        }
        case "topic_not_found":
          return htmlPage(
            dict.topicNotFoundTitle,
            `<h1>${dict.topicNotFoundTitle}</h1><p>${dict.topicNotFoundBody}</p>`,
            404,
          );
        case "user_not_found":
        default:
          return htmlPage(
            fallback.invalidTitle,
            `<h1>${fallback.invalidTitle}</h1><p>${fallback.invalidBody}</p>`,
            404,
          );
      }
    }

    const out = await subscriptionUnsubscribeService.byToken({
      token,
      categorySlug: category ?? null,
      req: { headers: request.headers },
    });
    const dict = localeDict("user" in out ? out.user : null);
    switch (out.status) {
      case "global_unsubscribed":
        return htmlPage(
          out.alreadyUnsubscribed ? dict.globalAlreadyTitle : dict.globalSuccessTitle,
          out.alreadyUnsubscribed
            ? `<h1>${dict.globalAlreadyTitle}</h1><p>${dict.globalAlreadyBody}</p>`
            : `<h1>${dict.globalSuccessTitle}</h1><p>${dict.globalSuccessBody}</p>`,
          200,
        );
      case "category_unsubscribed":
        return htmlPage(
          dict.categorySuccessTitle,
          `<h1>${dict.categorySuccessTitle}</h1><p>${dict.categorySuccessBody(
            escapeHtml(out.category.name),
          )}</p>`,
          200,
        );
      case "category_ignored_transactional":
        return htmlPage(
          dict.categoryTransactionalTitle,
          `<h1>${dict.categoryTransactionalTitle}</h1><p>${dict.categoryTransactionalBody(
            escapeHtml(out.category.name),
          )}</p>`,
          200,
        );
      case "category_not_found":
        return htmlPage(
          dict.categoryNotFoundTitle,
          `<h1>${dict.categoryNotFoundTitle}</h1><p>${dict.categoryNotFoundBody}</p>`,
          404,
        );
      case "user_not_found":
      default:
        return htmlPage(
          fallback.invalidTitle,
          `<h1>${fallback.invalidTitle}</h1><p>${fallback.invalidBody}</p>`,
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
    const { token, category, topic } = await readPostInputs(request);

    // 优先级：topic > category > global
    if (topic) {
      const out = await subscriptionUnsubscribeService.unsubscribeByTopic({
        token,
        topicSlug: topic,
        req: { headers: request.headers },
      });
      switch (out.status) {
        case "topic_unsubscribed":
          return NextResponse.json({
            ok: true,
            status: "topic_unsubscribed",
            slug: out.topic.slug,
            already: out.alreadyUnsubscribed,
          });
        case "topic_not_found":
          return NextResponse.json(
            { ok: false, status: "topic_not_found", slug: out.slug },
            { status: 404 },
          );
        case "user_not_found":
        default:
          return NextResponse.json(
            { ok: false, status: "user_not_found", code: "not_found" },
            { status: 404 },
          );
      }
    }

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
