/**
 * 用户批量导入：CSV / JSON 解析 + 校验 + 分批 upsert。
 *
 * 设计要点：
 *  - **CSV 注入防护**：所有字符串字段首字符 `=+-@\t\r` 一律加单引号前缀（specs §292 / §1019）。
 *    防御目标是导出回 Excel 时被解释为公式；防护应用于 *写入数据库* 前后均可，这里在导入入口
 *    统一处理，确保后续展示/导出无需再思考。
 *  - **限制**：≤10MB / ≤50000 行（specs §295-296）。
 *  - **匹配优先级**：externalId > email。两者都缺失则跳过并记录错误。
 *  - **批处理**：每批 1000 条，逐批 upsert；每行错误不中断整体流程，最终汇总返回。
 *  - 标签自动创建（按 name 查找/创建），用 in-memory map 缓存，避免每行 SQL 抖动。
 *  - 邮箱归一化：写入前统一 `normalizeEmail()`。
 */

import Papa from "papaparse";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { isValidEmail, normalizeEmail } from "@/lib/email-utils";
import { ValidationError } from "@/lib/errors";
import { logger } from "@/lib/logger";

export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 50_000;
export const IMPORT_BATCH_SIZE = 1_000;

const FORMULA_INJECTION_RE = /^[=+\-@\t\r]/;

export interface ImportRow {
  externalId?: string;
  email: string;
  name?: string;
  source?: string;
  metadata?: Record<string, unknown>;
  userLevel?: string;
  totalSpend?: string | number;
  orderCount?: number;
  lastOrderAt?: string | Date;
  birthDate?: string | Date;
  tags?: string[];
  /**
   * 用户语言偏好（多语言模板的 AUTO 策略将使用该字段决策）。
   * 合法值为 "zh" | "en"；其他值会按行返回错误，但不会中断整体导入。
   * 显式传入 null 表示清空已有偏好。
   */
  locale?: "zh" | "en" | null;
  /**
   * 订阅分类首选项（spec/preference-center.md §348-365）。
   * key 为分类 slug，value 为 true=订阅 / false=退订。
   * 未列出的分类不会被改动；isTransactional 分类会被静默忽略并写入 errors。
   */
  subscriptions?: Record<string, boolean>;
}

export interface ImportError {
  row: number;
  email?: string;
  reason: string;
}

export interface ImportResult {
  created: number;
  updated: number;
  skipped: number;
  errors: ImportError[];
}

/**
 * 对单个字符串字段做 CSV 注入防护：若首字符是 `=+-@\t\r` 则加单引号前缀。
 * 对 null/undefined/空串保持原样返回 undefined。
 */
export function sanitizeCsvField(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const s = typeof value === "string" ? value : String(value);
  if (s.length === 0) return undefined;
  return FORMULA_INJECTION_RE.test(s) ? `'${s}` : s;
}

