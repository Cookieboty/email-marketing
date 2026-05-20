"use client";

import { useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export interface FieldMappingEditorProps {
  value: Record<string, string>;
  onChange: (
    next: Record<string, string>,
    meta: { valid: boolean; error: string | null; raw: string },
  ) => void;
}

function parse(raw: string): {
  ok: true;
  value: Record<string, string>;
} | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "JSON 解析失败" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "fieldMapping 必须是对象" };
  }
  const obj = parsed as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v !== "string" || v.length === 0) {
      return { ok: false, error: `字段 "${k}" 的值必须为非空字符串` };
    }
  }
  if (typeof obj.email !== "string" || obj.email.length === 0) {
    return { ok: false, error: "fieldMapping.email 是必填字段" };
  }
  return { ok: true, value: obj as Record<string, string> };
}

export function FieldMappingEditor({ value, onChange }: FieldMappingEditorProps) {
  const [raw, setRaw] = useState<string>(() => JSON.stringify(value, null, 2));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const incoming = JSON.stringify(value, null, 2);
    setRaw((prev) => {
      try {
        const cur = JSON.parse(prev);
        return JSON.stringify(cur) === JSON.stringify(value) ? prev : incoming;
      } catch {
        return incoming;
      }
    });
  }, [value]);

  function handle(next: string) {
    setRaw(next);
    const r = parse(next);
    if (r.ok) {
      setError(null);
      onChange(r.value, { valid: true, error: null, raw: next });
    } else {
      setError(r.error);
      onChange(value, { valid: false, error: r.error, raw: next });
    }
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor="field-mapping-textarea">字段映射（JSON）</Label>
      <Textarea
        id="field-mapping-textarea"
        data-testid="field-mapping-textarea"
        rows={8}
        spellCheck={false}
        value={raw}
        onChange={(e) => handle(e.target.value)}
        className="font-mono text-xs"
      />
      {error ? (
        <p
          data-testid="field-mapping-error"
          className="text-xs text-destructive"
        >
          {error}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          形如 <code>{`{ "email": "$.email", "name": "$.full_name" }`}</code>，
          必须包含 <code>email</code> 字段。
        </p>
      )}
    </div>
  );
}
