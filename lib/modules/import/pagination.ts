/**
 * Outbound Importer 分页解析器。
 *
 * 关联 spec：specs/modules/outbound-importer.md §32-39 / phase-10 §10.5
 *
 * 四种模式：
 *  1. offset：?offset=N&limit=M  → 下一页 offset += pageSize；fetched < pageSize 时停止
 *  2. cursor：?cursor=xxx&limit=M → 响应中 cursorJsonPath 取下一个 cursor，null/undefined 即停止
 *  3. page：?page=N&pageSize=M   → 下一页 page += 1；fetched < pageSize 时停止
 *  4. link_header：解析 `Link: <url>; rel="next"`，无 next 即停止
 */

import { getByJsonPath } from "./mapper";

export type PaginationType = "offset" | "cursor" | "page" | "link_header";

export interface ImportSourceLike {
  baseUrl: string;
  paginationType: string;
  pageSize: number;
  pageSizeParam?: string | null;
  pageParam?: string | null;
  cursorParam?: string | null;
  cursorJsonPath?: string | null;
}

/** Runner 维护的“游标”状态。 */
export interface PaginationState {
  /** 当前 offset（offset 模式） */
  offset: number;
  /** 当前 page（page 模式，1-indexed） */
  page: number;
  /** 当前 cursor（cursor 模式） */
  cursor: string | null;
  /** Link header 提取的下一页绝对 URL（link_header 模式） */
  nextLinkUrl: string | null;
}

export function initialState(): PaginationState {
  return { offset: 0, page: 1, cursor: null, nextLinkUrl: null };
}

function setQuery(url: URL, key: string | null | undefined, value: string | number): void {
  if (!key) return;
  url.searchParams.set(key, String(value));
}

/** 构造下一次请求 URL。返回 null 表示已无更多页。 */
export function buildRequestUrl(source: ImportSourceLike, state: PaginationState): string | null {
  const type = source.paginationType as PaginationType;

  if (type === "link_header") {
    if (state.nextLinkUrl === null) {
      // 第一次请求：使用 baseUrl 原样，并带上 pageSize（如果配置了）
      const u = new URL(source.baseUrl);
      setQuery(u, source.pageSizeParam, source.pageSize);
      return u.toString();
    }
    // 后续请求：直接用 link header 给出的绝对 URL
    return state.nextLinkUrl;
  }

  const u = new URL(source.baseUrl);

  if (type === "offset") {
    setQuery(u, source.pageParam ?? "offset", state.offset);
    setQuery(u, source.pageSizeParam ?? "limit", source.pageSize);
  } else if (type === "page") {
    setQuery(u, source.pageParam ?? "page", state.page);
    setQuery(u, source.pageSizeParam ?? "pageSize", source.pageSize);
  } else if (type === "cursor") {
    setQuery(u, source.pageSizeParam ?? "limit", source.pageSize);
    if (state.cursor !== null && state.cursor !== "") {
      setQuery(u, source.cursorParam ?? "cursor", state.cursor);
    }
  } else {
    return null;
  }

  return u.toString();
}

/**
 * 根据响应推进 state，并返回是否还有下一页。
 *
 * @param fetchedThisPage 本次响应解析出的行数
 * @param responseBody 已经 JSON.parse 的响应体（用于 cursor 模式提取下一 cursor）
 * @param linkHeader 响应 `Link` 头（用于 link_header 模式）
 */
export function advanceState(
  source: ImportSourceLike,
  state: PaginationState,
  fetchedThisPage: number,
  responseBody: unknown,
  linkHeader: string | null,
): { hasNext: boolean; next: PaginationState } {
  const type = source.paginationType as PaginationType;
  const next: PaginationState = { ...state };

  if (type === "offset") {
    next.offset = state.offset + Math.max(fetchedThisPage, 0);
    const hasNext = fetchedThisPage >= source.pageSize && fetchedThisPage > 0;
    return { hasNext, next };
  }
  if (type === "page") {
    next.page = state.page + 1;
    const hasNext = fetchedThisPage >= source.pageSize && fetchedThisPage > 0;
    return { hasNext, next };
  }
  if (type === "cursor") {
    if (!source.cursorJsonPath) return { hasNext: false, next };
    const raw = getByJsonPath(responseBody, source.cursorJsonPath);
    const cur =
      typeof raw === "string" || typeof raw === "number" ? String(raw) : null;
    next.cursor = cur && cur.length > 0 ? cur : null;
    const hasNext = next.cursor !== null && fetchedThisPage > 0;
    return { hasNext, next };
  }
  if (type === "link_header") {
    const nextUrl = parseNextFromLinkHeader(linkHeader);
    next.nextLinkUrl = nextUrl;
    const hasNext = nextUrl !== null && fetchedThisPage > 0;
    return { hasNext, next };
  }
  return { hasNext: false, next };
}

/** 解析 RFC 5988 Link 头，提取 rel="next" 的 URL。 */
export function parseNextFromLinkHeader(header: string | null | undefined): string | null {
  if (!header) return null;
  // 形如：<https://api.example.com/users?page=2>; rel="next", <...>; rel="last"
  const segments = header.split(",");
  for (const seg of segments) {
    const m = seg.match(/<([^>]+)>\s*;\s*([^,]+)/);
    if (!m) continue;
    const url = m[1]!;
    const params = m[2]!;
    if (/rel\s*=\s*"?next"?/i.test(params)) {
      return url;
    }
  }
  return null;
}

/** 给定响应，按 dataJsonPath 取数组（不为数组时返回空数组并发出 0 行）。 */
export function extractDataArray(
  responseBody: unknown,
  dataJsonPath: string,
): unknown[] {
  const v = dataJsonPath === "$" ? responseBody : getByJsonPath(responseBody, dataJsonPath);
  if (Array.isArray(v)) return v;
  return [];
}

/** 把 PaginationState 序列化为 ImportJob.cursor 字符串（用于断点续跑）。 */
export function serializeState(state: PaginationState): string {
  return JSON.stringify(state);
}

export function deserializeState(raw: string | null | undefined): PaginationState {
  if (!raw) return initialState();
  try {
    const parsed = JSON.parse(raw) as Partial<PaginationState>;
    return {
      offset: typeof parsed.offset === "number" ? parsed.offset : 0,
      page: typeof parsed.page === "number" ? parsed.page : 1,
      cursor: typeof parsed.cursor === "string" ? parsed.cursor : null,
      nextLinkUrl: typeof parsed.nextLinkUrl === "string" ? parsed.nextLinkUrl : null,
    };
  } catch {
    return initialState();
  }
}
