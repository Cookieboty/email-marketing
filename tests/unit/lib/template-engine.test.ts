import { describe, it, expect } from "vitest";
import {
  render,
  extractVariables,
  escapeHtml,
  buildBuiltinVariables,
  MissingVariableError,
  RAW_HTML_VARIABLES,
  BUILTIN_VARIABLE_NAMES,
  expandBlocks,
  extractBlockRefs,
  extractAllVariables,
  BlockExpansionError,
  type BlockResolver,
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

  it("RAW_HTML_VARIABLES contains unsubscribe_topic_link", () => {
    expect(RAW_HTML_VARIABLES.has("unsubscribe_topic_link")).toBe(true);
  });

  it("BUILTIN_VARIABLE_NAMES is non-empty and includes core names", () => {
    expect(BUILTIN_VARIABLE_NAMES).toContain("unsubscribe_url");
    expect(BUILTIN_VARIABLE_NAMES).toContain("current_year");
    expect(BUILTIN_VARIABLE_NAMES).toContain("unsubscribe_topic_url");
    expect(BUILTIN_VARIABLE_NAMES).toContain("unsubscribe_topic_link");
  });

  it("buildBuiltinVariables returns escaped link with default text", () => {
    const v = buildBuiltinVariables({ unsubscribeUrl: "https://x/u" });
    expect(v.unsubscribe_link).toContain('href="https://x/u"');
  });

  it("buildBuiltinVariables generates topic link only when topic url provided", () => {
    const empty = buildBuiltinVariables({});
    expect(empty.unsubscribe_topic_url).toBe("");
    expect(empty.unsubscribe_topic_link).toBe("");

    const withTopic = buildBuiltinVariables({
      unsubscribeTopicUrl: "https://x/u?topic=t1",
    });
    expect(withTopic.unsubscribe_topic_url).toBe("https://x/u?topic=t1");
    expect(withTopic.unsubscribe_topic_link).toContain('href="https://x/u?topic=t1"');
    expect(withTopic.unsubscribe_topic_link).toContain("退订该主题");
  });

  it("buildBuiltinVariables uses custom topic link text", () => {
    const v = buildBuiltinVariables({
      unsubscribeTopicUrl: "https://x/u?topic=t1",
      unsubscribeTopicLinkText: "Unsubscribe from this topic",
    });
    expect(v.unsubscribe_topic_link).toContain("Unsubscribe from this topic");
  });
});

describe("template-engine: unsubscribe_topic_link rendering", () => {
  it("renders raw HTML anchor when topic url provided", () => {
    const out = render("Topic: {{unsubscribe_topic_link}}", {}, {
      builtin: { unsubscribeTopicUrl: "https://app.test/u/abc?topic=campaign1" },
    });
    expect(out).toContain('<a href="https://app.test/u/abc?topic=campaign1">');
    expect(out).toContain("退订该主题</a>");
  });

  it("renders empty when topic url not provided", () => {
    const out = render("Topic: [{{unsubscribe_topic_link}}]", {}, { builtin: {} });
    expect(out).toBe("Topic: []");
  });

  it("escapes unsafe URL characters inside topic link", () => {
    const out = render("{{unsubscribe_topic_link}}", {}, {
      builtin: { unsubscribeTopicUrl: 'https://x?topic="</a>' },
    });
    expect(out).toContain("&quot;");
    expect(out).toContain("&lt;/a&gt;");
  });
});

function makeResolver(map: Record<string, string>): BlockResolver {
  return {
    get(name: string) {
      return Object.prototype.hasOwnProperty.call(map, name) ? map[name]! : null;
    },
  };
}

