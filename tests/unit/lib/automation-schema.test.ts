import { describe, it, expect } from "vitest";
import {
  CreateAutomationSchema,
  UpdateAutomationSchema,
  ListAutomationsQuerySchema,
} from "@/lib/modules/automation/schema";

describe("automation schema", () => {
  describe("CreateAutomationSchema", () => {
    it("accepts valid input", () => {
      const result = CreateAutomationSchema.safeParse({
        name: "Welcome Email",
        triggerType: "USER_CREATED",
        subject: "Welcome!",
      });
      expect(result.success).toBe(true);
    });

    it("rejects missing name", () => {
      const result = CreateAutomationSchema.safeParse({
        triggerType: "USER_CREATED",
        subject: "Welcome!",
      });
      expect(result.success).toBe(false);
    });

    it("rejects invalid triggerType", () => {
      const result = CreateAutomationSchema.safeParse({
        name: "Test",
        triggerType: "INVALID",
        subject: "Welcome!",
      });
      expect(result.success).toBe(false);
    });

    it("accepts all valid trigger types", () => {
      for (const tt of ["USER_CREATED", "TAG_CHANGED", "BIRTHDAY", "REENGAGEMENT", "CUSTOM_EVENT"]) {
        const result = CreateAutomationSchema.safeParse({
          name: "Test",
          triggerType: tt,
          subject: "Hello",
        });
        expect(result.success).toBe(true);
      }
    });

    it("defaults delayMinutes to 0", () => {
      const result = CreateAutomationSchema.parse({
        name: "Test",
        triggerType: "USER_CREATED",
        subject: "Hello",
      });
      expect(result.delayMinutes).toBe(0);
    });

    it("defaults status to DISABLED", () => {
      const result = CreateAutomationSchema.parse({
        name: "Test",
        triggerType: "USER_CREATED",
        subject: "Hello",
      });
      expect(result.status).toBe("DISABLED");
    });
  });

  describe("UpdateAutomationSchema", () => {
    it("rejects empty update", () => {
      const result = UpdateAutomationSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it("accepts partial update", () => {
      const result = UpdateAutomationSchema.safeParse({ name: "New Name" });
      expect(result.success).toBe(true);
    });

    it("rejects unknown fields", () => {
      const result = UpdateAutomationSchema.safeParse({ unknown: true });
      expect(result.success).toBe(false);
    });
  });

  describe("ListAutomationsQuerySchema", () => {
    it("defaults page and pageSize", () => {
      const result = ListAutomationsQuerySchema.parse({});
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(20);
    });

    it("parses status filter", () => {
      const result = ListAutomationsQuerySchema.parse({ status: "ENABLED" });
      expect(result.status).toBe("ENABLED");
    });
  });
});
