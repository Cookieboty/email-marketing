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
import type { SmtpConfigRow } from "./types";

export interface TestSendDialogProps {
  open: boolean;
  config: SmtpConfigRow | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (payload: { to: string; subject: string; html: string }) => Promise<void>;
}

interface FormShape {
  to: string;
  subject: string;
  html: string;
}

const DEFAULT_HTML =
  "<p>这是一封 SMTP 配置测试邮件。</p><p>如果你看到这条信息，说明配置可正常发送。</p>";

function asMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return "操作失败";
}

export function TestSendDialog({
  open,
  config,
  onOpenChange,
  onSubmit,
}: TestSendDialogProps) {
  const { toast } = useToast();
  const {
    register,
    handleSubmit,
    reset,
    formState: { isSubmitting, errors },
  } = useForm<FormShape>({
    defaultValues: {
      to: "",
      subject: `[SMTP 测试] ${config?.name ?? ""}`.trim(),
      html: DEFAULT_HTML,
    },
  });

  useEffect(() => {
    if (open) {
      reset({
        to: "",
        subject: `[SMTP 测试] ${config?.name ?? ""}`.trim(),
        html: DEFAULT_HTML,
      });
    }
  }, [open, config, reset]);

  async function submit(values: FormShape) {
    try {
      await onSubmit({
        to: values.to.trim(),
        subject: values.subject.trim(),
        html: values.html,
      });
      reset();
      onOpenChange(false);
    } catch (e) {
      toast({
        title: "测试发送失败",
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
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>发送测试邮件</DialogTitle>
          <DialogDescription>
            使用「{config?.name ?? "—"}」实际发送一封邮件，校验配置可正常投递。
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={handleSubmit(submit)}
          className="space-y-4"
          data-testid="smtp-test-send-form"
        >
          <div className="space-y-1.5">
            <Label htmlFor="ts-to">收件人 *</Label>
            <Input
              id="ts-to"
              type="email"
              autoFocus
              placeholder="me@example.com"
              {...register("to", { required: true })}
            />
            {errors.to && <p className="text-xs text-destructive">请输入收件邮箱</p>}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ts-subject">主题 *</Label>
            <Input id="ts-subject" {...register("subject", { required: true })} />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ts-html">HTML 正文 *</Label>
            <Textarea
              id="ts-html"
              rows={6}
              {...register("html", { required: true })}
            />
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
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "发送中..." : "发送"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
