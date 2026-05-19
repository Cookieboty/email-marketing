/**
 * 邮件相关字符串工具。所有函数对 null/undefined 输入返回空字符串或 false，
 * 调用方无需先做存在性判断。
 */

import { z } from "zod";

const EmailSchema = z.string().email();

export function normalizeEmail(email: string | null | undefined): string {
  if (!email) return "";
  return email.trim().toLowerCase();
}

export function extractDomain(email: string | null | undefined): string {
  const norm = normalizeEmail(email);
  const at = norm.lastIndexOf("@");
  if (at < 0 || at === norm.length - 1) return "";
  return norm.slice(at + 1);
}

export function isValidEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return EmailSchema.safeParse(email.trim()).success;
}

/**
 * 将邮箱本地部分掩码：abcdef@x.com → abc***@x.com；
 * 长度 ≤3 的本地部分仅保留首字符；非法邮箱按整体掩码处理。
 */
export function maskEmail(email: string | null | undefined): string {
  const norm = normalizeEmail(email);
  if (!norm) return "";
  const at = norm.lastIndexOf("@");
  if (at <= 0 || at === norm.length - 1) {
    return norm.length > 2 ? `${norm.slice(0, 2)}***` : "***";
  }
  const local = norm.slice(0, at);
  const domain = norm.slice(at + 1);
  if (local.length <= 1) return `*@${domain}`;
  if (local.length <= 3) return `${local[0]}***@${domain}`;
  return `${local.slice(0, 3)}***@${domain}`;
}

/**
 * 去除 subject 中的 HTML 标签（specs §930）。注意主题行不应渲染 HTML，
 * 仅做防御性剥离；同时折叠连续空白避免 \n 注入伪造头部。
 */
export function stripSubjectHtml(subject: string | null | undefined): string {
  if (!subject) return "";
  return subject
    .replace(/<[^>]*>/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * 从 RFC 5322 风格的 From 头取出纯地址。
 * 支持：
 *  - 裸地址：`news@example.com`
 *  - Display Name 格式：`Marketing <news@example.com>` / `"Marketing" <news@example.com>`
 * 解析失败返回空字符串。
 */
export function extractAddressFromHeader(value: string | null | undefined): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  const angle = trimmed.match(/<\s*([^<>\s]+@[^<>\s]+)\s*>$/);
  const addr = angle ? angle[1]! : trimmed;
  return addr.trim();
}

/**
 * 校验 From 头是否合法：要么裸地址，要么 `Display Name <addr>` 形式，
 * 内部地址必须通过邮箱格式校验。同时禁止内联换行避免头注入。
 */
export function isValidFromHeader(value: string | null | undefined): boolean {
  if (!value) return false;
  if (/[\r\n]/.test(value)) return false;
  const addr = extractAddressFromHeader(value);
  return isValidEmail(addr);
}
