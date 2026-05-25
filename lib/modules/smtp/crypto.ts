/**
 * SMTP 凭证加解密。
 *
 * 关联 spec：specs/modules/smtp-configuration.md（"凭证加密"小节）
 *
 * 设计要点：
 * - 算法：AES-256-GCM（与 ApiClient secret 一致），密文格式 `iv:cipher:tag`（hex）。
 * - 与 `lib/modules/api-client/crypto.ts` 共用 `SESSION_SECRET`，但通过 HKDF
 *   info=`smtp.password.v1` 派生独立 32 字节子密钥，确保「即便 ApiClient 子密钥
 *   泄漏，也无法解密任何 SMTP 凭证」。
 * - HKDF 参数：digest=sha256，salt=固定字节串 `email-marketing/smtp/v1`，
 *   ikm=`SESSION_SECRET` 原文（要求 ≥ 16 字节），keylen=32。
 * - 完全无状态：不缓存派生 key，避免 key 在内存里长留；调用频率与登录态请求一致，
 *   性能影响可忽略。
 */

import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";

const HKDF_SALT = Buffer.from("email-marketing/smtp/v1", "utf8");
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const ALGORITHM = "aes-256-gcm" as const;
const MIN_SECRET_LENGTH = 16;
const MAX_PLAINTEXT_BYTES = 1024;

export class SmtpCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmtpCryptoError";
  }
}

function readMasterSecret(): string {
  const raw = process.env.SESSION_SECRET ?? "";
  if (raw.length < MIN_SECRET_LENGTH) {
    throw new SmtpCryptoError(
      `SESSION_SECRET must be set (>= ${MIN_SECRET_LENGTH} chars) to encrypt SMTP credentials`,
    );
  }
  return raw;
}

function deriveKey(info: string, masterSecret: string = readMasterSecret()): Buffer {
  const ikm = Buffer.from(masterSecret, "utf8");
  const derived = hkdfSync("sha256", ikm, HKDF_SALT, Buffer.from(info, "utf8"), KEY_LENGTH);
  return Buffer.from(derived);
}

/**
 * 派生 SMTP 凭证专用密钥（导出仅供测试）。
 */
export function deriveSmtpKey(masterSecret: string = readMasterSecret()): Buffer {
  return deriveKey("smtp.password.v1", masterSecret);
}

/**
 * 派生 Resend API Key 专用密钥（导出仅供测试）。
 */
export function deriveResendKey(masterSecret: string = readMasterSecret()): Buffer {
  return deriveKey("resend.apikey.v1", masterSecret);
}

function encryptWithKey(plaintext: string, key: Buffer): string {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new SmtpCryptoError("plaintext must be a non-empty string");
  }
  const plainBuf = Buffer.from(plaintext, "utf8");
  if (plainBuf.byteLength > MAX_PLAINTEXT_BYTES) {
    throw new SmtpCryptoError(
      `plaintext too long (${plainBuf.byteLength} > ${MAX_PLAINTEXT_BYTES} bytes)`,
    );
  }
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plainBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${ciphertext.toString("hex")}:${tag.toString("hex")}`;
}

function decryptWithKey(encrypted: string, key: Buffer): string {
  if (typeof encrypted !== "string" || encrypted.length === 0) {
    throw new SmtpCryptoError("encrypted value is empty");
  }
  const parts = encrypted.split(":");
  if (parts.length !== 3) {
    throw new SmtpCryptoError("malformed encrypted value");
  }
  const [ivHex, cipherHex, tagHex] = parts;
  if (!ivHex || !cipherHex || !tagHex) {
    throw new SmtpCryptoError("malformed encrypted value");
  }

  let iv: Buffer;
  let cipherBuf: Buffer;
  let tag: Buffer;
  try {
    iv = Buffer.from(ivHex, "hex");
    cipherBuf = Buffer.from(cipherHex, "hex");
    tag = Buffer.from(tagHex, "hex");
  } catch {
    throw new SmtpCryptoError("malformed encrypted value");
  }
  if (iv.byteLength !== IV_LENGTH || tag.byteLength !== 16) {
    throw new SmtpCryptoError("malformed encrypted value");
  }

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  try {
    const plain = Buffer.concat([decipher.update(cipherBuf), decipher.final()]);
    return plain.toString("utf8");
  } catch {
    throw new SmtpCryptoError("failed to decrypt value");
  }
}

// ── SMTP Password ──

/**
 * 加密 SMTP 密码。
 * 输出：`iv:cipher:tag` hex 串。
 */
export function encryptSmtpPassword(plaintext: string): string {
  return encryptWithKey(plaintext, deriveSmtpKey());
}

/**
 * 解密 `passwordCipher`。
 */
export function decryptSmtpPassword(encrypted: string): string {
  return decryptWithKey(encrypted, deriveSmtpKey());
}

// ── Resend API Key ──

/**
 * 加密 Resend API Key。
 * 输出：`iv:cipher:tag` hex 串。
 */
export function encryptResendApiKey(plaintext: string): string {
  return encryptWithKey(plaintext, deriveResendKey());
}

/**
 * 解密 Resend API Key cipher。
 */
export function decryptResendApiKey(encrypted: string): string {
  return decryptWithKey(encrypted, deriveResendKey());
}

// ── Hint builders ──

/**
 * 构造前端展示用的密码提示，形如 `••••a4f1`。
 */
export function buildPasswordHint(plaintext: string): string {
  if (typeof plaintext !== "string" || plaintext.length < 4) return "••••";
  return `••••${plaintext.slice(-4)}`;
}

/**
 * 构造 Resend API Key 展示提示，形如 `re_...a3Bf`。
 */
export function buildApiKeyHint(plaintext: string): string {
  if (typeof plaintext !== "string" || plaintext.length < 8) return "re_••••";
  return `${plaintext.slice(0, 3)}...${plaintext.slice(-4)}`;
}
