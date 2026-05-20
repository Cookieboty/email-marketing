import { describe, it, expect } from "vitest";
import {
  CreateApiClientFormSchema,
  buildApiClientFormPayload,
} from "@/app/(dashboard)/api-clients/_components/form-schema";

describe("CreateApiClientFormSchema", () => {
  const valid = {
    name: "Demo",
    description: "",
    scopes: ["user:write"],
    ipWhitelist: ["10.0.0.1"],
    rpsLimit: 10,
    rphLimit: 1000,
    enableHmac: false,
    metadata: undefined,
  };

  it("合法输入通过", () => {
    expect(CreateApiClientFormSchema.safeParse(valid).success).toBe(true);
  });

  it("scopes 为空失败", () => {
    const r = CreateApiClientFormSchema.safeParse({ ...valid, scopes: [] });
    expect(r.success).toBe(false);
  });

  it("未知 scope 失败", () => {
    const r = CreateApiClientFormSchema.safeParse({
      ...valid,
      scopes: ["nope:write"],
    });
    expect(r.success).toBe(false);
  });

  it("name 超长失败", () => {
    const r = CreateApiClientFormSchema.safeParse({
      ...valid,
      name: "x".repeat(121),
    });
    expect(r.success).toBe(false);
  });

  it("非法 ipWhitelist 失败（含字母 / 不符合 regex）", () => {
    const r = CreateApiClientFormSchema.safeParse({
      ...valid,
      ipWhitelist: ["not-an-ip!!"],
    });
    expect(r.success).toBe(false);
  });

  it("非法 IPv4 数值与 CIDR 范围失败", () => {
    expect(
      CreateApiClientFormSchema.safeParse({
        ...valid,
        ipWhitelist: ["999.0.0.1"],
      }).success,
    ).toBe(false);
    expect(
      CreateApiClientFormSchema.safeParse({
        ...valid,
        ipWhitelist: ["10.0.0.1/99"],
      }).success,
    ).toBe(false);
  });

  it("合法 IPv4 / IPv6 CIDR 通过", () => {
    const r = CreateApiClientFormSchema.safeParse({
      ...valid,
      ipWhitelist: ["10.0.0.1/32", "2001:db8::1/128"],
    });
    expect(r.success).toBe(true);
  });

  it("rpsLimit / rphLimit 为 0 失败", () => {
    const r = CreateApiClientFormSchema.safeParse({
      ...valid,
      rpsLimit: 0,
    });
    expect(r.success).toBe(false);
  });

  it("create payload 省略空 optional 字段而不是发送 null", () => {
    expect(
      buildApiClientFormPayload("create", {
        name: "Demo",
        description: "",
        scopes: ["user:write"],
        ipWhitelist: [],
        rpsLimit: undefined,
        rphLimit: undefined,
        enableHmac: false,
      }),
    ).toEqual({
      name: "Demo",
      scopes: ["user:write"],
      ipWhitelist: [],
      enableHmac: false,
    });
  });

  it("edit payload 用 null 清空 nullable 字段", () => {
    expect(
      buildApiClientFormPayload("edit", {
        name: "Demo",
        description: "",
        scopes: ["user:write"],
        ipWhitelist: [],
        rpsLimit: undefined,
        rphLimit: undefined,
        enableHmac: undefined,
      }),
    ).toEqual({
      name: "Demo",
      description: null,
      scopes: ["user:write"],
      ipWhitelist: [],
      rpsLimit: null,
      rphLimit: null,
    });
  });
});
