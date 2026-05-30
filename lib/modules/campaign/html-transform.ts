import * as cheerio from "cheerio";
import { createHmac } from "crypto";

export interface TransformHtmlOptions {
  campaignId: string;
  recipientId: string;
  appUrl: string;
  sessionSecret: string;
  utmParams?: Record<string, string> | null;
  enableTracking?: boolean;
}

function generateClickHmac(recipientId: string, url: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`${recipientId}:${url}`)
    .digest("hex");
}

export function verifyClickHmac(
  recipientId: string,
  url: string,
  secret: string,
  hmac: string,
): boolean {
  const expected = generateClickHmac(recipientId, url, secret);
  if (expected.length !== hmac.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ hmac.charCodeAt(i);
  }
  return diff === 0;
}

function isTrackableHref(href: string): boolean {
  if (!href.startsWith("http://") && !href.startsWith("https://")) return false;
  if (href.toLowerCase().includes("unsubscribe")) return false;
  return true;
}

export function transformHtml(html: string, opts: TransformHtmlOptions): string {
  const $ = cheerio.load(html);
  const tracking = opts.enableTracking !== false;
  let linkIndex = 0;

  $("a[href]").each((_i, el) => {
    const href = $(el).attr("href");
    if (!href) return;

    if (href.startsWith("mailto:") || href.startsWith("tel:")) return;
    if (!isTrackableHref(href)) return;

    let parsed: URL;
    try {
      parsed = new URL(href);
    } catch {
      return;
    }

    if (!parsed.searchParams.has("utm_source")) {
      const defaults: Record<string, string> = {
        utm_source: "email",
        utm_medium: "email",
        utm_campaign: opts.campaignId,
        utm_content: `link-${linkIndex}`,
      };
      const merged = { ...defaults, ...(opts.utmParams ?? {}) };
      for (const [k, v] of Object.entries(merged)) {
        parsed.searchParams.set(k, v);
      }
    }

    const finalUrl = parsed.toString();

    if (tracking) {
      const hmac = generateClickHmac(opts.recipientId, finalUrl, opts.sessionSecret);
      const trackUrl = `${opts.appUrl}/api/track/click?rid=${encodeURIComponent(opts.recipientId)}&url=${encodeURIComponent(finalUrl)}&t=${hmac}`;
      $(el).attr("href", trackUrl);
    } else {
      $(el).attr("href", finalUrl);
    }

    linkIndex++;
  });

  return $.html();
}
