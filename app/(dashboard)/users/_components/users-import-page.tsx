"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { apiFetch, type ApiClientError } from "@/lib/api-client";

type Mode = "csv" | "json";

interface ImportError {
  row: number;
  email?: string;
  reason: string;
}

interface ImportResp {
  created: number;
  updated: number;
  skipped: number;
  errors: ImportError[];
}

const MAX_BYTES = 10 * 1024 * 1024;

function asMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return "请求失败";
}

export default function UsersImportPage() {
  const { toast } = useToast();
  const [mode, setMode] = useState<Mode>("csv");
  const [file, setFile] = useState<File | null>(null);
  const [jsonText, setJsonText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ImportResp | null>(null);

  const onSelectFile = (f: File | null) => {
    setResult(null);
    if (f && f.size > MAX_BYTES) {
      toast({
        title: "文件过大",
        description: "文件大小不能超过 10MB",
        variant: "destructive",
      });
      setFile(null);
      return;
    }
    setFile(f);
  };

  const onSubmit = async () => {
    setResult(null);
    setSubmitting(true);
    try {
      let resp: ImportResp;
      if (mode === "csv") {
        if (!file) {
          toast({
            title: "请选择文件",
            description: "请先选择需要导入的 CSV 文件",
            variant: "destructive",
          });
          return;
        }
        const fd = new FormData();
        fd.append("file", file);
        resp = await apiFetch<ImportResp>("/api/users/import", {
          method: "POST",
          body: fd,
        });
      } else {
        let parsed: unknown;
        try {
          parsed = JSON.parse(jsonText);
        } catch {
          toast({
            title: "JSON 解析失败",
            description: "请检查输入是否为合法 JSON",
            variant: "destructive",
          });
          return;
        }
        const users = Array.isArray(parsed)
          ? parsed
          : (parsed as { users?: unknown }).users;
        if (!Array.isArray(users)) {
          toast({
            title: "格式错误",
            description: "需要 JSON 数组或 { users: [...] } 形式",
            variant: "destructive",
          });
          return;
        }
        resp = await apiFetch<ImportResp>("/api/users/import", {
          method: "POST",
          body: JSON.stringify({ users }),
        });
      }
      setResult(resp);
      toast({
        title: "导入完成",
        description: `创建 ${resp.created} / 更新 ${resp.updated} / 错误 ${resp.errors.length}`,
      });
    } catch (e) {
      const err = e as ApiClientError;
      toast({
        title: "导入失败",
        description: asMessage(err),
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="space-y-4">
      <header className="flex items-center justify-between">
        <h1
          className="text-2xl font-semibold tracking-tight"
          data-testid="users-import-heading"
        >
          批量导入用户
        </h1>
        <Link
          href="/users"
          className="text-sm text-muted-foreground hover:underline"
          data-testid="users-import-back"
        >
          ← 返回用户列表
        </Link>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>选择导入方式</CardTitle>
          <CardDescription>
            支持 CSV 文件上传或直接粘贴 JSON。文件 ≤ 10MB，行数 ≤ 50000。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2" role="tablist" aria-label="导入方式">
            <Button
              type="button"
              variant={mode === "csv" ? "default" : "outline"}
              onClick={() => setMode("csv")}
              data-testid="users-import-mode-csv"
              role="tab"
              aria-selected={mode === "csv"}
            >
              CSV 文件
            </Button>
            <Button
              type="button"
              variant={mode === "json" ? "default" : "outline"}
              onClick={() => setMode("json")}
              data-testid="users-import-mode-json"
              role="tab"
              aria-selected={mode === "json"}
            >
              JSON
            </Button>
          </div>

          {mode === "csv" ? (
            <div className="space-y-2">
              <Label htmlFor="csv-file">CSV 文件</Label>
              <input
                id="csv-file"
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => onSelectFile(e.target.files?.[0] ?? null)}
                data-testid="users-import-file"
                className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-input file:bg-background file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:bg-accent"
              />
              {file ? (
                <p className="text-xs text-muted-foreground">
                  已选择：{file.name}（{(file.size / 1024).toFixed(1)} KB）
                </p>
              ) : null}
              <details className="rounded-md border bg-muted/30 p-3 text-xs">
                <summary className="cursor-pointer font-medium">CSV 列示例</summary>
                <pre className="mt-2 overflow-x-auto whitespace-pre text-[11px] leading-5">
                  {`externalId,email,name,tags,userLevel,totalSpend,orderCount,lastOrderAt,locale
ext-001,alice@example.com,Alice,"vip,active",vip,1250.00,15,2026-05-12T00:00:00Z,zh
ext-002,bob@example.com,Bob,,,,0,,en`}
                </pre>
                <p className="mt-2 text-muted-foreground">
                  <code>locale</code> 可选值：<code>zh</code>、<code>en</code>，留空表示未指定（沿用模板默认语言）。无效值会按行返回错误明细，但不会中断整体导入。
                </p>
              </details>
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="json-text">JSON 内容</Label>
              <Textarea
                id="json-text"
                value={jsonText}
                onChange={(e) => setJsonText(e.target.value)}
                rows={12}
                placeholder='[{"email":"alice@example.com","name":"Alice","tags":["vip"],"locale":"zh"}]'
                data-testid="users-import-json"
                className="font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">
                可直接传入数组，或包装为 <code>{`{ "users": [...] }`}</code>。可附带 <code>locale</code> 字段（<code>zh</code>/<code>en</code>），不传或传 <code>null</code> 表示未指定。
              </p>
            </div>
          )}

          <div className="flex justify-end gap-2 border-t pt-4">
            <Button
              type="button"
              onClick={onSubmit}
              disabled={submitting || (mode === "csv" ? !file : jsonText.trim().length === 0)}
              data-testid="users-import-submit"
            >
              {submitting ? "导入中..." : "开始导入"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {result ? (
        <Card>
          <CardHeader>
            <CardTitle>导入结果</CardTitle>
            <CardDescription>
              共解析行数 ≈ {result.created + result.updated + result.skipped + result.errors.length}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <SummaryStat label="创建" value={result.created} testId="users-import-created" />
              <SummaryStat label="更新" value={result.updated} testId="users-import-updated" />
              <SummaryStat label="跳过" value={result.skipped} testId="users-import-skipped" />
              <SummaryStat
                label="错误"
                value={result.errors.length}
                testId="users-import-errors"
                tone={result.errors.length > 0 ? "danger" : "default"}
              />
            </div>

            {result.errors.length > 0 ? (
              <div className="rounded-md border">
                <div className="border-b bg-muted/40 px-3 py-2 text-sm font-medium">
                  错误明细（前 {Math.min(result.errors.length, 100)} 条）
                </div>
                <ul
                  className="max-h-72 divide-y overflow-y-auto text-xs"
                  data-testid="users-import-error-list"
                >
                  {result.errors.slice(0, 100).map((err, i) => (
                    <li
                      key={`${err.row}-${i}`}
                      className="flex flex-wrap gap-2 px-3 py-2"
                    >
                      <span className="font-mono text-muted-foreground">
                        第 {err.row} 行
                      </span>
                      {err.email ? (
                        <span className="font-mono">{err.email}</span>
                      ) : null}
                      <span className="text-destructive">{err.reason}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="flex justify-end gap-2">
              <Link
                href="/users"
                className="inline-flex h-9 items-center justify-center rounded-md border border-input bg-background px-4 text-sm font-medium shadow-sm hover:bg-accent hover:text-accent-foreground"
                data-testid="users-import-view-list"
              >
                查看用户列表
              </Link>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </section>
  );
}

function SummaryStat({
  label,
  value,
  testId,
  tone = "default",
}: {
  label: string;
  value: number;
  testId?: string;
  tone?: "default" | "danger";
}) {
  return (
    <div
      className={`rounded-md border p-3 ${tone === "danger" && value > 0 ? "border-destructive/40 bg-destructive/5" : ""
        }`}
      data-testid={testId}
    >
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={`mt-1 text-2xl font-semibold ${tone === "danger" && value > 0 ? "text-destructive" : ""
          }`}
      >
        {value}
      </div>
    </div>
  );
}
