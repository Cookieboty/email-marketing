/**
 * 抑制名单命中检查（含 LRU 缓存）。
 *
 * 设计：
 *  - `isSuppressed(email)` 是发送热路径的高频调用，每条 recipient 都要查一次。
 *  - 用进程内 LRU 缓存命中结果（Map 维护插入顺序模拟 LRU），TTL 短 → 写后立即失效。
 *  - 任何 service 层的写操作（create/update/delete/import）必须调用 invalidateSuppressionCache()。
 *  - 单实例部署假设：无需考虑多机器一致性；多实例时该缓存可降级为短 TTL（默认 5 分钟）。
 *
 * 输入归一化：
 *  - 入参先 normalizeEmail，避免大小写差异穿透缓存。
 *  - 非法邮箱直接返回 false（不抑制；调用方仍可能在更早阶段拒绝）。
 */

import { extractDomain, isValidEmail, normalizeEmail } from "@/lib/email-utils";
import { suppressionRepository } from "./repository";

const DEFAULT_MAX_ENTRIES = 5000;
const DEFAULT_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  value: boolean;
  expiresAt: number;
}

class LruCache {
  private map = new Map<string, CacheEntry>();

  constructor(private readonly maxEntries: number, private readonly ttlMs: number) {}

  get(key: string): boolean | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    // refresh recency: delete + set so this key becomes the most-recently-used
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: string, value: boolean): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    if (this.map.size > this.maxEntries) {
      // evict oldest (first inserted)
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  clear(): void {
    this.map.clear();
  }

  size(): number {
    return this.map.size;
  }
}

let cache = new LruCache(DEFAULT_MAX_ENTRIES, DEFAULT_TTL_MS);

/** 全量失效缓存。所有写操作完成后必须调用。 */
export function invalidateSuppressionCache(): void {
  cache.clear();
}

/** 测试钩子：允许测试用例自定义容量/TTL。 */
export function _resetSuppressionCacheForTests(maxEntries = DEFAULT_MAX_ENTRIES, ttlMs = DEFAULT_TTL_MS): void {
  cache = new LruCache(maxEntries, ttlMs);
}

/**
 * 判断 email 是否被抑制名单命中。
 * 命中任意一条 EMAIL/DOMAIN/PATTERN 即返回 true。
 */
export async function isSuppressed(email: string | null | undefined): Promise<boolean> {
  if (!isValidEmail(email)) return false;
  const norm = normalizeEmail(email);
  const cached = cache.get(norm);
  if (cached !== undefined) return cached;
  const domain = extractDomain(norm);
  const exists = await suppressionRepository.existsForEmail(norm, domain);
  cache.set(norm, exists);
  return exists;
}

export const _suppressionCache = {
  size: () => cache.size(),
};
