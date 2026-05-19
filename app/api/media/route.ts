import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-helpers";
import { verifyOrigin } from "@/lib/auth/origin";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import {
  ListMediaQuerySchema,
  UploadMediaMetadataSchema,
} from "@/lib/modules/media/schema";
import { mediaService } from "@/lib/modules/media/service";

export const runtime = "nodejs";

export const GET = withAuth(async (_session, request: Request) => {
  const url = new URL(request.url);
  const parsed = ListMediaQuerySchema.parse({
    q: url.searchParams.get("q") ?? url.searchParams.get("search") ?? undefined,
    type: url.searchParams.get("type") ?? undefined,
    page: url.searchParams.get("page") ?? undefined,
    pageSize: url.searchParams.get("pageSize") ?? undefined,
  });
  const result = await mediaService.list(parsed);
  return NextResponse.json(result);
});

export const POST = withAuth(async (session, request: Request) => {
  if (!verifyOrigin(request.headers)) throw new ForbiddenError("Forbidden origin");
  const ct = request.headers.get("content-type") ?? "";
  if (!ct.toLowerCase().startsWith("multipart/form-data")) {
    throw new ValidationError("Content-Type must be multipart/form-data");
  }
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw new ValidationError("file is required");
  if (!file.name) throw new ValidationError("filename is required");
  const buffer = Buffer.from(await file.arrayBuffer());
  const metadata = UploadMediaMetadataSchema.parse({
    alt: typeof form.get("alt") === "string" ? form.get("alt") : undefined,
    tags: typeof form.get("tags") === "string" ? form.get("tags") : undefined,
  });
  const { asset, deduped } = await mediaService.upload(
    { filename: file.name, declaredMime: file.type || undefined, buffer },
    metadata,
    {
      actorType: "ADMIN",
      adminId: session.sessionId,
      req: { headers: request.headers },
    },
  );
  return NextResponse.json(asset, { status: deduped ? 200 : 201 });
});
