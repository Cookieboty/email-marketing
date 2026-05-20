"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";

export interface CredentialRevealDialogProps {
  open: boolean;
  title: string;
  description?: string;
  token: string;
  hmacSecret?: string;
  previousTokenExpiresAt?: string | null;
  onOpenChange: (open: boolean) => void;
  onClosed?: () => void;
}

export function CredentialRevealDialog({
  open,
  title,
  description,
  token,
  hmacSecret,
  previousTokenExpiresAt,
  onOpenChange,
  onClosed,
}: CredentialRevealDialogProps) {
  const { toast } = useToast();

  function fallbackCopy(value: string): boolean {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    try {
      return document.execCommand("copy");
    } finally {
      document.body.removeChild(textarea);
    }
  }

  async function copy(value: string, label: string) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else if (!fallbackCopy(value)) {
        throw new Error("copy failed");
      }
      toast({ title: `${label}已复制` });
    } catch {
      if (fallbackCopy(value)) {
        toast({ title: `${label}已复制` });
      } else {
        toast({
          title: `${label}复制失败`,
          description: "请手动选中并复制",
          variant: "destructive",
        });
      }
    }
  }

  function handleClose() {
    onOpenChange(false);
    onClosed?.();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) onClosed?.();
      }}
    >
      <DialogContent data-testid="credential-reveal-dialog">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <div className="space-y-4">
          <CredentialField
            label="Token"
            value={token}
            testId="credential-token"
            copyTestId="copy-token"
            onCopy={() => copy(token, "Token")}
          />
          {hmacSecret ? (
            <CredentialField
              label="HMAC Secret"
              value={hmacSecret}
              testId="credential-hmac"
              copyTestId="copy-hmac"
              onCopy={() => copy(hmacSecret, "HMAC Secret")}
            />
          ) : null}
          {previousTokenExpiresAt ? (
            <p className="text-xs text-muted-foreground">
              旧 Token 在 {new Date(previousTokenExpiresAt).toLocaleString()} 之前仍可使用。
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button onClick={handleClose} data-testid="credential-close">
            我已保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface FieldProps {
  label: string;
  value: string;
  testId: string;
  copyTestId: string;
  onCopy: () => void;
}

function CredentialField({ label, value, testId, copyTestId, onCopy }: FieldProps) {
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="flex items-center gap-2">
        <code
          data-testid={testId}
          className="flex-1 break-all rounded border bg-muted px-2 py-1 font-mono text-sm"
        >
          {value}
        </code>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onCopy}
          data-testid={copyTestId}
        >
          复制
        </Button>
      </div>
    </div>
  );
}
