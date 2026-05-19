/**
 * 媒体本地存储抽象层。
 *
 * 职责：
 *  - 提供 MIME 白名单 / 大小 / 像素上限常量（specs §74-§82）
 *  - 校验上传 buffer 的 MIME 与大小（不依赖 client 提供的 Content-Type）
 *  - 计算 sha256（去重）
 *  - 提取图片宽高（image-size 用于位图；SVG 走正则解析 viewBox/width/height）
 *  - SVG 上传前剥 <script> 与事件属性（specs §384）
 *  - 落盘 / 读取 / 删除 物理文件（UPLOAD_DIR + {id}.{ext}）
 *
 * 不引入 prisma；所有副作用集中在 service.ts 的事务边界内调用。
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { imageSize } from "image-size";

export const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/svg+xml",
  "image/webp",
] as const;
export type AllowedMime = (typeof ALLOWED_MIME_TYPES)[number];

export const MAX_FILE_SIZE = 5 * 1024 * 1024;
export const MAX_DIMENSION = 4096;

export const MIME_TO_EXT: Record<AllowedMime, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "image/webp": "webp",
};

const SIGNATURES: Array<{ mime: AllowedMime; check: (b: Uint8Array) => boolean }> = [
  {
    mime: "image/jpeg",
    check: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    mime: "image/png",
    check: (b) =>
      b.length >= 8 &&
      b[0] === 0x89 &&
      b[1] === 0x50 &&
      b[2] === 0x4e &&
      b[3] === 0x47 &&
      b[4] === 0x0d &&
      b[5] === 0x0a &&
      b[6] === 0x1a &&
      b[7] === 0x0a,
  },
  {
    mime: "image/gif",
    check: (b) =>
      b.length >= 6 &&
      b[0] === 0x47 &&
      b[1] === 0x49 &&
      b[2] === 0x46 &&
      b[3] === 0x38 &&
      (b[4] === 0x37 || b[4] === 0x39) &&
      b[5] === 0x61,
  },
  {
    mime: "image/webp",
    check: (b) =>
      b.length >= 12 &&
      b[0] === 0x52 &&
      b[1] === 0x49 &&
      b[2] === 0x46 &&
      b[3] === 0x46 &&
      b[8] === 0x57 &&
      b[9] === 0x45 &&
      b[10] === 0x42 &&
      b[11] === 0x50,
  },
];

/** 通过 magic number 嗅探真实 MIME；SVG 走文本检测。 */
export function sniffMime(buffer: Uint8Array): AllowedMime | null {
  for (const s of SIGNATURES) {
    if (s.check(buffer)) return s.mime;
  }
  // SVG：纯文本，扫描首 1024 字节是否含 <svg
  const head = Buffer.from(buffer.subarray(0, Math.min(buffer.length, 1024)))
    .toString("utf8")
    .toLowerCase();
  if (head.includes("<svg")) return "image/svg+xml";
  return null;
}

export function computeSha256(buffer: Uint8Array): string {
  return createHash("sha256").update(buffer).digest("hex");
}

const SVG_SCRIPT_RE = /<script\b[\s\S]*?<\/script\s*>/gi;
const SVG_EVENT_ATTR_RE = /\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi;
const SVG_JS_PROTOCOL_RE = /(href|xlink:href)\s*=\s*("|')\s*javascript:[^"']*(\2)/gi;

/** SVG XSS 兜底：剥 <script>、事件处理器、javascript: 协议。 */
export function sanitizeSvg(source: string): string {
  return source
    .replace(SVG_SCRIPT_RE, "")
    .replace(SVG_EVENT_ATTR_RE, "")
    .replace(SVG_JS_PROTOCOL_RE, '$1=$2about:blank$2');
}

const SVG_VIEWBOX_RE = /viewBox\s*=\s*"([^"]+)"/i;
const SVG_WIDTH_RE = /\bwidth\s*=\s*"([^"]+)"/i;
const SVG_HEIGHT_RE = /\bheight\s*=\s*"([^"]+)"/i;

function parsePxValue(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const m = v.match(/([0-9]+(?:\.[0-9]+)?)/);
  if (!m) return undefined;
  const n = Number.parseFloat(m[1]!);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}

/** 从 SVG 文本读取尺寸：优先 width/height 属性，回退到 viewBox 后两位。 */
export function readSvgDimensions(source: string): { width?: number; height?: number } {
  const w = parsePxValue(source.match(SVG_WIDTH_RE)?.[1]);
  const h = parsePxValue(source.match(SVG_HEIGHT_RE)?.[1]);
  if (w !== undefined && h !== undefined) return { width: w, height: h };
  const vb = source.match(SVG_VIEWBOX_RE)?.[1];
  if (vb) {
    const parts = vb.trim().split(/[\s,]+/).map(Number);
    if (parts.length >= 4 && Number.isFinite(parts[2]) && Number.isFinite(parts[3])) {
      return {
        width: w ?? Math.round(parts[2]!),
        height: h ?? Math.round(parts[3]!),
      };
    }
  }
  return { width: w, height: h };
}

