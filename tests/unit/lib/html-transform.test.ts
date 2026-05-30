import { describe, it, expect } from "vitest";
import { transformHtml, verifyClickHmac } from "@/lib/modules/campaign/html-transform";

const BASE_OPTS = {
  campaignId: "camp_1",
  recipientId: "rcpt_1",
  appUrl: "https://app.test",
  sessionSecret: "test-secret-key-1234",
};

describe("html-transform: UTM injection", () => {
  it("adds UTM params to http links", () => {
    const html = '<a href="https://example.com/page">Click</a>';
    const result = transformHtml(html, { ...BASE_OPTS, enableTracking: false });
    expect(result).toContain("utm_source=email");
    expect(result).toContain("utm_medium=email");
    expect(result).toContain("utm_campaign=camp_1");
    expect(result).toContain("utm_content=link-0");
  });

  it("does not overwrite existing utm_source", () => {
    const html = '<a href="https://example.com?utm_source=google">Click</a>';
    const result = transformHtml(html, { ...BASE_OPTS, enableTracking: false });
    expect(result).toContain("utm_source=google");
    expect(result).not.toContain("utm_source=email");
  });

  it("skips mailto: and tel: links", () => {
    const html = '<a href="mailto:a@b.com">Mail</a><a href="tel:123">Call</a>';
    const result = transformHtml(html, { ...BASE_OPTS, enableTracking: false });
    expect(result).toContain('href="mailto:a@b.com"');
    expect(result).toContain('href="tel:123"');
  });

  it("skips unsubscribe links", () => {
    const html = '<a href="https://example.com/unsubscribe?token=abc">退订</a>';
    const result = transformHtml(html, { ...BASE_OPTS, enableTracking: false });
    expect(result).not.toContain("utm_source");
  });

  it("applies custom UTM params overriding defaults", () => {
    const html = '<a href="https://example.com">Click</a>';
    const result = transformHtml(html, {
      ...BASE_OPTS,
      enableTracking: false,
      utmParams: { utm_source: "newsletter", utm_term: "promo" },
    });
    expect(result).toContain("utm_source=newsletter");
    expect(result).toContain("utm_term=promo");
    expect(result).toContain("utm_medium=email");
  });
});

describe("html-transform: link tracking", () => {
  it("rewrites links to tracking URL", () => {
    const html = '<a href="https://example.com">Click</a>';
    const result = transformHtml(html, BASE_OPTS);
    expect(result).toContain("https://app.test/api/track/click");
    expect(result).toContain("rid=rcpt_1");
  });

  it("disables tracking when enableTracking=false", () => {
    const html = '<a href="https://example.com">Click</a>';
    const result = transformHtml(html, { ...BASE_OPTS, enableTracking: false });
    expect(result).not.toContain("/api/track/click");
  });
});

describe("html-transform: HMAC verification", () => {
  it("verifyClickHmac returns true for valid HMAC", () => {
    const html = '<a href="https://example.com">Click</a>';
    const result = transformHtml(html, BASE_OPTS);
    const match = result.match(/t=([a-f0-9]+)/);
    expect(match).not.toBeNull();
    const hmac = match![1]!;
    const urlMatch = result.match(/url=([^&"]+)/);
    const originalUrl = decodeURIComponent(urlMatch![1]!);
    expect(verifyClickHmac("rcpt_1", originalUrl, "test-secret-key-1234", hmac)).toBe(true);
  });

  it("verifyClickHmac returns false for tampered HMAC", () => {
    expect(verifyClickHmac("rcpt_1", "https://evil.com", "test-secret-key-1234", "0000000000000000")).toBe(false);
  });

  it("emits full 64-hex HMAC (not truncated)", () => {
    const html = '<a href="https://example.com">Click</a>';
    const result = transformHtml(html, BASE_OPTS);
    const match = result.match(/t=([a-f0-9]+)/);
    expect(match).not.toBeNull();
    expect(match![1]!).toHaveLength(64);
  });
});
