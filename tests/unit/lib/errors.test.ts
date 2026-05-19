import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  AppError,
  ValidationError,
  AuthError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  handleApiError,
} from "@/lib/errors";

describe("errors: status & code mapping", () => {
  it("AppError defaults", () => {
    const e = new AppError("boom");
    expect(e.status).toBe(500);
    expect(e.code).toBe("internal_error");
  });
  it("ValidationError → 400", () => {
    const e = new ValidationError("bad", [{ path: ["x"], message: "y" }]);
    expect(e.status).toBe(400);
    expect(e.details).toEqual([{ path: ["x"], message: "y" }]);
  });
  it("AuthError → 401", () => {
    expect(new AuthError().status).toBe(401);
  });
  it("NotFoundError → 404", () => {
    expect(new NotFoundError().status).toBe(404);
  });
  it("ConflictError → 409", () => {
    expect(new ConflictError().status).toBe(409);
  });
  it("RateLimitError preserves retryAfter", () => {
    const e = new RateLimitError(7);
    expect(e.status).toBe(429);
    expect(e.retryAfterSec).toBe(7);
  });
});

describe("errors: handleApiError", () => {
  it("maps ZodError to 400", async () => {
    const schema = z.object({ name: z.string() });
    const parsed = schema.safeParse({});
    expect(parsed.success).toBe(false);
    const res = handleApiError(parsed.success ? null : parsed.error);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("validation_error");
  });

  it("maps RateLimitError to 429 with Retry-After header", async () => {
    const res = handleApiError(new RateLimitError(15));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("15");
  });

  it("maps AppError subclass to its status", async () => {
    const res = handleApiError(new NotFoundError("missing"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("missing");
  });

  it("falls back to 500 for unknown errors", async () => {
    const res = handleApiError(new Error("oops"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("internal_error");
  });
});
