"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface AuthValueFieldProps {
  mode: "create" | "edit";
  hasAuth: boolean;
  value: string;
  onChange: (value: string, meta: { keep: boolean }) => void;
  authType?: "NONE" | "BEARER" | "BASIC" | "API_KEY_HEADER";
}

export function AuthValueField({
  mode,
  hasAuth,
  value,
  onChange,
  authType,
}: AuthValueFieldProps) {
  const showKeep = mode === "edit" && hasAuth;
  const [keep, setKeep] = useState<boolean>(showKeep);

  if (authType === "NONE") {
    return null;
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor="auth-value-input">
        {authType === "BASIC" ? "用户名:密码" : "Token / 凭据"}
      </Label>
      {showKeep ? (
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            data-testid="auth-keep"
            checked={keep}
            onChange={(e) => {
              const next = e.target.checked;
              setKeep(next);
              if (next) {
                onChange("", { keep: true });
              } else {
                onChange(value, { keep: false });
              }
            }}
          />
          保留现有凭据（不修改）
        </label>
      ) : null}
      <Input
        id="auth-value-input"
        data-testid="auth-value-input"
        type="password"
        autoComplete="off"
        disabled={keep}
        value={value}
        placeholder={
          showKeep && keep
            ? "已存在凭据，未取消勾选则不会更新"
            : authType === "BASIC"
              ? "user:password"
              : "tk_xxx"
        }
        onChange={(e) => onChange(e.target.value, { keep: false })}
      />
    </div>
  );
}
