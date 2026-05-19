import { describe, it, expect } from "vitest";
import {
  normalizeEmail,
  extractDomain,
  isValidEmail,
  maskEmail,
  stripSubjectHtml,
} from "@/lib/email-utils";

describe("email-utils: normalizeEmail", () => {
  it("trims and lowercases", () => {
    expect(normalizeEmail("  Foo@Bar.COM  ")).toBe("foo@bar.com");
  });
  it("returns empty for nullish", () => {
    expect(normalizeEmail(null)).toBe("");
    expect(normalizeEmail(undefined)).toBe("");
  });
});

describe("email-utils: extractDomain", () => {
  it("returns lowercase domain part", () => {
    expect(extractDomain("Foo@Bar.com")).toBe("bar.com");
  });
  it("returns empty for invalid input", () => {
    expect(extractDomain("no-at-sign")).toBe("");
    expect(extractDomain("trailing@")).toBe("");
  });
});

describe("email-utils: isValidEmail", () => {
  it("accepts well-formed addresses", () => {
    expect(isValidEmail("foo@bar.com")).toBe(true);
  });
  it("rejects malformed addresses", () => {
    expect(isValidEmail("not-an-email")).toBe(false);
    expect(isValidEmail("")).toBe(false);
    expect(isValidEmail(null)).toBe(false);
  });
});

describe("email-utils: maskEmail", () => {
  it("masks local part keeping first 3 chars", () => {
    expect(maskEmail("abcdef@x.com")).toBe("abc***@x.com");
  });
  it("short local masks to first char", () => {
    expect(maskEmail("ab@x.com")).toBe("a***@x.com");
  });
  it("single-char local masks fully", () => {
    expect(maskEmail("a@x.com")).toBe("*@x.com");
  });
  it("returns empty for empty", () => {
    expect(maskEmail("")).toBe("");
  });
});

describe("email-utils: stripSubjectHtml", () => {
  it("removes tags and collapses whitespace", () => {
    expect(stripSubjectHtml("<b>Hi</b>  there")).toBe("Hi there");
  });
  it("removes newlines preventing header injection", () => {
    expect(stripSubjectHtml("Hi\r\nBcc: x@y.com")).toBe("Hi Bcc: x@y.com");
  });
  it("returns empty for nullish", () => {
    expect(stripSubjectHtml(null)).toBe("");
  });
});
