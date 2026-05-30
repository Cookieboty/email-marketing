import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE_NAME, verifySession } from "@/lib/auth/session";

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|api/track|api/unsubscribe|api/webhooks|api/health|api/preferences|preferences|unsubscribe|login).*)",
  ],
};

const PUBLIC_API_PREFIXES = [
  "/api/auth/login",
  "/api/auth/me",
  "/api/track",
  "/api/unsubscribe",
  "/api/webhooks",
  "/api/health",
  "/api/confirm",
  "/api/preferences",
  "/api/inbound",
];

function isPublicPath(pathname: string): boolean {
  if (pathname === "/login") return true;
  if (pathname === "/preferences" || pathname.startsWith("/preferences/")) return true;
  if (pathname === "/unsubscribe" || pathname.startsWith("/unsubscribe/")) return true;
  // 媒体文件流（邮件正文 <img src> 直接拉取）必须公开访问
  if (pathname.startsWith("/api/media/") && pathname.endsWith("/file")) return true;
  return PUBLIC_API_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();

  const cookie = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  let authenticated = false;
  if (cookie) {
    try {
      const payload = await verifySession(cookie);
      authenticated = !!payload;
    } catch {
      authenticated = false;
    }
  }

  if (authenticated) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { ok: false, error: "unauthenticated", code: "unauthenticated" },
      { status: 401 },
    );
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("from", pathname);
  return NextResponse.redirect(url);
}
