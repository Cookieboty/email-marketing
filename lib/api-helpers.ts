/**
 * Route Handler 公用辅助：身份校验、JSON 解析、统一错误捕获。
 *
 * 仅供 Node runtime 的 API 路由使用（依赖 next/headers）。
 */

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { ZodError, type ZodTypeAny, type z } from "zod";
import { SESSION_COOKIE_NAME, verifySession, type SessionPayload } from "./auth/session";
import { AuthError, ValidationError, handleApiError } from "./errors";

export async function getSession(): Promise<SessionPayload | null> {
  const store = await cookies();
  const raw = store.get(SESSION_COOKIE_NAME)?.value;
  if (!raw) return null;
  return verifySession(raw);
}

export async function requireSession(): Promise<SessionPayload> {
  const s = await getSession();
  if (!s) throw new AuthError();
  return s;
}

/**
 * 包装一个需要登录的 handler。withAuth 会在未登录时返回 401，
 * 在 handler 抛出 AppError/ZodError 时统一转成 JSON 响应。
 */
export function withAuth<Args extends unknown[]>(
  handler: (session: SessionPayload, ...args: Args) => Promise<NextResponse>,
): (...args: Args) => Promise<NextResponse> {
  return async (...args: Args) => {
    try {
      const session = await requireSession();
      return await handler(session, ...args);
    } catch (e) {
      return handleApiError(e);
    }
  };
}

/**
 * 解析并校验 JSON body。失败统一抛 ValidationError，便于 handleApiError 转 400。
 */
export async function parseJsonBody<S extends ZodTypeAny>(
  req: Request,
  schema: S,
): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ValidationError("Invalid JSON body");
  }
  try {
    return schema.parse(raw);
  } catch (e) {
    if (e instanceof ZodError) throw new ValidationError("Validation failed", e.issues);
    throw e;
  }
}

/**
 * 从代理头提取客户端 IP。
 *
 * 信任边界：直接取 X-Forwarded-For 的首段，假设本服务部署在受信任的反向代理
 * （如 Nginx / 负载均衡）之后，且该代理会重写/追加 XFF。若直接对公网暴露，
 * 客户端可伪造 XFF，IP 不可信——此时仅用于限流/审计的尽力而为标识，不可用于鉴权。
 */
export function getClientIpFromHeaders(headers: Headers): string {
  const xff = headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  const real = headers.get("x-real-ip");
  if (real) return real.trim();
  return "unknown";
}
