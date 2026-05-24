"use client";

import { Suspense, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter, useSearchParams } from "next/navigation";
import { z } from "zod";

const Schema = z.object({
  token: z.string().min(1, "请输入管理员 Token"),
});
type FormValues = z.infer<typeof Schema>;

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const sp = useSearchParams();
  const from = sp.get("from") ?? "/dashboard";
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(Schema) });

  async function onSubmit(values: FormValues) {
    setServerError(null);
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(values),
      credentials: "same-origin",
    });
    if (res.ok) {
      router.replace(from);
      router.refresh();
      return;
    }
    if (res.status === 429) {
      const retry = res.headers.get("retry-after");
      setServerError(`请求过于频繁，请稍后再试${retry ? `（${retry}s）` : ""}`);
      return;
    }
    setServerError("Token 不正确");
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-md rounded-lg border bg-card p-8 shadow-sm">
        <h1 className="text-2xl font-semibold tracking-tight" data-testid="login-heading">
          管理员登录
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          请输入 ADMIN_TOKEN 以访问后台。
        </p>
        <form className="mt-6 space-y-4" onSubmit={handleSubmit(onSubmit)} noValidate>
          <div className="space-y-1.5">
            <label htmlFor="token" className="text-sm font-medium">
              Token
            </label>
            <input
              id="token"
              type="password"
              autoComplete="current-password"
              data-testid="login-token-input"
              className="flex h-10 w-full rounded-md border bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              {...register("token")}
            />
            {errors.token ? (
              <p className="text-sm text-destructive" data-testid="login-token-error">
                {errors.token.message}
              </p>
            ) : null}
          </div>
          {serverError ? (
            <p className="text-sm text-destructive" data-testid="login-server-error">
              {serverError}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={isSubmitting}
            data-testid="login-submit"
            className="inline-flex h-10 w-full items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow disabled:opacity-50"
          >
            {isSubmitting ? "登录中..." : "登录"}
          </button>
        </form>
      </div>
    </main>
  );
}
