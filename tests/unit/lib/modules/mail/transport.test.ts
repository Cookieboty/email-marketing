/**
 * MailTransport 单元测试。
 *
 * 验证范围：
 *  - getTransportForChannel()：按 SendingChannel 路由到 RESEND / SMTP；
 *  - getSystemDefaultTransport()：查 isSystemDefault=true 的 channel；
 *  - SmtpTransport：sendSingle/sendBatch + 节流 + 错误归一化；
 *  - ResendTransport：透传 Resend SDK 调用 + 错误归一化。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SmtpConfig } from "@prisma/client";

const findUniqueFn = vi.fn();
const findFirstFn = vi.fn();
const decryptSmtpFn = vi.fn();
const decryptResendFn = vi.fn();
const sendMailFn = vi.fn();
const closeFn = vi.fn();
const createTransportFn = vi.fn();
const resendEmailsSendFn = vi.fn();
const resendBatchSendFn = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    sendingChannel: {
      findUnique: (...args: unknown[]) => findUniqueFn(...args),
      findFirst: (...args: unknown[]) => findFirstFn(...args),
    },
  },
}));

vi.mock("@/lib/modules/smtp/crypto", () => ({
  decryptSmtpPassword: (...args: unknown[]) => decryptSmtpFn(...args),
  decryptResendApiKey: (...args: unknown[]) => decryptResendFn(...args),
}));

vi.mock("resend", () => ({
  Resend: vi.fn().mockImplementation(() => ({
    emails: { send: (...args: unknown[]) => resendEmailsSendFn(...args) },
    batch: { send: (...args: unknown[]) => resendBatchSendFn(...args) },
  })),
}));

vi.mock("nodemailer", () => ({
  createTransport: (...args: unknown[]) => createTransportFn(...args),
}));

import {
  getTransportForChannel,
  getSystemDefaultTransport,
  ResendTransport,
  SmtpTransport,
  sendSingle,
  sendBatch,
} from "@/lib/modules/mail/transport";

const FAKE_SMTP_CONFIG = {
  id: "smtp_1",
  name: "main",
  description: null,
  host: "smtp.example.com",
  port: 587,
  secure: "STARTTLS",
  username: "u@example.com",
  passwordCipher: "cipher",
  passwordHint: "h***",
  fromEmail: "noreply@example.com",
  fromName: "Acme",
  replyTo: null,
  maxConnections: 5,
  maxMessagesPerConn: 100,
  rateLimitPerSec: null,
  connectionTimeoutMs: 30000,
  greetingTimeoutMs: 30000,
  socketTimeoutMs: 60000,
  rejectUnauthorized: true,
  requireTls: true,
  status: "ACTIVE",
  isDefault: true,
  lastTestAt: new Date(),
  lastTestStatus: "OK",
  lastTestError: null,
  lastSendAt: null,
  recentFailures: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  createdBy: null,
  updatedBy: null,
} as unknown as SmtpConfig;

const FAKE_RESEND_CONFIG = {
  id: "resend_1",
  name: "main resend",
  apiKeyCipher: "encrypted_key",
  apiKeyHint: "re_...a3Bf",
  status: "ACTIVE",
  createdAt: new Date(),
  updatedAt: new Date(),
};

beforeEach(() => {
  findUniqueFn.mockReset();
  findFirstFn.mockReset();
  decryptSmtpFn.mockReset();
  decryptResendFn.mockReset();
  sendMailFn.mockReset();
  closeFn.mockReset();
  createTransportFn.mockReset();
  resendEmailsSendFn.mockReset();
  resendBatchSendFn.mockReset();

  createTransportFn.mockReturnValue({
    sendMail: (...args: unknown[]) => sendMailFn(...args),
    close: (...args: unknown[]) => closeFn(...args),
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

// ───────── getTransportForChannel ─────────

describe("getTransportForChannel", () => {
  it("RESEND channel → ResendTransport", async () => {
    findUniqueFn.mockResolvedValue({
      id: "ch_1",
      providerType: "RESEND",
      status: "ACTIVE",
      smtpConfig: null,
      resendConfig: FAKE_RESEND_CONFIG,
    });
    decryptResendFn.mockReturnValue("re_test_key");

    const t = await getTransportForChannel("ch_1");
    expect(t).toBeInstanceOf(ResendTransport);
    expect(t.provider).toBe("RESEND");
    expect(t.channelId).toBe("ch_1");
    expect(decryptResendFn).toHaveBeenCalledWith("encrypted_key");
  });

  it("SMTP channel → SmtpTransport", async () => {
    findUniqueFn.mockResolvedValue({
      id: "ch_2",
      providerType: "SMTP",
      status: "ACTIVE",
      smtpConfig: FAKE_SMTP_CONFIG,
      resendConfig: null,
    });
    decryptSmtpFn.mockReturnValue("plain-pass");

    const t = await getTransportForChannel("ch_2");
    expect(t).toBeInstanceOf(SmtpTransport);
    expect(t.provider).toBe("SMTP");
    expect(t.channelId).toBe("ch_2");
  });

  it("channel not found → throws", async () => {
    findUniqueFn.mockResolvedValue(null);
    await expect(getTransportForChannel("nope")).rejects.toThrow("not found");
  });

  it("channel DISABLED → throws", async () => {
    findUniqueFn.mockResolvedValue({
      id: "ch_3",
      providerType: "RESEND",
      status: "DISABLED",
      smtpConfig: null,
      resendConfig: FAKE_RESEND_CONFIG,
    });
    await expect(getTransportForChannel("ch_3")).rejects.toThrow("DISABLED");
  });
});

// ───────── getSystemDefaultTransport ─────────

describe("getSystemDefaultTransport", () => {
  it("finds isSystemDefault=true channel", async () => {
    findFirstFn.mockResolvedValue({ id: "ch_default" });
    findUniqueFn.mockResolvedValue({
      id: "ch_default",
      providerType: "RESEND",
      status: "ACTIVE",
      smtpConfig: null,
      resendConfig: FAKE_RESEND_CONFIG,
    });
    decryptResendFn.mockReturnValue("re_key");

    const t = await getSystemDefaultTransport();
    expect(t.channelId).toBe("ch_default");
  });

  it("no system default → throws", async () => {
    findFirstFn.mockResolvedValue(null);
    await expect(getSystemDefaultTransport()).rejects.toThrow("No system default");
  });
});

// ───────── SmtpTransport 行为 ─────────

describe("SmtpTransport", () => {
  it("sendSingle：sendMail 成功 → 返回 messageId", async () => {
    sendMailFn.mockResolvedValue({ messageId: "<abc@host>" });
    const t = new SmtpTransport(FAKE_SMTP_CONFIG, "plain", "ch_1", (() => ({
      sendMail: (...args: unknown[]) => sendMailFn(...args),
      close: () => undefined,
    })) as never);
    const r = await t.sendSingle({
      from: "",
      to: "rcpt@e.com",
      subject: "hi",
      html: "<p>hi</p>",
    });
    expect(r).toEqual({ ok: true, id: "<abc@host>" });
    const call = sendMailFn.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.from).toBe("Acme <noreply@example.com>");
  });

  it("sendOnce 错误归一化：透传 responseCode 到 statusCode", async () => {
    sendMailFn.mockRejectedValue(
      Object.assign(new Error("535 auth failed"), { responseCode: 535, code: "EAUTH" }),
    );
    const t = new SmtpTransport(FAKE_SMTP_CONFIG, "plain", "ch_1", (() => ({
      sendMail: (...args: unknown[]) => sendMailFn(...args),
      close: () => undefined,
    })) as never);
    const r = await t.sendSingle({
      from: "",
      to: "rcpt@e.com",
      subject: "hi",
      html: "<p/>",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.statusCode).toBe(535);
      expect(r.error).toContain("535");
    }
  });

  it("sendBatch：保序顺序发送，失败/成功逐项独立", async () => {
    sendMailFn
      .mockResolvedValueOnce({ messageId: "m1" })
      .mockRejectedValueOnce(new Error("temp fail"))
      .mockResolvedValueOnce({ messageId: "m3" });
    const t = new SmtpTransport(FAKE_SMTP_CONFIG, "plain", "ch_1", (() => ({
      sendMail: (...args: unknown[]) => sendMailFn(...args),
      close: () => undefined,
    })) as never);
    const r = await t.sendBatch([
      { from: "", to: "a@e.com", subject: "1", html: "<p/>" },
      { from: "", to: "b@e.com", subject: "2", html: "<p/>" },
      { from: "", to: "c@e.com", subject: "3", html: "<p/>" },
    ]);
    expect(r).toHaveLength(3);
    expect(r[0]).toEqual({ ok: true, id: "m1" });
    expect(r[1]!.ok).toBe(false);
    expect(r[2]).toEqual({ ok: true, id: "m3" });
  });

  it("rateLimitPerSec=2 → sendBatch 第二封等待 ≥500ms（节流）", async () => {
    const cfg = { ...FAKE_SMTP_CONFIG, rateLimitPerSec: 2 };
    sendMailFn.mockResolvedValue({ messageId: "m" });
    const t = new SmtpTransport(cfg as never, "plain", "ch_1", (() => ({
      sendMail: (...args: unknown[]) => sendMailFn(...args),
      close: () => undefined,
    })) as never);
    const start = Date.now();
    await t.sendBatch([
      { from: "", to: "a@e.com", subject: "1", html: "<p/>" },
      { from: "", to: "b@e.com", subject: "2", html: "<p/>" },
    ]);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(490);
  });

  it("close() 调用底层 transporter.close", async () => {
    const localClose = vi.fn();
    const t = new SmtpTransport(FAKE_SMTP_CONFIG, "plain", "ch_1", (() => ({
      sendMail: () => Promise.resolve({ messageId: "x" }),
      close: localClose,
    })) as never);
    await t.close();
    expect(localClose).toHaveBeenCalledTimes(1);
  });
});

// ───────── ResendTransport 行为 ─────────

describe("ResendTransport", () => {
  it("sendSingle 成功", async () => {
    const { Resend } = await import("resend");
    const client = new Resend("re_test");
    resendEmailsSendFn.mockResolvedValue({ data: { id: "rs_1" }, error: null });

    const t = new ResendTransport(client, "ch_1");
    const r = await t.sendSingle({
      from: "f@e.com",
      to: "t@e.com",
      subject: "s",
      html: "<p/>",
    });
    expect(r).toEqual({ ok: true, id: "rs_1" });
  });

  it("sendSingle SDK error → normalized result", async () => {
    const { Resend } = await import("resend");
    const client = new Resend("re_test");
    resendEmailsSendFn.mockResolvedValue({
      data: null,
      error: { message: "invalid api key", name: "validation_error" },
    });

    const t = new ResendTransport(client, "ch_1");
    const r = await t.sendSingle({
      from: "f@e.com",
      to: "t@e.com",
      subject: "s",
      html: "<p/>",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("invalid api key");
  });

  it("sendBatch 成功", async () => {
    const { Resend } = await import("resend");
    const client = new Resend("re_test");
    resendBatchSendFn.mockResolvedValue({
      data: { data: [{ id: "b1" }, { id: "b2" }] },
      error: null,
    });

    const t = new ResendTransport(client, "ch_1");
    const r = await t.sendBatch([
      { from: "f@e.com", to: "a@e.com", subject: "1", html: "<p/>" },
      { from: "f@e.com", to: "b@e.com", subject: "2", html: "<p/>" },
    ]);
    expect(r).toEqual([{ ok: true, id: "b1" }, { ok: true, id: "b2" }]);
  });
});
