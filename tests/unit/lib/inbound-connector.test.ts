/**
 * Phase 9 inbound-connector：crypto + schema + ip-whitelist 单元测试。
 *
 * 关联 spec：specs/modules/inbound-connector.md
 */

import { describe, it, expect } from "vitest";
import {
  generateApiToken,
  generateHmacSecret,
  hashToken,
  computeRequestSignature,
  encryptApiSecret,
  decryptApiSecret,
  isIpAllowed,
  timingSafeEqualHex,
} from "@/lib/modules/api-client/crypto";
import {
  CreateApiClientSchema,
  UpdateApiClientSchema,
  ListApiClientsQuerySchema,
} from "@/lib/modules/api-client/schema";

describe("inbound-connector / crypto", () => {
  it("generateApiToken: token 以 ic_ 开头且 hash 是 sha256(token)", () => {
    const { token, prefix, hash } = generateApiToken();
    expect(token).toMatch(/^ic_[0-9a-f]{64}$/);
    expect(prefix).toBe(token.slice(0, 12));
    expect(hash).toBe(hashToken(token));
    expect(hash).toHaveLength(64);
  });

  it("generateHmacSecret: 64 hex secret + 64 hex hash", () => {
    const { secret, hash } = generateHmacSecret();
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashToken(secret));
  });

  it("computeRequestSignature: 按 spec 签名 timestamp + '.' + rawBody", () => {
    const sig1 = computeRequestSignature("seckey", {
      timestamp: "1700000000",
      body: '{"email":"a@example.com"}',
    });
    const sig2 = computeRequestSignature("seckey", {
      timestamp: "1700000000",
      body: '{"email":"a@example.com"}',
    });
    expect(sig1).toBe(sig2);
    expect(sig1).toHaveLength(64);
  });

  it("computeRequestSignature: body / timestamp 变化即变化", () => {
    const a = computeRequestSignature("k", {
      timestamp: "1",
      body: "{}",
    });
    const b = computeRequestSignature("k", {
      timestamp: "1",
      body: '{"x":1}',
    });
    expect(a).not.toBe(b);
  });

  it("encryptApiSecret / decryptApiSecret: 往返且密文不泄漏明文", () => {
    process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef";
    const enc = encryptApiSecret("hmac-secret");
    expect(enc).not.toContain("hmac-secret");
    expect(enc.split(":")).toHaveLength(3);
    expect(decryptApiSecret(enc)).toBe("hmac-secret");
  });

  it("timingSafeEqualHex: 长度不同直接 false，相同字符串 true", () => {
    expect(timingSafeEqualHex("abcd", "abcde")).toBe(false);
    expect(timingSafeEqualHex("ab", "ab")).toBe(true);
    expect(timingSafeEqualHex("ab", "cd")).toBe(false);
  });
});

describe("inbound-connector / isIpAllowed", () => {
  it("空白名单 → 全部放行", () => {
    expect(isIpAllowed("1.2.3.4", [])).toBe(true);
  });
  it("精确 IPv4 匹配", () => {
    expect(isIpAllowed("10.0.0.1", ["10.0.0.1"])).toBe(true);
    expect(isIpAllowed("10.0.0.2", ["10.0.0.1"])).toBe(false);
  });
  it("CIDR 匹配", () => {
    expect(isIpAllowed("10.0.0.5", ["10.0.0.0/24"])).toBe(true);
    expect(isIpAllowed("10.0.1.5", ["10.0.0.0/24"])).toBe(false);
    expect(isIpAllowed("10.0.0.5", ["10.0.0.0/0"])).toBe(true);
  });
  it("unknown ip 在非空白名单下被拒", () => {
    expect(isIpAllowed("unknown", ["10.0.0.1"])).toBe(false);
  });
});

describe("inbound-connector / schema", () => {
  it("CreateApiClientSchema: scopes 必须非空且取自枚举", () => {
    expect(() =>
      CreateApiClientSchema.parse({ name: "ok", scopes: [] }),
    ).toThrow();
    expect(() =>
      CreateApiClientSchema.parse({ name: "ok", scopes: ["bad:scope"] }),
    ).toThrow();
    const ok = CreateApiClientSchema.parse({
      name: "Importer",
      scopes: ["user:write", "tag:write", "topic:write"],
    });
    expect(ok.scopes).toEqual(["user:write", "tag:write", "topic:write"]);
  });

  it("CreateApiClientSchema: ipWhitelist 校验 IPv4/CIDR", () => {
    expect(() =>
      CreateApiClientSchema.parse({
        name: "x",
        scopes: ["user:write"],
        ipWhitelist: ["bad-ip"],
      }),
    ).toThrow();
    const ok = CreateApiClientSchema.parse({
      name: "x",
      scopes: ["user:write"],
      ipWhitelist: ["10.0.0.0/24", "127.0.0.1"],
    });
    expect(ok.ipWhitelist).toHaveLength(2);
  });

  it("UpdateApiClientSchema: status 只允许 ACTIVE/DISABLED（REVOKED 走 DELETE）", () => {
    expect(() =>
      UpdateApiClientSchema.parse({ status: "REVOKED" }),
    ).toThrow();
    expect(
      UpdateApiClientSchema.parse({ status: "DISABLED" }).status,
    ).toBe("DISABLED");
  });

  it("ListApiClientsQuerySchema: page/pageSize 默认值", () => {
    const q = ListApiClientsQuerySchema.parse({});
    expect(q.page).toBe(1);
    expect(q.pageSize).toBe(20);
  });
});
