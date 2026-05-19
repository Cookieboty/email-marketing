import { NextResponse } from "next/server";
import { withAuth, parseJsonBody } from "@/lib/api-helpers";
import { verifyOrigin } from "@/lib/auth/origin";
import { ForbiddenError } from "@/lib/errors";
import { CreateUserSchema, ListUsersQuerySchema } from "@/lib/modules/user/schema";
import { userService } from "@/lib/modules/user/service";

export const runtime = "nodejs";

function arrayParam(searchParams: URLSearchParams, key: string): string[] | undefined {
  const all = searchParams.getAll(key);
  if (all.length === 0) return undefined;
  return all.flatMap((v) => v.split(",")).filter(Boolean);
}

export const GET = withAuth(async (_session, request: Request) => {
  const url = new URL(request.url);
  const q = url.searchParams;
  const parsed = ListUsersQuerySchema.parse({
    q: q.get("q") ?? undefined,
    tagIds: arrayParam(q, "tagIds") ?? arrayParam(q, "tag"),
    tagFilterMode: q.get("tagFilterMode") ?? undefined,
    unsubscribed: q.get("unsubscribed") ?? undefined,
    userLevel: q.get("userLevel") ?? undefined,
    minSpend: q.get("minSpend") ?? undefined,
    maxSpend: q.get("maxSpend") ?? undefined,
    minOrderCount: q.get("minOrderCount") ?? undefined,
    lastOrderAfter: q.get("lastOrderAfter") ?? undefined,
    page: q.get("page") ?? undefined,
    pageSize: q.get("pageSize") ?? undefined,
    sortBy: q.get("sortBy") ?? undefined,
    sortDir: q.get("sortDir") ?? undefined,
  });
  const result = await userService.list(parsed);
  return NextResponse.json(result);
});

export const POST = withAuth(async (_session, request: Request) => {
  if (!verifyOrigin(request.headers)) throw new ForbiddenError("Forbidden origin");
  const input = await parseJsonBody(request, CreateUserSchema);
  const user = await userService.create(input, {
    actorType: "ADMIN",
    req: { headers: request.headers },
  });
  return NextResponse.json(user, { status: 201 });
});
