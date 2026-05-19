/**
 * Outbound Importer 管理 API 入参 zod schema。
 *
 * 关联 spec：specs/modules/outbound-importer.md §218-244
 */

import { z } from "zod";
import { ImportAuthType } from "@prisma/client";

const PaginationTypeSchema = z.enum(["offset", "cursor", "page", "link_header"]);

const FieldMappingSchema = z
  .record(z.string().min(1), z.string().min(1))
  .refine((v) => typeof v.email === "string" && v.email.length > 0, {
    message: "fieldMapping.email is required",
    path: ["email"],
  });

const HeadersSchema = z.record(z.string(), z.string()).optional();

const ImportSourceBaseSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  baseUrl: z.string().url(),
  authType: z.nativeEnum(ImportAuthType).default(ImportAuthType.NONE),
  authValue: z.string().optional(),
  authHeader: z.string().optional(),
  headers: HeadersSchema,
  paginationType: PaginationTypeSchema.default("offset"),
  pageSize: z.number().int().min(1).max(1000).default(100),
  pageSizeParam: z.string().optional(),
  pageParam: z.string().optional(),
  cursorParam: z.string().optional(),
  cursorJsonPath: z.string().optional(),
  dataJsonPath: z.string().default("$"),
  fieldMapping: FieldMappingSchema,
  schedule: z.string().max(64).optional().nullable(),
  enabled: z.boolean().default(true),
});

export const CreateImportSourceSchema = ImportSourceBaseSchema.refine(
  (v) =>
    v.authType === ImportAuthType.NONE ||
    (typeof v.authValue === "string" && v.authValue.length > 0),
  {
    message: "authValue is required when authType != NONE",
    path: ["authValue"],
  },
);

export const UpdateImportSourceSchema = ImportSourceBaseSchema.partial().extend({
  /** 显式传 null 表示清空 schedule。 */
  schedule: z.string().max(64).nullable().optional(),
});

export const TriggerJobSchema = z.object({
  dryRun: z.boolean().optional().default(false),
  resume: z.boolean().optional().default(false),
});

export type CreateImportSourceInput = z.infer<typeof CreateImportSourceSchema>;
export type UpdateImportSourceInput = z.infer<typeof UpdateImportSourceSchema>;
export type TriggerJobInput = z.infer<typeof TriggerJobSchema>;
