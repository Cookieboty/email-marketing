import type { ApiClientScope } from "@/lib/modules/api-client/schema";
import { SCOPES as BE_SCOPES } from "@/lib/modules/api-client/schema";

export const SCOPES = BE_SCOPES;

export type ApiClientStatus = "ACTIVE" | "DISABLED" | "REVOKED";

export interface ApiClientRow {
  id: string;
  name: string;
  description: string | null;
  status: ApiClientStatus;
  tokenPrefix: string;
  scopes: ApiClientScope[];
  ipWhitelist: string[];
  rpsLimit: number | null;
  rphLimit: number | null;
  hmacEnabled: boolean;
  hasGraceToken: boolean;
  previousTokenExpiresAt: string | null;
  metadata: unknown;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApiClientListResponse {
  data: ApiClientRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ApiClientCreatedResponse extends ApiClientRow {
  token: string;
  hmacSecret?: string;
}

export interface ApiClientRotatedResponse extends ApiClientRow {
  token: string;
  previousTokenExpiresAt: string;
}

export const STATUS_LABELS: Record<ApiClientStatus, string> = {
  ACTIVE: "启用",
  DISABLED: "停用",
  REVOKED: "已吊销",
};

export const SCOPE_LABELS: Record<ApiClientScope, string> = {
  "user:read": "读取用户",
  "user:write": "写入/更新用户",
  "tag:read": "读取标签关系",
  "tag:write": "写入标签关系",
  "unsubscribe:write": "退订/重新订阅",
  "event:write": "上报事件",
  "topic:write": "Topic 退订",
};
