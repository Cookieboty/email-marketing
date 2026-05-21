/**
 * Outbound Importer Runner：单 ImportJob 的拉取/映射/upsert 执行器。
 *
 * 关联 spec：specs/modules/outbound-importer.md §159-200 / phase-10 §10.6
 *
 * 流程：
 *   1. load job + source
 *   2. 解密 authValue → 构造请求头（Bearer / Basic / API_KEY_HEADER + 自定义 headers）
 *   3. 循环：
 *      a. buildRequestUrl → assertSafeRequestUrl → fetch（超时 + 响应体上限）
 *      b. 解析 JSON → extractDataArray
 *      c. 逐行：mapRow → 若非 dryRun 调 upsertByExternalIdOrEmail
 *      d. 写错误 → ImportJobError；更新计数
 *      e. advanceState → 持久化 cursor / currentPage
 *   4. status: COMPLETED / FAILED；CANCELLED 由外部接口设置后 runner 检测退出
 *
 * 约束：
 *   - 每页处理后 commit 一次 ImportJob 进度（断点续跑）
 *   - 每行错误不中断 job
 *   - CANCELLED 状态在每页边界检测
 *   - dryRun：不写 User，但仍然记录 errors 与计数
 */

import { ImportAuthType, ImportJobStatus, type Prisma } from "@prisma/client";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { audit } from "@/lib/audit";
import { AppError } from "@/lib/errors";
import { upsertByExternalIdOrEmail } from "@/lib/modules/user/upsert";
import {
  type FieldMapping,
  mapRow,
  validateFieldMapping,
} from "./mapper";
import {
  advanceState,
  buildRequestUrl,
  deserializeState,
  extractDataArray,
  type PaginationState,
  serializeState,
} from "./pagination";
import { decryptSecret } from "./secrets";
import { assertSafeRequestUrl } from "./security";
import { importRepository, type ImportJobRow, type ImportSourceRow } from "./repository";

const log = logger.child("import-runner");

interface FetchResult {
  body: unknown;
  linkHeader: string | null;
  status: number;
}

interface PageOutcome {
  fetched: number;
  created: number;
  updated: number;
  skipped: number;
  errored: number;
  hasNext: boolean;
  nextState: PaginationState;
}

function buildHeaders(source: ImportSourceRow): Record<string, string> {
  const out: Record<string, string> = {
    accept: "application/json",
    "user-agent": "ems-importer/1.0",
  };
  if (source.headers && typeof source.headers === "object" && !Array.isArray(source.headers)) {
    for (const [k, v] of Object.entries(source.headers as Record<string, unknown>)) {
      if (typeof v === "string") out[k.toLowerCase()] = v;
    }
  }
  if (source.authType !== ImportAuthType.NONE) {
    if (!source.authValue) {
      throw new AppError("authValue required for authenticated source", {
        status: 500,
        code: "import_auth_missing",
      });
    }
    const secret = decryptSecret(source.authValue);
    if (source.authType === ImportAuthType.BEARER) {
      out["authorization"] = `Bearer ${secret}`;
    } else if (source.authType === ImportAuthType.BASIC) {
      out["authorization"] = `Basic ${Buffer.from(secret, "utf8").toString("base64")}`;
    } else if (source.authType === ImportAuthType.API_KEY_HEADER) {
      const headerName = (source.authHeader ?? "X-API-Key").toLowerCase();
      out[headerName] = secret;
    }
  }
  return out;
}

/** 带超时 + 响应体大小限制的 fetch。 */
async function fetchPage(url: string, headers: Record<string, string>): Promise<FetchResult> {
  await assertSafeRequestUrl(url);
  const e = env();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("timeout")), e.IMPORT_HTTP_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "GET",
      headers,
      signal: ctrl.signal,
      redirect: "manual",
    });
  } finally {
    clearTimeout(timer);
  }
  if (resp.status >= 300 && resp.status < 400) {
    throw new AppError("Upstream redirects are not allowed", {
      status: 502,
      code: "import_redirect_not_allowed",
    });
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new AppError(
      `Upstream error ${resp.status}: ${text.slice(0, 200)}`,
      { status: 502, code: "import_upstream_error" },
    );
  }
  const linkHeader = resp.headers.get("link");
  const lenHeader = resp.headers.get("content-length");
  if (lenHeader) {
    const len = Number(lenHeader);
    if (Number.isFinite(len) && len > e.IMPORT_MAX_RESPONSE_BYTES) {
      throw new AppError("Response body exceeds IMPORT_MAX_RESPONSE_BYTES", {
        status: 502,
        code: "import_response_too_large",
      });
    }
  }

  const reader = resp.body?.getReader();
  if (!reader) {
    return { body: null, linkHeader, status: resp.status };
  }
  const max = e.IMPORT_MAX_RESPONSE_BYTES;
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > max) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        throw new AppError("Response body exceeds IMPORT_MAX_RESPONSE_BYTES", {
          status: 502,
          code: "import_response_too_large",
        });
      }
      chunks.push(value);
    }
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  let body: unknown = null;
  try {
    body = JSON.parse(buf.toString("utf8"));
  } catch (err) {
    throw new AppError(
      `Invalid JSON response: ${err instanceof Error ? err.message : String(err)}`,
      { status: 502, code: "import_invalid_json" },
    );
  }
  return { body, linkHeader, status: resp.status };
}

