/**
 * ImportSource 凭据 AES-256-GCM 加解密。
 *
 * 关联 spec：specs/modules/outbound-importer.md §122-132
 *
 * 输出格式：`iv:ciphertext:tag`（hex 拼接），便于 DB 文本字段存储。
 * 密钥来源：`IMPORT_SOURCE_SECRET_KEY`；缺省时由 `SESSION_SECRET` 派生（SHA-256），
 * 保证旧部署在不显式配置时仍可工作。32 字节固定密钥长度；任何长度的源串
 * 都会经过 SHA-256 派生为 32B。
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";

const IV_BYTES = 12;
const TAG_BYTES = 16;
const ALGO = "aes-256-gcm" as const;

function deriveKey(): Buffer {
  const e = env();
  const raw = e.IMPORT_SOURCE_SECRET_KEY ?? process.env.SESSION_SECRET ?? "";
  if (!raw || raw.length < 16) {
    throw new AppError(
      "IMPORT_SOURCE_SECRET_KEY (or SESSION_SECRET fallback) must be set (>=16 chars)",
      { status: 500, code: "import_secret_missing" },
    );
  }
  return createHash("sha256").update(raw).digest();
}

/** 加密为 `iv:ciphertext:tag` (hex)。 */
export function encryptSecret(plaintext: string): string {
  if (typeof plaintext !== "string") {
    throw new AppError("encryptSecret expects a string", {
      status: 500,
      code: "import_secret_invalid",
    });
  }
  const key = deriveKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${enc.toString("hex")}:${tag.toString("hex")}`;
}

/** 解密 `iv:ciphertext:tag` (hex)。任何篡改会抛错。 */
export function decryptSecret(encrypted: string): string {
  if (typeof encrypted !== "string" || encrypted.length === 0) {
    throw new AppError("decryptSecret expects a non-empty string", {
      status: 500,
      code: "import_secret_invalid",
    });
  }
  const parts = encrypted.split(":");
  if (parts.length !== 3) {
    throw new AppError("Malformed encrypted secret payload", {
      status: 500,
      code: "import_secret_malformed",
    });
  }
  const [ivHex, ctHex, tagHex] = parts as [string, string, string];
  const iv = Buffer.from(ivHex, "hex");
  const ct = Buffer.from(ctHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new AppError("Invalid IV or auth tag length", {
      status: 500,
      code: "import_secret_malformed",
    });
  }
  const key = deriveKey();
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  try {
    const dec = Buffer.concat([decipher.update(ct), decipher.final()]);
    return dec.toString("utf8");
  } catch {
    throw new AppError("Failed to decrypt secret (tampered or wrong key)", {
      status: 500,
      code: "import_secret_decrypt_failed",
    });
  }
}