export interface Dimensions {
  width: number | null;
  height: number | null;
}

/** 提取宽高；SVG 走文本解析，其他走 image-size。失败返回 null。 */
export function readDimensions(buffer: Uint8Array, mime: AllowedMime): Dimensions {
  if (mime === "image/svg+xml") {
    const text = Buffer.from(buffer).toString("utf8");
    const { width, height } = readSvgDimensions(text);
    return { width: width ?? null, height: height ?? null };
  }
  try {
    // image-size@1.2 在 ESM 下对 Buffer 的支持依赖精确的 Uint8Array 视图，
    // 直接传 Node Buffer 会因为底层 ArrayBuffer 偏移导致 magic number 嗅探失败。
    const view =
      buffer instanceof Uint8Array && !(buffer instanceof Buffer)
        ? buffer
        : new Uint8Array(
          (buffer as Buffer).buffer,
          (buffer as Buffer).byteOffset,
          (buffer as Buffer).byteLength,
        );
    const r = imageSize(view);
    return { width: r.width ?? null, height: r.height ?? null };
  } catch {
    return { width: null, height: null };
  }
}

export interface ValidatedUpload {
  buffer: Buffer;
  mime: AllowedMime;
  size: number;
  sha256: string;
  width: number | null;
  height: number | null;
}

export class UploadValidationError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "UploadValidationError";
    this.status = status;
  }
}

/**
 * 校验上传 buffer：
 *  - size ≤ 5MB
 *  - 真实 MIME ∈ 白名单（不信任客户端 declared）
 *  - 像素 ≤ 4096×4096（位图能解出尺寸时硬卡；SVG 不强制）
 *  - SVG 自动 sanitize，buffer 在原地替换为安全版本
 */
export function validateUpload(input: { buffer: Buffer; declaredMime?: string }): ValidatedUpload {
  if (input.buffer.length === 0) {
    throw new UploadValidationError("文件内容为空");
  }
  if (input.buffer.length > MAX_FILE_SIZE) {
    throw new UploadValidationError("文件大小超过 5MB 限制");
  }
  const sniffed = sniffMime(input.buffer);
  if (!sniffed) {
    throw new UploadValidationError("不支持的文件格式，仅支持 JPEG/PNG/GIF/SVG/WebP");
  }
  // declaredMime 与嗅探不一致时以嗅探为准（更安全）；只在二者都白名单内时通过。
  if (input.declaredMime && !ALLOWED_MIME_TYPES.includes(input.declaredMime as AllowedMime)) {
    throw new UploadValidationError("不支持的文件格式，仅支持 JPEG/PNG/GIF/SVG/WebP");
  }
  let buffer = input.buffer;
  if (sniffed === "image/svg+xml") {
    const cleaned = sanitizeSvg(buffer.toString("utf8"));
    buffer = Buffer.from(cleaned, "utf8");
  }
  const { width, height } = readDimensions(buffer, sniffed);
  if (width !== null && height !== null) {
    if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
      throw new UploadValidationError(
        `图片像素超过 ${MAX_DIMENSION}×${MAX_DIMENSION} 限制`,
      );
    }
  }
  return {
    buffer,
    mime: sniffed,
    size: buffer.length,
    sha256: computeSha256(buffer),
    width,
    height,
  };
}

export function buildStoragePath(uploadDir: string, id: string, mime: AllowedMime): string {
  return resolvePath(uploadDir, `${id}.${MIME_TO_EXT[mime]}`);
}

export async function ensureUploadDir(uploadDir: string): Promise<void> {
  await mkdir(uploadDir, { recursive: true });
}

export async function writeUpload(
  uploadDir: string,
  id: string,
  mime: AllowedMime,
  buffer: Buffer,
): Promise<string> {
  await ensureUploadDir(uploadDir);
  const target = buildStoragePath(uploadDir, id, mime);
  await writeFile(target, buffer);
  return target;
}

export async function readUpload(
  uploadDir: string,
  id: string,
  mime: AllowedMime,
): Promise<Buffer> {
  return readFile(buildStoragePath(uploadDir, id, mime));
}

export async function deleteUpload(
  uploadDir: string,
  id: string,
  mime: AllowedMime,
): Promise<void> {
  try {
    await unlink(buildStoragePath(uploadDir, id, mime));
  } catch (err) {
    // ENOENT 视作已删除
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export function buildPublicUrl(id: string): string {
  return `/api/media/${id}/file`;
}
