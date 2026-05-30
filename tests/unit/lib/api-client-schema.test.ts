import { describe, it, expect } from "vitest";
import { CreateApiClientSchema } from "@/lib/modules/api-client/schema";

describe("CreateApiClientSchema enableHmac default", () => {
  it("defaults enableHmac to true when omitted", () => {
    const parsed = CreateApiClientSchema.parse({
      name: "Demo",
      scopes: ["user:write"],
    });
    expect(parsed.enableHmac).toBe(true);
  });

  it("respects explicit enableHmac=false", () => {
    const parsed = CreateApiClientSchema.parse({
      name: "Demo",
      scopes: ["user:write"],
      enableHmac: false,
    });
    expect(parsed.enableHmac).toBe(false);
  });
});
