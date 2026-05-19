import { describe, it, expect } from "vitest";
import {
  assertTransition,
  canTransition,
  isTerminal,
  targetStateFor,
  listAllowedTransitions,
  TERMINAL_STATES,
} from "@/lib/modules/campaign/state-machine";
import type { CampaignStatus } from "@prisma/client";

const ALL_STATUSES: CampaignStatus[] = [
  "DRAFT", "SCHEDULED", "SENDING", "AB_TESTING", "PAUSED", "COMPLETED", "FAILED", "CANCELLED",
];

describe("campaign state-machine", () => {
  it("terminal states cannot transition to anything", () => {
    for (const ts of TERMINAL_STATES) {
      expect(listAllowedTransitions(ts)).toHaveLength(0);
    }
  });

  it("COMPLETED and CANCELLED are terminal", () => {
    expect(isTerminal("COMPLETED")).toBe(true);
    expect(isTerminal("CANCELLED")).toBe(true);
    expect(isTerminal("DRAFT")).toBe(false);
    expect(isTerminal("SENDING")).toBe(false);
  });

  it("DRAFT -> SCHEDULED via schedule", () => {
    expect(targetStateFor("DRAFT", "schedule")).toBe("SCHEDULED");
    expect(() => assertTransition("DRAFT", "SCHEDULED", "schedule")).not.toThrow();
  });

  it("DRAFT -> SENDING via send", () => {
    expect(canTransition("DRAFT", "SENDING")).toBe(true);
    expect(() => assertTransition("DRAFT", "SENDING", "send")).not.toThrow();
  });

  it("DRAFT -> AB_TESTING via ab_test_start", () => {
    expect(targetStateFor("DRAFT", "ab_test_start")).toBe("AB_TESTING");
  });

  it("SENDING -> PAUSED via pause", () => {
    expect(() => assertTransition("SENDING", "PAUSED", "pause")).not.toThrow();
  });

  it("PAUSED -> SENDING via resume", () => {
    expect(() => assertTransition("PAUSED", "SENDING", "resume")).not.toThrow();
  });

  it("FAILED -> SENDING via retry", () => {
    expect(() => assertTransition("FAILED", "SENDING", "retry")).not.toThrow();
  });

  it("rejects invalid transition DRAFT -> COMPLETED", () => {
    expect(canTransition("DRAFT", "COMPLETED")).toBe(false);
    expect(() => assertTransition("DRAFT", "COMPLETED")).toThrow();
  });

  it("rejects COMPLETED -> SENDING", () => {
    expect(canTransition("COMPLETED", "SENDING")).toBe(false);
    expect(() => assertTransition("COMPLETED", "SENDING")).toThrow();
  });

  it("every non-terminal state can cancel", () => {
    for (const s of ALL_STATUSES) {
      if (isTerminal(s)) continue;
      expect(canTransition(s, "CANCELLED")).toBe(true);
    }
  });
});
