/**
 * 应用级错误类型与统一 API 错误响应。
 *
 * 设计：
 *  - AppError 是所有受控错误的基类；HTTP 状态、错误码、可暴露的 message
 *  - 子类语义化：ValidationError / AuthError / NotFoundError / ConflictError / RateLimitError
 *  - handleApiError 负责把 throw 转成统一 JSON 响应 `{ ok:false, error, code, details? }`
 *  - 仅 ValidationError 暴露 details（zod issues）；其余错误隐藏栈
 */

import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { logger } from "./logger";

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(message: string, opts: { status?: number; code?: string; details?: unknown } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.status = opts.status ?? 500;
    this.code = opts.code ?? "internal_error";
    this.details = opts.details;
  }
}

export class ValidationError extends AppError {
  constructor(message = "Validation failed", details?: unknown) {
    super(message, { status: 400, code: "validation_error", details });
  }
}

export class AuthError extends AppError {
  constructor(message = "Unauthorized") {
    super(message, { status: 401, code: "unauthorized" });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden") {
    super(message, { status: 403, code: "forbidden" });
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not Found") {
    super(message, { status: 404, code: "not_found" });
  }
}

export class ConflictError extends AppError {
  constructor(message = "Conflict") {
    super(message, { status: 409, code: "conflict" });
  }
}

export class RateLimitError extends AppError {
  readonly retryAfterSec: number;
  constructor(retryAfterSec: number, message = "Too many requests") {
    super(message, { status: 429, code: "rate_limited" });
    this.retryAfterSec = retryAfterSec;
  }
}

export function handleApiError(error: unknown): NextResponse {
  if (error instanceof ZodError) {
    return NextResponse.json(
      {
        ok: false,
        error: "validation_error",
        code: "validation_error",
        details: error.issues,
      },
      { status: 400 },
    );
  }
  if (error instanceof RateLimitError) {
    const res = NextResponse.json(
      { ok: false, error: error.message, code: error.code },
      { status: 429 },
    );
    res.headers.set("Retry-After", String(error.retryAfterSec));
    return res;
  }
  if (error instanceof AppError) {
    return NextResponse.json(
      {
        ok: false,
        error: error.message,
        code: error.code,
        ...(error.details !== undefined ? { details: error.details } : {}),
      },
      { status: error.status },
    );
  }
  logger.error("unhandled api error", {
    message: error instanceof Error ? error.message : String(error),
  });
  return NextResponse.json(
    { ok: false, error: "internal_error", code: "internal_error" },
    { status: 500 },
  );
}