const SENSITIVE_KEY_RE = /(email|phone|mobile|token|secret|password|authorization|api[-_]?key)/i;

function maskEmailValue(value: string): string {
  const [name, domain] = value.split("@");
  if (!domain) return "***";
  return `${name.slice(0, 2)}***@${domain}`;
}

function maskPhoneValue(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 7) return "***";
  return `${digits.slice(0, 2)}${"*".repeat(Math.max(3, digits.length - 4))}${digits.slice(-2)}`;
}

function maskSensitiveValue(key: string, value: unknown): unknown {
  if (!SENSITIVE_KEY_RE.test(key)) return value;
  if (typeof value !== "string") return "***";
  if (key.toLowerCase().includes("email") || value.includes("@")) return maskEmailValue(value);
  if (key.toLowerCase().includes("phone") || key.toLowerCase().includes("mobile")) {
    return maskPhoneValue(value);
  }
  return "***";
}

function maskRawData(raw: unknown): unknown {
  if (raw === null || raw === undefined) return raw;
  if (Array.isArray(raw)) return raw.map((v) => maskRawData(v));
  if (typeof raw !== "object") return raw;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value && typeof value === "object") {
      out[key] = SENSITIVE_KEY_RE.test(key) ? "***" : maskRawData(value);
    } else {
      out[key] = maskSensitiveValue(key, value);
    }
  }
  return out;
}

async function processOnePage(
  job: ImportJobRow,
  source: ImportSourceRow,
  fieldMapping: FieldMapping,
  state: PaginationState,
  isDryRun: boolean,
): Promise<PageOutcome> {
  const url = buildRequestUrl(source, state);
  if (!url) {
    return {
      fetched: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      errored: 0,
      hasNext: false,
      nextState: state,
    };
  }
  const headers = buildHeaders(source);
  log.debug("import fetch page", { jobId: job.id, sourceId: source.id, url });
  const { body, linkHeader } = await fetchPage(url, headers);
  const rows = extractDataArray(body, source.dataJsonPath);

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let errored = 0;

  for (let i = 0; i < rows.length; i += 1) {
    const raw = rows[i];
    const result = mapRow(raw, fieldMapping);
    const rowNum = job.totalFetched + i + 1;
    if (!result.ok) {
      errored += 1;
      for (const e of result.errors) {
        await importRepository.addJobError({
          jobId: job.id,
          row: rowNum,
          field: e.field,
          message: e.message,
          rawData: raw === undefined ? undefined : (maskRawData(raw) as Prisma.InputJsonValue),
        });
      }
      continue;
    }
    for (const warning of result.warnings ?? []) {
      await importRepository.addJobError({
        jobId: job.id,
        row: rowNum,
        field: warning.field,
        message: warning.message,
        rawData: raw === undefined ? undefined : (maskRawData(raw) as Prisma.InputJsonValue),
      });
    }
    if (isDryRun) {
      skipped += 1;
      continue;
    }
    try {
      const upsert = await upsertByExternalIdOrEmail(result.mapped, {
        actorType: "SYSTEM",
        auditPrefix: "import",
      });
      if (upsert.created) created += 1;
      else updated += 1;
    } catch (err) {
      errored += 1;
      const msg = err instanceof Error ? err.message : String(err);
      await importRepository.addJobError({
        jobId: job.id,
        row: rowNum,
        field: "email",
        message: `upsert failed: ${msg}`,
        rawData: raw === undefined ? undefined : (maskRawData(raw) as Prisma.InputJsonValue),
      });
    }
  }

  const adv = advanceState(source, state, rows.length, body, linkHeader);
  return {
    fetched: rows.length,
    created,
    updated,
    skipped,
    errored,
    hasNext: adv.hasNext,
    nextState: adv.next,
  };
}

export const __testing = { maskRawData };

/**
 * 执行一个 ImportJob。完成后 job.status 变为 COMPLETED / FAILED / CANCELLED。
 * 失败原因写入 failureReason；任何意外异常会被捕获，job 标记 FAILED 后返回。
 */
