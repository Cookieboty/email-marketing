import type {
  MailProviderType,
  SmtpConfigStatus,
  SmtpSecureMode,
} from "@/lib/modules/smtp/schema";

export type { MailProviderType, SmtpConfigStatus, SmtpSecureMode };

export interface SmtpConfigRow {
  id: string;
  name: string;
  description: string | null;
  host: string;
  port: number;
  secure: SmtpSecureMode;
  username: string | null;
  hasPassword: boolean;
  passwordHint: string | null;
  fromEmail: string;
  fromName: string | null;
  replyTo: string | null;
  maxConnections: number;
  maxMessagesPerConn: number;
  rateLimitPerSec: number | null;
  connectionTimeoutMs: number;
  greetingTimeoutMs: number;
  socketTimeoutMs: number;
  rejectUnauthorized: boolean;
  requireTls: boolean;
  status: SmtpConfigStatus;
  isDefault: boolean;
  lastTestAt: string | null;
  lastTestStatus:
  | "OK"
  | "AUTH_FAILED"
  | "CONN_FAILED"
  | "TLS_FAILED"
  | "TIMEOUT"
  | "SEND_FAILED"
  | "UNKNOWN"
  | null;
  lastTestError: string | null;
  lastSendAt: string | null;
  recentFailures: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
}

export interface SmtpConfigListResponse {
  data: SmtpConfigRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface MailProviderSettingResponse {
  activeProvider: MailProviderType;
  activeSmtpId: string | null;
  fallback: MailProviderType;
  updatedAt: string;
  updatedBy: string | null;
}

export interface SmtpTestConnectionResponse {
  ok: boolean;
  error?: string;
  code?: string;
  responseCode?: number;
  testedAt: string;
  config: SmtpConfigRow;
}

export interface SmtpTestSendResponse {
  ok: boolean;
  messageId?: string;
  error?: string;
  testedAt: string;
}

export const STATUS_LABELS: Record<SmtpConfigStatus, string> = {
  ACTIVE: "启用",
  DISABLED: "停用",
  REVOKED: "已撤销",
};

export const SECURE_LABELS: Record<SmtpSecureMode, string> = {
  NONE: "明文 / 不加密",
  STARTTLS: "STARTTLS",
  TLS: "TLS（隐式）",
};

export const TEST_STATUS_LABELS: Record<
  NonNullable<SmtpConfigRow["lastTestStatus"]>,
  string
> = {
  OK: "通过",
  AUTH_FAILED: "鉴权失败",
  CONN_FAILED: "连接失败",
  TLS_FAILED: "TLS 失败",
  TIMEOUT: "超时",
  SEND_FAILED: "发送失败",
  UNKNOWN: "未知错误",
};
