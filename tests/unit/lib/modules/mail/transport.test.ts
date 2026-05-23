/**
 * MailTransport 路由层单元测试。
 *
 * 验证范围：
 *  - getActiveTransport()：按 MailProviderSetting 路由到 RESEND / SMTP；
 *  - 60 秒进程缓存（同一秒命中、超时失效、invalidate 立即失效）；
 *  - 错误兜底：解密失败 / 配置缺失 / status≠ACTIVE / 读 DB 抛错 → fallback RESEND；
 *  - SmtpTransport.sendBatch 顺序 + 节流（rateLimitPerSec）；
 *  - 错误归一化：nodemailer responseCode 透传到 SendResult.statusCode。
 *
 * 隔离策略：vi.mock prisma、smtp/repository、smtp/crypto、resend、nodemailer，
 * 让 transport 模块只看到 fake 对象，避免触发 env 严格校验或真实 socket。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SmtpConfig } from "@prisma/client";

const settingGet = vi.fn();
const findById = vi.fn();
const decryptFn = vi.fn();
const resendSingle = vi.fn();
const resendBatch = vi.fn();
const sendMailFn = vi.fn();
const closeFn = vi.fn();
const createTransportFn = vi.fn();

vi.mock("@/lib/modules/smtp/repository", () => ({
  mailProviderSettingRepository: {
    get: (...args: unknown[]) => settingGet(...args),
  },
  smtpConfigRepository: {
    findById: (...args: unknown[]) => findById(...args),
  },
}));

vi.mock("@/lib/modules/smtp/crypto", () => ({
  decryptSmtpPassword: (...args: unknown[]) => decryptFn(...args),
}));

vi.mock("@/lib/resend", () => ({
  sendSingle: (...args: unknown[]) => resendSingle(...args),
  sendBatch: (...args: unknown[]) => resendBatch(...args),
}));

vi.mock("nodemailer", () => ({
  createTransport: (...args: unknown[]) => createTransportFn(...args),
}));

import {
  __resetTransportCacheForTest,
  getActiveTransport,
  invalidateActiveTransport,
  ResendTransport,
  SmtpTransport,
  sendBatch,
  sendSingle,
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

beforeEach(() => {
  __resetTransportCacheForTest();
  settingGet.mockReset();
  findById.mockReset();
  decryptFn.mockReset();
  resendSingle.mockReset();
  resendBatch.mockReset();
  sendMailFn.mockReset();
  closeFn.mockReset();
  createTransportFn.mockReset();

  createTransportFn.mockReturnValue({
    sendMail: (...args: unknown[]) => sendMailFn(...args),
    close: (...args: unknown[]) => closeFn(...args),
  });
});

afterEach(async () => {
  await invalidateActiveTransport();
});

// ───────── 路由 ─────────

describe("getActiveTransport routing", () => {
  it("RESEND 设置 → ResendTransport", async () => {
    settingGet.mockResolvedValue({ activeProvider: "RESEND", activeSmtpId: null });
    const t = await getActiveTransport();
    expect(t).toBeInstanceOf(ResendTransport);
    expect(t.provider).toBe("RESEND");
    expect(t.smtpId).toBeNull();
  });

  it("SMTP 设置 + ACTIVE 配置 → SmtpTransport，构造池配置正确", async () => {
    settingGet.mockResolvedValue({ activeProvider: "SMTP", activeSmtpId: "smtp_1" });
    findById.mockResolvedValue(FAKE_SMTP_CONFIG);
    decryptFn.mockReturnValue("plain-pass");

    const t = await getActiveTransport();
    expect(t).toBeInstanceOf(SmtpTransport);
    expect(t.provider).toBe("SMTP");
    expect(t.smtpId).toBe("smtp_1");
    expect(decryptFn).toHaveBeenCalledWith("cipher");
    expect(createTransportFn).toHaveBeenCalledTimes(1);
    const opts = createTransportFn.mock.calls[0]![0] as Record<string, unknown>;
    expect(opts.host).toBe("smtp.example.com");
    expect(opts.port).toBe(587);
    expect(opts.secure).toBe(false); // STARTTLS
    expect(opts.requireTLS).toBe(true);
    expect(opts.pool).toBe(true);
    expect(opts.maxConnections).toBe(5);
    expect(opts.auth).toEqual({ user: "u@example.com", pass: "plain-pass" });
    expect(opts.tls).toEqual({ rejectUnauthorized: true });
  });

  it("activeProvider=SMTP 但 activeSmtpId=null → 回退 RESEND", async () => {
    settingGet.mockResolvedValue({ activeProvider: "SMTP", activeSmtpId: null });
    const t = await getActiveTransport();
    expect(t.provider).toBe("RESEND");
    expect(findById).not.toHaveBeenCalled();
  });

  it("配置不存在 → 回退 RESEND", async () => {
    settingGet.mockResolvedValue({ activeProvider: "SMTP", activeSmtpId: "smtp_1" });
    findById.mockResolvedValue(null);
    const t = await getActiveTransport();
    expect(t.provider).toBe("RESEND");
  });

  it("配置 status=DISABLED → 回退 RESEND", async () => {
    settingGet.mockResolvedValue({ activeProvider: "SMTP", activeSmtpId: "smtp_1" });
    findById.mockResolvedValue({ ...FAKE_SMTP_CONFIG, status: "DISABLED" });
    const t = await getActiveTransport();
    expect(t.provider).toBe("RESEND");
  });

  it("解密失败 → 回退 RESEND", async () => {
    settingGet.mockResolvedValue({ activeProvider: "SMTP", activeSmtpId: "smtp_1" });
    findById.mockResolvedValue(FAKE_SMTP_CONFIG);
    decryptFn.mockImplementation(() => {
      throw new Error("bad key");
    });
    const t = await getActiveTransport();
    expect(t.provider).toBe("RESEND");
  });

  it("读取 setting 抛错 → 回退 RESEND（永不打死发件链路）", async () => {
    settingGet.mockRejectedValue(new Error("db down"));
    const t = await getActiveTransport();
    expect(t.provider).toBe("RESEND");
  });
});

// ───────── 缓存 ─────────

describe("getActiveTransport caching", () => {
  it("两次连续调用复用同一个 transport 实例", async () => {
    settingGet.mockResolvedValue({ activeProvider: "RESEND", activeSmtpId: null });
    const a = await getActiveTransport();
    const b = await getActiveTransport();
    expect(a).toBe(b);
    expect(settingGet).toHaveBeenCalledTimes(1);
  });

  it("超过 60s TTL 后重新构造", async () => {
    settingGet.mockResolvedValue({ activeProvider: "RESEND", activeSmtpId: null });
    const realNow = Date.now;
    let fake = 1_000_000;
    Date.now = () => fake;
    try {
      const a = await getActiveTransport(fake);
      fake += 60_001;
      const b = await getActiveTransport(fake);
      expect(a).not.toBe(b);
      expect(settingGet).toHaveBeenCalledTimes(2);
    } finally {
      Date.now = realNow;
    }
  });

  it("invalidateActiveTransport() 立即失效，并 close 旧 SMTP 池", async () => {
    settingGet.mockResolvedValue({ activeProvider: "SMTP", activeSmtpId: "smtp_1" });
    findById.mockResolvedValue(FAKE_SMTP_CONFIG);
    decryptFn.mockReturnValue("p");
    const a = await getActiveTransport();
    expect(a.provider).toBe("SMTP");

    await invalidateActiveTransport();
    expect(closeFn).toHaveBeenCalledTimes(1);

    const b = await getActiveTransport();
    expect(b).not.toBe(a);
    expect(settingGet).toHaveBeenCalledTimes(2);
  });

  it("并发请求只构造一个 transport", async () => {
    settingGet.mockResolvedValue({ activeProvider: "RESEND", activeSmtpId: null });
    const [a, b, c] = await Promise.all([
      getActiveTransport(),
      getActiveTransport(),
      getActiveTransport(),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(settingGet).toHaveBeenCalledTimes(1);
  });
});

// ───────── 路由转发 ─────────

describe("sendSingle / sendBatch dispatch", () => {
  it("RESEND：sendSingle 直接转发 lib/resend", async () => {
    settingGet.mockResolvedValue({ activeProvider: "RESEND", activeSmtpId: null });
    resendSingle.mockResolvedValue({ ok: true, id: "rs_1" });
    const r = await sendSingle({
      from: "f@e.com",
      to: "t@e.com",
      subject: "s",
      html: "<p/>",
    });
    expect(r).toEqual({ ok: true, id: "rs_1" });
    expect(resendSingle).toHaveBeenCalledTimes(1);
  });

  it("RESEND：sendBatch 直接转发 lib/resend.sendBatch", async () => {
    settingGet.mockResolvedValue({ activeProvider: "RESEND", activeSmtpId: null });
    resendBatch.mockResolvedValue([{ ok: true, id: "x" }]);
    const r = await sendBatch([
      { from: "f@e.com", to: "t@e.com", subject: "s", html: "<p/>" },
    ]);
    expect(r).toEqual([{ ok: true, id: "x" }]);
    expect(resendBatch).toHaveBeenCalledTimes(1);
  });
});

// ───────── SmtpTransport 行为 ─────────

describe("SmtpTransport", () => {
  it("sendSingle：sendMail 成功 → 返回 messageId", async () => {
    sendMailFn.mockResolvedValue({ messageId: "<abc@host>" });
    const t = new SmtpTransport(FAKE_SMTP_CONFIG, "plain", () => ({
      sendMail: (...args: unknown[]) => sendMailFn(...args),
      close: () => undefined,
    }) as never);
    const r = await t.sendSingle({
      from: "",
      to: "rcpt@e.com",
      subject: "hi",
      html: "<p>hi</p>",
    });
    expect(r).toEqual({ ok: true, id: "<abc@host>" });
    const call = sendMailFn.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.from).toBe("Acme <noreply@example.com>"); // fromName 拼接
  });

  it("sendOnce 错误归一化：透传 responseCode 到 statusCode", async () => {
    sendMailFn.mockRejectedValue(
      Object.assign(new Error("535 auth failed"), { responseCode: 535, code: "EAUTH" }),
    );
    const t = new SmtpTransport(FAKE_SMTP_CONFIG, "plain", () => ({
      sendMail: (...args: unknown[]) => sendMailFn(...args),
      close: () => undefined,
    }) as never);
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
    const t = new SmtpTransport(FAKE_SMTP_CONFIG, "plain", () => ({
      sendMail: (...args: unknown[]) => sendMailFn(...args),
      close: () => undefined,
    }) as never);
    const r = await t.sendBatch([
      { from: "", to: "a@e.com", subject: "1", html: "<p/>" },
      { from: "", to: "b@e.com", subject: "2", html: "<p/>" },
      { from: "", to: "c@e.com", subject: "3", html: "<p/>" },
    ]);
    expect(r).toHaveLength(3);
    expect(r[0]).toEqual({ ok: true, id: "m1" });
    expect(r[1].ok).toBe(false);
    expect(r[2]).toEqual({ ok: true, id: "m3" });
  });

  it("rateLimitPerSec=2 → sendBatch 第二封等待 ≥500ms（节流）", async () => {
    const cfg = { ...FAKE_SMTP_CONFIG, rateLimitPerSec: 2 };
    sendMailFn.mockResolvedValue({ messageId: "m" });
    const t = new SmtpTransport(cfg as never, "plain", () => ({
      sendMail: (...args: unknown[]) => sendMailFn(...args),
      close: () => undefined,
    }) as never);
    const start = Date.now();
    await t.sendBatch([
      { from: "", to: "a@e.com", subject: "1", html: "<p/>" },
      { from: "", to: "b@e.com", subject: "2", html: "<p/>" },
    ]);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(490); // 允许 10ms 误差
  });

  it("close() 调用底层 transporter.close 且不抛异常", async () => {
    const localClose = vi.fn();
    const t = new SmtpTransport(FAKE_SMTP_CONFIG, "plain", () => ({
      sendMail: () => Promise.resolve({ messageId: "x" }),
      close: localClose,
    }) as never);
    await t.close();
    expect(localClose).toHaveBeenCalledTimes(1);
  });

  it("无密码（username+plain 任一为空）时不带 auth 字段", () => {
    const cfg = { ...FAKE_SMTP_CONFIG, username: null };
    const factory = vi.fn(() => ({
      sendMail: () => Promise.resolve({ messageId: "x" }),
      close: () => undefined,
    })) as never;
    new SmtpTransport(cfg as never, null, factory);
    const opts = (factory as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]![0] as Record<string, unknown>;
    expect(opts.auth).toBeUndefined();
  });

  it("secure=TLS 时 secure=true，requireTLS 由配置决定", () => {
    const cfg = { ...FAKE_SMTP_CONFIG, port: 465, secure: "TLS" };
    const factory = vi.fn(() => ({
      sendMail: () => Promise.resolve({ messageId: "x" }),
      close: () => undefined,
    })) as never;
    new SmtpTransport(cfg as never, "p", factory);
    const opts = (factory as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]![0] as Record<string, unknown>;
    expect(opts.secure).toBe(true);
  });
});
