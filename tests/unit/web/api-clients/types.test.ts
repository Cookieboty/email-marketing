import { describe, it, expect } from "vitest";
import {
  SCOPES as FE_SCOPES,
  STATUS_LABELS,
  SCOPE_LABELS,
} from "@/app/(dashboard)/api-clients/_components/types";
import { SCOPES as BE_SCOPES } from "@/lib/modules/api-client/schema";

describe("api-clients/types", () => {
  it("FE SCOPES 与后端 schema SCOPES 完全一致", () => {
    expect(new Set(FE_SCOPES)).toEqual(new Set(BE_SCOPES));
    expect(FE_SCOPES.length).toBe(BE_SCOPES.length);
  });

  it("STATUS_LABELS 覆盖三态", () => {
    expect(Object.keys(STATUS_LABELS).sort()).toEqual([
      "ACTIVE",
      "DISABLED",
      "REVOKED",
    ]);
  });

  it("SCOPE_LABELS 覆盖所有 scope 且非空", () => {
    for (const s of FE_SCOPES) {
      expect(SCOPE_LABELS[s]).toBeTruthy();
    }
  });
});
