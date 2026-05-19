import { handleApiError, NotFoundError } from "@/lib/errors";
import { mediaService } from "@/lib/modules/media/service";

export const runtime = "nodejs";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * 公开访问：邮件正文 <img src> 会直接命中此路由（middleware 已放行）。
 *  - 不做鉴权；删除后的资源 404。
 *  - Cache-Control 按 specs §211 设置，长缓存 + immutable。
 */
export async function GET(_request: Request, ctx: Ctx): Promise<Response> {
  try {
    const { id } = await ctx.params;
    const { asset, buffer } = await mediaService.readFile(id);
    const arrayBuffer = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    );
    return new Response(arrayBuffer as ArrayBuffer, {
      status: 200,
      headers: {
        "Content-Type": asset.mimeType,
        "Content-Length": String(asset.size),
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    // 物理文件丢失也走 404（非 500）
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return handleApiError(new NotFoundError("媒体资源不存在"));
    }
    return handleApiError(err);
  }
}

export async function HEAD(request: Request, ctx: Ctx): Promise<Response> {
  const res = await GET(request, ctx);
  return new Response(null, { status: res.status, headers: res.headers });
}
