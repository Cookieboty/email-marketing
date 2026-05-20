import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ApiClientRowActions } from "@/app/(dashboard)/api-clients/_components/list-row-actions";
import type { ApiClientRow } from "@/app/(dashboard)/api-clients/_components/types";

const baseRow: ApiClientRow = {
  id: "ac_1",
  name: "Demo",
  description: null,
  status: "ACTIVE",
  tokenPrefix: "tk_xxxx",
  scopes: ["user:write"],
  ipWhitelist: [],
  rpsLimit: null,
  rphLimit: null,
  hmacEnabled: false,
  hasGraceToken: false,
  previousTokenExpiresAt: null,
  metadata: null,
  lastUsedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe("ApiClientRowActions", () => {
  function setup(row: ApiClientRow) {
    const onToggleStatus = vi.fn();
    const onRotate = vi.fn();
    const onRevoke = vi.fn();
    const utils = render(
      <ApiClientRowActions
        row={row}
        onToggleStatus={onToggleStatus}
        onRotate={onRotate}
        onRevoke={onRevoke}
      />,
    );
    return { ...utils, onToggleStatus, onRotate, onRevoke };
  }

  it("ACTIVE 行显示「停用 / 轮转 / 吊销」且都可点", () => {
    const { onToggleStatus, onRotate, onRevoke } = setup(baseRow);
    const toggle = screen.getByTestId("row-toggle-status");
    expect(toggle).toHaveTextContent("停用");
    expect(toggle).not.toBeDisabled();
    expect(screen.getByTestId("row-revoke")).toHaveTextContent("吊销");
    fireEvent.click(toggle);
    fireEvent.click(screen.getByTestId("row-rotate"));
    fireEvent.click(screen.getByTestId("row-revoke"));
    expect(onToggleStatus).toHaveBeenCalledWith(baseRow);
    expect(onRotate).toHaveBeenCalledWith(baseRow);
    expect(onRevoke).toHaveBeenCalledWith(baseRow);
  });

  it("DISABLED 行的切换按钮显示「启用」", () => {
    setup({ ...baseRow, status: "DISABLED" });
    expect(screen.getByTestId("row-toggle-status")).toHaveTextContent("启用");
  });

  it("REVOKED 行的所有操作按钮均 disabled", () => {
    setup({ ...baseRow, status: "REVOKED" });
    expect(screen.getByTestId("row-toggle-status")).toBeDisabled();
    expect(screen.getByTestId("row-rotate")).toBeDisabled();
    expect(screen.getByTestId("row-revoke")).toBeDisabled();
  });
});
