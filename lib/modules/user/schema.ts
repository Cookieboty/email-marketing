/**
 * 用户模块 zod 校验。
 *
 * 与 Phase 1 Prisma schema 对齐：
 *  - email：唯一，写入前 normalizeEmail()
 *  - externalId：可选，唯一
 *  - 系统管理字段（不可由 API 写入）：unsubscribe*, totalBounceCount,
 *    engagementScore, lastEmail*, optIn*, unsubscribeToken
 *  - 业务字段：userLevel/totalSpend/orderCount/lastOrderAt/birthDate
 */

import { z } from "zod";

const optionalNullableString = z
  .union([z.string().trim(), z.null()])
  .optional()
  .transform((v): string | undefined =>
    v === null || v === undefined ? undefined : v,
  );

const externalIdSchema = optionalNullableString.refine(
  (v) => v === undefined || (v.length > 0 && v.length <= 128),
  { message: "externalId must be 1-128 chars" },
);

const isoDateSchema = z
  .union([z.string().datetime({ offset: true }), z.date()])
  .transform((v) => (v instanceof Date ? v : new Date(v)))
  .refine((d) => !Number.isNaN(d.getTime()), { message: "invalid date" });
const LocaleSchema = z.enum(["zh", "en"]);
const nullableLocaleSchema = z.union([LocaleSchema, z.null()]).optional();

export const CreateUserSchema = z.object({
  email: z.string().email().max(255),
  externalId: externalIdSchema,
  name: optionalNullableString,
  source: optionalNullableString,
  metadata: z.record(z.unknown()).optional(),
  userLevel: optionalNullableString,
  totalSpend: z
    .union([z.number(), z.string()])
    .optional()
    .refine(
      (v) => v === undefined || Number(v) >= 0,
      { message: "totalSpend must be >= 0" },
    ),
  orderCount: z.number().int().nonnegative().optional(),
  lastOrderAt: isoDateSchema.optional(),
  birthDate: isoDateSchema.optional(),
  locale: LocaleSchema.optional(),
  tagIds: z.array(z.string().min(1)).optional(),
  tagNames: z.array(z.string().min(1).max(64)).optional(),
});

export type CreateUserInput = z.infer<typeof CreateUserSchema>;

export const UpdateUserSchema = z
  .object({
    name: optionalNullableString,
    source: optionalNullableString,
    metadata: z.record(z.unknown()).optional(),
    userLevel: optionalNullableString,
    totalSpend: z
      .union([z.number(), z.string()])
      .optional()
      .refine(
        (v) => v === undefined || Number(v) >= 0,
        { message: "totalSpend must be >= 0" },
      ),
    orderCount: z.number().int().nonnegative().optional(),
    lastOrderAt: isoDateSchema.optional(),
    birthDate: isoDateSchema.optional(),
    locale: nullableLocaleSchema,
  })
  .strict();

export type UpdateUserInput = z.infer<typeof UpdateUserSchema>;

export const ListUsersQuerySchema = z.object({
  q: z.string().trim().max(128).optional(),
  tagIds: z.array(z.string()).optional(),
  tagFilterMode: z.enum(["any", "all"]).default("all"),
  unsubscribed: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
  userLevel: z.string().optional(),
  minSpend: z.coerce.number().nonnegative().optional(),
  maxSpend: z.coerce.number().nonnegative().optional(),
  minOrderCount: z.coerce.number().int().nonnegative().optional(),
  lastOrderAfter: isoDateSchema.optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(20),
  sortBy: z
    .enum(["createdAt", "email", "totalSpend", "lastOrderAt", "engagementScore"])
    .default("createdAt"),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
});

export type ListUsersQuery = z.infer<typeof ListUsersQuerySchema>;

export const SetTagsSchema = z.object({
  tagIds: z.array(z.string().min(1)).max(100),
});

export const AddTagsSchema = z.object({
  tagIds: z.array(z.string().min(1)).min(1).max(100),
});
