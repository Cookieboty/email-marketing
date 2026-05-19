"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

type ToastVariant = "default" | "destructive";
interface ToastItem {
  id: number;
  title?: string;
  description?: string;
  variant: ToastVariant;
}

interface ToastContextValue {
  toast: (input: { title?: string; description?: string; variant?: ToastVariant }) => void;
}

const ToastContext = React.createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = React.useContext(ToastContext);
  if (!ctx) {
    return {
      toast: () => {
        if (process.env.NODE_ENV !== "production") {
          console.warn("[toast] ToastProvider not mounted; toast() ignored");
        }
      },
    };
  }
  return ctx;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = React.useState<ToastItem[]>([]);
  const idRef = React.useRef(0);

  const toast = React.useCallback(
    (input: { title?: string; description?: string; variant?: ToastVariant }) => {
      const id = ++idRef.current;
      const item: ToastItem = {
        id,
        title: input.title,
        description: input.description,
        variant: input.variant ?? "default",
      };
      setItems((prev) => [...prev, item]);
      window.setTimeout(() => {
        setItems((prev) => prev.filter((t) => t.id !== id));
      }, 4000);
    },
    [],
  );

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-full max-w-sm flex-col gap-2">
        {items.map((t) => (
          <div
            key={t.id}
            role="status"
            data-testid="toast"
            className={cn(
              "pointer-events-auto rounded-md border bg-background p-3 text-sm shadow-lg",
              t.variant === "destructive" && "border-destructive/40 bg-destructive/10 text-destructive",
            )}
          >
            {t.title ? <div className="font-medium">{t.title}</div> : null}
            {t.description ? (
              <div className="text-muted-foreground">{t.description}</div>
            ) : null}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
