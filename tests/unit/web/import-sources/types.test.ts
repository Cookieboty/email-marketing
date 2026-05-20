import { describe, it, expect } from "vitest";
import {
  AUTH_TYPE_LABELS,
  PAGINATION_LABELS,
  JOB_STATUS_LABELS,
  type ImportAuthType,
  type ImportJobStatus,
  type PaginationType,
} from "@/app/(dashboard)/import-sources/_components/types";

describe("import-source types 与后端枚举一致", () => {
  it("AUTH_TYPE_LABELS 覆盖 NONE / BEARER / BASIC / API_KEY_HEADER 四种", () => {
    const keys: ImportAuthType[] = ["NONE", "BEARER", "BASIC", "API_KEY_HEADER"];
    expect(new Set(Object.keys(AUTH_TYPE_LABELS))).toEqual(new Set(keys));
    for (const k of keys) {
      expect(AUTH_TYPE_LABELS[k]).toBeTruthy();
    }
  });

  it("PAGINATION_LABELS 覆盖 offset / cursor / page / link_header 四种", () => {
    const keys: PaginationType[] = ["offset", "cursor", "page", "link_header"];
    expect(new Set(Object.keys(PAGINATION_LABELS))).toEqual(new Set(keys));
  });

  it("JOB_STATUS_LABELS 覆盖 PENDING/RUNNING/COMPLETED/FAILED/CANCELLED 五种", () => {
    const keys: ImportJobStatus[] = [
      "PENDING",
      "RUNNING",
      "COMPLETED",
      "FAILED",
      "CANCELLED",
    ];
    expect(new Set(Object.keys(JOB_STATUS_LABELS))).toEqual(new Set(keys));
  });
});
