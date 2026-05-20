import { describe, it, expect } from "vitest";
import { parseIpWhitelistText } from "@/app/(dashboard)/api-clients/_components/ip-whitelist";

describe("parseIpWhitelistText", () => {
  it("空字符串返回空数组", () => {
    expect(parseIpWhitelistText("")).toEqual([]);
    expect(parseIpWhitelistText("\n  \n")).toEqual([]);
  });

  it("按行拆分并 trim", () => {
    const input = " 10.0.0.1 \n 192.168.0.0/24 \n";
    expect(parseIpWhitelistText(input)).toEqual(["10.0.0.1", "192.168.0.0/24"]);
  });

  it("过滤注释行（以 # 开头）", () => {
    const input = "# office\n10.0.0.1\n# vpn\n10.0.0.2";
    expect(parseIpWhitelistText(input)).toEqual(["10.0.0.1", "10.0.0.2"]);
  });

  it("保留 IPv6 + CIDR", () => {
    expect(parseIpWhitelistText("2001:db8::/32")).toEqual(["2001:db8::/32"]);
  });
});
