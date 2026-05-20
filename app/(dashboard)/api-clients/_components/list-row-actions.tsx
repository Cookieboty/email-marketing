"use client";

import { Button } from "@/components/ui/button";
import type { ApiClientRow } from "./types";

export interface ApiClientRowActionsProps {
  row: ApiClientRow;
  onToggleStatus: (row: ApiClientRow) => void;
  onRotate: (row: ApiClientRow) => void;
  onRevoke: (row: ApiClientRow) => void;
}

export function ApiClientRowActions({
  row,
  onToggleStatus,
  onRotate,
  onRevoke,
}: ApiClientRowActionsProps) {
  const revoked = row.status === "REVOKED";
  const toggleLabel = row.status === "ACTIVE" ? "停用" : "启用";
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={revoked}
        data-testid="row-toggle-status"
        onClick={() => onToggleStatus(row)}
      >
        {toggleLabel}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={revoked}
        data-testid="row-rotate"
        onClick={() => onRotate(row)}
      >
        轮转 Token
      </Button>
      <Button
        type="button"
        variant="destructive"
        size="sm"
        disabled={revoked}
        data-testid="row-revoke"
        onClick={() => onRevoke(row)}
      >
        吊销
      </Button>
    </div>
  );
}
