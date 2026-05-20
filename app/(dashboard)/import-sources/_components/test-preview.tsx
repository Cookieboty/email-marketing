"use client";

import type { ImportTestResp } from "./types";

export interface TestPreviewProps {
  result: ImportTestResp | null;
}

export function TestPreview({ result }: TestPreviewProps) {
  if (!result) {
    return (
      <p data-testid="test-preview-empty" className="text-sm text-muted-foreground">
        点击「运行测试」从远端拉取最多 5 行预览。此操作不会写入用户表。
      </p>
    );
  }

  const errors = result.errors ?? [];
  const rows = result.preview ?? [];

  return (
    <div className="space-y-3">
      <p className="text-sm">
        本次远端共拉取 <strong data-testid="test-preview-fetched">{result.fetched}</strong> 行；
        预览 {rows.length} 行；错误 {errors.length} 条。
      </p>

      <pre
        data-testid="test-preview-rows"
        className="max-h-64 overflow-auto rounded-md border bg-muted p-3 font-mono text-[11px]"
      >
        {JSON.stringify(rows, null, 2)}
      </pre>

      {errors.length > 0 ? (
        <div className="space-y-1.5" data-testid="test-preview-errors">
          <p className="text-xs font-medium text-destructive">错误明细</p>
          <ul className="space-y-1 text-xs">
            {errors.map((e, i) => (
              <li
                key={`${e.row}-${e.field}-${i}`}
                data-testid="test-preview-error-row"
                className="rounded border border-destructive/30 bg-destructive/5 px-2 py-1"
              >
                Row #{e.row} · <code>{e.field}</code> · {e.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
