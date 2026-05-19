import { describe, it, expect } from "vitest";
import {
  render,
  extractVariables,
  escapeHtml,
  buildBuiltinVariables,
  MissingVariableError,
  RAW_HTML_VARIABLES,
  BUILTIN_VARIABLE_NAMES,
} from "@/lib/template-engine";

describe("template-engine: escapeHtml", () => {
  it("escapes 5 critical HTML characters", () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
  });

  it("does not double-escape entity sequences", () => {
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
  });

  it("returns empty string unchanged", () => {
    expect(escapeHtml("")).toBe("");
  });
});

describe("template-engine: render", () => {
  it("replaces simple variable", () => {
    expect(render("Hi {{name}}", { name: "Bob" })).toBe("Hi Bob");
  });

  it("escapes HTML in user-provided values", () => {
    expect(render("<p>{{x}}</p>", { x: "<script>" })).toBe("<p>&lt;script&gt;</p>");
  });

  it("does not escape unsubscribe_link (raw HTML allowed)", () => {
    const out = render("Footer: {{unsubscribe_link}}", {}, {
      builtin: { unsubscribeUrl: "https://app.test/u/abc" },
    });
    expect(out).toContain('<a href="https://app.test/u/abc">');
    expect(out).toContain("退订</a>");
  });

  it("escapes unsafe URL inside unsubscribe_link", () => {
    const out = render("{{unsubscribe_link}}", {}, {
      builtin: { unsubscribeUrl: 'https://x?y="</a>' },
    });
    expect(out).toContain("&quot;");
    expect(out).toContain("&lt;/a&gt;");
  });

  it("builtin variables take precedence over user vars", () => {
    const out = render("{{user_email}}", { user_email: "spoofed@x.com" }, {
      builtin: { userEmail: "real@x.com" },
    });
    expect(out).toBe("real@x.com");
  });

  it("missing strategy=empty replaces with empty string by default", () => {
    expect(render("[{{x}}]", {})).toBe("[]");
  });

  it("missing strategy=keep retains placeholder", () => {
    expect(render("[{{x}}]", {}, { missing: "keep" })).toBe("[{{x}}]");
  });

  it("missing strategy=throw throws MissingVariableError", () => {
    expect(() => render("[{{x}}]", {}, { missing: "throw" })).toThrow(MissingVariableError);
  });

  it("supports multiple occurrences", () => {
    expect(render("{{a}}-{{a}}-{{b}}", { a: "1", b: "2" })).toBe("1-1-2");
  });

  it("preserves literal text outside placeholders", () => {
    expect(render("hello world", {})).toBe("hello world");
  });

  it("ignores invalid placeholder syntax", () => {
    expect(render("{{ space }}", { " space ": "x" })).toBe("{{ space }}");
  });

  it("handles consecutive placeholders without space", () => {
    expect(render("{{a}}{{b}}", { a: "x", b: "y" })).toBe("xy");
  });

  it("nested {{{{x}}}} renders to '{{' + value + '}}'", () => {
    expect(render("{{{{x}}}}", { x: "v" })).toBe("{{v}}");
  });

  it("current_year is current year as string", () => {
    const fixed = new Date(2030, 5, 1);
    const out = render("{{current_year}}", {}, { builtin: { now: fixed } });
    expect(out).toBe("2030");
  });

  it("missing builtin (e.g., unsubscribe_url undefined) renders empty without error", () => {
    expect(render("[{{unsubscribe_url}}]", {})).toBe("[]");
  });

  it("user_email passes through with escaping", () => {
    const out = render("{{user_email}}", {}, { builtin: { userEmail: "<a@b>" } });
    expect(out).toBe("&lt;a@b&gt;");
  });

  it("does not match placeholders with hyphens (only \\w supported)", () => {
    expect(render("{{user-name}}", { "user-name": "x" }, { missing: "keep" })).toBe(
      "{{user-name}}",
    );
  });
});

describe("template-engine: extractVariables", () => {
  it("returns unique variables in order", () => {
    expect(extractVariables("{{a}} {{b}} {{a}} {{c}}")).toEqual(["a", "b", "c"]);
  });

  it("returns empty for plain text", () => {
    expect(extractVariables("no placeholders here")).toEqual([]);
  });

  it("includes builtin names if used", () => {
    expect(extractVariables("{{unsubscribe_link}}{{user_name}}")).toEqual([
      "unsubscribe_link",
      "user_name",
    ]);
  });
});

describe("template-engine: builtin set", () => {
  it("RAW_HTML_VARIABLES contains unsubscribe_link", () => {
    expect(RAW_HTML_VARIABLES.has("unsubscribe_link")).toBe(true);
  });

  it("BUILTIN_VARIABLE_NAMES is non-empty and includes core names", () => {
    expect(BUILTIN_VARIABLE_NAMES).toContain("unsubscribe_url");
    expect(BUILTIN_VARIABLE_NAMES).toContain("current_year");
  });

  it("buildBuiltinVariables returns escaped link with default text", () => {
    const v = buildBuiltinVariables({ unsubscribeUrl: "https://x/u" });
    expect(v.unsubscribe_link).toContain('href="https://x/u"');
  });
});
