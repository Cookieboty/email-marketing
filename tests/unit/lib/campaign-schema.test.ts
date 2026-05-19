import { describe, it, expect } from "vitest";
import {
  CreateCampaignSchema,
  UpdateCampaignSchema,
  ListCampaignsQuerySchema,
  ScheduleCampaignSchema,
  SendCampaignSchema,
} from "@/lib/modules/campaign/schema";

describe("campaign schema", () => {
  describe("CreateCampaignSchema", () => {
    it("accepts minimal valid input", () => {
      const result = CreateCampaignSchema.safeParse({
        name: "My Campaign",
        templateId: "tpl_1",
      });
      expect(result.success).toBe(true);
    });

    it("requires A/B config when isAbTest=true", () => {
      const result = CreateCampaignSchema.safeParse({
        name: "AB Test",
        templateId: "tpl_1",
        isAbTest: true,
      });
      expect(result.success).toBe(false);
    });

    it("requires 2+ variants when isAbTest=true", () => {
      const result = CreateCampaignSchema.safeParse({
        name: "AB Test",
        templateId: "tpl_1",
        isAbTest: true,
        abTestConfig: { winnerMetric: "open", testDurationHours: 24 },
        variants: [
          { variantName: "A", subject: "Sub A", htmlContent: "<p>A</p>", samplePercentage: 10 },
        ],
      });
      expect(result.success).toBe(false);
    });

    it("accepts valid A/B test input", () => {
      const result = CreateCampaignSchema.safeParse({
        name: "AB Test",
        templateId: "tpl_1",
        isAbTest: true,
        abTestConfig: { winnerMetric: "open", testDurationHours: 24 },
        variants: [
          { variantName: "A", subject: "Sub A", htmlContent: "<p>A</p>", samplePercentage: 10 },
          { variantName: "B", subject: "Sub B", htmlContent: "<p>B</p>", samplePercentage: 10 },
        ],
      });
      expect(result.success).toBe(true);
    });

    it("rejects A/B variants whose samplePercentage sum exceeds 50", () => {
      const result = CreateCampaignSchema.safeParse({
        name: "AB Test",
        templateId: "tpl_1",
        isAbTest: true,
        abTestConfig: { winnerMetric: "click", testDurationHours: 12 },
        variants: [
          { variantName: "A", subject: "S", htmlContent: "<p>A</p>", samplePercentage: 30 },
          { variantName: "B", subject: "S", htmlContent: "<p>B</p>", samplePercentage: 30 },
        ],
      });
      expect(result.success).toBe(false);
    });

    it("rejects duplicate variantName", () => {
      const result = CreateCampaignSchema.safeParse({
        name: "AB Test",
        templateId: "tpl_1",
        isAbTest: true,
        abTestConfig: { winnerMetric: "click", testDurationHours: 12 },
        variants: [
          { variantName: "A", subject: "S", htmlContent: "<p>A</p>", samplePercentage: 10 },
          { variantName: "A", subject: "S", htmlContent: "<p>B</p>", samplePercentage: 10 },
        ],
      });
      expect(result.success).toBe(false);
    });

    it("rejects unknown abTestConfig keys (strict)", () => {
      const result = CreateCampaignSchema.safeParse({
        name: "AB Test",
        templateId: "tpl_1",
        isAbTest: true,
        abTestConfig: {
          winnerMetric: "open",
          testDurationHours: 24,
          unknownField: 1,
        },
        variants: [
          { variantName: "A", subject: "S", htmlContent: "<p>A</p>", samplePercentage: 10 },
          { variantName: "B", subject: "S", htmlContent: "<p>B</p>", samplePercentage: 10 },
        ],
      });
      expect(result.success).toBe(false);
    });

    it("normalizes tagFilterMode AND->ALL", () => {
      const result = CreateCampaignSchema.parse({
        name: "Test",
        templateId: "tpl_1",
        tagFilterMode: "AND",
      });
      expect(result.tagFilterMode).toBe("ALL");
    });
  });

  describe("UpdateCampaignSchema", () => {
    it("rejects empty body", () => {
      const result = UpdateCampaignSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it("allows single field update", () => {
      const result = UpdateCampaignSchema.safeParse({ name: "New Name" });
      expect(result.success).toBe(true);
    });
  });

  describe("ListCampaignsQuerySchema", () => {
    it("defaults page and pageSize", () => {
      const result = ListCampaignsQuerySchema.parse({});
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(20);
    });

    it("accepts valid status filter", () => {
      const result = ListCampaignsQuerySchema.parse({ status: "DRAFT" });
      expect(result.status).toBe("DRAFT");
    });
  });

  describe("ScheduleCampaignSchema", () => {
    it("rejects past date", () => {
      const result = ScheduleCampaignSchema.safeParse({
        scheduledAt: "2020-01-01T00:00:00Z",
      });
      expect(result.success).toBe(false);
    });

    it("accepts future date", () => {
      const future = new Date(Date.now() + 600_000).toISOString();
      const result = ScheduleCampaignSchema.safeParse({ scheduledAt: future });
      expect(result.success).toBe(true);
    });
  });

  describe("SendCampaignSchema", () => {
    it("accepts empty body", () => {
      const result = SendCampaignSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it("accepts undefined (optional)", () => {
      const result = SendCampaignSchema.safeParse(undefined);
      expect(result.success).toBe(true);
    });
  });
});
