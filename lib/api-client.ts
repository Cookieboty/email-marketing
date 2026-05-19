"use client";

export interface ApiClientError extends Error {
  status: number;
  payload?: unknown;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function buildError(status: number, payload: unknown): ApiClientError {
  let message = `HTTP ${status}`;
  if (isPlainObject(payload)) {
    const errField = (payload as { error?: unknown }).error;
    const msgField = (payload as { message?: unknown }).message;
    if (typeof errField === "string" && errField.length > 0) message = errField;
    else if (typeof msgField === "string" && msgField.length > 0) message = msgField;
  }
  const err = new Error(message) as ApiClientError;
  err.status = status;
  err.payload = payload;
  return err;
}

async function parseBody(res: Response): Promise<unknown> {
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.toLowerCase().includes("application/json")) {
    return await res.text();
  }
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export async function apiFetch<T = unknown>(
  input: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers ?? {});
  const isFormData = typeof FormData !== "undefined" && init.body instanceof FormData;
  if (!isFormData && !headers.has("content-type") && init.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  const res = await fetch(input, {
    credentials: "same-origin",
    ...init,
    headers,
  });
  const body = await parseBody(res);
  if (!res.ok) throw buildError(res.status, body);
  return body as T;
}

export const apiGet = <T = unknown,>(url: string) => apiFetch<T>(url, { method: "GET" });
export const apiDelete = <T = unknown,>(url: string) => apiFetch<T>(url, { method: "DELETE" });
export const apiPost = <T = unknown,>(url: string, body?: unknown) =>
  apiFetch<T>(url, {
    method: "POST",
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  });
export const apiPatch = <T = unknown,>(url: string, body?: unknown) =>
  apiFetch<T>(url, {
    method: "PATCH",
    body: body === undefined ? undefined : JSON.stringify(body),
  });

export const swrFetcher = <T = unknown,>(url: string) => apiGet<T>(url);
