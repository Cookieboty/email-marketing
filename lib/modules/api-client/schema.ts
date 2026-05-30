/**
 * ApiClient zod 校验。
 *
 * 关联 spec：specs/modules/inbound-connector.md
 */

import { z } from "zod";

export const SCOPES = [
  "user:read",
  "user:write",
  "tag:read",
  "tag:write",
  "unsubscribe:write",
  "event:write",
  "topic:write",
] as const;

export type ApiClientScope = (typeof SCOPES)[number];

const ScopeSchema = z.enum(SCOPES);

const IpEntrySchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(
    /^([0-9]{1,3}\.){3}[0-9]{1,3}(\/[0-9]{1,2})?$|^([0-9a-fA-F:]+)(\/[0-9]{1,3})?$/,
    "ip whitelist must be IPv4/IPv6 with optional CIDR",
  );

export const CreateApiClientSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  scopes: z.array(ScopeSchema).min(1).max(SCOPES.length),
  ipWhitelist: z.array(IpEntrySchema).max(50).optional(),
  rpsLimit: z.number().int().positive().max(10_000).optional(),
  rphLimit: z.number().int().positive().max(1_000_000).optional(),
  // 默认开启 HMAC：直接通过 API 创建时（省略该字段）也具备签名校验，
  // 避免仅 Bearer token 的弱认证基线。
  enableHmac: z.boolean().default(true),
  metadata: z.record(z.unknown()).optional(),
});

export type CreateApiClientInput = z.infer<typeof CreateApiClientSchema>;

export const UpdateApiClientSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    scopes: z.array(ScopeSchema).min(1).max(SCOPES.length).optional(),
    ipWhitelist: z.array(IpEntrySchema).max(50).optional(),
    rpsLimit: z.number().int().positive().max(10_000).nullable().optional(),
    rphLimit: z.number().int().positive().max(1_000_000).nullable().optional(),
    status: z.enum(["ACTIVE", "DISABLED"]).optional(),
    metadata: z.record(z.unknown()).nullable().optional(),
  })
  .strict();

export type UpdateApiClientInput = z.infer<typeof UpdateApiClientSchema>;

export const ListApiClientsQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  status: z.enum(["ACTIVE", "DISABLED", "REVOKED"]).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});

export type ListApiClientsQuery = z.infer<typeof ListApiClientsQuerySchema>;
