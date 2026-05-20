"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { apiPatch, apiPost } from "@/lib/api-client";
import { swrKeys } from "@/lib/swr-keys";
import { mutate as globalMutate } from "swr";
import {
  buildImportSourcePayload,
  CreateImportSourceFormSchema,
  UpdateImportSourceFormSchema,
  type CreateImportSourceFormValues,
  validateScheduleString,
} from "./form-schema";
import { FieldMappingEditor } from "./field-mapping-editor";
import { AuthValueField } from "./auth-value-field";
import {
  AUTH_TYPE_LABELS,
  PAGINATION_LABELS,
  type ImportAuthType,
  type ImportSourceRow,
  type PaginationType,
} from "./types";

export interface ImportSourceFormProps {
  mode: "create" | "edit";
  initial?: ImportSourceRow;
}

const AUTH_TYPES: ImportAuthType[] = ["NONE", "BEARER", "BASIC", "API_KEY_HEADER"];
const PAGE_TYPES: PaginationType[] = ["offset", "cursor", "page", "link_header"];

function asMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return "操作失败";
}

function defaultsFor(initial?: ImportSourceRow): CreateImportSourceFormValues {
  return {
    name: initial?.name ?? "",
    description: initial?.description ?? "",
    baseUrl: initial?.baseUrl ?? "https://",
    authType: initial?.authType ?? "NONE",
    authValue: "",
    authHeader: initial?.authHeader ?? "",
    headers: (initial?.headers ?? {}) as Record<string, string>,
    paginationType: initial?.paginationType ?? "offset",
    pageSize: initial?.pageSize ?? 100,
    pageSizeParam: initial?.pageSizeParam ?? "limit",
    pageParam: initial?.pageParam ?? "offset",
    cursorParam: initial?.cursorParam ?? "",
    cursorJsonPath: initial?.cursorJsonPath ?? "",
    dataJsonPath: initial?.dataJsonPath ?? "$.data",
    fieldMapping: (initial?.fieldMapping as Record<string, string>) ?? { email: "$.email" },
    schedule: initial?.schedule ?? "",
    enabled: initial?.enabled ?? true,
  };
}

