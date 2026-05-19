/**
 * 媒体资源（MediaAsset）zod 校验。
 *
 * 设计：
 *  - 上传校验在 service 层针对 buffer 实施（MIME 白名单 / 大小 / 像素），
 *    本文件仅校验「业务级输入」（list 查询、PATCH 元数据）。
 *  - tags 使用 string[] 校验，通过 service 归一化（trim + 去重 + 空过滤）。
 *  - alt 文本上限 256 字符（specs §22-§23 隐含 UI 显示场景）。
 */

import { z } from "zod";

export const ALT_MAX_LEN = 256;
export const TAG_MAX_LEN = 64;
export const TAG_MAX_COUNT = 32;
export const FILENAME_MAX_LEN = 255;

const tagsArray = z
  .array(z.string().trim().min(1).max(TAG_MAX_LEN))
  .max(TAG_MAX_COUNT)
  .optional();

export const ListMediaQuerySchema = z.object({
  q: z.string().trim().max(128).optional(),
  type: z.string().trim().max(64).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(20),
});
export type ListMediaQuery = z.infer<typeof ListMediaQuerySchema>;

export const UpdateMediaSchema = z
  .object({
    alt: z.union([z.string().trim().max(ALT_MAX_LEN), z.null()]).optional(),
    tags: tagsArray,
  })
  .strict()
  .refine((v) => v.alt !== undefined || v.tags !== undefined, {
    message: "must provide at least one field",
  });
export type UpdateMediaInput = z.infer<typeof UpdateMediaSchema>;

/**
 * 上传 multipart 中除 file 外的元数据字段；tags 为逗号分隔字符串（specs §169）。
 * service 接收解析后的结构（见 service.uploadMedia 的 metadata 参数）。
 */
export const UploadMediaMetadataSchema = z.object({
  alt: z
    .union([z.string().trim().max(ALT_MAX_LEN), z.null()])
    .optional()
    .transform((v) => (v === null ? undefined : v)),
  tags: z
    .union([z.string().trim().max(TAG_MAX_LEN * (TAG_MAX_COUNT + 1)), z.null()])
    .optional()
    .transform((v) => {
      if (v === null || v === undefined || v === "") return [] as string[];
      return v
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }),
});
export type UploadMediaMetadata = z.infer<typeof UploadMediaMetadataSchema>;