describe("template-engine: expandBlocks", () => {
  it("expands a single-level block reference", () => {
    const r = makeResolver({ footer: "<p>bye</p>" });
    expect(expandBlocks("Hi {{> footer}}", r)).toBe("Hi <p>bye</p>");
  });

  it("expands nested block references depth-first", () => {
    const r = makeResolver({ A: "{{> B}}", B: "hello" });
    expect(expandBlocks("{{> A}}", r)).toBe("hello");
  });

  it("detects 2-cycle and throws CYCLE with full trace", () => {
    const r = makeResolver({ A: "{{> B}}", B: "{{> A}}" });
    expect.assertions(3);
    try {
      expandBlocks("{{> A}}", r);
    } catch (err) {
      expect(err).toBeInstanceOf(BlockExpansionError);
      const e = err as BlockExpansionError;
      expect(e.code).toBe("CYCLE");
      expect(e.trace).toEqual(["A", "B", "A"]);
    }
  });

  it("detects self-reference cycle", () => {
    const r = makeResolver({ A: "{{> A}}" });
    expect.assertions(2);
    try {
      expandBlocks("{{> A}}", r);
    } catch (err) {
      const e = err as BlockExpansionError;
      expect(e.code).toBe("CYCLE");
      expect(e.trace).toEqual(["A", "A"]);
    }
  });

  it("throws DEPTH when nesting exceeds maxDepth (default 4)", () => {
    // A→B→C→D→E：5 层超过 maxDepth=4
    const r = makeResolver({
      A: "{{> B}}",
      B: "{{> C}}",
      C: "{{> D}}",
      D: "{{> E}}",
      E: "leaf",
    });
    expect.assertions(2);
    try {
      expandBlocks("{{> A}}", r);
    } catch (err) {
      const e = err as BlockExpansionError;
      expect(e.code).toBe("DEPTH");
      expect(e.trace).toEqual(["A", "B", "C", "D", "E"]);
    }
  });

  it("throws SIZE on fan-out expansion exceeding maxBytes", () => {
    // 每层引用同一片段两次 → 5 层 ~ 2^5=32 倍膨胀；用低 maxBytes 触发
    const big = "x".repeat(64);
    const r = makeResolver({
      L1: "{{> L2}}{{> L2}}",
      L2: "{{> L3}}{{> L3}}",
      L3: "{{> L4}}{{> L4}}",
      L4: big,
    });
    expect.assertions(1);
    try {
      expandBlocks("{{> L1}}", r, { maxBytes: 256 });
    } catch (err) {
      expect((err as BlockExpansionError).code).toBe("SIZE");
    }
  });

  it("missing='throw' raises MISSING for unknown ref", () => {
    const r = makeResolver({});
    expect.assertions(2);
    try {
      expandBlocks("{{> ghost}}", r);
    } catch (err) {
      const e = err as BlockExpansionError;
      expect(e.code).toBe("MISSING");
      expect(e.blockName).toBe("ghost");
    }
  });

  it("missing='keep' preserves the original token", () => {
    const r = makeResolver({});
    expect(expandBlocks("Hi {{> ghost}}!", r, { missing: "keep" })).toBe(
      "Hi {{> ghost}}!",
    );
  });

  it("missing='empty' replaces unknown ref with empty string", () => {
    const r = makeResolver({});
    expect(expandBlocks("Hi {{> ghost}}!", r, { missing: "empty" })).toBe(
      "Hi !",
    );
  });

  it("does NOT replace variables in stage 1 (mixed with vars)", () => {
    const r = makeResolver({ hdr: "Hi {{user_name}}" });
    // 展开后片段内的变量原样保留，留给 Stage 2
    expect(expandBlocks("{{> hdr}} {{user_name}}", r)).toBe(
      "Hi {{user_name}} {{user_name}}",
    );
  });

  it("stage-2 variable output is NOT re-parsed as block ref", () => {
    // render 的产物里出现 {{> evil}} 不应触发 evil 展开
    const r = makeResolver({ hdr: "static" });
    // 用非 builtin 变量名 my_var；user_name 是 builtin 会被空内置覆盖掉
    const stage1 = expandBlocks("{{> hdr}} {{my_var}}", r);
    expect(stage1).toBe("static {{my_var}}");
    // 外部调用方先 expandBlocks 后 render；变量值含 {{> evil}} 字面量应当原样保留
    const stage2 = render(stage1, { my_var: "{{> evil}}" });
    // my_var 经 escapeHtml：< > ' " & 被转义；{} 不在 escape 列表里——所以保留花括号字面量；
    // > 会被转义为 &gt;。Stage 2 产物即使含 {{> 也无法被再次解析（不变量 3）。
    expect(stage2).toBe("static {{&gt; evil}}");
  });

  it("tolerates whitespace around block name", () => {
    const r = makeResolver({ footer: "ok" });
    expect(expandBlocks("a{{>   footer  }}b", r)).toBe("aokb");
  });

  it("supports hyphenated block names", () => {
    const r = makeResolver({ "brand-footer": "BF" });
    expect(expandBlocks("X {{> brand-footer}}", r)).toBe("X BF");
  });
});

describe("template-engine: extractBlockRefs", () => {
  it("dedupes multiple references to the same block", () => {
    expect(extractBlockRefs("{{> a}} mid {{> a}} end {{> b}}")).toEqual([
      "a",
      "b",
    ]);
  });

  it("returns empty array when no references exist", () => {
    expect(extractBlockRefs("just {{user_name}} variables")).toEqual([]);
  });
});

describe("template-engine: extractAllVariables", () => {
  it("collects variables across the template and its referenced blocks", () => {
    const r = makeResolver({ footer: "{{company_name}}" });
    const vars = extractAllVariables("{{user_name}} {{> footer}}", r);
    expect(vars).toEqual(["user_name", "company_name"]);
  });
});
