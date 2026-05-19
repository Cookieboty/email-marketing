/**
 * Suppression check + LRU cache 单元测试。
 *
 * 思路：vi.mock 替换 repository.existsForEmail，验证：
 *  1. 同 email 的二次查询走缓存（spy 计数 = 1）
 *  2. invalidate 后再次查询会重新落到 repository
 *  3. 大小写不同的 email 归一化后命中同一缓存键
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/modules/suppression/repository", () => ({
  suppressionRepository: {
    existsForEmail: vi.fn(),
  },
}));

import { suppressionRepository } from "@/lib/modules/suppression/repository";
import {
  _resetSuppressionCacheForTests,
  invalidateSuppressionCache,
  isSuppressed,
} from "@/lib/modules/suppression/check";

const existsForEmail = suppressionRepository.existsForEmail as ReturnType<typeof vi.fn>;

describe("suppression/check", () => {
  beforeEach(() => {
    _resetSuppressionCacheForTests();
    existsForEmail.mockReset();
  });
  afterEach(() => {
    _resetSuppressionCacheForTests();
  });

  it("returns false for invalid emails without DB lookup", async () => {
    existsForEmail.mockResolvedValue(true);
    expect(await isSuppressed("not-an-email")).toBe(false);
    expect(await isSuppressed(null)).toBe(false);
    expect(existsForEmail).not.toHaveBeenCalled();
  });

  it("caches results after first hit", async () => {
    existsForEmail.mockResolvedValue(true);
    expect(await isSuppressed("a@b.com")).toBe(true);
    expect(await isSuppressed("a@b.com")).toBe(true);
    expect(existsForEmail).toHaveBeenCalledTimes(1);
  });

  it("normalizes case when caching", async () => {
    existsForEmail.mockResolvedValue(false);
    await isSuppressed("A@B.COM");
    await isSuppressed("a@b.com");
    expect(existsForEmail).toHaveBeenCalledTimes(1);
    // Repository called with normalized email + domain
    expect(existsForEmail).toHaveBeenCalledWith("a@b.com", "b.com");
  });

  it("invalidate clears cache", async () => {
    existsForEmail.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    expect(await isSuppressed("a@b.com")).toBe(false);
    invalidateSuppressionCache();
    expect(await isSuppressed("a@b.com")).toBe(true);
    expect(existsForEmail).toHaveBeenCalledTimes(2);
  });

  it("LRU evicts oldest when over capacity", async () => {
    _resetSuppressionCacheForTests(2, 60_000);
    existsForEmail.mockResolvedValue(false);
    await isSuppressed("a@x.com");
    await isSuppressed("b@x.com");
    // promote a@x.com
    await isSuppressed("a@x.com");
    // c overflows: should evict b@x.com (oldest)
    await isSuppressed("c@x.com");
    expect(existsForEmail).toHaveBeenCalledTimes(3);
    // b should require fresh lookup
    await isSuppressed("b@x.com");
    expect(existsForEmail).toHaveBeenCalledTimes(4);
  });

  it("TTL expiry forces re-lookup", async () => {
    _resetSuppressionCacheForTests(10, 1);
    existsForEmail.mockResolvedValue(false);
    await isSuppressed("a@x.com");
    await new Promise((r) => setTimeout(r, 5));
    await isSuppressed("a@x.com");
    expect(existsForEmail).toHaveBeenCalledTimes(2);
  });
});
