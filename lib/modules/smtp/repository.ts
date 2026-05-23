/**
 * SmtpConfig + MailProviderSetting 数据访问层。
 *
 * 关联 spec：specs/modules/smtp-configuration.md
 *
 * 设计要点：
 * - 仅做 SQL 操作；业务校验、加解密、审计都放在 service。
 * - 由于 schema.prisma 中没有 `@@unique([host, port, username])`（NULL 处理需求
 *   在迁移里写成表达式唯一索引 `COALESCE(username, '')`），重复检测用 SQL 查
 *   询封装一个明确的方法 `findByHostPortUser`，避免 service 端重复拼条件。
 * - `MailProviderSetting` 是单例（id="singleton"），用 upsert 写入；getter 也兜
 *   底创建，让运行时无需关心 seed 是否跑过。
 * - 健康度计数 `recentFailures` 走 increment，避免 read-modify-write 竞态。
 */

import type {
  MailProviderType,
  Prisma,
  SmtpConfig,
  SmtpConfigStatus,
  SmtpTestStatus,
  MailProviderSetting,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { PrismaTx } from "../user/repository";
import type { ListSmtpConfigsQuery } from "./schema";

export const PROVIDER_SETTING_ID = "singleton";

export interface ListSmtpConfigsResult {
  data: SmtpConfig[];
  total: number;
  page: number;
  pageSize: number;
}

export const smtpConfigRepository = {
  async list(
    query: ListSmtpConfigsQuery,
    db: PrismaTx = prisma,
  ): Promise<ListSmtpConfigsResult> {
    const where: Prisma.SmtpConfigWhereInput = {};
    if (query.q) {
      where.OR = [
        { name: { contains: query.q, mode: "insensitive" } },
        { host: { contains: query.q, mode: "insensitive" } },
        { username: { contains: query.q, mode: "insensitive" } },
      ];
    }
    if (query.status) where.status = query.status;

    const [total, data] = await Promise.all([
      db.smtpConfig.count({ where }),
      db.smtpConfig.findMany({
        where,
        orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return { data, total, page: query.page, pageSize: query.pageSize };
  },

  findById(id: string, db: PrismaTx = prisma): Promise<SmtpConfig | null> {
    return db.smtpConfig.findUnique({ where: { id } });
  },

  /**
   * 通过 (host, port, username) 复合查重。`username` 为空字符串视同 NULL，
   * 与迁移里的 `COALESCE(username, '')` 表达式唯一索引保持一致。
   */
  findByHostPortUser(
    host: string,
    port: number,
    username: string | null,
    db: PrismaTx = prisma,
  ): Promise<SmtpConfig | null> {
    return db.smtpConfig.findFirst({
      where: {
        host,
        port,
        username: username ?? null,
      },
    });
  },

  create(
    data: Prisma.SmtpConfigUncheckedCreateInput,
    db: PrismaTx = prisma,
  ): Promise<SmtpConfig> {
    return db.smtpConfig.create({ data });
  },

  update(
    id: string,
    data: Prisma.SmtpConfigUncheckedUpdateInput,
    db: PrismaTx = prisma,
  ): Promise<SmtpConfig> {
    return db.smtpConfig.update({ where: { id }, data });
  },

  updateStatus(
    id: string,
    status: SmtpConfigStatus,
    db: PrismaTx = prisma,
  ): Promise<SmtpConfig> {
    return db.smtpConfig.update({ where: { id }, data: { status } });
  },

  /** 把所有 isDefault=true 的配置（除 exceptId）置回 false。 */
  async clearDefaultExcept(
    exceptId: string | null,
    db: PrismaTx = prisma,
  ): Promise<number> {
    const where: Prisma.SmtpConfigWhereInput = { isDefault: true };
    if (exceptId) where.NOT = { id: exceptId };
    const result = await db.smtpConfig.updateMany({
      where,
      data: { isDefault: false },
    });
    return result.count;
  },

  /** 将指定配置标记为默认（不清其它，调用方须先 clearDefaultExcept）。 */
  setDefault(id: string, db: PrismaTx = prisma): Promise<SmtpConfig> {
    return db.smtpConfig.update({ where: { id }, data: { isDefault: true } });
  },

  /**
   * 写回连接测试结果。
   * - status=OK：清零 recentFailures、清空 lastTestError；
   * - 其它：递增 recentFailures，保留错误摘要（截断 1KB 由调用方负责）。
   */
  recordTestResult(
    id: string,
    payload: { status: SmtpTestStatus; error?: string | null; at?: Date },
    db: PrismaTx = prisma,
  ): Promise<SmtpConfig> {
    const at = payload.at ?? new Date();
    if (payload.status === "OK") {
      return db.smtpConfig.update({
        where: { id },
        data: {
          lastTestAt: at,
          lastTestStatus: "OK",
          lastTestError: null,
          recentFailures: 0,
        },
      });
    }
    return db.smtpConfig.update({
      where: { id },
      data: {
        lastTestAt: at,
        lastTestStatus: payload.status,
        lastTestError: payload.error ?? null,
        recentFailures: { increment: 1 },
      },
    });
  },

  /** 实际发送成功后的健康度回写：lastSendAt 推进 + recentFailures 清零。 */
  recordSendSuccess(
    id: string,
    at: Date = new Date(),
    db: PrismaTx = prisma,
  ): Promise<SmtpConfig> {
    return db.smtpConfig.update({
      where: { id },
      data: { lastSendAt: at, recentFailures: 0 },
    });
  },

  /** 实际发送失败：recentFailures += 1。错误细节由调用方写日志，不入此表。 */
  recordSendFailure(id: string, db: PrismaTx = prisma): Promise<SmtpConfig> {
    return db.smtpConfig.update({
      where: { id },
      data: { recentFailures: { increment: 1 } },
    });
  },
};

export type SmtpConfigRepository = typeof smtpConfigRepository;

export const mailProviderSettingRepository = {
  /**
   * 取当前激活通道。表里没有时（理论上 seed 已写入）回退创建一个 RESEND 行，
   * 保证调用方永远拿得到非 null 的 setting。
   */
  async get(db: PrismaTx = prisma): Promise<MailProviderSetting> {
    const found = await db.mailProviderSetting.findUnique({
      where: { id: PROVIDER_SETTING_ID },
    });
    if (found) return found;
    return db.mailProviderSetting.upsert({
      where: { id: PROVIDER_SETTING_ID },
      update: {},
      create: {
        id: PROVIDER_SETTING_ID,
        activeProvider: "RESEND",
        activeSmtpId: null,
      },
    });
  },

  /** 切换激活通道；activeSmtpId 由 service 层根据 provider 决定是否清空。 */
  setActive(
    provider: MailProviderType,
    activeSmtpId: string | null,
    actor: string | null,
    db: PrismaTx = prisma,
  ): Promise<MailProviderSetting> {
    return db.mailProviderSetting.upsert({
      where: { id: PROVIDER_SETTING_ID },
      update: {
        activeProvider: provider,
        activeSmtpId,
        updatedBy: actor,
      },
      create: {
        id: PROVIDER_SETTING_ID,
        activeProvider: provider,
        activeSmtpId,
        updatedBy: actor,
      },
    });
  },
};

export type MailProviderSettingRepository = typeof mailProviderSettingRepository;
