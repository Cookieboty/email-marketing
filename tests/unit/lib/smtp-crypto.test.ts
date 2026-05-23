import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import {
  buildPasswordHint,
  decryptSmtpPassword,
  deriveSmtpKey,
  encryptSmtpPassword,
  SmtpCryptoError,
} from "@/lib/modules/smtp/crypto";

const TEST_SECRET = "test-session-secret-at-least-16-chars";

let originalSecret: string | undefined;

beforeEach(() => {
  originalSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = TEST_SECRET;
});

afterEach(() => {
  if (originalSecret === undefined) {
    delete process.env.SESSION_SECRET;
  } else {
    process.env.SESSION_SECRET = originalSecret;
  }
});

describe("smtp/crypto", () => {
  describe("encrypt/decrypt round-trip", () => {
    it("解密后还原明文", () => {
      const cipher = encryptSmtpPassword("hunter2");
      expect(decryptSmtpPassword(cipher)).toBe("hunter2");
    });

    it("支持 UTF-8 多字节明文", () => {
      const plain = "中文密码🚀!@#";
      const cipher = encryptSmtpPassword(plain);
      expect(decryptSmtpPassword(cipher)).toBe(plain);
    });

    it("同一明文两次加密产生不同密文（随机 IV）", () => {
      const a = encryptSmtpPassword("same");
      const b = encryptSmtpPassword("same");
      expect(a).not.toBe(b);
      expect(decryptSmtpPassword(a)).toBe("same");
      expect(decryptSmtpPassword(b)).toBe("same");
    });

    it("密文格式为 iv:cipher:tag（三段 hex）", () => {
      const cipher = encryptSmtpPassword("payload");
      const parts = cipher.split(":");
      expect(parts).toHaveLength(3);
      const [ivHex, , tagHex] = parts;
      expect(ivHex).toMatch(/^[0-9a-f]+$/);
      expect(Buffer.from(ivHex, "hex").byteLength).toBe(12);
      expect(Buffer.from(tagHex, "hex").byteLength).toBe(16);
    });
  });

  describe("encrypt 输入校验", () => {
    it("空字符串拒绝", () => {
      expect(() => encryptSmtpPassword("")).toThrow(SmtpCryptoError);
    });

    it("超过 1KB 拒绝", () => {
      const big = "x".repeat(1025);
      expect(() => encryptSmtpPassword(big)).toThrow(SmtpCryptoError);
    });

    it("SESSION_SECRET 未配置或过短抛 SmtpCryptoError", () => {
      process.env.SESSION_SECRET = "short";
      expect(() => encryptSmtpPassword("x")).toThrow(SmtpCryptoError);
    });
  });

  describe("decrypt 错误路径", () => {
    it("格式不正确（非三段）抛错", () => {
      expect(() => decryptSmtpPassword("not-a-cipher")).toThrow(SmtpCryptoError);
      expect(() => decryptSmtpPassword("a:b")).toThrow(SmtpCryptoError);
    });

    it("空字符串抛错", () => {
      expect(() => decryptSmtpPassword("")).toThrow(SmtpCryptoError);
    });

    it("IV 长度不对抛错", () => {
      const cipher = encryptSmtpPassword("p");
      const [, body, tag] = cipher.split(":");
      const badIv = "00".repeat(8);
      expect(() => decryptSmtpPassword(`${badIv}:${body}:${tag}`)).toThrow(SmtpCryptoError);
    });

    it("tag 被篡改 → 抛错且不泄漏明文", () => {
      const cipher = encryptSmtpPassword("secret");
      const [iv, body, tag] = cipher.split(":");
      const flipped =
        tag.slice(0, -2) + (tag.endsWith("00") ? "01" : "00");
      expect(() => decryptSmtpPassword(`${iv}:${body}:${flipped}`)).toThrow(
        /failed to decrypt/,
      );
    });

    it("使用不同 SESSION_SECRET 加密的密文无法解密", () => {
      const cipher = encryptSmtpPassword("crossenv");
      process.env.SESSION_SECRET = "different-session-secret-16chars+";
      expect(() => decryptSmtpPassword(cipher)).toThrow(SmtpCryptoError);
    });
  });

  describe("HKDF 域分离", () => {
    it("相同 master secret 派生出确定性的 32 字节 key", () => {
      const k1 = deriveSmtpKey(TEST_SECRET);
      const k2 = deriveSmtpKey(TEST_SECRET);
      expect(k1.byteLength).toBe(32);
      expect(k1.equals(k2)).toBe(true);
    });

    it("派生 key 与 ApiClient 的 SHA-256(masterSecret) 派生方式不同", () => {
      // ApiClient 用 createHash("sha256") 直接摘要 master secret；
      // SMTP 走 HKDF + info=smtp.password.v1，二者必须不同，
      // 否则 ApiClient 子密钥泄漏会牵连到 SMTP。
      const apiClientKey = createHash("sha256").update(TEST_SECRET).digest();
      const smtpKey = deriveSmtpKey(TEST_SECRET);
      expect(smtpKey.equals(apiClientKey)).toBe(false);
    });
  });

  describe("buildPasswordHint", () => {
    it("正常长度 → ••••<last4>", () => {
      expect(buildPasswordHint("abcdef1234")).toBe("••••1234");
    });

    it("长度不足 4 → ••••（不泄漏内容）", () => {
      expect(buildPasswordHint("abc")).toBe("••••");
      expect(buildPasswordHint("")).toBe("••••");
    });
  });
});
