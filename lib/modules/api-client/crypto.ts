/**
 * ApiClient 凭证 / 签名 / IP 白名单 工具集。
 *
 * 关联 spec：specs/modules/inbound-connector.md
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const TOKEN_PREFIX = "ic_";
const TOKEN_RAW_BYTES = 32;
const SECRET_RAW_BYTES = 32;

/** 生成新 ApiClient 明文 token，形如 `ic_<64-hex>`；前 8 字符作为公开前缀方便审计。 */
export function generateApiToken(): { token: string; prefix: string; hash: string } {
  const raw = randomBytes(TOKEN_RAW_BYTES).toString("hex");
  const token = `${TOKEN_PREFIX}${raw}`;
  return {
    token,
    prefix: token.slice(0, 12),
    hash: hashToken(token),
  };
}

/** 生成 HMAC 共享密钥（仅在创建/轮转时返回明文，DB 仅保存哈希）。 */
export function generateHmacSecret(): { secret: string; hash: string } {
  const secret = randomBytes(SECRET_RAW_BYTES).toString("hex");
  return { secret, hash: hashToken(secret) };
}

/** SHA-256 hex 摘要；用作 token / secret 在 DB 的存储形式。 */
export function hashToken(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** 常时比较两个十六进制字符串。 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

/** 计算 HMAC-SHA256 签名：sign(timestamp + "." + rawBody)，返回 hex。 */
export function computeRequestSignature(
  secret: string,
  parts: { timestamp: string; body: string },
): string {
  const payload = `${parts.timestamp}.${parts.body}`;
  return createHmac("sha256", secret).update(payload).digest("hex");
}

function deriveEncryptionKey(): Buffer {
  const raw = process.env.INBOUND_HMAC_SECRET_KEY ?? process.env.SESSION_SECRET ?? "";
  if (!raw || raw.length < 16) {
    throw new Error("INBOUND_HMAC_SECRET_KEY or SESSION_SECRET must be set (>=16 chars)");
  }
  return createHash("sha256").update(raw).digest();
}

/** AES-256-GCM 加密 HMAC secret，格式 iv:ciphertext:tag（hex）。 */
export function encryptApiSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveEncryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${ciphertext.toString("hex")}:${tag.toString("hex")}`;
}

export function decryptApiSecret(encrypted: string): string {
  const [ivHex, ciphertextHex, tagHex] = encrypted.split(":");
  if (!ivHex || !ciphertextHex || !tagHex) {
    throw new Error("Malformed encrypted api secret");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    deriveEncryptionKey(),
    Buffer.from(ivHex, "hex"),
  );
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, "hex")),
    decipher.final(),
  ]).toString("utf8");
}

/** 把 IP 或 CIDR 解析为 32 位整数 + 子网长度（仅 IPv4，IPv6 暂以字符串前缀近似）。 */
function parseIPv4(addr: string): number | null {
  const parts = addr.split(".");
  if (parts.length !== 4) return null;
  let acc = 0;
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    acc = (acc << 8) + n;
  }
  return acc >>> 0;
}

/**
 * 判定 ip 是否落在白名单内：
 *  - 白名单为空 → 允许
 *  - 条目无 `/` → 精确匹配
 *  - IPv4 + CIDR → 子网比对
 *  - IPv6 → 仅做精确（或前缀近似）匹配
 */
export function isIpAllowed(ip: string, whitelist: string[]): boolean {
  if (!whitelist || whitelist.length === 0) return true;
  if (!ip || ip === "unknown") return false;
  const ipv4 = parseIPv4(ip);
  for (const entry of whitelist) {
    const [base, maskStr] = entry.split("/");
    if (!base) continue;
    if (!maskStr) {
      if (base === ip) return true;
      continue;
    }
    const mask = Number(maskStr);
    if (!Number.isInteger(mask) || mask < 0) continue;
    if (ipv4 !== null && base.includes(".")) {
      const baseInt = parseIPv4(base);
      if (baseInt === null) continue;
      if (mask === 0) return true;
      const m = mask >= 32 ? 0xffffffff : (~0 << (32 - mask)) >>> 0;
      if ((baseInt & m) === (ipv4 & m)) return true;
    } else if (base.includes(":")) {
      // IPv6：简单前缀字符串匹配（生产环境如需精确 v6 应换 `ipaddr.js`）
      const len = Math.floor(mask / 4);
      if (ip.startsWith(base.slice(0, len))) return true;
    }
  }
  return false;
}