export async function runImportJob(jobId: string): Promise<void> {
  const job = await importRepository.getJob(jobId);
  if (!job) {
    log.warn("runImportJob: job not found", { jobId });
    return;
  }
  if (job.status !== ImportJobStatus.PENDING && job.status !== ImportJobStatus.RUNNING) {
    log.warn("runImportJob: job not runnable", { jobId, status: job.status });
    return;
  }
  const source = await importRepository.getSource(job.sourceId);
  if (!source) {
    await importRepository.updateJob(jobId, {
      status: ImportJobStatus.FAILED,
      failureReason: "source not found",
      completedAt: new Date(),
    });
    return;
  }
  if (!source.enabled) {
    await importRepository.updateJob(jobId, {
      status: ImportJobStatus.CANCELLED,
      failureReason: "source disabled",
      completedAt: new Date(),
    });
    return;
  }

  // validate mapping
  const fm = (source.fieldMapping as unknown) as FieldMapping;
  const fmErrs = validateFieldMapping(fm);
  if (fmErrs.length > 0) {
    await importRepository.updateJob(jobId, {
      status: ImportJobStatus.FAILED,
      failureReason: `invalid fieldMapping: ${fmErrs.map((e) => `${e.field}:${e.message}`).join("; ")}`,
      completedAt: new Date(),
    });
    return;
  }

  await importRepository.updateJob(jobId, {
    status: ImportJobStatus.RUNNING,
    startedAt: job.startedAt ?? new Date(),
  });

  let state = deserializeState(job.cursor);
  let totalFetched = job.totalFetched;
  let totalCreated = job.totalCreated;
  let totalUpdated = job.totalUpdated;
  let totalSkipped = job.totalSkipped;
  let totalErrored = job.totalErrored;
  let currentPage = job.currentPage;

  audit({
    action: "import_job.start",
    entityType: "ImportJob",
    entityId: job.id,
    actorType: "SYSTEM",
    details: { sourceId: source.id, dryRun: job.isDryRun },
  });

  try {
    for (;;) {
      // CANCELLED 检查（每页边界）
      const fresh = await importRepository.getJob(jobId);
      if (!fresh) {
        log.warn("job disappeared mid-run", { jobId });
        return;
      }
      if (fresh.status === ImportJobStatus.CANCELLED) {
        log.info("job cancelled, stopping", { jobId });
        return;
      }

      const outcome = await processOnePage(fresh, source, fm, state, job.isDryRun);
      totalFetched += outcome.fetched;
      totalCreated += outcome.created;
      totalUpdated += outcome.updated;
      totalSkipped += outcome.skipped;
      totalErrored += outcome.errored;
      currentPage += 1;
      state = outcome.nextState;

      await importRepository.updateJob(jobId, {
        totalFetched,
        totalCreated,
        totalUpdated,
        totalSkipped,
        totalErrored,
        currentPage,
        cursor: serializeState(state),
      });

      if (!outcome.hasNext) break;
    }

    await importRepository.updateJob(jobId, {
      status: ImportJobStatus.COMPLETED,
      completedAt: new Date(),
    });
    await importRepository.touchLastRun(source.id, new Date());
    audit({
      action: "import_job.finish",
      entityType: "ImportJob",
      entityId: jobId,
      actorType: "SYSTEM",
      details: {
        totalFetched,
        totalCreated,
        totalUpdated,
        totalSkipped,
        totalErrored,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("import job failed", { jobId, error: msg });
    await importRepository.updateJob(jobId, {
      status: ImportJobStatus.FAILED,
      failureReason: msg.slice(0, 500),
      completedAt: new Date(),
      totalFetched,
      totalCreated,
      totalUpdated,
      totalSkipped,
      totalErrored,
      currentPage,
      cursor: serializeState(state),
    });
  }
}

/**
 * Test 端点用：拉一页 + 应用映射，返回前 N 行预览，不写 User。
 */
export async function runImportTest(
  source: ImportSourceRow,
  previewLimit = 5,
): Promise<{
  fetched: number;
  preview: unknown[];
  errors: Array<{ row: number; field: string; message: string }>;
}> {
  const fm = source.fieldMapping as unknown as FieldMapping;
  const fmErrs = validateFieldMapping(fm);
  if (fmErrs.length > 0) {
    return {
      fetched: 0,
      preview: [],
      errors: fmErrs.map((e, i) => ({ row: i + 1, field: e.field, message: e.message })),
    };
  }
  const headers = buildHeaders(source);
  const state = deserializeState(null);
  const url = buildRequestUrl(source, state);
  if (!url) {
    return { fetched: 0, preview: [], errors: [] };
  }
  const { body } = await fetchPage(url, headers);
  const rows = extractDataArray(body, source.dataJsonPath);
  const preview: unknown[] = [];
  const errors: Array<{ row: number; field: string; message: string }> = [];
  for (let i = 0; i < rows.length; i += 1) {
    const r = mapRow(rows[i], fm);
    if (r.ok) {
      if (preview.length < previewLimit) preview.push(r.mapped);
    } else {
      for (const e of r.errors) {
        errors.push({ row: i + 1, field: e.field, message: e.message });
      }
    }
  }
  return { fetched: rows.length, preview, errors };
}
