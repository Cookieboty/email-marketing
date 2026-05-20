import { describe, it, expect } from "vitest";
import {
  CreateImportSourceFormSchema,
  UpdateImportSourceFormSchema,
  buildImportSourcePayload,
  validateScheduleString,
} from "@/app/(dashboard)/import-sources/_components/form-schema";

const baseValid = {
  name: "Test",
  baseUrl: "https://api.example.com/users",
  authType: "BEARER" as const,
  authValue: "tok",
  paginationType: "offset" as const,
  pageSize: 100,
  pageSizeParam: "limit",
  pageParam: "offset",
  dataJsonPath: "$.data",
  fieldMapping: { email: "$.email" },
  enabled: true,
};

describe("CreateImportSourceFormSchema", () => {
  it("合法 HTTPS + bearer + offset 通过", () => {
    const r = CreateImportSourceFormSchema.safeParse(baseValid);
    expect(r.success).toBe(true);
  });

  it("http URL 失败", () => {
    const r = CreateImportSourceFormSchema.safeParse({
      ...baseValid,
      baseUrl: "http://api.example.com/users",
    });
    expect(r.success).toBe(false);
  });

  it("paginationType=cursor 缺 cursorParam 失败", () => {
    const r = CreateImportSourceFormSchema.safeParse({
      ...baseValid,
      paginationType: "cursor",
      cursorParam: "",
    });
    expect(r.success).toBe(false);
  });

  it("paginationType=cursor 缺 cursorJsonPath 失败", () => {
    const r = CreateImportSourceFormSchema.safeParse({
      ...baseValid,
      paginationType: "cursor",
      cursorParam: "cursor",
      cursorJsonPath: "",
    });
    expect(r.success).toBe(false);
  });

  it("fieldMapping 缺 email 失败", () => {
    const r = CreateImportSourceFormSchema.safeParse({
      ...baseValid,
      fieldMapping: { name: "$.name" },
    });
    expect(r.success).toBe(false);
  });

  it("authType != NONE 但 authValue 空字符串 失败", () => {
    const r = CreateImportSourceFormSchema.safeParse({
      ...baseValid,
      authType: "BEARER",
      authValue: "",
    });
    expect(r.success).toBe(false);
  });

  it("authType=NONE 不需要 authValue", () => {
    const r = CreateImportSourceFormSchema.safeParse({
      ...baseValid,
      authType: "NONE",
      authValue: "",
    });
    expect(r.success).toBe(true);
  });

  it("默认 dataJsonPath 为 $.data", () => {
    const r = CreateImportSourceFormSchema.parse({
      ...baseValid,
      dataJsonPath: undefined,
    });
    expect(r.dataJsonPath).toBe("$.data");
  });

  it("edit schema 允许保留已有凭据时 authValue 为空", () => {
    const r = UpdateImportSourceFormSchema.safeParse({
      name: "Renamed",
      authType: "BEARER",
      authValue: "",
    });
    expect(r.success).toBe(true);
  });

  it("edit schema 中 cursor 分页同样要求 cursorJsonPath", () => {
    const r = UpdateImportSourceFormSchema.safeParse({
      paginationType: "cursor",
      cursorParam: "cursor",
      cursorJsonPath: "",
    });
    expect(r.success).toBe(false);
  });

  it("create payload 省略空 optional 字段而不是发送 null", () => {
    expect(
      buildImportSourcePayload(
        {
          ...baseValid,
          description: "",
          authType: "NONE",
          authValue: "",
          authHeader: "",
          pageSizeParam: "",
          pageParam: "",
          cursorParam: "",
          cursorJsonPath: "",
          schedule: "",
        },
        {},
        false,
        false,
      ),
    ).toEqual({
      name: "Test",
      baseUrl: "https://api.example.com/users",
      authType: "NONE",
      headers: {},
      paginationType: "offset",
      pageSize: 100,
      dataJsonPath: "$.data",
      fieldMapping: { email: "$.email" },
      enabled: true,
    });
  });

  it("edit payload 保留凭据时不提交 authValue", () => {
    const payload = buildImportSourcePayload(
      baseValid,
      { "X-Tenant": "a" },
      true,
      true,
    );
    expect(payload.authValue).toBeUndefined();
    expect(payload.headers).toEqual({ "X-Tenant": "a" });
  });
});

describe("validateScheduleString", () => {
  it("空 / null 视为合法（手动）", () => {
    expect(validateScheduleString("")).toBeNull();
    expect(validateScheduleString(null)).toBeNull();
  });

  it("不足 5 段失败", () => {
    expect(validateScheduleString("* * * *")).toBeTruthy();
  });

  it("超过 5 段失败", () => {
    expect(validateScheduleString("* * * * * *")).toBeTruthy();
  });

  it("非法字符失败", () => {
    expect(validateScheduleString("* * * * abc!")).toBeTruthy();
  });

  it("合法 5 段 cron 通过", () => {
    expect(validateScheduleString("*/5 * * * *")).toBeNull();
    expect(validateScheduleString("0 0 * * 1")).toBeNull();
  });
});
