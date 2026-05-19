/**
 * Origin / Referer 校验（CSRF 第一道防线）。
 *
 * 思路：副作用 API（POST/PUT/PATCH/DELETE）必须携带与 APP_URL 同源的 Origin 头；
 * 若浏览器未发送 Origin（少数旧版/同源 GET 后跟 POST 场景），回退到 Referer。
 *
 * 与 SameSite=Lax cookie 形成纵深防御：
 *   - SameSite=Lax 阻止跨站表单 POST 自动携带 cookie
 *   - verifyOrigin 阻止跨站 fetch CORS 简单请求伪造
 */

function safeHostname(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function getAllowedOrigin(): string | null {
  return safeHostname(process.env.APP_URL ?? null);
}

export function verifyOrigin(headers: Headers, allowedOrigin?: string | null): boolean {
  const allowed = allowedOrigin ?? getAllowedOrigin();
  if (!allowed) return false;
  const origin = headers.get("origin");
  if (origin) return safeHostname(origin) === allowed;
  const referer = headers.get("referer");
  if (referer) return safeHostname(referer) === allowed;
  return false;
}
