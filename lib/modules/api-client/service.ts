/**
 * ApiClient 业务服务（管理后台 API 使用）。
 *
 * 关联 spec：specs/modules/inbound-connector.md
 */

import type { ApiClient, Prisma } from "@prisma/client";
import { Prisma as PrismaNS } from "@prisma/client";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { ConflictError, NotFoundError } from "@/lib/errors";
import {
  encryptApiSecret,
  generateApiToken,
  generateHmacSecret,
} from "./crypto";
import { apiClientRepository } from "./repository";
import type {
  CreateApiClientInput,
  ListApiClientsQuery,
  UpdateApiClientInput,
} from "./schema";

interface ActorContext {
  actorType: "ADMIN" | "SYSTEM" | "WEBHOOK";
  actorId?: string | null;
  req?: { headers: Headers } | null;
}

export interface CreatedApiClient {
  client: ApiClient;
  /** 仅在创建时返回一次的明文 token；之后无法再读取。 */
  token: string;
  /** 启用 HMAC 时返回的明文密钥；仅创建/轮转时返回一次。 */
  hmacSecret?: string;
}

export interface RotatedApiClient {
  client: ApiClient;
  token: string;
  /** 旧 token grace 截止时间。 */
  previousTokenExpiresAt: Date;
}

export const apiClientService = {
  list(query: ListApiClientsQuery) {
    return apiClientRepository.list(query);
  },

  async getById(id: string): Promise<ApiClient> {
    const c = await apiClientRepository.findById(id);
    if (!c) throw new NotFoundError("ApiClient not found");
    return c;
  },

  async create(
    input: CreateApiClientInput,
    ctx: ActorContext,
  ): Promise<CreatedApiClient> {
    const { token, prefix, hash } = generateApiToken();
    let hmacSecret: string | undefined;
    let hmacSecretHash: string | null = null;
    let hmacSecretEncrypted: string | null = null;
    if (input.enableHmac) {
      const secret = generateHmacSecret();
      hmacSecret = secret.secret;
      hmacSecretHash = secret.hash;
      hmacSecretEncrypted = encryptApiSecret(secret.secret);
    }

    const data: Prisma.ApiClientUncheckedCreateInput = {
      name: input.name,
      description: input.description ?? null,
      tokenHash: hash,
      tokenPrefix: prefix,
      hmacSecretHash,
      hmacSecretEncrypted,
      scopes: input.scopes,
      ipWhitelist: input.ipWhitelist ?? [],
      rpsLimit: input.rpsLimit ?? null,
      rphLimit: input.rphLimit ?? null,
      metadata:
        input.metadata === undefined
          ? undefined
          : (input.metadata as Prisma.InputJsonValue),
      createdBy: ctx.actorId ?? null,
    };

    let client: ApiClient;
    try {
      client = await apiClientRepository.create(data);
    } catch (err) {
      // 极小概率 tokenHash 冲突；重试一次
      if (
        err &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code?: string }).code === "P2002"
      ) {
        throw new ConflictError("Token collision, please retry");
      }
      throw err;
    }

    audit({
      action: "api_client.create",
      entityType: "ApiClient",
      entityId: client.id,
      actorType: ctx.actorType,
      details: {
        name: client.name,
        scopes: client.scopes,
        tokenPrefix: client.tokenPrefix,
        hmac: Boolean(hmacSecret),
      },
      req: ctx.req ?? null,
    });

    return { client, token, hmacSecret };
  },

  async update(
    id: string,
    input: UpdateApiClientInput,
    ctx: ActorContext,
  ): Promise<ApiClient> {
    const existing = await apiClientRepository.findById(id);
    if (!existing) throw new NotFoundError("ApiClient not found");
    if (existing.status === "REVOKED") {
      throw new ConflictError("ApiClient is revoked and cannot be modified");
    }

    const data: Prisma.ApiClientUncheckedUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.description !== undefined) data.description = input.description;
    if (input.scopes !== undefined) data.scopes = input.scopes;
    if (input.ipWhitelist !== undefined) data.ipWhitelist = input.ipWhitelist;
    if (input.rpsLimit !== undefined) data.rpsLimit = input.rpsLimit;
    if (input.rphLimit !== undefined) data.rphLimit = input.rphLimit;
    if (input.status !== undefined) data.status = input.status;
    if (input.metadata !== undefined) {
      data.metadata =
        input.metadata === null
          ? PrismaNS.JsonNull
          : (input.metadata as Prisma.InputJsonValue);
    }

    const updated = await apiClientRepository.update(id, data);
    audit({
      action: "api_client.update",
      entityType: "ApiClient",
      entityId: id,
      actorType: ctx.actorType,
      details: { fields: Object.keys(input), name: updated.name },
      req: ctx.req ?? null,
    });
    return updated;
  },

  async revoke(id: string, ctx: ActorContext): Promise<ApiClient> {
    const existing = await apiClientRepository.findById(id);
    if (!existing) throw new NotFoundError("ApiClient not found");
    if (existing.status === "REVOKED") return existing;
    const updated = await apiClientRepository.update(id, {
      status: "REVOKED",
      previousTokenHash: null,
      previousTokenExpiresAt: null,
    });
    audit({
      action: "api_client.revoke",
      entityType: "ApiClient",
      entityId: id,
      actorType: ctx.actorType,
      details: { name: existing.name, tokenPrefix: existing.tokenPrefix },
      req: ctx.req ?? null,
    });
    return updated;
  },

  async rotate(id: string, ctx: ActorContext): Promise<RotatedApiClient> {
    const existing = await apiClientRepository.findById(id);
    if (!existing) throw new NotFoundError("ApiClient not found");
    if (existing.status === "REVOKED") {
      throw new ConflictError("Cannot rotate a revoked ApiClient");
    }
    const { token, prefix, hash } = generateApiToken();
    const graceSec = env().INBOUND_TOKEN_GRACE_SEC;
    const previousTokenExpiresAt = new Date(Date.now() + graceSec * 1000);

    const updated = await apiClientRepository.update(id, {
      previousTokenHash: existing.tokenHash,
      previousTokenExpiresAt,
      tokenHash: hash,
      tokenPrefix: prefix,
    });

    audit({
      action: "api_client.rotate",
      entityType: "ApiClient",
      entityId: id,
      actorType: ctx.actorType,
      details: {
        name: updated.name,
        previousPrefix: existing.tokenPrefix,
        newPrefix: prefix,
        graceSec,
      },
      req: ctx.req ?? null,
    });
    return { client: updated, token, previousTokenExpiresAt };
  },
};

/** 序列化为可暴露给管理后台的视图（隐藏 hash 字段）。 */
export function serializeApiClient(client: ApiClient): Record<string, unknown> {
  return {
    id: client.id,
    name: client.name,
    description: client.description,
    status: client.status,
    tokenPrefix: client.tokenPrefix,
    scopes: client.scopes,
    ipWhitelist: client.ipWhitelist,
    rpsLimit: client.rpsLimit,
    rphLimit: client.rphLimit,
    hmacEnabled: Boolean(client.hmacSecretHash),
    hasGraceToken: Boolean(client.previousTokenHash),
    previousTokenExpiresAt: client.previousTokenExpiresAt,
    metadata: client.metadata,
    lastUsedAt: client.lastUsedAt,
    createdAt: client.createdAt,
    updatedAt: client.updatedAt,
  };
}

export type ApiClientService = typeof apiClientService;
