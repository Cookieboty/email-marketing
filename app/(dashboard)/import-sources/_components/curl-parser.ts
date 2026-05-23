/**
 * 解析 `curl` 命令，提取 URL / method / headers / 认证信息，
 * 用于在“新增数据源”表单中快速回填字段。
 *
 * 支持常见写法：
 *   curl 'https://api.example.com/users?limit=100' \
 *     -H 'Authorization: Bearer xxx' \
 *     -H "X-Tenant: abc" \
 *     -u user:pass \
 *     -X GET
 *
 * 设计取舍：
 *  - 仅做最佳努力解析，失败时返回 { ok: false, error }，由调用方 toast 提示。
 *  - 不解析 -d / --data-raw 等 body，因为 import-source 默认 GET。
 */

import type { ImportAuthType } from "./types";

export type ParsedPaginationType = "offset" | "page" | "cursor" | "link_header";

export interface ParsedPagination {
  /** 推断出的分页类型；当无法推断时为 undefined，调用方保留默认值。 */
  type?: ParsedPaginationType;
  /** 页参数名（如 `page` / `offset`）。 */
  pageParam?: string;
  /** 每页大小参数名（如 `page_size` / `limit`）。 */
  pageSizeParam?: string;
  /** 每页大小，从 URL query 读取到的整数。 */
  pageSize?: number;
  /** 游标参数名（cursor 风格分页时识别到）。 */
  cursorParam?: string;
}

export interface ParsedCurl {
  url: string;
  method: string;
  headers: Record<string, string>;
  authType: ImportAuthType;
  authHeader?: string;
  authValue?: string;
  pagination?: ParsedPagination;
}

export type CurlParseResult =
  | { ok: true; value: ParsedCurl }
  | { ok: false; error: string };

/**
 * 将 curl 命令拆为 token：处理单引号 / 双引号 / 反斜杠续行。
 */
function tokenize(input: string): string[] {
  const src = input.replace(/\\\r?\n/g, " ").trim();
  const tokens: string[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i += 1;
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      i += 1;
      let buf = "";
      while (i < n && src[i] !== quote) {
        if (src[i] === "\\" && i + 1 < n && quote === '"') {
          buf += src[i + 1];
          i += 2;
        } else {
          buf += src[i];
          i += 1;
        }
      }
      if (i >= n) {
        throw new Error("引号未闭合");
      }
      i += 1;
      tokens.push(buf);
      continue;
    }
    let buf = "";
    while (i < n && !/\s/.test(src[i]) && src[i] !== "'" && src[i] !== '"') {
      if (src[i] === "\\" && i + 1 < n) {
        buf += src[i + 1];
        i += 2;
      } else {
        buf += src[i];
        i += 1;
      }
    }
    if (buf) tokens.push(buf);
  }
  return tokens;
}

function parseHeaderLine(line: string): { name: string; value: string } | null {
  const idx = line.indexOf(":");
  if (idx <= 0) return null;
  const name = line.slice(0, idx).trim();
  const value = line.slice(idx + 1).trim();
  if (!name) return null;
  return { name, value };
}

/**
 * 去掉一些粘贴时容易混进的“装饰字符”：
 *  - 文档常见的反引号包裹  `https://…`
 *  - 用户多手输入的首尾空格
 *  - 末尾杂乱标点
 */
function cleanUrlToken(raw: string): string {
  let s = raw.trim();
  while (s.length >= 2 && (s.startsWith("`") || s.startsWith("'") || s.startsWith('"'))) {
    const head = s[0];
    const tail = s[s.length - 1];
    if (head === tail) {
      s = s.slice(1, -1).trim();
    } else {
      break;
    }
  }
  // 去掉孤立的反引号（粘贴 markdown 时常见）
  s = s.replace(/^`+|`+$/g, "").trim();
  return s;
}

/**
 * 常见 page-style / offset-style 参数名清单，用于自动识别分页字段。
 * 排序：越靠前越优先匹配（防止 `pageSize` 被当成 `page`）。
 */
const PAGE_SIZE_PARAM_CANDIDATES = [
  "page_size",
  "pagesize",
  "per_page",
  "perpage",
  "page-size",
  "limit",
  "size",
  "count",
];

const PAGE_PARAM_CANDIDATES = ["page", "pageno", "page_no", "page-no", "pagenum", "page_num"];

const OFFSET_PARAM_CANDIDATES = ["offset", "start", "from", "skip"];

const CURSOR_PARAM_CANDIDATES = [
  "cursor",
  "next",
  "next_cursor",
  "after",
  "next_page_token",
  "page_token",
  "continuation",
  "continuation_token",
];

function findParam(query: URLSearchParams, candidates: readonly string[]): string | null {
  const keys: string[] = [];
  query.forEach((_v, k) => keys.push(k));
  for (const cand of candidates) {
    const hit = keys.find((k) => k.toLowerCase() === cand);
    if (hit) return hit;
  }
  return null;
}

/**
 * 从 URL 中分离出 query，识别分页字段并把这些字段从 baseUrl 中剥离。
 *
 * 这样做的原因：runner 在翻页时会自行把 `pageParam` / `pageSizeParam`
 * 拼到 baseUrl 上；如果 baseUrl 已经带了 `?page=1&page_size=200`，
 * 翻第二页时会出现 `?page=1&page_size=200&page=2` 这种重复 / 错误参数。
 */