export function ImportSourceForm({ mode, initial }: ImportSourceFormProps) {
  const router = useRouter();
  const { toast } = useToast();
  const isEdit = mode === "edit";
  const hasAuth = !!initial?.hasAuth;
  const [keepAuth, setKeepAuth] = useState<boolean>(isEdit && hasAuth);
  const [headersJson, setHeadersJson] = useState<string>(() =>
    JSON.stringify(initial?.headers ?? {}, null, 2),
  );
  const [headersError, setHeadersError] = useState<string | null>(null);
  const [fieldMappingValid, setFieldMappingValid] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const form = useForm<CreateImportSourceFormValues>({
    resolver: zodResolver(isEdit ? UpdateImportSourceFormSchema : CreateImportSourceFormSchema),
    defaultValues: useMemo(() => defaultsFor(initial), [initial]),
    mode: "onBlur",
  });
  const {
    register,
    control,
    handleSubmit,
    watch,
    formState: { errors },
  } = form;

  const authType = watch("authType");
  const paginationType = watch("paginationType");

  function parseHeaders(): Record<string, string> | null {
    if (!headersJson.trim()) return {};
    try {
      const v = JSON.parse(headersJson);
      if (!v || typeof v !== "object" || Array.isArray(v)) {
        setHeadersError("headers 必须是对象");
        return null;
      }
      const out: Record<string, string> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (typeof val !== "string") {
          setHeadersError(`header "${k}" 必须为字符串`);
          return null;
        }
        out[k] = val;
      }
      setHeadersError(null);
      return out;
    } catch (e) {
      setHeadersError(e instanceof Error ? e.message : "JSON 解析失败");
      return null;
    }
  }

  async function onSubmit(values: CreateImportSourceFormValues) {
    const cronError = validateScheduleString(values.schedule ?? null);
    if (cronError) {
      toast({ title: "调度表达式非法", description: cronError, variant: "destructive" });
      return;
    }
    const headers = parseHeaders();
    if (headersError || headers == null) {
      toast({ title: "headers JSON 非法", description: headersError ?? "", variant: "destructive" });
      return;
    }
    if (!fieldMappingValid) {
      toast({ title: "字段映射 JSON 非法", variant: "destructive" });
      return;
    }
    if (isEdit && authType !== "NONE" && !keepAuth && !values.authValue) {
      toast({ title: "凭据不能为空", variant: "destructive" });
      return;
    }

    const payload = buildImportSourcePayload(values, headers, isEdit, keepAuth);

    setSubmitting(true);
    try {
      if (isEdit && initial) {
        await apiPatch(`/api/import-sources/${initial.id}`, payload);
        toast({ title: "已保存" });
        await globalMutate(swrKeys.importSource(initial.id));
        await globalMutate(swrKeys.importSources());
        router.push(`/import-sources/${initial.id}`);
      } else {
        const res = await apiPost<ImportSourceRow>(
          "/api/import-sources",
          payload,
        );
        toast({ title: "已创建" });
        await globalMutate(swrKeys.importSources());
        const id = res?.id;
        router.push(id ? `/import-sources/${id}` : "/import-sources");
      }
    } catch (e) {
      toast({ title: "保存失败", description: asMessage(e), variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="space-y-6" onSubmit={handleSubmit(onSubmit)} noValidate>
      <section className="grid gap-4 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="name">名称</Label>
          <Input id="name" {...register("name")} />
          {errors.name ? (
            <p className="text-xs text-destructive">{errors.name.message}</p>
          ) : null}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="baseUrl">数据源 URL（必须 https）</Label>
          <Input id="baseUrl" {...register("baseUrl")} placeholder="https://api.example.com/users" />
          {errors.baseUrl ? (
            <p className="text-xs text-destructive">{errors.baseUrl.message}</p>
          ) : null}
        </div>
        <div className="space-y-1.5 md:col-span-2">
          <Label htmlFor="description">描述（可选）</Label>
          <Textarea id="description" rows={2} {...register("description")} />
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="authType">认证类型</Label>
          <select
            id="authType"
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
            {...register("authType")}
          >
            {AUTH_TYPES.map((t) => (
              <option key={t} value={t}>
                {AUTH_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </div>
        {authType === "API_KEY_HEADER" ? (
          <div className="space-y-1.5">
            <Label htmlFor="authHeader">Header 名称</Label>
            <Input id="authHeader" {...register("authHeader")} placeholder="X-API-Key" />
            {errors.authHeader ? (
              <p className="text-xs text-destructive">{errors.authHeader.message}</p>
            ) : null}
          </div>
        ) : null}

        {authType !== "NONE" ? (
          <div className="md:col-span-2">
            <Controller
              control={control}
              name="authValue"
              render={({ field }) => (
                <AuthValueField
                  mode={mode}
                  hasAuth={hasAuth}
                  authType={authType}
                  value={field.value ?? ""}
                  onChange={(v, meta) => {
                    setKeepAuth(meta.keep);
                    field.onChange(v);
                  }}
                />
              )}
            />
            {errors.authValue ? (
              <p className="mt-1 text-xs text-destructive">{errors.authValue.message}</p>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="space-y-1.5">
        <Label htmlFor="headers">额外 headers（JSON 对象）</Label>
        <Textarea
          id="headers"
          rows={4}
          spellCheck={false}
          value={headersJson}
          onChange={(e) => {
            setHeadersJson(e.target.value);
            setHeadersError(null);
          }}
          className="font-mono text-xs"
        />
        {headersError ? (
          <p className="text-xs text-destructive">{headersError}</p>
        ) : (
          <p className="text-xs text-muted-foreground">
            形如 <code>{`{ "X-Tenant": "abc" }`}</code>，留空表示不发送额外 headers。
          </p>
        )}
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="paginationType">分页方式</Label>
          <select
            id="paginationType"
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
            {...register("paginationType")}
          >
            {PAGE_TYPES.map((t) => (
              <option key={t} value={t}>
                {PAGINATION_LABELS[t]}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pageSize">每页大小</Label>
          <Input
            id="pageSize"
            type="number"
            min={1}
            max={1000}
            {...register("pageSize", { valueAsNumber: true })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pageSizeParam">分页大小参数名</Label>
          <Input id="pageSizeParam" {...register("pageSizeParam")} placeholder="limit" />
        </div>
        {paginationType === "offset" || paginationType === "page" ? (
          <div className="space-y-1.5">
            <Label htmlFor="pageParam">
              {paginationType === "page" ? "页码参数名" : "offset 参数名"}
            </Label>
            <Input id="pageParam" {...register("pageParam")} placeholder={paginationType === "page" ? "page" : "offset"} />
            {errors.pageParam ? (
              <p className="text-xs text-destructive">{errors.pageParam.message}</p>
            ) : null}
          </div>
        ) : null}
        {paginationType === "cursor" ? (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="cursorParam">cursor 参数名</Label>
              <Input id="cursorParam" {...register("cursorParam")} placeholder="cursor" />
              {errors.cursorParam ? (
                <p className="text-xs text-destructive">{errors.cursorParam.message}</p>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cursorJsonPath">cursor JSONPath</Label>
              <Input
                id="cursorJsonPath"
                {...register("cursorJsonPath")}
                placeholder="$.next_cursor"
              />
            </div>
          </>
        ) : null}
        <div className="space-y-1.5 md:col-span-2">
          <Label htmlFor="dataJsonPath">数据 JSONPath</Label>
          <Input id="dataJsonPath" {...register("dataJsonPath")} placeholder="$.data" />
        </div>
      </section>

      <section>
        <Controller
          control={control}
          name="fieldMapping"
          render={({ field }) => (
            <FieldMappingEditor
              value={field.value}
              onChange={(next, meta) => {
                setFieldMappingValid(meta.valid);
                if (meta.valid) {
                  field.onChange(next);
                }
              }}
            />
          )}
        />
        {errors.fieldMapping ? (
          <p className="mt-1 text-xs text-destructive">
            {typeof errors.fieldMapping?.message === "string"
              ? errors.fieldMapping.message
              : "fieldMapping 不合法"}
          </p>
        ) : null}
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="schedule">cron 表达式（5 段，留空表示手动）</Label>
          <Input id="schedule" {...register("schedule")} placeholder="*/5 * * * *" />
        </div>
        <div className="flex items-end gap-2">
          <input
            id="enabled"
            type="checkbox"
            className="h-4 w-4"
            {...register("enabled")}
          />
          <Label htmlFor="enabled" className="!mb-0 cursor-pointer">
            启用（停用后调度器跳过）
          </Label>
        </div>
      </section>

      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => router.back()}
          disabled={submitting}
        >
          取消
        </Button>
        <Button type="submit" disabled={submitting || !fieldMappingValid}>
          {submitting ? "保存中…" : isEdit ? "保存" : "创建"}
        </Button>
      </div>

      <input
        type="hidden"
        value={keepAuth ? "1" : "0"}
        readOnly
        data-testid="auth-keep-state"
      />
    </form>
  );
}
