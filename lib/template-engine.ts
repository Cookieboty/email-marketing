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

/**
 * 模板片段引用语法：`{{> blockName}}`。
 *
 * 与 VAR_RE 解耦——VAR_RE 只匹配纯标识符，BLOCK_REF_RE 强制 `>` 前缀，且仅 Stage 1
 * （expandBlocks）会消费它；Stage 2 的 render 永远看不到 `>` 前缀的 token，因此变量
 * 替换的产物里出现 `{{> evil}}` 也不会触发任何展开（spec §核心不变量 3）。
 *
 * 名称字符集：`[A-Za-z0-9_-]+`（与 TemplateBlock.name 一致），允许 `>` 前后任意空白。
 */
const BLOCK_REF_RE = /\{\{\s*>\s*([A-Za-z0-9_-]+)\s*\}\}/g;

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export const RAW_HTML_VARIABLES = new Set<string>([
  "unsubscribe_link",
  "unsubscribe_topic_link",
]);

export type MissingStrategy = "empty" | "keep" | "throw";

export interface BuiltinVariableInput {
  unsubscribeUrl?: string;
  unsubscribeLinkText?: string;
  /** 主题级退订 URL（可选，仅当本封邮件归属某个 Topic 时注入） */
  unsubscribeTopicUrl?: string;
  /** 主题级退订链接文案，默认 “退订该主题” */
  unsubscribeTopicLinkText?: string;
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
  const topicUrl = input.unsubscribeTopicUrl ?? "";
  const topicLinkText = input.unsubscribeTopicLinkText ?? "退订该主题";
  const topicLink =
    topicUrl.length > 0
      ? `<a href="${escapeHtml(topicUrl)}">${escapeHtml(topicLinkText)}</a>`
      : "";
  const year = (input.now ?? new Date()).getFullYear().toString();
  return {
    unsubscribe_url: url,
    unsubscribe_link: link,
    unsubscribe_topic_url: topicUrl,
    unsubscribe_topic_link: topicLink,
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
  "unsubscribe_topic_url",
  "unsubscribe_topic_link",
  "user_email",
  "user_name",
  "campaign_name",
  "current_year",
] as const;

/**
 * 模板片段解析器。
 *
 * 实现负责按 `name` 返回片段的 htmlContent；对调用 `expandBlocks` 的引擎来说是
 * 纯函数：未命中返回 `null`（与 `""` 区分）。`null` 触发 `missing` 策略；空字符串
 * 是合法返回值，按"展开为空"处理。
 *
 * 实现可以是：
 *  - Map / Record 包装（worker 渲染快照路径，从 snapshot.blocks 还原）
 *  - 数据库 batched 查询的内存缓存（模板服务 / 测试发送 / 预览路径）
 */
export interface BlockResolver {
  get(name: string): string | null;
}

export interface ExpandOptions {
  /** 最大递归深度，超出抛 BlockExpansionError(code='DEPTH')。默认 4。 */
  maxDepth?: number;
  /** 展开后字节上限（utf-8），超出抛 BlockExpansionError(code='SIZE')。默认 1 MiB。 */
  maxBytes?: number;
  /** 未命中片段处理策略。默认 'throw'。 */
  missing?: "throw" | "keep" | "empty";
}

export type BlockExpansionErrorCode = "CYCLE" | "DEPTH" | "SIZE" | "MISSING";

export class BlockExpansionError extends Error {
  readonly code: BlockExpansionErrorCode;
  readonly blockName?: string;
  readonly trace?: string[];
  constructor(
    code: BlockExpansionErrorCode,
    message: string,
    detail: { blockName?: string; trace?: string[] } = {},
  ) {
    super(message);
    this.name = "BlockExpansionError";
    this.code = code;
    if (detail.blockName !== undefined) this.blockName = detail.blockName;
    if (detail.trace !== undefined) this.trace = detail.trace;
  }
}

const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_MAX_BYTES = 1024 * 1024;

/**
 * Stage 1：把 `{{> name}}` 引用按 resolver 替换为对应 htmlContent。
 *
 * 核心约束（与 spec §核心不变量对齐）：
 *  1. **不替换变量**：`expandBlocks` 只做字符串拼接，`{{var}}` 原样保留，留给 Stage 2 处理。
 *  2. **Stage 2 产物不再被解析**：变量替换后产生的 `{{> evil}}` 不会触发 evil 展开
 *     （因为外层 render 走 VAR_RE，BLOCK_REF_RE 仅在本函数被消费）。
 *  3. **循环检测**：Set + 数组双结构，O(1) 判环 + 完整 `A→B→A` 调用链回放。
 *  4. **深度限制**：进栈前先判，避免最后一层先展开再抛错。
 *  5. **大小限制**：合并完成后判一次（中间膨胀也会被最终结果反映出来），避免每步检查的开销。
 */
export function expandBlocks(
  html: string,
  resolver: BlockResolver,
  opts: ExpandOptions = {},
): string {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const missing = opts.missing ?? "throw";

  const seen = new Set<string>();
  const stack: string[] = [];

  function step(input: string): string {
    return input.replace(BLOCK_REF_RE, (match, name: string) => {

      if (seen.has(name)) {
        const trace = [...stack, name];
        throw new BlockExpansionError(
          "CYCLE",
          `Block reference cycle detected: ${trace.join(" -> ")}`,
          { blockName: name, trace },
        );
      }

      // 进栈前判深度，确保异常 trace 中的 stack 反映尝试进入的链路
      if (stack.length >= maxDepth) {
        const trace = [...stack, name];
        throw new BlockExpansionError(
          "DEPTH",
          `Block expansion depth exceeded ${maxDepth}: ${trace.join(" -> ")}`,
          { blockName: name, trace },
        );
      }

      const content = resolver.get(name);
      if (content === null) {
        if (missing === "throw") {
          throw new BlockExpansionError(
            "MISSING",
            `Block not found: ${name}`,
            { blockName: name, trace: [...stack, name] },
          );
        }
        if (missing === "keep") return match;
        // missing === 'empty'
        return "";
      }

      seen.add(name);
      stack.push(name);
      try {
        return step(content);
      } finally {
        stack.pop();
        seen.delete(name);
      }
    });
  }

  const result = step(html);
  if (Buffer.byteLength(result, "utf8") > maxBytes) {
    throw new BlockExpansionError(
      "SIZE",
      `Expanded block exceeds ${maxBytes} bytes`,
    );
  }
  return result;
}

/**
 * 提取顶层 html 中直接引用的所有片段名（按出现顺序去重）。
 *
 * 仅看 BLOCK_REF_RE，不递归进 resolver；用于：
 *  - 模板写时校验：`(template.locales[].html, subject, text) → 收集 names → 校验存在`
 *  - 编辑器 UI：高亮 unknown refs
 *  - 预览 API：返回 unknownBlocks 列表给前端
 */
export function extractBlockRefs(html: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of html.matchAll(BLOCK_REF_RE)) {
    const name = m[1]!;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * 收集模板（含其引用片段）展开后所有变量名（递归）。
 *
 * 实现：先用宽松 missing='empty' 把片段全展开（unknown ref 视为空，不抛错；这与
 * 编辑期期望对齐——模板服务在保存时另有显式校验拒绝 unknown refs），再走 extractVariables。
 */
export function extractAllVariables(
  html: string,
  resolver: BlockResolver,
): string[] {
  const expanded = expandBlocks(html, resolver, { missing: "empty" });
  return extractVariables(expanded);
}
