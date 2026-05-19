/**
 * Outbound Importer 出站安全网：URL/IP 校验，SSRF 防护。
 *
 * 关联 spec：specs/modules/outbound-importer.md §184-193 / phase-10 §10.3
 *
 * 策略：
 *  - 仅允许 `https:` 协议（防 http/file/ftp/javascript:）
 *  - 拒绝 hostname：localhost / *.localhost / *.local / *.internal
 *  - 解析 IP（IPv4/IPv6）后拒绝：
 *      10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16,
 *      127.0.0.0/8, 169.254.0.0/16, 0.0.0.0/8, 224.0.0.0/4
 *      ::1, fc00::/7, fe80::/10, ::ffff:私网映射
 *  - 运行时每次请求会解析 A/AAAA 记录并拒绝私网/保留地址
 *  - 连接建立后的 DNS rebinding 仍需自定义 dispatcher 才能做到 socket 级约束
 */

import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { ValidationError } from "@/lib/errors";

const PRIVATE_IPV4_CIDRS: Array<[bigint, bigint]> = [
  cidrV4("10.0.0.0/8"),
  cidrV4("172.16.0.0/12"),
  cidrV4("192.168.0.0/16"),
  cidrV4("127.0.0.0/8"),
  cidrV4("169.254.0.0/16"),
  cidrV4("0.0.0.0/8"),
  cidrV4("224.0.0.0/4"),
  cidrV4("100.64.0.0/10"),
];

function ipv4ToInt(ip: string): bigint {
  const parts = ip.split(".");
  if (parts.length !== 4) return -1n;
  let acc = 0n;
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) return -1n;
    acc = (acc << 8n) | BigInt(n);
  }
  return acc;
}

function cidrV4(entry: string): [bigint, bigint] {
  const [base, maskStr] = entry.split("/");
  const baseInt = ipv4ToInt(base!);
  const mask = Number(maskStr ?? "32");
  if (mask === 0) return [0n, 0n];
  const m = ((1n << BigInt(mask)) - 1n) << BigInt(32 - mask);
  return [baseInt & m, m];
}

function isPrivateIPv4(ip: string): boolean {
  const v = ipv4ToInt(ip);
  if (v < 0n) return false;
  for (const [base, mask] of PRIVATE_IPV4_CIDRS) {
    if ((v & mask) === base) return true;
  }
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fe80")) return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  // IPv4-mapped IPv6: ::ffff:a.b.c.d
  const m = lower.match(/^::ffff:([0-9a-f.:]+)$/);
  if (m && m[1] && m[1].includes(".")) {
    return isPrivateIPv4(m[1]);
  }
  return false;
}

function isBlockedHostname(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost") return true;
  if (h.endsWith(".localhost")) return true;
  if (h.endsWith(".local")) return true;
  if (h.endsWith(".internal")) return true;
  return false;
}

/**
 * 校验 baseUrl：仅允许 https，hostname 非内网。
 * IP 字面量直接落入 CIDR 检查；域名仅做 hostname 启发，运行时另外解析。
 */
export function validateTargetUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ValidationError("Invalid URL", [{ path: ["baseUrl"], message: "invalid" }]);
  }
  if (parsed.protocol !== "https:") {
    throw new ValidationError("Only https:// URLs are allowed", [
      { path: ["baseUrl"], message: "must be https" },
    ]);
  }
  const host = parsed.hostname;
  if (!host) {
    throw new ValidationError("URL must have a hostname", [
      { path: ["baseUrl"], message: "missing host" },
    ]);
  }
  if (isBlockedHostname(host)) {
    throw new ValidationError("Hostname is in blocklist (localhost/.local/.internal)", [
      { path: ["baseUrl"], message: "blocked host" },
    ]);
  }
  const ipKind = isIP(host);
  if (ipKind === 4 && isPrivateIPv4(host)) {
    throw new ValidationError("Private IPv4 is not allowed", [
      { path: ["baseUrl"], message: "private ipv4" },
    ]);
  }
  if (ipKind === 6 && isPrivateIPv6(host)) {
    throw new ValidationError("Private IPv6 is not allowed", [
      { path: ["baseUrl"], message: "private ipv6" },
    ]);
  }
  return parsed;
}

/**
 * 给 runner 在每次发起请求时再次校验最终目的 URL（含分页拼接）。
 * 抛 AppError 而非 ValidationError，便于 runner 捕获后写 ImportJobError。
 */
type ResolveHost = (hostname: string) => Promise<string[]>;

async function defaultResolveHost(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
}

export async function assertSafeRequestUrl(
  url: string,
  resolveHost: ResolveHost = defaultResolveHost,
): Promise<void> {
  const parsed = validateTargetUrl(url);
  if (isIP(parsed.hostname) !== 0) return;
  const addresses = await resolveHost(parsed.hostname);
  if (addresses.length === 0) {
    throw new ValidationError("Hostname did not resolve", [
      { path: ["baseUrl"], message: "dns empty" },
    ]);
  }
  for (const address of addresses) {
    if (isPrivateIPv4(address) || isPrivateIPv6(address)) {
      throw new ValidationError("Resolved IP is not allowed", [
        { path: ["baseUrl"], message: "resolved private ip" },
      ]);
    }
  }
}

export const __testing = { isPrivateIPv4, isPrivateIPv6, isBlockedHostname };