function sanitizeRow(row: ImportRow): ImportRow {
  const out: ImportRow = { email: row.email };
  out.externalId = sanitizeCsvField(row.externalId);
  out.name = sanitizeCsvField(row.name);
  out.source = sanitizeCsvField(row.source) ?? "import";
  out.userLevel = sanitizeCsvField(row.userLevel);
  if (row.metadata !== undefined) out.metadata = row.metadata;
  if (row.totalSpend !== undefined) out.totalSpend = row.totalSpend;
  if (row.orderCount !== undefined) out.orderCount = row.orderCount;
  if (row.lastOrderAt !== undefined) out.lastOrderAt = row.lastOrderAt;
  if (row.birthDate !== undefined) out.birthDate = row.birthDate;
  if (row.locale !== undefined) out.locale = row.locale;
  if (row.tags && row.tags.length > 0) {
    out.tags = row.tags
      .map((t) => sanitizeCsvField(t))
      .filter((t): t is string => Boolean(t));
  }
  if (row.subscriptions && Object.keys(row.subscriptions).length > 0) {
    out.subscriptions = row.subscriptions;
  }
  return out;
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * CSV 单元格 `subscriptions` 解析：`slug:true;slug2:false`（分隔可用 ; 或 ,）。
 * 解析失败的子项静默丢弃；调用方在 service 层会再校验 slug 存在性。
 */
export function parseSubscriptionsCell(s: string | undefined): Record<string, boolean> | undefined {
  if (!s) return undefined;
  const trimmed = s.trim();
  if (!trimmed) return undefined;
  const out: Record<string, boolean> = {};
  for (const part of trimmed.split(/[;,]/)) {
    const seg = part.trim();
    if (!seg) continue;
    const idx = seg.indexOf(":");
    if (idx <= 0) continue;
    const slug = seg.slice(0, idx).trim().toLowerCase();
    const valRaw = seg.slice(idx + 1).trim().toLowerCase();
    if (!SLUG_RE.test(slug)) continue;
    if (valRaw === "true" || valRaw === "1" || valRaw === "yes") out[slug] = true;
    else if (valRaw === "false" || valRaw === "0" || valRaw === "no") out[slug] = false;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 解析 CSV/JSON 中的 locale 字段。返回 undefined=未传，null=显式清空，"zh"/"en"=合法，"invalid"=非法。 */
export function parseLocaleCell(
  raw: string | undefined | null,
): "zh" | "en" | null | undefined | "invalid" {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  const trimmed = String(raw).trim();
  if (trimmed === "") return undefined;
  const lower = trimmed.toLowerCase();
  if (lower === "zh" || lower === "en") return lower;
  return "invalid";
}

/** CSV 字符串 → ImportRow[]，保留行号（含 header 偏移）。 */
export function parseCsv(csv: string): { rows: ImportRow[]; errors: ImportError[] } {
  const errors: ImportError[] = [];
  const parsed = Papa.parse<Record<string, string>>(csv, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });
  if (parsed.errors.length > 0) {
    for (const e of parsed.errors) {
      errors.push({ row: (e.row ?? 0) + 2, reason: e.message });
    }
  }
  const rows: ImportRow[] = [];
  for (let i = 0; i < parsed.data.length; i += 1) {
    const r = parsed.data[i]!;
    const tagsField = (r.tags ?? "").trim();
    const localeParsed = parseLocaleCell(r.locale);
    if (localeParsed === "invalid") {
      errors.push({
        row: i + 2,
        email: (r.email ?? "").trim() || undefined,
        reason: `Invalid locale: ${r.locale}（仅支持 zh / en）`,
      });
    }
    rows.push({
      externalId: r.externalId?.trim() || undefined,
      email: (r.email ?? "").trim(),
      name: r.name?.trim() || undefined,
      source: r.source?.trim() || undefined,
      userLevel: r.userLevel?.trim() || undefined,
      totalSpend: r.totalSpend?.trim() || undefined,
      orderCount: r.orderCount ? Number(r.orderCount) : undefined,
      lastOrderAt: r.lastOrderAt?.trim() || undefined,
      birthDate: r.birthDate?.trim() || undefined,
      locale: localeParsed === "invalid" ? undefined : localeParsed,
      tags: tagsField
        ? tagsField
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
        : undefined,
      subscriptions: parseSubscriptionsCell(r.subscriptions),
    });
  }
  return { rows, errors };
}

interface ImportContext {
  actorType: "ADMIN" | "SYSTEM";
  req?: { headers: Headers } | null;
}

/**
 * 主入口：执行导入。
 * 调用方负责完成 size/rows 限制（这里也兜底校验）。
 */
export async function importUsers(
  rawRows: ImportRow[],
  ctx: ImportContext,
): Promise<ImportResult> {
  if (rawRows.length === 0) {
    return { created: 0, updated: 0, skipped: 0, errors: [] };
  }
  if (rawRows.length > MAX_IMPORT_ROWS) {
    throw new ValidationError(`Import exceeds ${MAX_IMPORT_ROWS} rows limit`);
  }

  const result: ImportResult = { created: 0, updated: 0, skipped: 0, errors: [] };

  // 1. 预扫：行级校验，分离合法/非法
  type Pending = {
    rowNo: number;
    data: ImportRow;
    tagNames: string[];
    subscriptions?: Record<string, boolean>;
  };
  const pending: Pending[] = [];
  for (let i = 0; i < rawRows.length; i += 1) {
    const rowNo = i + 1;
    const original = rawRows[i]!;
    if (!original.email && !original.externalId) {
      result.errors.push({ row: rowNo, reason: "email or externalId is required" });
      continue;
    }
    if (!isValidEmail(original.email)) {
      result.errors.push({
        row: rowNo,
        email: original.email,
        reason: "Invalid email format",
      });
      continue;
    }
    const sanitized = sanitizeRow(original);
    sanitized.email = normalizeEmail(original.email);
    pending.push({
      rowNo,
      data: sanitized,
      tagNames: original.tags ?? [],
      subscriptions: original.subscriptions,
    });
  }

  // 2. 收集 tag 名称，事先批量解析/创建，缓存 id
  const allTagNames = Array.from(
    new Set(pending.flatMap((p) => p.tagNames).map((t) => t.trim()).filter(Boolean)),
  );
  const tagIdByName = new Map<string, string>();
  if (allTagNames.length > 0) {
    const existing = await prisma.tag.findMany({ where: { name: { in: allTagNames } } });
    for (const t of existing) tagIdByName.set(t.name, t.id);
    const missing = allTagNames.filter((n) => !tagIdByName.has(n));
    for (const name of missing) {
      try {
        const created = await prisma.tag.create({ data: { name } });
        tagIdByName.set(name, created.id);
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          // 并发情况下被别处创建，重新查一次
          const t = await prisma.tag.findUnique({ where: { name } });
          if (t) tagIdByName.set(name, t.id);
        } else {
          throw err;
        }
      }
    }
  }

  // 2.5 收集 subscription slug，预解析 categoryId + isTransactional
  const allSlugs = Array.from(
    new Set(
      pending.flatMap((p) => (p.subscriptions ? Object.keys(p.subscriptions) : [])),
    ),
  );
  type CategoryBrief = { id: string; isTransactional: boolean };
  const categoryBySlug = new Map<string, CategoryBrief>();
  if (allSlugs.length > 0) {
    const cats = await prisma.subscriptionCategory.findMany({
      where: { slug: { in: allSlugs } },
      select: { id: true, slug: true, isTransactional: true },
    });
    for (const c of cats) {
      categoryBySlug.set(c.slug, { id: c.id, isTransactional: c.isTransactional });
    }
  }

  // 3. 分批 upsert
  for (let start = 0; start < pending.length; start += IMPORT_BATCH_SIZE) {
    const batch = pending.slice(start, start + IMPORT_BATCH_SIZE);
    for (const item of batch) {
      try {
        const outcome = await upsertOne(
          item.data,
          item.tagNames,
          tagIdByName,
          item.subscriptions,
          categoryBySlug,
          (reason) => {
            result.errors.push({ row: item.rowNo, email: item.data.email, reason });
          },
        );
        if (outcome === "created") result.created += 1;
        else if (outcome === "updated") result.updated += 1;
        else result.skipped += 1;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        result.errors.push({ row: item.rowNo, email: item.data.email, reason });
      }
    }
  }

  audit({
    action: "user.import",
    entityType: "User",
    entityId: "batch",
    actorType: ctx.actorType,
    details: {
      total: rawRows.length,
      created: result.created,
      updated: result.updated,
      skipped: result.skipped,
      errors: result.errors.length,
    },
    req: ctx.req ?? null,
  });

  if (result.errors.length > 0) {
    logger.warn("user import completed with errors", {
      total: rawRows.length,
      errors: result.errors.length,
    });
  }
  return result;
}

async function upsertOne(
  row: ImportRow,
  tagNames: string[],
  tagIdByName: Map<string, string>,
  subscriptions: Record<string, boolean> | undefined,
  categoryBySlug: Map<string, { id: string; isTransactional: boolean }>,
  reportError: (reason: string) => void,
): Promise<"created" | "updated" | "skipped"> {
  return prisma.$transaction(async (tx) => {
    let existing = null as Awaited<ReturnType<typeof tx.user.findUnique>>;
    if (row.externalId) {
      existing = await tx.user.findUnique({ where: { externalId: row.externalId } });
    }
    if (!existing && row.email) {
      existing = await tx.user.findUnique({ where: { email: row.email } });
    }

    const updateData: Prisma.UserUncheckedUpdateInput = {};
    const createData: Prisma.UserUncheckedCreateInput = {
      email: row.email,
      externalId: row.externalId ?? null,
      name: row.name ?? null,
      source: row.source ?? "import",
      userLevel: row.userLevel ?? null,
      orderCount: typeof row.orderCount === "number" ? row.orderCount : 0,
      lastOrderAt: row.lastOrderAt ? new Date(row.lastOrderAt) : null,
      birthDate: row.birthDate ? new Date(row.birthDate) : null,
      locale: row.locale ?? null,
    };
    if (row.totalSpend !== undefined && row.totalSpend !== "") {
      createData.totalSpend = new Prisma.Decimal(String(row.totalSpend));
    }
    if (row.metadata !== undefined) {
      createData.metadata = row.metadata as Prisma.InputJsonValue;
    }

    // 更新场景：仅对显式提供的字段赋值，避免覆盖既有值
    if (row.name !== undefined) updateData.name = row.name ?? null;
    if (row.source !== undefined) updateData.source = row.source;
    if (row.userLevel !== undefined) updateData.userLevel = row.userLevel ?? null;
    if (row.orderCount !== undefined) updateData.orderCount = row.orderCount;
    if (row.lastOrderAt !== undefined)
      updateData.lastOrderAt = row.lastOrderAt ? new Date(row.lastOrderAt) : null;
    if (row.birthDate !== undefined)
      updateData.birthDate = row.birthDate ? new Date(row.birthDate) : null;
    if (row.locale !== undefined) updateData.locale = row.locale;
    if (row.totalSpend !== undefined && row.totalSpend !== "") {
      updateData.totalSpend = new Prisma.Decimal(String(row.totalSpend));
    }
    if (row.metadata !== undefined) {
      updateData.metadata = row.metadata as Prisma.InputJsonValue;
    }
    if (row.email && existing && row.email !== existing.email) {
      updateData.email = row.email;
    }
    if (row.externalId && existing && row.externalId !== existing.externalId) {
      updateData.externalId = row.externalId;
    }

    let user;
    let outcome: "created" | "updated";
    if (existing) {
      user = await tx.user.update({ where: { id: existing.id }, data: updateData });
      outcome = "updated";
    } else {
      user = await tx.user.create({ data: createData });
      outcome = "created";
    }

    if (tagNames.length > 0) {
      const ids = tagNames
        .map((n) => tagIdByName.get(n.trim()))
        .filter((id): id is string => Boolean(id));
      if (ids.length > 0) {
        await tx.userTag.createMany({
          data: ids.map((tagId) => ({ userId: user.id, tagId })),
          skipDuplicates: true,
        });
      }
    }

    // 订阅分类首选项：每个 slug 单独 upsert 该 user 的 UserSubscription
    if (subscriptions) {
      for (const [slug, subscribed] of Object.entries(subscriptions)) {
        const cat = categoryBySlug.get(slug);
        if (!cat) {
          reportError(`subscription category not found: ${slug}`);
          continue;
        }
        if (cat.isTransactional && subscribed === false) {
          // 交易类不允许退订；订阅请求（true）则不必显式写（默认即订阅）
          reportError(`category ${slug} is transactional and cannot be unsubscribed`);
          continue;
        }
        await tx.userSubscription.upsert({
          where: { userId_categoryId: { userId: user.id, categoryId: cat.id } },
          update: { subscribed },
          create: { userId: user.id, categoryId: cat.id, subscribed },
        });
      }
    }
    return outcome;
  });
}
