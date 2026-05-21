import { describe, expect, it } from "vitest";
import {
  getUnsubscribeDict,
  UNSUBSCRIBE_FALLBACK_LOCALE,
} from "@/lib/modules/subscription-category/unsubscribe-i18n";

describe("getUnsubscribeDict", () => {
  it("returns Chinese dictionary when locale=zh", () => {
    const dict = getUnsubscribeDict("zh");
    expect(dict.pageButtonConfirm).toBe("确认退订");
    expect(dict.globalSuccessBody).toContain("将不再收到");
  });

  it("returns English dictionary when locale=en", () => {
    const dict = getUnsubscribeDict("en");
    expect(dict.pageButtonConfirm).toBe("Confirm unsubscribe");
    expect(dict.globalSuccessBody).toMatch(/will no longer/i);
  });

  it("falls back when locale is null or unknown", () => {
    const fallback = getUnsubscribeDict(null);
    expect(fallback).toEqual(getUnsubscribeDict(UNSUBSCRIBE_FALLBACK_LOCALE));
  });

  it("interpolates names into category / topic templates", () => {
    const dict = getUnsubscribeDict("en");
    expect(dict.categorySuccessBody("Promotions")).toContain('"Promotions"');
    expect(dict.topicSuccessBody("Weekly")).toContain('"Weekly"');
  });
});
