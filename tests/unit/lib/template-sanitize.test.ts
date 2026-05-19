/**
 * 模板 sanitizeHtml + 与 extractVariables 一致性测试。
 *
 * 不接 DB；只验证：
 *   - script 标签（成对、孤立 open/close、嵌套）都被剥离
 *   - 内联事件处理器被剥离
 *   - href/src 中的 javascript: 协议被替换为 about:blank
 *   - 剥离后剩余的 {{var}} 仍可被 extractVariables 抽出（与渲染端一致）
 */

import { describe, it, expect } from "vitest";
import { sanitizeHtml } from "@/lib/modules/template/service";
import { extractVariables } from "@/lib/template-engine";

describe("sanitizeHtml", () => {
  it("removes paired <script> blocks (case-insensitive)", () => {
    const out = sanitizeHtml(
      `<p>Hi {{user_name}}</p><SCRIPT>alert(1)</SCRIPT><script>alert(2)</script>`,
    );
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toMatch(/alert\(/);
    expect(out).toContain("{{user_name}}");
  });

  it("removes orphan <script> open/close tags", () => {
    const out = sanitizeHtml(
      `<p>{{a}}</p><script src="x.js"><p>{{b}}</p></script>`,
    );
    expect(out).not.toMatch(/<\/?script/i);
    expect(out).toContain("{{a}}");
  });

  it("strips inline event handlers", () => {
    const out = sanitizeHtml(`<a href="/" onclick="boom()" onmouseover='x'>go</a>`);
    expect(out).not.toMatch(/on\w+\s*=/i);
    expect(out).toMatch(/href="\/"/);
  });

  it("rewrites javascript: URLs in href/src to about:blank", () => {
    const out = sanitizeHtml(
      `<a href="javascript:alert(1)">x</a><img src='javascript:alert(2)'/>`,
    );
    expect(out).not.toMatch(/javascript:/i);
    expect(out).toMatch(/href="about:blank"/);
    expect(out).toMatch(/src='about:blank'/);
  });

  it("preserves variables for downstream extractVariables", () => {
    const html = `<p>{{user_name}} <script>{{leak}}</script>{{order_id}}</p>`;
    const cleaned = sanitizeHtml(html);
    const vars = extractVariables(cleaned);
    expect(vars).toContain("user_name");
    expect(vars).toContain("order_id");
    // {{leak}} 在被剥离的 script 内，剥离后不应被抽出
    expect(vars).not.toContain("leak");
  });

  it("is idempotent (a second pass changes nothing)", () => {
    const html = `<p>{{x}}</p><script>1</script><a href="javascript:1">y</a>`;
    const once = sanitizeHtml(html);
    const twice = sanitizeHtml(once);
    expect(twice).toBe(once);
  });
});
