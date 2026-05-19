import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RecipientStatus } from "@prisma/client";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    emailEvent: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    campaignRecipient: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    user: {
      update: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/modules/suppression/check", () => ({
  isSuppressed: vi.fn().mockResolvedValue(false),
}));

vi.mock("@/lib/modules/suppression/repository", () => ({
  suppressionRepository: {
    create: vi.fn(),
  },
}));

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

import { processWebhookEvent } from "@/lib/modules/webhook/handler";
import { prisma } from "@/lib/prisma";

const mockPrisma = prisma as unknown as {
  emailEvent: { findUnique: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  campaignRecipient: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  user: { update: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

describe("webhook handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips event without email_id", async () => {
    const result = await processWebhookEvent({
      type: "delivered",
      data: {},
    });
    expect(result.processed).toBe(false);
    expect(result.reason).toBe("missing email_id");
  });

  it("deduplicates by idempotencyKey", async () => {
    mockPrisma.emailEvent.findUnique.mockResolvedValue({ id: "existing" });

    const result = await processWebhookEvent({
      type: "delivered",
      data: { email_id: "resend_123" },
    });
    expect(result.processed).toBe(false);
    expect(result.reason).toBe("duplicate");
  });

  it("returns not found when recipient is missing", async () => {
    mockPrisma.emailEvent.findUnique.mockResolvedValue(null);
    mockPrisma.campaignRecipient.findUnique.mockResolvedValue(null);

    const result = await processWebhookEvent({
      type: "delivered",
      data: { email_id: "resend_456" },
    });
    expect(result.processed).toBe(false);
    expect(result.reason).toBe("recipient_not_found");
  });

  it("processes delivered event and updates status", async () => {
    mockPrisma.emailEvent.findUnique.mockResolvedValue(null);
    mockPrisma.campaignRecipient.findUnique.mockResolvedValue({
      id: "rcpt_1",
      campaignId: "camp_1",
      userId: "user_1",
      status: "SENT" as RecipientStatus,
      user: { id: "user_1", email: "test@example.com", totalBounceCount: 0, unsubscribed: false },
    });

    mockPrisma.$transaction.mockImplementation(async (fn: Function) => fn(mockPrisma));

    const result = await processWebhookEvent({
      type: "delivered",
      data: { email_id: "resend_789", created_at: new Date().toISOString() },
    });
    expect(result.processed).toBe(true);
  });
});
