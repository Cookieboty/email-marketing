/**
 * Suppression schema 单元测试：归一化/三种类型校验/PATTERN 安全性。
 */

import { describe, expect, it } from "vitest";
import {
  CreateSuppressionSchema,
  isPatternSafe,
  normalizeSuppressionValue,
} from "@/lib/modules/suppression/schema";

describe("suppression/schema", () => {
  describe("normalizeSuppressionValue", () => {
    it("EMAIL lowercases and trims", () => {
      expect(normalizeSuppressionValue("EMAIL", "  Foo@Bar.COM  ")).toBe("foo@bar.com");
    });
    it("DOMAIN lowercases and trims", () => {
      expect(normalizeSuppressionValue("DOMAIN", "  Spam.Com  ")).toBe("spam.com");
    });
    it("PATTERN keeps original case (only trim)", () => {
      expect(normalizeSuppressionValue("PATTERN", "  %Promo%  ")).toBe("%Promo%");
    });
  });

  describe("isPatternSafe", () => {
    it("rejects pure wildcards", () => {
      expect(isPatternSafe("%")).toBe(false);
      expect(isPatternSafe("%%")).toBe(false);
      expect(isPatternSafe("__")).toBe(false);
      expect(isPatternSafe("%_%")).toBe(false);
    });
    it("accepts patterns with literals", () => {
      expect(isPatternSafe("%spam%")).toBe(true);
      expect(isPatternSafe("user_%")).toBe(true);
      expect(isPatternSafe("a")).toBe(true);
    });
    it("treats escaped backslash sequence as literal", () => {
      expect(isPatternSafe("\\%")).toBe(true);
    });
  });

  describe("CreateSuppressionSchema", () => {
    it("validates EMAIL type", () => {
      expect(
        CreateSuppressionSchema.safeParse({ type: "EMAIL", value: "a@b.com" }).success,
      ).toBe(true);
      expect(
        CreateSuppressionSchema.safeParse({ type: "EMAIL", value: "not-an-email" }).success,
      ).toBe(false);
    });
    it("validates DOMAIN type rejects wildcards and leading dot", () => {
      expect(
        CreateSuppressionSchema.safeParse({ type: "DOMAIN", value: "spam.com" }).success,
      ).toBe(true);
      expect(
        CreateSuppressionSchema.safeParse({ type: "DOMAIN", value: ".spam.com" }).success,
      ).toBe(false);
      expect(
        CreateSuppressionSchema.safeParse({ type: "DOMAIN", value: "%.com" }).success,
      ).toBe(false);
      expect(
        CreateSuppressionSchema.safeParse({ type: "DOMAIN", value: "no-tld" }).success,
      ).toBe(false);
    });
    it("validates PATTERN safety", () => {
      expect(
        CreateSuppressionSchema.safeParse({ type: "PATTERN", value: "%spam%" }).success,
      ).toBe(true);
      expect(
        CreateSuppressionSchema.safeParse({ type: "PATTERN", value: "%" }).success,
      ).toBe(false);
    });
  });
});