function extractPaginationAndCleanUrl(rawUrl: string): {
  url: string;
  pagination: ParsedPagination;
} {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { url: rawUrl, pagination: {} };
  }

  const params = parsed.searchParams;
  const pagination: ParsedPagination = {};

  const pageSizeParam = findParam(params, PAGE_SIZE_PARAM_CANDIDATES);
  if (pageSizeParam) {
    const v = params.get(pageSizeParam);
    if (v != null) {
      const n = Number.parseInt(v, 10);
      if (Number.isFinite(n) && n > 0 && n <= 1000) {
        pagination.pageSize = n;
      }
      pagination.pageSizeParam = pageSizeParam;
    }
    params.delete(pageSizeParam);
  }

  const pageParam = findParam(params, PAGE_PARAM_CANDIDATES);
  if (pageParam) {
    pagination.type = "page";
    pagination.pageParam = pageParam;
    params.delete(pageParam);
  } else {
    const offsetParam = findParam(params, OFFSET_PARAM_CANDIDATES);
    if (offsetParam) {
      pagination.type = "offset";
      pagination.pageParam = offsetParam;
      params.delete(offsetParam);
    } else {
      const cursorParam = findParam(params, CURSOR_PARAM_CANDIDATES);
      if (cursorParam) {
        pagination.type = "cursor";
        pagination.cursorParam = cursorParam;
        params.delete(cursorParam);
      }
    }
  }

  // searchParams 已被 mutate，重新生成 url
  const cleanedSearch = params.toString();
  parsed.search = cleanedSearch ? `?${cleanedSearch}` : "";

  return { url: parsed.toString(), pagination };
}

export function parseCurlCommand(input: string): CurlParseResult {
  if (!input || !input.trim()) {
    return { ok: false, error: "curl 命令不能为空" };
  }
  let tokens: string[];
  try {
    tokens = tokenize(input);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "解析失败" };
  }
  if (tokens.length === 0) {
    return { ok: false, error: "无法解析 curl 命令" };
  }
  if (tokens[0].toLowerCase() === "curl") {
    tokens.shift();
  }

  let url: string | null = null;
  let method = "GET";
  const headers: Record<string, string> = {};
  let basicAuthRaw: string | null = null;

  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t === "-H" || t === "--header") {
      const next = tokens[i + 1];
      if (next == null) return { ok: false, error: "-H 缺少参数" };
      const h = parseHeaderLine(next);
      if (h) headers[h.name] = h.value;
      i += 1;
    } else if (t === "-X" || t === "--request") {
      const next = tokens[i + 1];
      if (next == null) return { ok: false, error: "-X 缺少参数" };
      method = next.toUpperCase();
      i += 1;
    } else if (t === "-u" || t === "--user") {
      const next = tokens[i + 1];
      if (next == null) return { ok: false, error: "-u 缺少参数" };
      basicAuthRaw = next;
      i += 1;
    } else if (t === "--url") {
      const next = tokens[i + 1];
      if (next == null) return { ok: false, error: "--url 缺少参数" };
      url = cleanUrlToken(next);
      i += 1;
    } else if (
      t === "-A" ||
      t === "--user-agent" ||
      t === "-e" ||
      t === "--referer" ||
      t === "-b" ||
      t === "--cookie" ||
      t === "-d" ||
      t === "--data" ||
      t === "--data-raw" ||
      t === "--data-binary" ||
      t === "--data-urlencode" ||
      t === "-F" ||
      t === "--form" ||
      t === "--cacert" ||
      t === "--cert" ||
      t === "--key" ||
      t === "-o" ||
      t === "--output" ||
      t === "-T" ||
      t === "--upload-file"
    ) {
      i += 1;
    } else if (t.startsWith("-")) {
      // 其它 flag（如 --compressed / -L / -k）忽略，不消费参数
      continue;
    } else if (!url) {
      url = cleanUrlToken(t);
    }
  }

  if (!url) {
    return { ok: false, error: "未找到 URL" };
  }

  const { url: cleanedUrl, pagination } = extractPaginationAndCleanUrl(url);
  url = cleanedUrl;

  let authType: ImportAuthType = "NONE";
  let authHeader: string | undefined;
  let authValue: string | undefined;

  const authRaw = headers["Authorization"] ?? headers["authorization"];
  if (authRaw) {
    const m = /^Bearer\s+(.+)$/i.exec(authRaw);
    const b = /^Basic\s+(.+)$/i.exec(authRaw);
    if (m) {
      authType = "BEARER";
      authValue = m[1].trim();
    } else if (b) {
      authType = "BASIC";
      try {
        const decoded =
          typeof atob === "function"
            ? atob(b[1].trim())
            : Buffer.from(b[1].trim(), "base64").toString("utf8");
        authValue = decoded;
      } catch {
        authValue = b[1].trim();
      }
    }
    delete headers["Authorization"];
    delete headers["authorization"];
  } else if (basicAuthRaw) {
    authType = "BASIC";
    authValue = basicAuthRaw;
  } else {
    // 寻找形如 X-API-Key / X-Api-Key 这类 header
    const apiKeyName = Object.keys(headers).find((k) =>
      /^x[-_]?api[-_]?key$/i.test(k),
    );
    if (apiKeyName) {
      authType = "API_KEY_HEADER";
      authHeader = apiKeyName;
      authValue = headers[apiKeyName];
      delete headers[apiKeyName];
    }
  }

  return {
    ok: true,
    value: {
      url,
      method,
      headers,
      authType,
      authHeader,
      authValue,
      pagination,
    },
  };
}
