/**
 * SMTP 服务层核心业务逻辑测试。
 *
 * 设计：
 * - 全部 Prisma 调用通过 vi.mock 替身，不依赖数据库；
 * - crypto / audit 也被 mock 掉，确保业务断言聚焦在调用契约；
 * - schema 部分使用 zod 直接 safeParse 校验，无需 mock。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- prisma mock：每个使用到的方法独立 vi.fn，便于断言 ----
const findUnique = vi.fn();
const findFirst = vi.fn();
const create = vi.fn();
const update = vi.fn();
const updateMany = vi.fn();
const settingFindUnique = vi.fn();
const settingUpsert = vi.fn();
const trx = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    smtpConfig: {
      findUnique: (...args: unknown[]) => findUnique(...args),
      findFirst: (...args: unknown[]) => findFirst(...args),
      create: (...args: unknown[]) => create(...args),
      update: (...args: unknown[]) => update(...args),
      updateMany: (...args: unknown[]) => updateMany(...args),
    },
    mailProviderSetting: {
      findUnique: (...args: unknown[]) => settingFindUnique(...args),
      upsert: (...args: unknown[]) => settingUpsert(...args),
    },
    deliverabilityAlert: {
      findFirst: (...args: unknown[]) => alertFindFirst(...args),
      create: (...args: unknown[]) => alertCreate(...args),
    },
    $transaction: (...args: unknown[]) => trx(...args),
  },
}));

const auditFn = vi.fn();
vi.mock("@/lib/audit", () => ({
  audit: (...args: unknown[]) => auditFn(...args),
}));

const envFn = vi.fn();
vi.mock("@/lib/env", () => ({
  env: () => envFn(),
}));

const rlCheckFn = vi.fn();
const rlRecordFn = vi.fn();
vi.mock("@/lib/rate-limit", () => ({
  getRateLimiter: () => ({
    check: (...args: unknown[]) => rlCheckFn(...args),
    recordFailure: (...args: unknown[]) => rlRecordFn(...args),
  }),
}));

const alertFindFirst = vi.fn();
const alertCreate = vi.fn();

const encryptFn = vi.fn();
const hintFn = vi.fn();
const decryptFn = vi.fn();
const { FakeSmtpCryptoError } = vi.hoisted(() => {
  class FakeSmtpCryptoError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = "SmtpCryptoError";
    }
  }
  return { FakeSmtpCryptoError };
});
vi.mock("@/lib/modules/smtp/crypto", () => ({
  encryptSmtpPassword: (...args: unknown[]) => encryptFn(...args),
  buildPasswordHint: (...args: unknown[]) => hintFn(...args),
  decryptSmtpPassword: (...args: unknown[]) => decryptFn(...args),
  SmtpCryptoError: FakeSmtpCryptoError,
}));

const invalidateFn = vi.fn().mockResolvedValue(undefined);
const verifyFn = vi.fn();
const smtpTransportSendSingle = vi.fn();
const smtpTransportClose = vi.fn().mockResolvedValue(undefined);
const { FakeSmtpTransport } = vi.hoisted(() => {
  class FakeSmtpTransport {
    readonly provider = "SMTP" as const;
    readonly smtpId: string;
    constructor(config: { id: string }) {
      this.smtpId = config.id;
    }
    sendSingle(...args: unknown[]) {
      return (globalThis as unknown as { __smtpTransportSendSingle: (...a: unknown[]) => unknown }).__smtpTransportSendSingle(...args);
    }
    sendBatch() {
      return Promise.resolve([]);
    }
    close() {
      return (globalThis as unknown as { __smtpTransportClose: () => Promise<void> }).__smtpTransportClose();
    }
  }
  return { FakeSmtpTransport };
});
(globalThis as unknown as { __smtpTransportSendSingle: typeof smtpTransportSendSingle }).__smtpTransportSendSingle = smtpTransportSendSingle;
(globalThis as unknown as { __smtpTransportClose: typeof smtpTransportClose }).__smtpTransportClose = smtpTransportClose;
vi.mock("@/lib/modules/mail/transport", () => ({
  invalidateActiveTransport: (...args: unknown[]) => invalidateFn(...args),
  verifySmtpConnection: (...args: unknown[]) => verifyFn(...args),
  SmtpTransport: FakeSmtpTransport,
}));

import {
  CreateSmtpConfigSchema,
  UpdateSmtpConfigSchema,
  ActivateProviderSchema,
} from "@/lib/modules/smtp/schema";
import {
  createSmtpConfig,
  updateSmtpConfig,
  revokeSmtpConfig,
  activateProvider,
  testSmtpConnection,
  testSmtpSend,
  checkSmtpDegradedAlert,
} from "@/lib/modules/smtp/service";
import { ConflictError, NotFoundError, RateLimitError, ValidationError } from "@/lib/errors";

const ACTOR = { adminId: "admin_1", req: { headers: new Headers() } };
const NOW = new Date("2026-05-20T00:00:00.000Z");
const MOCK_ENCRYPTED = "iv:cipher:tag";
const MOCK_HINT = "**ret";

const baseRow = {
  id: "smtp_1",
  name: "Old",
  description: null,
  host: "smtp.example.com",
  port: 587,
  secure: "STARTTLS" as const,
  username: "u@example.com",
  passwordCipher: "old:cipher:tag",
  passwordHint: "**old",
  fromEmail: "from@example.com",
  fromName: null,
  replyTo: null,
  maxConnections: 5,
  maxMessagesPerConn: 100,
  rateLimitPerSec: null,
  connectionTimeoutMs: 30000,
  greetingTimeoutMs: 30000,
  socketTimeoutMs: 60000,
  rejectUnauthorized: true,
  requireTls: true,
  status: "ACTIVE" as const,
  isDefault: false,
  lastTestAt: null,
  lastTestStatus: null,
  lastTestError: null,
  lastSendAt: null,
  recentFailures: 0,
  createdAt: NOW,
  updatedAt: NOW,
  createdBy: null,
  updatedBy: null,
};

const DEFAULT_ENV = {
  RATE_LIMIT_TEST_SEND_MAX: 60,
  RATE_LIMIT_TEST_SEND_WINDOW_SEC: 3600,
  SMTP_FAILURE_THRESHOLD: 20,
};

beforeEach(() => {
  vi.clearAllMocks();
  encryptFn.mockReturnValue(MOCK_ENCRYPTED);
  hintFn.mockReturnValue(MOCK_HINT);
  envFn.mockReturnValue(DEFAULT_ENV);
  rlCheckFn.mockReturnValue({ allowed: true });
});

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

describe("CreateSmtpConfigSchema", () => {
  const ok = {
    name: "Test",
    host: "smtp.example.com",
    port: 587,
    secure: "STARTTLS" as const,
    fromEmail: "from@example.com",
  };

  it("port=465 必须 TLS", () => {
    const r = CreateSmtpConfigSchema.safeParse({ ...ok, port: 465, secure: "STARTTLS" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].path).toEqual(["secure"]);
  });

  it("port=587 不允许 TLS", () => {
    const r = CreateSmtpConfigSchema.safeParse({ ...ok, secure: "TLS" });
    expect(r.success).toBe(false);
  });

  it("没有 username 时不能有 password", () => {
    const r = CreateSmtpConfigSchema.safeParse({ ...ok, password: "secret" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].path).toEqual(["password"]);
  });

  it("有 username + password 通过", () => {
    const r = CreateSmtpConfigSchema.safeParse({ ...ok, username: "u@e.com", password: "secret" });
    expect(r.success).toBe(true);
  });
});

describe("UpdateSmtpConfigSchema", () => {
  it("password=null 必须 username=null", () => {
    const r = UpdateSmtpConfigSchema.safeParse({ password: null, username: "still_here" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].path).toEqual(["password"]);
  });

  it("password=undefined 不会触发联动校验", () => {
    const r = UpdateSmtpConfigSchema.safeParse({ name: "rename" });
    expect(r.success).toBe(true);
  });

  it("password='' 视为未修改", () => {
    const r = UpdateSmtpConfigSchema.safeParse({ password: "" });
    expect(r.success).toBe(true);
  });

  it("password=null + username=null 通过", () => {
    const r = UpdateSmtpConfigSchema.safeParse({ password: null, username: null });
    expect(r.success).toBe(true);
  });
});

describe("ActivateProviderSchema", () => {
  it("SMTP 必须带 smtpId", () => {
    const r = ActivateProviderSchema.safeParse({ provider: "SMTP" });
    expect(r.success).toBe(false);
  });
  it("RESEND 不能带 smtpId", () => {
    const r = ActivateProviderSchema.safeParse({ provider: "RESEND", smtpId: "x" });
    expect(r.success).toBe(false);
  });
  it("RESEND without smtpId 通过", () => {
    const r = ActivateProviderSchema.safeParse({ provider: "RESEND" });
    expect(r.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createSmtpConfig
// ---------------------------------------------------------------------------

describe("createSmtpConfig", () => {
  const input = {
    name: "Prod SMTP",
    host: "smtp.example.com",
    port: 587,
    secure: "STARTTLS" as const,
    username: "u@example.com",
    password: "s3cret",
    fromEmail: "from@example.com",
  };

  it("成功创建并加密密码 + 写审计", async () => {
    findFirst.mockResolvedValue(null);
    create.mockResolvedValue({ ...baseRow, name: input.name, passwordCipher: MOCK_ENCRYPTED, passwordHint: MOCK_HINT });

    const view = await createSmtpConfig(input, ACTOR);

    expect(findFirst).toHaveBeenCalledWith({
      where: { host: input.host, port: input.port, username: input.username },
    });
    expect(encryptFn).toHaveBeenCalledWith("s3cret");
    expect(hintFn).toHaveBeenCalledWith("s3cret");
    const callArg = create.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(callArg.data.passwordCipher).toBe(MOCK_ENCRYPTED);
    expect(callArg.data.passwordHint).toBe(MOCK_HINT);
    expect(view.hasPassword).toBe(true);
    expect(auditFn).toHaveBeenCalledTimes(1);
    expect(auditFn.mock.calls[0]![0]).toMatchObject({ action: "smtp.create" });
  });

  it("重复 (host, port, username) → ConflictError", async () => {
    findFirst.mockResolvedValue(baseRow);
    await expect(createSmtpConfig(input, ACTOR)).rejects.toBeInstanceOf(ConflictError);
    expect(create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// updateSmtpConfig
// ---------------------------------------------------------------------------

describe("updateSmtpConfig", () => {
  it("password=null 同时清除 username 与 cipher，并重置健康度", async () => {
    findUnique.mockResolvedValue(baseRow);
    findFirst.mockResolvedValue(null);
    update.mockResolvedValue({ ...baseRow, username: null, passwordCipher: null, passwordHint: null });

    await updateSmtpConfig("smtp_1", { password: null, username: null }, ACTOR);

    const arg = update.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(arg.data.passwordCipher).toBeNull();
    expect(arg.data.passwordHint).toBeNull();
    expect(arg.data.username).toBeNull();
    expect(arg.data.lastTestStatus).toBeNull();
    expect(arg.data.recentFailures).toBe(0);
  });

  it("password='' 不修改 cipher", async () => {
    findUnique.mockResolvedValue(baseRow);
    update.mockResolvedValue(baseRow);

    await updateSmtpConfig("smtp_1", { password: "", name: "rename" }, ACTOR);

    const arg = update.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(arg.data).not.toHaveProperty("passwordCipher");
    expect(arg.data.name).toBe("rename");
    expect(encryptFn).not.toHaveBeenCalled();
  });

  it("password='new' 重新加密并重置健康度", async () => {
    findUnique.mockResolvedValue(baseRow);
    update.mockResolvedValue(baseRow);

    await updateSmtpConfig("smtp_1", { password: "new" }, ACTOR);

    expect(encryptFn).toHaveBeenCalledWith("new");
    const arg = update.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(arg.data.passwordCipher).toBe(MOCK_ENCRYPTED);
    expect(arg.data.recentFailures).toBe(0);
  });

  it("不存在 → NotFoundError", async () => {
    findUnique.mockResolvedValue(null);
    await expect(updateSmtpConfig("missing", { name: "x" }, ACTOR)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("已撤销 → ConflictError", async () => {
    findUnique.mockResolvedValue({ ...baseRow, status: "REVOKED" });
    await expect(updateSmtpConfig("smtp_1", { name: "x" }, ACTOR)).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it("修改 host 触发查重，命中则 Conflict", async () => {
    findUnique.mockResolvedValue(baseRow);
    findFirst.mockResolvedValue({ ...baseRow, id: "other" });
    await expect(
      updateSmtpConfig("smtp_1", { host: "another.smtp.com" }, ACTOR),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

// ---------------------------------------------------------------------------
// revokeSmtpConfig
// ---------------------------------------------------------------------------

describe("revokeSmtpConfig", () => {
  it("当前激活通道不可撤销", async () => {
    findUnique.mockResolvedValue(baseRow);
    settingFindUnique.mockResolvedValue({
      id: "singleton",
      activeProvider: "SMTP",
      activeSmtpId: "smtp_1",
      fallback: null,
      updatedAt: NOW,
      updatedBy: null,
    });

    await expect(revokeSmtpConfig("smtp_1", ACTOR)).rejects.toBeInstanceOf(ConflictError);
    expect(update).not.toHaveBeenCalled();
  });

  it("非激活通道允许撤销 + 写审计 + 清 isDefault + 清凭证", async () => {
    findUnique.mockResolvedValue({ ...baseRow, isDefault: true });
    settingFindUnique.mockResolvedValue({
      id: "singleton",
      activeProvider: "RESEND",
      activeSmtpId: null,
      fallback: null,
      updatedAt: NOW,
      updatedBy: null,
    });
    update.mockResolvedValue({ ...baseRow, status: "REVOKED", isDefault: false, passwordCipher: null, passwordHint: null });

    const view = await revokeSmtpConfig("smtp_1", ACTOR);

    const arg = update.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(arg.data.status).toBe("REVOKED");
    expect(arg.data.isDefault).toBe(false);
    expect(arg.data.passwordCipher).toBeNull();
    expect(arg.data.passwordHint).toBeNull();
    expect(view.status).toBe("REVOKED");
    expect(auditFn.mock.calls[0]![0]).toMatchObject({ action: "smtp.revoke" });
  });
});

// ---------------------------------------------------------------------------
// activateProvider
// ---------------------------------------------------------------------------

describe("activateProvider", () => {
  // 让 $transaction(cb) 直接执行 cb(prisma)
  function mockTxPassthrough() {
    trx.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
      return cb({
        smtpConfig: {
          findUnique: (...a: unknown[]) => findUnique(...a),
          update: (...a: unknown[]) => update(...a),
          updateMany: (...a: unknown[]) => updateMany(...a),
        },
        mailProviderSetting: {
          findUnique: (...a: unknown[]) => settingFindUnique(...a),
          upsert: (...a: unknown[]) => settingUpsert(...a),
        },
      });
    });
  }

  it("RESEND：清空 isDefault + upsert setting", async () => {
    mockTxPassthrough();
    updateMany.mockResolvedValue({ count: 1 });
    settingUpsert.mockResolvedValue({
      id: "singleton",
      activeProvider: "RESEND",
      activeSmtpId: null,
      fallback: null,
      updatedAt: NOW,
      updatedBy: ACTOR.adminId,
    });

    const view = await activateProvider({ provider: "RESEND" }, ACTOR);

    expect(updateMany).toHaveBeenCalledWith({ where: { isDefault: true }, data: { isDefault: false } });
    const upsertArg = settingUpsert.mock.calls[0]![0] as { update: Record<string, unknown> };
    expect(upsertArg.update.activeProvider).toBe("RESEND");
    expect(upsertArg.update.activeSmtpId).toBeNull();
    expect(view.activeProvider).toBe("RESEND");
  });

  it("SMTP：未通过测试 → ValidationError", async () => {
    mockTxPassthrough();
    findUnique.mockResolvedValue({ ...baseRow, status: "ACTIVE", lastTestStatus: null });

    await expect(
      activateProvider({ provider: "SMTP", smtpId: "smtp_1" }, ACTOR),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(settingUpsert).not.toHaveBeenCalled();
  });

  it("SMTP：状态非 ACTIVE → ValidationError", async () => {
    mockTxPassthrough();
    findUnique.mockResolvedValue({ ...baseRow, status: "DISABLED", lastTestStatus: "OK" });

    await expect(
      activateProvider({ provider: "SMTP", smtpId: "smtp_1" }, ACTOR),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("SMTP：目标不存在 → NotFoundError", async () => {
    mockTxPassthrough();
    findUnique.mockResolvedValue(null);
    await expect(
      activateProvider({ provider: "SMTP", smtpId: "ghost" }, ACTOR),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("SMTP：成功激活会先清其它 default 再 setDefault 再 upsert setting", async () => {
    mockTxPassthrough();
    findUnique.mockResolvedValue({ ...baseRow, status: "ACTIVE", lastTestStatus: "OK" });
    updateMany.mockResolvedValue({ count: 0 });
    update.mockResolvedValue({ ...baseRow, isDefault: true });
    settingUpsert.mockResolvedValue({
      id: "singleton",
      activeProvider: "SMTP",
      activeSmtpId: "smtp_1",
      fallback: null,
      updatedAt: NOW,
      updatedBy: ACTOR.adminId,
    });

    const view = await activateProvider({ provider: "SMTP", smtpId: "smtp_1" }, ACTOR);

    expect(updateMany).toHaveBeenCalledWith({
      where: { isDefault: true, NOT: { id: "smtp_1" } },
      data: { isDefault: false },
    });
    expect(update).toHaveBeenCalledWith({ where: { id: "smtp_1" }, data: { isDefault: true } });
    const upsertArg = settingUpsert.mock.calls[0]![0] as { update: Record<string, unknown> };
    expect(upsertArg.update.activeProvider).toBe("SMTP");
    expect(upsertArg.update.activeSmtpId).toBe("smtp_1");
    expect(view.activeProvider).toBe("SMTP");
    expect(view.activeSmtpId).toBe("smtp_1");
  });
});

// ---------------------------------------------------------------------------
// testSmtpConnection
// ---------------------------------------------------------------------------

describe("testSmtpConnection", () => {
  it("不存在 → NotFoundError", async () => {
    findUnique.mockResolvedValue(null);
    await expect(testSmtpConnection("ghost", ACTOR)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("已撤销 → ConflictError", async () => {
    findUnique.mockResolvedValue({ ...baseRow, status: "REVOKED" });
    await expect(testSmtpConnection("smtp_1", ACTOR)).rejects.toBeInstanceOf(ConflictError);
  });

  it("成功：写回 OK + 清零 recentFailures", async () => {
    findUnique.mockResolvedValue(baseRow);
    decryptFn.mockReturnValue("plain-pass");
    verifyFn.mockResolvedValue({ ok: true });
    update.mockResolvedValue({ ...baseRow, lastTestStatus: "OK", recentFailures: 0 });

    const result = await testSmtpConnection("smtp_1", ACTOR);

    expect(decryptFn).toHaveBeenCalledWith(baseRow.passwordCipher);
    const verifyArg = verifyFn.mock.calls[0]![0] as { password: string };
    expect(verifyArg.password).toBe("plain-pass");
    const updArg = update.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(updArg.data.lastTestStatus).toBe("OK");
    expect(updArg.data.recentFailures).toBe(0);
    expect(result.ok).toBe(true);
    expect(typeof result.elapsedMs).toBe("number");
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(auditFn.mock.calls[0]![0]).toMatchObject({ action: "smtp.test" });
  });

  it("auth 失败：状态映射为 AUTH_FAILED", async () => {
    findUnique.mockResolvedValue(baseRow);
    decryptFn.mockReturnValue("plain-pass");
    verifyFn.mockResolvedValue({ ok: false, error: "bad creds", responseCode: 535 });
    update.mockResolvedValue({ ...baseRow, lastTestStatus: "AUTH_FAILED" });

    const result = await testSmtpConnection("smtp_1", ACTOR);

    const updArg = update.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(updArg.data.lastTestStatus).toBe("AUTH_FAILED");
    expect(result.ok).toBe(false);
    expect(result.responseCode).toBe(535);
  });

  it("超时：状态映射为 TIMEOUT", async () => {
    findUnique.mockResolvedValue(baseRow);
    decryptFn.mockReturnValue("plain-pass");
    verifyFn.mockResolvedValue({ ok: false, error: "timed out", code: "ETIMEDOUT" });
    update.mockResolvedValue({ ...baseRow, lastTestStatus: "TIMEOUT" });

    const result = await testSmtpConnection("smtp_1", ACTOR);
    const updArg = update.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(updArg.data.lastTestStatus).toBe("TIMEOUT");
    expect(result.code).toBe("ETIMEDOUT");
  });

  it("解密失败：写回 UNKNOWN 并标记原因", async () => {
    findUnique.mockResolvedValue(baseRow);
    decryptFn.mockImplementation(() => {
      throw new FakeSmtpCryptoError("decrypt boom");
    });
    update.mockResolvedValue({ ...baseRow, lastTestStatus: "UNKNOWN" });

    const result = await testSmtpConnection("smtp_1", ACTOR);

    expect(verifyFn).not.toHaveBeenCalled();
    const updArg = update.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(updArg.data.lastTestStatus).toBe("UNKNOWN");
    expect(result.ok).toBe(false);
    expect(result.elapsedMs).toBe(0);
    expect(auditFn.mock.calls[0]![0]).toMatchObject({
      action: "smtp.test",
      details: expect.objectContaining({ reason: "decrypt_failed" }),
    });
  });
});

// ---------------------------------------------------------------------------
// testSmtpSend
// ---------------------------------------------------------------------------

describe("testSmtpSend", () => {
  const sendInput = {
    to: "qa@example.com",
    subject: "ping",
    html: "<p>hi</p>",
  };

  it("限流触发 → RateLimitError", async () => {
    rlCheckFn.mockReturnValue({ allowed: false, retryAfterSec: 300 });
    await expect(testSmtpSend("smtp_1", sendInput, ACTOR)).rejects.toBeInstanceOf(RateLimitError);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("不存在 → NotFoundError", async () => {
    findUnique.mockResolvedValue(null);
    await expect(testSmtpSend("ghost", sendInput, ACTOR)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("非 ACTIVE 状态 → ConflictError", async () => {
    findUnique.mockResolvedValue({ ...baseRow, status: "DISABLED" });
    await expect(testSmtpSend("smtp_1", sendInput, ACTOR)).rejects.toBeInstanceOf(ConflictError);
  });

  it("解密失败 → ValidationError", async () => {
    findUnique.mockResolvedValue(baseRow);
    decryptFn.mockImplementation(() => {
      throw new FakeSmtpCryptoError("decrypt boom");
    });
    await expect(testSmtpSend("smtp_1", sendInput, ACTOR)).rejects.toBeInstanceOf(ValidationError);
  });

  it("成功：调用 transport + recordSendSuccess + audit + 限流计数", async () => {
    findUnique.mockResolvedValue(baseRow);
    decryptFn.mockReturnValue("plain-pass");
    smtpTransportSendSingle.mockResolvedValue({ ok: true, id: "msg_123" });
    update.mockResolvedValue(baseRow);

    const result = await testSmtpSend("smtp_1", sendInput, ACTOR);

    expect(smtpTransportSendSingle).toHaveBeenCalledTimes(1);
    expect(smtpTransportClose).toHaveBeenCalledTimes(1);
    const sendArg = smtpTransportSendSingle.mock.calls[0]![0] as Record<string, unknown>;
    expect(sendArg.to).toBe(sendInput.to);
    expect(sendArg.subject).toBe(sendInput.subject);
    const updArg = update.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(updArg.data.recentFailures).toBe(0);
    expect(updArg.data.lastSendAt).toBeInstanceOf(Date);
    expect(result).toMatchObject({ ok: true, messageId: "msg_123" });
    expect(auditFn.mock.calls[0]![0]).toMatchObject({ action: "smtp.test_send" });
    expect(rlRecordFn).toHaveBeenCalledTimes(1);
  });

  it("失败：recordSendFailure + 错误回传 + 限流计数", async () => {
    findUnique.mockResolvedValue(baseRow);
    decryptFn.mockReturnValue("plain-pass");
    smtpTransportSendSingle.mockResolvedValue({ ok: false, error: "boom" });
    update.mockResolvedValue(baseRow);
    alertFindFirst.mockResolvedValue(null);
    alertCreate.mockResolvedValue({});

    const result = await testSmtpSend("smtp_1", sendInput, ACTOR);

    const updArg = update.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(updArg.data.recentFailures).toEqual({ increment: 1 });
    expect(result).toMatchObject({ ok: false, error: "boom" });
    expect(smtpTransportClose).toHaveBeenCalledTimes(1);
    expect(rlRecordFn).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// checkSmtpDegradedAlert
// ---------------------------------------------------------------------------

describe("checkSmtpDegradedAlert", () => {
  it("recentFailures 低于阈值：不触发", async () => {
    await checkSmtpDegradedAlert({ ...baseRow, recentFailures: 5 });
    expect(alertFindFirst).not.toHaveBeenCalled();
  });

  it("达到阈值 + 无未解决 alert：创建告警", async () => {
    alertFindFirst.mockResolvedValue(null);
    alertCreate.mockResolvedValue({});

    await checkSmtpDegradedAlert({ ...baseRow, recentFailures: 20 });

    expect(alertFindFirst).toHaveBeenCalledWith({
      where: { type: "SMTP_DEGRADED", resolved: false, action: baseRow.id },
    });
    expect(alertCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: "SMTP_DEGRADED", threshold: 20, actualValue: 20 }),
    });
  });

  it("达到阈值 + 已有未解决 alert：幂等不创建", async () => {
    alertFindFirst.mockResolvedValue({ id: "existing_alert" });

    await checkSmtpDegradedAlert({ ...baseRow, recentFailures: 25 });

    expect(alertCreate).not.toHaveBeenCalled();
  });
});
