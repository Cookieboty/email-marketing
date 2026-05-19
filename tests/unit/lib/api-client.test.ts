import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { apiFetch, apiGet, apiPost, apiPatch, apiDelete } from "@/lib/api-client";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("api-client", () => {
  it("apiGet 返回 JSON 解析结果", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: [1, 2] }));
    const out = await apiGet<{ items: number[] }>("/api/x");
    expect(out.items).toEqual([1, 2]);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("GET");
    expect(init.credentials).toBe("same-origin");
  });

  it("apiPost JSON body 自动写 content-type", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    await apiPost("/api/x", { a: 1 });
    const [, init] = fetchMock.mock.calls[0];
    const headers = new Headers(init.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
  });

  it("apiPost FormData 不覆写 content-type", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    const fd = new FormData();
    fd.append("k", "v");
    await apiPost("/api/x", fd);
    const [, init] = fetchMock.mock.calls[0];
    const headers = new Headers(init.headers);
    expect(headers.get("content-type")).toBeNull();
    expect(init.body).toBe(fd);
  });

  it("apiPatch 序列化 body", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    await apiPatch("/api/x/1", { name: "n" });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("PATCH");
    expect(init.body).toBe(JSON.stringify({ name: "n" }));
  });

  it("apiDelete 不带 body", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    await apiDelete("/api/x/1");
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("DELETE");
    expect(init.body).toBeUndefined();
  });

  it("非 2xx 抛出 ApiClientError 并保留 status/payload", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "Bad" }, { status: 400 }));
    await expect(apiFetch("/api/x")).rejects.toMatchObject({
      message: "Bad",
      status: 400,
      payload: { error: "Bad" },
    });
  });

  it("非 JSON 响应作为 text 返回", async () => {
    fetchMock.mockResolvedValue(
      new Response("plain", { status: 200, headers: { "content-type": "text/plain" } }),
    );
    const out = await apiGet<string>("/api/x");
    expect(out).toBe("plain");
  });
});
