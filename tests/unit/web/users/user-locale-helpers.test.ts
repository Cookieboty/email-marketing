import { describe, expect, it } from "vitest";
import {
  diffUserLocale,
  formatUserLocale,
  formatUserLocaleShort,
  parseLocaleFormValue,
} from "@/app/(dashboard)/users/_components/user-locale-helpers";

describe("formatUserLocale", () => {
  it("renders friendly label for known locales", () => {
    expect(formatUserLocale("zh")).toBe("中文");
    expect(formatUserLocale("en")).toBe("English");
  });

  it("renders dash placeholder when locale is null", () => {
    expect(formatUserLocale(null)).toBe("—");
  });
});

describe("formatUserLocaleShort", () => {
  it("returns raw locale code or dash", () => {
    expect(formatUserLocaleShort("zh")).toBe("zh");
    expect(formatUserLocaleShort("en")).toBe("en");
    expect(formatUserLocaleShort(null)).toBe("—");
  });
});

describe("parseLocaleFormValue", () => {
  it("accepts canonical zh/en values", () => {
    expect(parseLocaleFormValue("zh")).toBe("zh");
    expect(parseLocaleFormValue("en")).toBe("en");
  });

  it("returns null for empty/unknown values", () => {
    expect(parseLocaleFormValue("")).toBeNull();
    expect(parseLocaleFormValue("auto")).toBeNull();
    expect(parseLocaleFormValue("ja")).toBeNull();
  });
});

describe("diffUserLocale", () => {
  it("flags transitions from null to value", () => {
    expect(diffUserLocale("zh", null)).toEqual({ changed: true, value: "zh" });
  });

  it("flags transitions from value to null", () => {
    expect(diffUserLocale(null, "en")).toEqual({ changed: true, value: null });
  });

  it("returns unchanged when same", () => {
    expect(diffUserLocale("zh", "zh")).toEqual({ changed: false, value: "zh" });
    expect(diffUserLocale(null, null)).toEqual({ changed: false, value: null });
  });
});
