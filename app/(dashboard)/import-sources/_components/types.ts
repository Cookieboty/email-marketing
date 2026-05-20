/**
 * Phase 10 出站数据导入前端共享类型。
 * 与 lib/modules/import/service.ts 的 SerializedImportSource / serializeImportJob 对齐。
 */

export type ImportAuthType = "NONE" | "BEARER" | "BASIC" | "API_KEY_HEADER";
export type PaginationType = "offset" | "cursor" | "page" | "link_header";
export type ImportJobStatus =
  | "PENDING"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export interface ImportSourceRow {
  id: string;
  name: string;
  description: string | null;
  baseUrl: string;
  authType: ImportAuthType;
  authHeader: string | null;
  hasAuth: boolean;
  headers: Record<string, string> | null;
  paginationType: PaginationType;
  pageSize: number;
  pageSizeParam: string | null;
  pageParam: string | null;
  cursorParam: string | null;
  cursorJsonPath: string | null;
  dataJsonPath: string;
  fieldMapping: Record<string, string>;
  schedule: string | null;
  enabled: boolean;
  lastRunAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ImportJobRow {
  id: string;
  sourceId: string;
  status: ImportJobStatus;
  isDryRun: boolean;
  totalFetched: number;
  totalCreated: number;
  totalUpdated: number;
  totalSkipped: number;
  totalErrored: number;
  cursor: string | null;
  currentPage: number;
  startedAt: string | null;
  completedAt: string | null;
  failureReason: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ImportSourceListResp {
  data: ImportSourceRow[];
}

export interface ImportJobListResp {
  data: ImportJobRow[];
  page: number;
  pageSize: number;
}

export interface ImportTestResp {
  fetched: number;
  preview: unknown[];
  errors: Array<{ row: number; field: string; message: string }>;
}

export const AUTH_TYPE_LABELS: Record<ImportAuthType, string> = {
  NONE: "无",
  BEARER: "Bearer Token",
  BASIC: "HTTP Basic",
  API_KEY_HEADER: "自定义 Header",
};

export const PAGINATION_LABELS: Record<PaginationType, string> = {
  offset: "offset / limit",
  cursor: "cursor",
  page: "page / pageSize",
  link_header: "Link header (RFC 5988)",
};

export const JOB_STATUS_LABELS: Record<ImportJobStatus, string> = {
  PENDING: "待执行",
  RUNNING: "运行中",
  COMPLETED: "已完成",
  FAILED: "已失败",
  CANCELLED: "已取消",
};
