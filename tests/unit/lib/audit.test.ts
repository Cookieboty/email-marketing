import { describe, it, expect, vi, beforeEach } from "vitest";

const createMock = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    auditLog: {
      create: (...args: unknown[]) => createMock(...args),
    },
  },
}));

import { audit, auditNow, maskDetails } from "@/lib/audit";

describe("audit: maskDetails", () => {
  it("masks email field", () => {
    expect(maskDetails({ email: "abcdef@x.com" })?.email).toBe("abc***@x.com");
  });
  it("masks userEmail / to fields", () => {
    expect(maskDetails({ userEmail: "abcdef@x.com" })?.userEmail).toBe("abc***@x.com");
    expect(maskDetails({ to: "abcdef@x.com" })?.to).toBe("abc***@x.com");
  });
  it("masks emails[] array entries", () => {
    expect(maskDetails({ emails: ["abcdef@x.com"] })?.emails).toEqual(["abc***@x.com"]);
  });
  it("leaves non-email fields untouched", () => {
    expect(maskDetails({ count: 5, foo: "bar" })).toEqual({ count: 5, foo: "bar" });
  });
});

describe("audit: auditNow", () => {
  beforeEach(() => {
    createMock.mockReset();
    createMock.mockResolvedValue({ id: "x" });
  });

  it("rejects malformed action strings", async () => {
    await expect(
      auditNow({ action: "BAD ACTION", entityType: "x", entityId: "y", actorType: "ADMIN" }),
    ).rejects.toThrow();
  });

  it("writes a sanitized record", async () => {
    await auditNow({
      action: "user.create",
      entityType: "user",
      entityId: "u1",
      actorType: "ADMIN",
      details: { email: "abcdef@x.com" },
      ipAddress: "1.2.3.4",
      userAgent: "ua",
    });
    expect(createMock).toHaveBeenCalledTimes(1);
    const data = createMock.mock.calls[0]![0].data;
    expect(data.action).toBe("user.create");
    expect(data.details.email).toBe("abc***@x.com");
    expect(data.ipAddress).toBe("1.2.3.4");
    expect(data.userAgent).toBe("ua");
  });

  it("extracts ip/ua from headers when provided", async () => {
    const req = {
      headers: new Headers({ "x-forwarded-for": "9.9.9.9, 1.1.1.1", "user-agent": "Bot/1.0" }),
    };
    await auditNow({
      action: "user.login",
      entityType: "user",
      entityId: "u1",
      actorType: "ADMIN",
      req,
    });
    const data = createMock.mock.calls[0]![0].data;
    expect(data.ipAddress).toBe("9.9.9.9");
    expect(data.userAgent).toBe("Bot/1.0");
  });
});

describe("audit: audit() fire-and-forget", () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  it("does not throw when underlying create rejects", async () => {
    createMock.mockRejectedValueOnce(new Error("db down"));
    expect(() =>
      audit({ action: "user.create", entityType: "user", entityId: "u1", actorType: "ADMIN" }),
    ).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
  });

  it("returns synchronously (does not block business)", () => {
    createMock.mockResolvedValue({ id: "x" });
    const start = Date.now();
    audit({ action: "user.create", entityType: "user", entityId: "u1", actorType: "ADMIN" });
    expect(Date.now() - start).toBeLessThan(20);
  });
});
