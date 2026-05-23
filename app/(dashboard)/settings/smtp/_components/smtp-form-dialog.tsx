"use client";

import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { SECURE_MODES } from "@/lib/modules/smtp/schema";
import { SECURE_LABELS, type SmtpConfigRow, type SmtpSecureMode } from "./types";

export interface SmtpFormDialogProps {
  open: boolean;
  mode: "create" | "edit";
  defaults?: SmtpConfigRow | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (payload: Record<string, unknown>) => Promise<void>;
}

interface FormShape {
  name: string;
  description: string;
  host: string;
  port: string;
  secure: SmtpSecureMode;
  username: string;
  password: string;
  clearPassword: boolean;
  fromEmail: string;
  fromName: string;
  replyTo: string;
  rejectUnauthorized: boolean;
  requireTls: boolean;
}

function rowToForm(row: SmtpConfigRow | null | undefined): FormShape {
  return {
    name: row?.name ?? "",
    description: row?.description ?? "",
    host: row?.host ?? "",
    port: row?.port != null ? String(row.port) : "587",
    secure: row?.secure ?? "STARTTLS",
    username: row?.username ?? "",
    password: "",
    clearPassword: false,
    fromEmail: row?.fromEmail ?? "",
    fromName: row?.fromName ?? "",
    replyTo: row?.replyTo ?? "",
    rejectUnauthorized: row?.rejectUnauthorized ?? true,
    requireTls: row?.requireTls ?? true,
  };
}

function asMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return "操作失败";
}

export function SmtpFormDialog({
  open,
  mode,
  defaults,
  onOpenChange,
  onSubmit,
}: SmtpFormDialogProps) {
  const { toast } = useToast();
  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { isSubmitting, errors },
  } = useForm<FormShape>({ defaultValues: rowToForm(defaults) });

  useEffect(() => {
    if (open) reset(rowToForm(defaults));
  }, [open, defaults, reset]);

  const clearPassword = watch("clearPassword");
  const username = watch("username");

  async function submit(values: FormShape) {
    if (!values.name.trim()) {
      toast({ title: "请输入名称", variant: "destructive" });
      return;
    }
    const portNum = Number(values.port);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      toast({ title: "端口无效", description: "端口必须是 1-65535 之间的整数", variant: "destructive" });
      return;
    }

    const payload: Record<string, unknown> = {
      name: values.name.trim(),
      host: values.host.trim(),
      port: portNum,
      secure: values.secure,
      fromEmail: values.fromEmail.trim(),
      rejectUnauthorized: values.rejectUnauthorized,
      requireTls: values.requireTls,
    };

    const desc = values.description.trim();
    if (mode === "create") {
      if (desc) payload.description = desc;
    } else {
      payload.description = desc ? desc : null;
    }

    const fromName = values.fromName.trim();
    if (mode === "create") {
      if (fromName) payload.fromName = fromName;
    } else {
      payload.fromName = fromName ? fromName : null;
    }

    const replyTo = values.replyTo.trim();
    if (mode === "create") {
      if (replyTo) payload.replyTo = replyTo;
    } else {
      payload.replyTo = replyTo ? replyTo : null;
    }

    const usernameTrim = values.username.trim();
    if (mode === "create") {
      if (usernameTrim) payload.username = usernameTrim;
      if (values.password) payload.password = values.password;
    } else {
      if (values.clearPassword) {
        payload.username = null;
        payload.password = null;
      } else {
        if (usernameTrim !== (defaults?.username ?? "")) {
          payload.username = usernameTrim ? usernameTrim : null;
        }
        if (values.password) payload.password = values.password;
      }
    }

    try {
      await onSubmit(payload);
      reset();
      onOpenChange(false);
    } catch (e) {
      toast({
        title: mode === "create" ? "创建失败" : "保存失败",
        description: asMessage(e),
        variant: "destructive",
      });
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{mode === "create" ? "新建 SMTP 配置" : "编辑 SMTP 配置"}</DialogTitle>
          <DialogDescription>
            配置只在保存后生效；密码使用 AES-256-GCM 加密存储，列表中只显示提示。
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={handleSubmit(submit)}
          className="space-y-4"
          data-testid="smtp-form"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="smtp-name">名称 *</Label>
              <Input
                id="smtp-name"
                autoFocus
                {...register("name", { required: true })}
              />
              {errors.name && (
                <p className="text-xs text-destructive">请输入名称</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="smtp-from-email">发件人邮箱 *</Label>
              <Input
                id="smtp-from-email"
                placeholder="noreply@example.com 或 Foo <a@b.com>"
                {...register("fromEmail", { required: true })}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="smtp-desc">描述</Label>
            <Textarea id="smtp-desc" rows={2} {...register("description")} />
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="smtp-host">SMTP 主机 *</Label>
              <Input
                id="smtp-host"
                placeholder="smtp.example.com"
                {...register("host", { required: true })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="smtp-port">端口 *</Label>
              <Input
                id="smtp-port"
                type="number"
                min={1}
                max={65535}
                {...register("port", { required: true })}
              />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="smtp-secure">加密方式 *</Label>
              <Select id="smtp-secure" {...register("secure")}>
                {SECURE_MODES.map((m) => (
                  <option key={m} value={m}>
                    {SECURE_LABELS[m]}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="smtp-from-name">发件人显示名</Label>
              <Input id="smtp-from-name" {...register("fromName")} />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="smtp-username">用户名</Label>
              <Input
                id="smtp-username"
                disabled={mode === "edit" && clearPassword}
                {...register("username")}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="smtp-password">
                密码{mode === "edit" ? "（留空保持不变）" : ""}
              </Label>
              <Input
                id="smtp-password"
                type="password"
                autoComplete="new-password"
                disabled={mode === "edit" && clearPassword}
                placeholder={
                  mode === "edit" && defaults?.passwordHint
                    ? `已存在：${defaults.passwordHint}`
                    : ""
                }
                {...register("password")}
              />
              {mode === "create" && username && !watch("password") ? (
                <p className="text-[11px] text-muted-foreground">
                  填写了用户名通常需要密码；如果使用 IP 白名单，可留空。
                </p>
              ) : null}
            </div>
          </div>

          {mode === "edit" ? (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={clearPassword}
                onChange={(e) =>
                  setValue("clearPassword", e.target.checked, { shouldDirty: true })
                }
              />
              <span>清除已保存的用户名 / 密码（用于改用 IP 白名单 / OAuth 等）</span>
            </label>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="smtp-reply-to">回信地址</Label>
            <Input
              id="smtp-reply-to"
              placeholder="reply@example.com"
              {...register("replyTo")}
            />
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" {...register("requireTls")} />
              <span>要求 TLS（requireTls）</span>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" {...register("rejectUnauthorized")} />
              <span>拒绝不可信证书（rejectUnauthorized）</span>
            </label>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              取消
            </Button>
            <Button type="submit" disabled={isSubmitting} data-testid="smtp-submit">
              {isSubmitting ? "提交中..." : mode === "create" ? "创建" : "保存"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
