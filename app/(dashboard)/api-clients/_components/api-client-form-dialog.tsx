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
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import {
  buildApiClientFormPayload,
  CreateApiClientFormSchema,
  type CreateApiClientFormValues,
} from "./form-schema";
import { parseIpWhitelistText, ipWhitelistToText } from "./ip-whitelist";
import { SCOPES, SCOPE_LABELS, type ApiClientRow } from "./types";

export interface ApiClientFormDialogProps {
  open: boolean;
  mode: "create" | "edit";
  defaults?: ApiClientRow | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (
    payload: Record<string, unknown>,
    raw: CreateApiClientFormValues,
  ) => Promise<void>;
}

interface FormShape {
  name: string;
  description: string;
  scopes: string[];
  ipWhitelistText: string;
  rpsLimit: string;
  rphLimit: string;
  enableHmac: boolean;
}

function rowToForm(row: ApiClientRow | null | undefined): FormShape {
  return {
    name: row?.name ?? "",
    description: row?.description ?? "",
    scopes: row?.scopes ?? [],
    ipWhitelistText: ipWhitelistToText(row?.ipWhitelist),
    rpsLimit: row?.rpsLimit != null ? String(row.rpsLimit) : "",
    rphLimit: row?.rphLimit != null ? String(row.rphLimit) : "",
    enableHmac: row?.hmacEnabled ?? false,
  };
}

function asMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return "操作失败";
}

export function ApiClientFormDialog({
  open,
  mode,
  defaults,
  onOpenChange,
  onSubmit,
}: ApiClientFormDialogProps) {
  const { toast } = useToast();

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { isSubmitting, errors },
  } = useForm<FormShape>({
    defaultValues: rowToForm(defaults),
  });

  useEffect(() => {
    if (open) {
      reset(rowToForm(defaults));
    }
  }, [open, defaults, reset]);

  const scopes = watch("scopes");
  const enableHmac = watch("enableHmac");

  function toggleScope(s: string, checked: boolean) {
    const next = checked
      ? Array.from(new Set([...(scopes ?? []), s]))
      : (scopes ?? []).filter((x) => x !== s);
    setValue("scopes", next, { shouldDirty: true, shouldValidate: false });
  }

  async function submit(values: FormShape) {
    const payloadRaw: CreateApiClientFormValues = {
      name: values.name.trim(),
      description: values.description.trim() || undefined,
      scopes: values.scopes as CreateApiClientFormValues["scopes"],
      ipWhitelist: parseIpWhitelistText(values.ipWhitelistText),
      rpsLimit: values.rpsLimit ? Number(values.rpsLimit) : undefined,
      rphLimit: values.rphLimit ? Number(values.rphLimit) : undefined,
      enableHmac: mode === "create" ? values.enableHmac : undefined,
    };
    const parsed = CreateApiClientFormSchema.safeParse(payloadRaw);
    if (!parsed.success) {
      toast({
        title: "校验失败",
        description: parsed.error.issues.map((i) => i.message).join("；"),
        variant: "destructive",
      });
      return;
    }

    const payload = buildApiClientFormPayload(mode, parsed.data);

    try {
      await onSubmit(payload, parsed.data);
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
          <DialogTitle>{mode === "create" ? "新建 API Client" : "编辑 API Client"}</DialogTitle>
          <DialogDescription>
            {mode === "create"
              ? "创建后会一次性显示 Token / HMAC Secret，请妥善保存。"
              : "修改权限、限流或描述。Token 不会因编辑而变化。"}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(submit)} className="space-y-4" data-testid="api-client-form">
          <div className="space-y-1.5">
            <Label htmlFor="ac-name">名称 *</Label>
            <Input id="ac-name" autoFocus {...register("name", { required: true })} />
            {errors.name && (
              <p className="text-xs text-destructive">{errors.name.message ?? "请输入名称"}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ac-desc">描述</Label>
            <Textarea id="ac-desc" rows={2} {...register("description")} />
          </div>

          <div className="space-y-1.5">
            <Label>权限范围（Scopes）*</Label>
            <div className="grid grid-cols-2 gap-2 rounded-md border p-3 sm:grid-cols-3">
              {SCOPES.map((s) => {
                const checked = scopes?.includes(s) ?? false;
                return (
                  <label
                    key={s}
                    className="flex cursor-pointer items-center gap-2 text-sm"
                    data-testid={`scope-${s}`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => toggleScope(s, e.target.checked)}
                    />
                    <span>{SCOPE_LABELS[s]}</span>
                    <code className="text-[10px] text-muted-foreground">{s}</code>
                  </label>
                );
              })}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ac-ips">IP 白名单（每行一个，支持 CIDR；# 开头为注释）</Label>
            <Textarea
              id="ac-ips"
              rows={3}
              placeholder={"10.0.0.0/24\n# office\n203.0.113.5"}
              {...register("ipWhitelistText")}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="ac-rps">RPS 限制（每秒）</Label>
              <Input
                id="ac-rps"
                type="number"
                min={1}
                max={10000}
                placeholder="留空表示不限"
                {...register("rpsLimit")}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ac-rph">RPH 限制（每小时）</Label>
              <Input
                id="ac-rph"
                type="number"
                min={1}
                max={1000000}
                placeholder="留空表示不限"
                {...register("rphLimit")}
              />
            </div>
          </div>

          {mode === "create" ? (
            <div className="flex items-center gap-2">
              <input
                id="ac-hmac"
                type="checkbox"
                checked={enableHmac}
                onChange={(e) =>
                  setValue("enableHmac", e.target.checked, { shouldDirty: true })
                }
              />
              <Label htmlFor="ac-hmac" className="cursor-pointer">
                启用 HMAC 签名（仅创建时返回 secret）
              </Label>
            </div>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              取消
            </Button>
            <Button type="submit" disabled={isSubmitting} data-testid="api-client-submit">
              {isSubmitting ? "提交中..." : mode === "create" ? "创建" : "保存"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
