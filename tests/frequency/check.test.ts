/**
 * Frequency check 单元测试：mock repository，验证窗口边界与无配置时的放行行为。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/modules/frequency/repository", () => ({
  frequencyRepository: {
    findActive: vi.fn(),
    countSentSince: vi.fn(),
  },
}));

import { frequencyRepository } from "@/lib/modules/frequency/repository";
import { checkFrequency, isOverLimit } from "@/lib/modules/frequency/check";

const findActive = frequencyRepository.findActive as ReturnType<typeof vi.fn>;
const countSentSince = frequencyRepository.countSentSince as ReturnType<typeof vi.fn>;

describe("frequency/check", () => {
  beforeEach(() => {
    findActive.mockReset();
    countSentSince.mockReset();
  });

  it("returns false (allow) when no active cap configured", async () => {
    findActive.mockResolvedValue(null);
    expect(await isOverLimit("u1")).toBe(false);
    expect(countSentSince).not.toHaveBeenCalled();
  });

  it("under limit: count < maxEmails", async () => {
    findActive.mockResolvedValue({ maxEmails: 5, periodDays: 7 });
    countSentSince.mockResolvedValue(4);
    const r = await checkFrequency("u1");
    expect(r).toEqual({
      overLimit: false,
      count: 4,
      cap: { maxEmails: 5, periodDays: 7 },
    });
  });

  it("at limit: count == maxEmails is over", async () => {
    findActive.mockResolvedValue({ maxEmails: 5, periodDays: 7 });
    countSentSince.mockResolvedValue(5);
    expect(await isOverLimit("u1")).toBe(true);
  });

  it("computes since as now - periodDays * 86400_000 (UTC)", async () => {
    findActive.mockResolvedValue({ maxEmails: 10, periodDays: 7 });
    countSentSince.mockResolvedValue(0);
    const before = Date.now();
    await checkFrequency("u1");
    const after = Date.now();
    const sinceArg = countSentSince.mock.calls[0][1] as Date;
    const expectedMin = before - 7 * 86_400_000;
    const expectedMax = after - 7 * 86_400_000;
    expect(sinceArg.getTime()).toBeGreaterThanOrEqual(expectedMin);
    expect(sinceArg.getTime()).toBeLessThanOrEqual(expectedMax);
  });
});
