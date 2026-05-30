import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 存活探针（liveness）。仅确认 Next.js 进程能响应 HTTP，不触碰 DB。
 * 容器 healthcheck 用它判定进程存活；DB 可用性属就绪/外部监控范畴，
 * 不应让它触发容器重启（重启 app 修不好 DB，反而引发级联）。
 */
export function GET(): NextResponse {
  return NextResponse.json({ ok: true });
}
