/**
 * Outbound Importer 字段映射引擎。
 *
 * 关联 spec：specs/modules/outbound-importer.md §134-157 / phase-10 §10.4
 *
 * fieldMapping 形如：
 *   {
 *     "email": "$.email",
 *     "name": "$.full_name",
 *     "externalId": "$.id",
 *     "metadata.phone": "$.phone",
 *     "metadata.level": "$.membership.level",
 *     "tags": "$.labels[*].name"
 *   }
 *
 * key（左侧）：
 *   - 顶层字段：email | name | externalId | source | tags
 *   - metadata.* 任意子字段（写入 metadata JSON 对象）
 *   - 系统管控字段（unsubscribed/unsubscribeToken/engagementScore）一律拒绝
 *
 * value（右侧 JSON Path 子集）：
 *   - `$` 表示当前 row 整体
 *   - `$.a.b.c`：嵌套属性（点号）
 *   - `$.a[0].b`：数组下标
 *   - `$.a[*].b`：通配数组（仅在 tags 字段允许 → 展平成字符串数组）
 *
 * 不实现的高级语法：filter、recursive descent (..)、表达式。
 */

import { isValidEmail } from "@/lib/email-utils";

export type FieldMapping = Record<string, string>;

export interface MappedUser {
  email: string;
  externalId?: string | null;
  name?: string | null;
  source?: string | null;
  metadata?: Record<string, unknown> | null;
  tags?: string[];
}

export interface MapRowError {
  field: string;
  message: string;
}

export type MapRowResult =
  | { ok: true; mapped: MappedUser }
  | { ok: false; errors: MapRowError[] };

const ALLOWED_TOP_FIELDS = new Set(["email", "name", "externalId", "source", "tags"]);
const FORBIDDEN_FIELDS = new Set([
  "unsubscribed",
  "unsubscribeToken",
  "engagementScore",
  "id",
  "createdAt",
  "updatedAt",
  "optInStatus",
]);

/** 校验 fieldMapping 的合法性；不抛错时返回 null。 */
export function validateFieldMapping(fm: FieldMapping): MapRowError[] {
  const errs: MapRowError[] = [];
  if (!fm || typeof fm !== "object") {
    return [{ field: "fieldMapping", message: "must be an object" }];
  }
  if (!fm.email || typeof fm.email !== "string") {
    errs.push({ field: "email", message: "email mapping is required" });
  }
  for (const [k, v] of Object.entries(fm)) {
    if (typeof v !== "string" || v.length === 0) {
      errs.push({ field: k, message: "json path must be non-empty string" });
      continue;
    }
    if (!v.startsWith("$")) {
      errs.push({ field: k, message: "json path must start with $" });
    }
    if (FORBIDDEN_FIELDS.has(k)) {
      errs.push({ field: k, message: "field is system-managed and not allowed" });
    }
    if (k.startsWith("metadata.")) continue;
    if (!ALLOWED_TOP_FIELDS.has(k)) {
      errs.push({ field: k, message: `unsupported target field: ${k}` });
    }
  }
  return errs;
}

interface Step {
  kind: "key" | "index" | "wildcard";
  value?: string | number;
}

function parseJsonPath(path: string): Step[] {
  if (path === "$") return [];
  if (!path.startsWith("$")) {
    throw new Error("json path must start with $");
  }
  const rest = path.slice(1);
  const steps: Step[] = [];
  // Tokenize: support .key and [n] and [*]
  let i = 0;
  while (i < rest.length) {
    const ch = rest[i]!;
    if (ch === ".") {
      i += 1;
      let key = "";
      while (i < rest.length && rest[i] !== "." && rest[i] !== "[") {
        key += rest[i++];
      }
      if (!key) throw new Error("empty key after .");
      steps.push({ kind: "key", value: key });
    } else if (ch === "[") {
      const close = rest.indexOf("]", i);
      if (close < 0) throw new Error("unclosed [");
      const inner = rest.slice(i + 1, close).trim();
      if (inner === "*") {
        steps.push({ kind: "wildcard" });
      } else {
        const n = Number(inner);
        if (!Number.isInteger(n)) throw new Error(`invalid array index: ${inner}`);
        steps.push({ kind: "index", value: n });
      }
      i = close + 1;
    } else {
      throw new Error(`unexpected char in json path: ${ch}`);
    }
  }
  return steps;
}

