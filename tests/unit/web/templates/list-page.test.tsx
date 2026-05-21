/**
 * 模板列表页（M2 11.5.8b）相关 helper / 渲染单测。
 *
 * - LocaleBadges：按 zh/en 顺序渲染、默认 locale 标记 ★、无 locale 不渲染。
 * - buildDuplicatePayload：保留 defaultLocale，按 locale 复制 subject/html/text，
 *   textContent 为空时省略。
 * - nextDuplicateName：去除已有「(副本)」后缀，attempt 1 时不带序号。
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import {
  LocaleBadges,
  buildDuplicatePayload,
  nextDuplicateName,
} from "@/app/(dashboard)/templates/_components/templates-list-page";
import type { TemplateRecord } from "@/app/(dashboard)/templates/_components/types";

describe("LocaleBadges", () => {
  it("renders nothing when there are no locales", () => {
    const { container } = render(
      <LocaleBadges
        templateId="t1"
        defaultLocale="zh"
        availableLocales={[]}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders badges in zh-then-en order regardless of input order", () => {
    render(
      <LocaleBadges
        templateId="t1"
        defaultLocale="zh"
        availableLocales={["en", "zh"]}
      />,
    );
    const wrapper = screen.getByTestId("template-locales-t1");
    const labels = Array.from(wrapper.querySelectorAll("[data-testid^=template-locale-badge-]"));
    expect(labels.map((el) => el.getAttribute("data-testid"))).toEqual([
      "template-locale-badge-t1-zh",
      "template-locale-badge-t1-en",
    ]);
  });

  it("marks the default locale with ★ and data-default=true", () => {
    render(
      <LocaleBadges
        templateId="t1"
        defaultLocale="en"
        availableLocales={["zh", "en"]}
      />,
    );
    const zh = screen.getByTestId("template-locale-badge-t1-zh");
    const en = screen.getByTestId("template-locale-badge-t1-en");
    expect(zh.getAttribute("data-default")).toBe("false");
    expect(en.getAttribute("data-default")).toBe("true");
    expect(en.textContent).toContain("★");
    expect(zh.textContent).not.toContain("★");
  });
});

describe("buildDuplicatePayload", () => {
  const base: TemplateRecord = {
    id: "t1",
    name: "Welcome",
    defaultLocale: "zh",
    variables: [],
    version: 1,
    isArchived: false,
    createdAt: "2026-05-20T00:00:00Z",
    updatedAt: "2026-05-20T00:00:00Z",
    locales: [
      {
        locale: "zh",
        subject: "你好",
        htmlContent: "<p>hi</p>",
        textContent: "hi",
      },
      {
        locale: "en",
        subject: "Hello",
        htmlContent: "<p>hello</p>",
        textContent: null,
      },
    ],
  };

  it("preserves defaultLocale and copies all locale contents", () => {
    const out = buildDuplicatePayload(base);
    expect(out.defaultLocale).toBe("zh");
    expect(out.locales.zh).toEqual({
      subject: "你好",
      htmlContent: "<p>hi</p>",
      textContent: "hi",
    });
  });

  it("omits textContent when it is null/empty", () => {
    const out = buildDuplicatePayload(base);
    expect(out.locales.en).toEqual({
      subject: "Hello",
      htmlContent: "<p>hello</p>",
    });
    expect("textContent" in out.locales.en).toBe(false);
  });
});

describe("nextDuplicateName", () => {
  it("uses (副本) for the first attempt", () => {
    expect(nextDuplicateName("Welcome", 1)).toBe("Welcome (副本)");
  });

  it("appends a counter from attempt 2 onwards", () => {
    expect(nextDuplicateName("Welcome", 2)).toBe("Welcome (副本 2)");
    expect(nextDuplicateName("Welcome", 5)).toBe("Welcome (副本 5)");
  });

  it("strips an existing (副本) / (副本 N) suffix before adding a new one", () => {
    expect(nextDuplicateName("Welcome (副本)", 1)).toBe("Welcome (副本)");
    expect(nextDuplicateName("Welcome (副本 3)", 2)).toBe("Welcome (副本 2)");
  });
});
