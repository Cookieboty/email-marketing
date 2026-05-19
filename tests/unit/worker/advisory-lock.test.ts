import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queryRawMock = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: (...args: unknown[]) => queryRawMock(...args),
    $disconnect: vi.fn(),
  },
}));

describe("worker / advisory lock", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    queryRawMock.mockReset();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.WORKER_DRY_RUN;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("WORKER_DRY_RUN=true 时跳过 SQL 调用并返回 true", async () => {
    process.env.WORKER_DRY_RUN = "true";
    process.env.DATABASE_URL = "postgresql://x";
    const { acquireLock, releaseLock } = await import("@/scripts/worker");

    const ok = await acquireLock();
    expect(ok).toBe(true);
    expect(queryRawMock).not.toHaveBeenCalled();

    await releaseLock();
    expect(queryRawMock).not.toHaveBeenCalled();
  });

  it("DATABASE_URL 缺失时跳过 SQL 调用并返回 true", async () => {
    delete process.env.DATABASE_URL;
    const { acquireLock } = await import("@/scripts/worker");

    const ok = await acquireLock();
    expect(ok).toBe(true);
    expect(queryRawMock).not.toHaveBeenCalled();
  });

  it("acquireLock 成功：locked=true 时返回 true", async () => {
    process.env.DATABASE_URL = "postgresql://x";
    queryRawMock.mockResolvedValueOnce([{ locked: true }]);
    const { acquireLock } = await import("@/scripts/worker");

    const ok = await acquireLock();
    expect(ok).toBe(true);
    expect(queryRawMock).toHaveBeenCalledTimes(1);

    const [strings, ...values] = queryRawMock.mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[],
    ];
    expect(strings.join("?")).toMatch(/pg_try_advisory_lock/);
    expect(values).toContain("email_worker");
  });

  it("acquireLock 失败：locked=false 时返回 false", async () => {
    process.env.DATABASE_URL = "postgresql://x";
    queryRawMock.mockResolvedValueOnce([{ locked: false }]);
    const { acquireLock } = await import("@/scripts/worker");

    const ok = await acquireLock();
    expect(ok).toBe(false);
  });

  it("releaseLock 仅在持锁后才发出 unlock SQL", async () => {
    process.env.DATABASE_URL = "postgresql://x";
    queryRawMock.mockResolvedValueOnce([{ locked: true }]); // acquire
    queryRawMock.mockResolvedValueOnce([{ unlocked: true }]); // release

    const { acquireLock, releaseLock } = await import("@/scripts/worker");
    await acquireLock();
    await releaseLock();

    expect(queryRawMock).toHaveBeenCalledTimes(2);
    const [strings] = queryRawMock.mock.calls[1] as [
      TemplateStringsArray,
      ...unknown[],
    ];
    expect(strings.join("?")).toMatch(/pg_advisory_unlock/);
  });

  it("releaseLock 在未持锁时为 no-op", async () => {
    process.env.DATABASE_URL = "postgresql://x";
    queryRawMock.mockResolvedValueOnce([{ locked: false }]); // acquire 失败

    const { acquireLock, releaseLock } = await import("@/scripts/worker");
    await acquireLock();
    queryRawMock.mockClear();
    await releaseLock();

    expect(queryRawMock).not.toHaveBeenCalled();
  });
});
