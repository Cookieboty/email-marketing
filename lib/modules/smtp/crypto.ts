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

const HKDF_INFO = Buffer.from("smtp.password.v1", "utf8");
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

/**
 * 派生 SMTP 凭证专用密钥（导出仅供测试）。
 *
 * 同样的 master secret + 同样的 info/salt 必然得到同样的 key，
 * 这是 HKDF 的确定性，也是密文跨进程可解密的前提。
 */
export function deriveSmtpKey(masterSecret: string = readMasterSecret()): Buffer {
  const ikm = Buffer.from(masterSecret, "utf8");
  const derived = hkdfSync("sha256", ikm, HKDF_SALT, HKDF_INFO, KEY_LENGTH);
  return Buffer.from(derived);
}

/**
 * 加密 SMTP 密码（或任意短凭证）。
 *
 * - 输入：UTF-8 明文，长度上限 1KB；超过抛 `SmtpCryptoError`。
 * - 输出：`iv:cipher:tag` hex 串，可直接写入 `SmtpConfig.passwordCipher`。
 * - 每次调用使用独立随机 IV，相同明文每次产出不同密文（语义安全）。
 */
export function encryptSmtpPassword(plaintext: string): string {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new SmtpCryptoError("plaintext password must be a non-empty string");
  }
  const plainBuf = Buffer.from(plaintext, "utf8");
  if (plainBuf.byteLength > MAX_PLAINTEXT_BYTES) {
    throw new SmtpCryptoError(
      `plaintext password too long (${plainBuf.byteLength} > ${MAX_PLAINTEXT_BYTES} bytes)`,
    );
  }

  const key = deriveSmtpKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plainBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${ciphertext.toString("hex")}:${tag.toString("hex")}`;
}

/**
 * 解密 `passwordCipher`。失败时统一抛 `SmtpCryptoError`，调用方应在外部映射为
 * 合适的 HTTP / 任务级错误，且**绝不能将异常 message 透传到客户端或日志**。
 */
export function decryptSmtpPassword(encrypted: string): string {
  if (typeof encrypted !== "string" || encrypted.length === 0) {
    throw new SmtpCryptoError("encrypted password is empty");
  }
  const parts = encrypted.split(":");
  if (parts.length !== 3) {
    throw new SmtpCryptoError("malformed encrypted SMTP password");
  }
  const [ivHex, cipherHex, tagHex] = parts;
  if (!ivHex || !cipherHex || !tagHex) {
    throw new SmtpCryptoError("malformed encrypted SMTP password");
  }

  let iv: Buffer;
  let cipherBuf: Buffer;
  let tag: Buffer;
  try {
    iv = Buffer.from(ivHex, "hex");
    cipherBuf = Buffer.from(cipherHex, "hex");
    tag = Buffer.from(tagHex, "hex");
  } catch {
    throw new SmtpCryptoError("malformed encrypted SMTP password");
  }
  if (iv.byteLength !== IV_LENGTH || tag.byteLength !== 16) {
    throw new SmtpCryptoError("malformed encrypted SMTP password");
  }

  const key = deriveSmtpKey();
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  try {
    const plain = Buffer.concat([decipher.update(cipherBuf), decipher.final()]);
    return plain.toString("utf8");
  } catch {
    // GCM tag mismatch / key mismatch / 数据被篡改 → 统一隐匿原因
    throw new SmtpCryptoError("failed to decrypt SMTP password");
  }
}

/**
 * 构造前端展示用的密码提示，形如 `••••a4f1`。
 *
 * - 不依赖密钥派生，纯字符串处理；
 * - 不在任何场合返回明文，仅用于 UI 显示。
 * - 明文长度不足 4 时降级为 `••••`，避免泄漏短密码细节。
 */
export function buildPasswordHint(plaintext: string): string {
  if (typeof plaintext !== "string" || plaintext.length < 4) return "••••";
  return `••••${plaintext.slice(-4)}`;
}
