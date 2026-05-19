/**
 * 媒体 storage 工具：MIME 嗅探 / SVG sanitize / 维度提取 / validateUpload 校验。
 *
 * 不接 fs（文件落地通过 service 路径覆盖）；本测试只覆盖纯函数。
 */

import { describe, expect, it } from "vitest";
import {
  ALLOWED_MIME_TYPES,
  MAX_DIMENSION,
  computeSha256,
  readDimensions,
  readSvgDimensions,
  sanitizeSvg,
  sniffMime,
  validateUpload,
  UploadValidationError,
} from "@/lib/modules/media/storage";

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=",
  "base64",
);
const GIF_1x1 = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);
const SVG_OK = Buffer.from(
  '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="32" height="16" viewBox="0 0 32 16"><rect width="32" height="16"/></svg>',
  "utf8",
);
const SVG_VIEWBOX_ONLY = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"></svg>',
  "utf8",
);
const SVG_MALICIOUS = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script><a href="javascript:alert(2)" onclick="x()">x</a></svg>',
  "utf8",
);
const WEBP_HEADER = Buffer.concat([
  Buffer.from("RIFF", "ascii"),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from("WEBP", "ascii"),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
]);
const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

describe("ALLOWED_MIME_TYPES", () => {
  it("包含五类基础图片格式", () => {
    expect(ALLOWED_MIME_TYPES).toEqual([
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/svg+xml",
      "image/webp",
    ]);
  });
});

describe("sniffMime", () => {
  it("识别 PNG", () => expect(sniffMime(PNG_1x1)).toBe("image/png"));
  it("识别 GIF", () => expect(sniffMime(GIF_1x1)).toBe("image/gif"));
  it("识别 SVG", () => expect(sniffMime(SVG_OK)).toBe("image/svg+xml"));
  it("识别 WebP（仅 header）", () => expect(sniffMime(WEBP_HEADER)).toBe("image/webp"));
  it("识别 JPEG（仅 header）", () => expect(sniffMime(JPEG_HEADER)).toBe("image/jpeg"));
  it("未知格式返回 null", () =>
    expect(sniffMime(Buffer.from("hello world"))).toBeNull());
});

describe("computeSha256", () => {
  it("空 buffer hash 稳定", () => {
    expect(computeSha256(Buffer.alloc(0))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
  it("相同内容产生相同 hash", () => {
    expect(computeSha256(PNG_1x1)).toBe(computeSha256(Buffer.from(PNG_1x1)));
  });
});

describe("sanitizeSvg", () => {
  it("剥离 <script>", () => {
    const out = sanitizeSvg(SVG_MALICIOUS.toString("utf8"));
    expect(out).not.toMatch(/<script/i);
  });
  it("剥离 onclick 等事件属性", () => {
    expect(sanitizeSvg(SVG_MALICIOUS.toString("utf8"))).not.toMatch(/onclick/i);
  });
  it("将 javascript: 协议替换为 about:blank", () => {
    const out = sanitizeSvg(SVG_MALICIOUS.toString("utf8"));
    expect(out).not.toMatch(/javascript:/i);
    expect(out).toMatch(/about:blank/);
  });
});

describe("readSvgDimensions", () => {
  it("优先 width/height 属性", () => {
    expect(readSvgDimensions(SVG_OK.toString("utf8"))).toEqual({ width: 32, height: 16 });
  });
  it("回退到 viewBox", () => {
    expect(readSvgDimensions(SVG_VIEWBOX_ONLY.toString("utf8"))).toEqual({
      width: 200,
      height: 100,
    });
  });
});

describe("readDimensions", () => {
  it("PNG：image-size 解析尺寸", () => {
    const r = readDimensions(PNG_1x1, "image/png");
    expect(r).toEqual({ width: 1, height: 1 });
  });
  it("GIF：image-size 解析尺寸", () => {
    const r = readDimensions(GIF_1x1, "image/gif");
    expect(r).toEqual({ width: 1, height: 1 });
  });
  it("SVG：走文本解析", () => {
    expect(readDimensions(SVG_OK, "image/svg+xml")).toEqual({ width: 32, height: 16 });
  });
  it("解析失败返回 null", () => {
    const r = readDimensions(Buffer.from([0x00, 0x01, 0x02, 0x03]), "image/webp");
    expect(r.width).toBeNull();
    expect(r.height).toBeNull();
  });
});

describe("validateUpload", () => {
  it("正常 PNG 通过；返回 sha256/size/mime/dim", () => {
    const r = validateUpload({ buffer: PNG_1x1, declaredMime: "image/png" });
    expect(r.mime).toBe("image/png");
    expect(r.size).toBe(PNG_1x1.length);
    expect(r.width).toBe(1);
    expect(r.height).toBe(1);
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("空 buffer 拒绝", () => {
    expect(() => validateUpload({ buffer: Buffer.alloc(0) })).toThrow(UploadValidationError);
  });

  it("超过 5MB 拒绝", () => {
    const big = Buffer.alloc(5 * 1024 * 1024 + 1);
    big.set(PNG_1x1, 0);
    expect(() => validateUpload({ buffer: big })).toThrow(/5MB/);
  });

  it("不在白名单的 declaredMime 拒绝", () => {
    expect(() => validateUpload({ buffer: PNG_1x1, declaredMime: "image/bmp" })).toThrow(
      UploadValidationError,
    );
  });

  it("未知 magic number 拒绝", () => {
    expect(() => validateUpload({ buffer: Buffer.from("hello world plain text") })).toThrow(
      UploadValidationError,
    );
  });

  it("SVG 自动 sanitize 后写回 buffer", () => {
    const r = validateUpload({ buffer: SVG_MALICIOUS, declaredMime: "image/svg+xml" });
    expect(r.mime).toBe("image/svg+xml");
    const text = r.buffer.toString("utf8");
    expect(text).not.toMatch(/<script/i);
    expect(text).not.toMatch(/javascript:/i);
  });

  it("超大像素 SVG 拒绝", () => {
    const big = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${MAX_DIMENSION + 1}" height="100"></svg>`,
      "utf8",
    );
    expect(() => validateUpload({ buffer: big, declaredMime: "image/svg+xml" })).toThrow(
      /像素超过/,
    );
  });
});
