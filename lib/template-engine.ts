/**
 * 模板变量引擎（specs §396-434）。
 *
 * 语法：`{{variable}}`，仅支持 [A-Za-z0-9_]+ 形式的标识符，避免与 CSS/JS 中的 `{{` 冲突。
 *
 * 核心规则：
 *  1. HTML 转义：自实现 5 字符替换 `& < > " '`，避免对 `&amp;` 二次转义。
 *  2. 例外字段：`unsubscribe_link` 视为受信 HTML（合规要求 anchor + 文案），不转义。
 *  3. 内置变量优先级 > 用户提供 vars，禁止前端覆盖 unsubscribe_url 等关键字段。
 *  4. 缺失策略：
 *      - `empty`（默认）：替换为空串
 *      - `keep`：保留原 `{{var}}`
 *      - `throw`：抛 MissingVariableError，由调用方决定是否回退
 *  5. 嵌套花括号 `{{{{x}}}}` 视为 `{{` + `{{x}}` + `}}`，仅匹配最内层一次。
 */

const VAR_RE = /\{\{(\w+)\}\}/g;

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export const RAW_HTML_VARIABLES = new Set<string>(["unsubscribe_link"]);

export type MissingStrategy = "empty" | "keep" | "throw";

export interface BuiltinVariableInput {
  unsubscribeUrl?: string;
  unsubscribeLinkText?: string;
  userEmail?: string;
  userName?: string;
  campaignName?: string;
  now?: Date;
}

export interface RenderOptions {
  builtin?: BuiltinVariableInput;
  missing?: MissingStrategy;
}

export class MissingVariableError extends Error {
  readonly variable: string;
  constructor(variable: string) {
    super(`Missing template variable: ${variable}`);
    this.name = "MissingVariableError";
    this.variable = variable;
  }
}

export function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

export function buildBuiltinVariables(input: BuiltinVariableInput = {}): Record<string, string> {
  const url = input.unsubscribeUrl ?? "";
  const linkText = input.unsubscribeLinkText ?? "退订";
  const link =
    url.length > 0
      ? `<a href="${escapeHtml(url)}">${escapeHtml(linkText)}</a>`
      : "";
  const year = (input.now ?? new Date()).getFullYear().toString();
  return {
    unsubscribe_url: url,
    unsubscribe_link: link,
    user_email: input.userEmail ?? "",
    user_name: input.userName ?? "",
    campaign_name: input.campaignName ?? "",
    current_year: year,
  };
}

export function render(
  template: string,
  vars: Record<string, string> = {},
  opts: RenderOptions = {},
): string {
  const builtin = buildBuiltinVariables(opts.builtin);
  const missing: MissingStrategy = opts.missing ?? "empty";

  return template.replace(VAR_RE, (match, name: string) => {
    const useBuiltin = Object.prototype.hasOwnProperty.call(builtin, name);
    const hasUser = Object.prototype.hasOwnProperty.call(vars, name);

    let value: string | undefined;
    if (useBuiltin) value = builtin[name];
    else if (hasUser) value = vars[name];

    if (value === undefined || value === "") {
      if (useBuiltin) {
        // 内置变量缺省（如未提供 unsubscribeUrl），按 empty 处理
        return RAW_HTML_VARIABLES.has(name) ? "" : "";
      }
      if (missing === "throw") throw new MissingVariableError(name);
      if (missing === "keep") return match;
      return "";
    }

    if (RAW_HTML_VARIABLES.has(name)) return value;
    return escapeHtml(value);
  });
}

export function extractVariables(template: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of template.matchAll(VAR_RE)) {
    const name = m[1]!;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

export const BUILTIN_VARIABLE_NAMES = [
  "unsubscribe_url",
  "unsubscribe_link",
  "user_email",
  "user_name",
  "campaign_name",
  "current_year",
] as const;