/** 评估 JSON Path；返回 undefined（不存在）或 unknown。Wildcard 时返回数组。 */
function evalPath(root: unknown, steps: Step[]): unknown {
  let current: unknown = root;
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i]!;
    if (current === null || current === undefined) return undefined;
    if (step.kind === "key") {
      if (typeof current !== "object" || Array.isArray(current)) return undefined;
      current = (current as Record<string, unknown>)[step.value as string];
    } else if (step.kind === "index") {
      if (!Array.isArray(current)) return undefined;
      current = current[step.value as number];
    } else {
      // wildcard
      if (!Array.isArray(current)) return undefined;
      const remaining = steps.slice(i + 1);
      const out: unknown[] = [];
      for (const item of current) {
        const v = evalPath(item, remaining);
        if (v !== undefined) out.push(v);
      }
      return out;
    }
  }
  return current;
}

/** 公开版本：供分页器 / runner 取响应中字段。 */
export function getByJsonPath(root: unknown, path: string): unknown {
  let steps: Step[];
  try {
    steps = parseJsonPath(path);
  } catch {
    return undefined;
  }
  return evalPath(root, steps);
}

function asString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

function asTagArray(v: unknown): string[] {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) {
    return v
      .map((x) => asString(x))
      .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      .map((x) => x.trim());
  }
  const s = asString(v);
  return s && s.trim().length > 0 ? [s.trim()] : [];
}

/**
 * 单行映射：
 *  - 缺失/类型错误的可选字段 → 写 null（保持兼容 upsert 输入）
 *  - email 必填且必须合法 → 走 errors
 *  - metadata.* 多个键合并到同一个对象
 *  - tags 支持 wildcard 数组
 */
export function mapRow(raw: unknown, fieldMapping: FieldMapping): MapRowResult {
  const errors: MapRowError[] = [];
  const mapped: MappedUser = { email: "" };
  const metadata: Record<string, unknown> = {};
  let metadataTouched = false;

  for (const [target, jp] of Object.entries(fieldMapping)) {
    let value: unknown;
    try {
      value = getByJsonPath(raw, jp);
    } catch (e) {
      errors.push({
        field: target,
        message: `path eval failed: ${e instanceof Error ? e.message : String(e)}`,
      });
      continue;
    }

    if (target === "email") {
      const s = asString(value);
      if (!s) {
        errors.push({ field: "email", message: "email missing" });
        continue;
      }
      if (!isValidEmail(s)) {
        errors.push({ field: "email", message: `invalid email format: ${s}` });
        continue;
      }
      mapped.email = s;
    } else if (target === "name") {
      mapped.name = asString(value);
    } else if (target === "externalId") {
      const s = asString(value);
      mapped.externalId = s && s.trim().length > 0 ? s.trim() : null;
    } else if (target === "source") {
      mapped.source = asString(value);
    } else if (target === "tags") {
      mapped.tags = asTagArray(value);
    } else if (target.startsWith("metadata.")) {
      const subKey = target.slice("metadata.".length);
      if (!subKey) {
        errors.push({ field: target, message: "empty metadata sub-key" });
        continue;
      }
      if (value !== undefined) {
        metadata[subKey] = value;
        metadataTouched = true;
      }
    } else {
      errors.push({ field: target, message: `unsupported target field: ${target}` });
    }
  }

  if (metadataTouched) {
    mapped.metadata = metadata;
  }

  if (!mapped.email) {
    if (!errors.some((e) => e.field === "email")) {
      errors.push({ field: "email", message: "email missing" });
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, mapped };
}

export const __testing = { parseJsonPath, evalPath };
