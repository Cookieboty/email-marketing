"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { apiPost, swrFetcher } from "@/lib/api-client";

interface TemplateOption {
  id: string;
  name: string;
  subject: string;
}

interface SegmentOption {
  id: string;
  name: string;
}

interface VariantInput {
  variantName: string;
  subject: string;
  htmlContent: string;
  samplePercentage: number;
}

interface FormData {
  name: string;
  templateId: string;
  subject: string;
  fromEmail: string;
  replyTo: string;
  tagFilter: string;
  tagFilterMode: "ANY" | "ALL";
  segmentId: string;
  subscriptionCategory: string;
  isAbTest: boolean;
  variants: VariantInput[];
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  winnerCriteria: "OPEN_RATE" | "CLICK_RATE";
  waitHours: number;
  autoSend: boolean;
}

const INITIAL: FormData = {
  name: "",
  templateId: "",
  subject: "",
  fromEmail: "",
  replyTo: "",
  tagFilter: "",
  tagFilterMode: "ANY",
  segmentId: "",
  subscriptionCategory: "",
  isAbTest: false,
  variants: [
    { variantName: "A", subject: "", htmlContent: "", samplePercentage: 25 },
    { variantName: "B", subject: "", htmlContent: "", samplePercentage: 25 },
  ],
  utmSource: "",
  utmMedium: "email",
  utmCampaign: "",
  winnerCriteria: "OPEN_RATE",
  waitHours: 4,
  autoSend: true,
};

const STEPS = ["基本信息", "收件人", "发送选项", "预览"] as const;

function asMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return "操作失败";
}

export default function CampaignCreatePage() {
  const router = useRouter();
  const { toast } = useToast();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<FormData>(INITIAL);
  const [submitting, setSubmitting] = useState(false);

  const { data: templates } = useSWR<{ data: TemplateOption[] }>(
    "/api/templates?pageSize=100",
    swrFetcher,
  );
  const { data: segments } = useSWR<{ data: SegmentOption[] }>(
    "/api/segments?pageSize=100",
    swrFetcher,
  );

  function upd(patch: Partial<FormData>) {
    setForm((prev) => ({ ...prev, ...patch }));
  }

  function updateVariant(idx: number, patch: Partial<VariantInput>) {
    setForm((prev) => ({
      ...prev,
      variants: prev.variants.map((v, i) => (i === idx ? { ...v, ...patch } : v)),
    }));
  }

  function addVariant() {
    if (form.variants.length >= 5) return;
    const letter = String.fromCharCode(65 + form.variants.length);
    setForm((prev) => ({
      ...prev,
      variants: [...prev.variants, { variantName: letter, subject: "", htmlContent: "", samplePercentage: 10 }],
    }));
  }

  function removeVariant(idx: number) {
    if (form.variants.length <= 2) return;
    setForm((prev) => ({
      ...prev,
      variants: prev.variants.filter((_, i) => i !== idx),
    }));
  }

  function canNext(): boolean {
    if (step === 0) return form.name.trim() !== "" && form.templateId !== "";
    return true;
  }

  async function handleSubmit() {
    setSubmitting(true);
    try {
      const tags = form.tagFilter
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);

      const utmParams: Record<string, string> = {};
      if (form.utmSource) utmParams.utm_source = form.utmSource;
      if (form.utmMedium) utmParams.utm_medium = form.utmMedium;
      if (form.utmCampaign) utmParams.utm_campaign = form.utmCampaign;

      const payload: Record<string, unknown> = {
        name: form.name.trim(),
        templateId: form.templateId,
      };
      if (form.subject) payload.subject = form.subject;
      if (form.fromEmail) payload.fromEmail = form.fromEmail;
      if (form.replyTo) payload.replyTo = form.replyTo;
      if (tags.length > 0) {
        payload.tagFilter = tags;
        payload.tagFilterMode = form.tagFilterMode;
      }
      if (form.segmentId) payload.segmentId = form.segmentId;
      if (form.subscriptionCategory) payload.subscriptionCategory = form.subscriptionCategory;
      if (Object.keys(utmParams).length > 0) payload.utmParams = utmParams;

      payload.isAbTest = form.isAbTest;
      if (form.isAbTest) {
        payload.variants = form.variants.map((v) => ({
          variantName: v.variantName,
          subject: v.subject,
          htmlContent: v.htmlContent,
          samplePercentage: v.samplePercentage,
        }));
        payload.abTestConfig = {
          winnerCriteria: form.winnerCriteria,
          waitHours: form.waitHours,
          autoSend: form.autoSend,
        };
      }

      const result = await apiPost<{ id: string }>("/api/campaigns", payload);
      toast({ title: "活动已创建" });
      router.push(`/campaigns/${result.id}`);
    } catch (e) {
      toast({ title: "创建失败", description: asMessage(e), variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight" data-testid="campaign-create-heading">
        新建活动
      </h1>

      <div className="flex gap-2" data-testid="campaign-create-steps">
        {STEPS.map((s, i) => (
          <div
            key={s}
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              i === step
                ? "bg-primary text-primary-foreground"
                : i < step
                  ? "bg-primary/20 text-primary"
                  : "bg-muted text-muted-foreground"
            }`}
          >
            {i + 1}. {s}
          </div>
        ))}
      </div>

      <div className="rounded-md border bg-card p-6">
        {step === 0 && (
          <div className="space-y-4" data-testid="step-basic">
            <div className="space-y-1.5">
              <Label>活动名称 *</Label>
              <Input
                value={form.name}
                onChange={(e) => upd({ name: e.target.value })}
                placeholder="例如：五月促销"
                data-testid="input-name"
              />
            </div>
            <div className="space-y-1.5">
              <Label>模板 *</Label>
              <Select
                value={form.templateId}
                onChange={(e) => upd({ templateId: e.target.value })}
                data-testid="select-template"
              >
                <option value="">选择模板</option>
                {templates?.data.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>主题</Label>
              <Input
                value={form.subject}
                onChange={(e) => upd({ subject: e.target.value })}
                placeholder="留空则使用模板主题"
                data-testid="input-subject"
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>发件人邮箱</Label>
                <Input
                  value={form.fromEmail}
                  onChange={(e) => upd({ fromEmail: e.target.value })}
                  placeholder="留空使用默认"
                  data-testid="input-from"
                />
              </div>
              <div className="space-y-1.5">
                <Label>回复邮箱</Label>
                <Input
                  value={form.replyTo}
                  onChange={(e) => upd({ replyTo: e.target.value })}
                  placeholder="可选"
                  data-testid="input-reply-to"
                />
              </div>
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-4" data-testid="step-recipients">
            <div className="space-y-1.5">
              <Label>标签过滤</Label>
              <Input
                value={form.tagFilter}
                onChange={(e) => upd({ tagFilter: e.target.value })}
                placeholder="多个标签用逗号分隔"
                data-testid="input-tag-filter"
              />
            </div>
            <div className="space-y-1.5">
              <Label>标签匹配模式</Label>
              <Select
                value={form.tagFilterMode}
                onChange={(e) => upd({ tagFilterMode: e.target.value as "ANY" | "ALL" })}
                data-testid="select-tag-mode"
              >
                <option value="ANY">任意匹配 (ANY)</option>
                <option value="ALL">全部匹配 (ALL)</option>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>分群</Label>
              <Select
                value={form.segmentId}
                onChange={(e) => upd({ segmentId: e.target.value })}
                data-testid="select-segment"
              >
                <option value="">不限分群</option>
                {segments?.data.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>订阅分类</Label>
              <Input
                value={form.subscriptionCategory}
                onChange={(e) => upd({ subscriptionCategory: e.target.value })}
                placeholder="可选，如 marketing"
                data-testid="input-sub-category"
              />
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4" data-testid="step-options">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="is-ab-test"
                checked={form.isAbTest}
                onChange={(e) => upd({ isAbTest: e.target.checked })}
                className="h-4 w-4 rounded border-gray-300"
                data-testid="checkbox-ab-test"
              />
              <Label htmlFor="is-ab-test">启用 A/B 测试</Label>
            </div>

            {form.isAbTest && (
              <div className="space-y-4 rounded-md border p-4">
                <div className="grid gap-4 sm:grid-cols-3">
                  <div className="space-y-1.5">
                    <Label>胜出标准</Label>
                    <Select
                      value={form.winnerCriteria}
                      onChange={(e) => upd({ winnerCriteria: e.target.value as "OPEN_RATE" | "CLICK_RATE" })}
                    >
                      <option value="OPEN_RATE">打开率</option>
                      <option value="CLICK_RATE">点击率</option>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>等待小时数</Label>
                    <Input
                      type="number"
                      min={1}
                      max={48}
                      value={form.waitHours}
                      onChange={(e) => upd({ waitHours: Number(e.target.value) })}
                    />
                  </div>
                  <div className="flex items-end gap-2 pb-0.5">
                    <input
                      type="checkbox"
                      id="auto-send"
                      checked={form.autoSend}
                      onChange={(e) => upd({ autoSend: e.target.checked })}
                      className="h-4 w-4 rounded border-gray-300"
                    />
                    <Label htmlFor="auto-send">自动发送胜出版本</Label>
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">变体</span>
                    <Button type="button" variant="outline" size="sm" onClick={addVariant} disabled={form.variants.length >= 5}>
                      添加变体
                    </Button>
                  </div>
                  {form.variants.map((v, i) => (
                    <div key={i} className="space-y-2 rounded-md border p-3">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium">变体 {v.variantName}</span>
                        {form.variants.length > 2 && (
                          <Button type="button" variant="destructive" size="sm" onClick={() => removeVariant(i)}>
                            移除
                          </Button>
                        )}
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className="space-y-1.5">
                          <Label>变体名称</Label>
                          <Input value={v.variantName} onChange={(e) => updateVariant(i, { variantName: e.target.value })} />
                        </div>
                        <div className="space-y-1.5">
                          <Label>样本比例 (%)</Label>
                          <Input
                            type="number"
                            min={1}
                            max={50}
                            value={v.samplePercentage}
                            onChange={(e) => updateVariant(i, { samplePercentage: Number(e.target.value) })}
                          />
                        </div>
                      </div>
                      <div className="space-y-1.5">
                        <Label>主题</Label>
                        <Input value={v.subject} onChange={(e) => updateVariant(i, { subject: e.target.value })} />
                      </div>
                      <div className="space-y-1.5">
                        <Label>HTML 内容</Label>
                        <Textarea
                          value={v.htmlContent}
                          onChange={(e) => updateVariant(i, { htmlContent: e.target.value })}
                          rows={4}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="space-y-3">
              <span className="text-sm font-medium">UTM 参数</span>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <Label>utm_source</Label>
                  <Input
                    value={form.utmSource}
                    onChange={(e) => upd({ utmSource: e.target.value })}
                    placeholder="例如 newsletter"
                    data-testid="input-utm-source"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>utm_medium</Label>
                  <Input
                    value={form.utmMedium}
                    onChange={(e) => upd({ utmMedium: e.target.value })}
                    data-testid="input-utm-medium"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>utm_campaign</Label>
                  <Input
                    value={form.utmCampaign}
                    onChange={(e) => upd({ utmCampaign: e.target.value })}
                    placeholder="留空则使用活动名称"
                    data-testid="input-utm-campaign"
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4" data-testid="step-preview">
            <h2 className="text-lg font-medium">确认信息</h2>
            <dl className="space-y-2 text-sm">
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 text-muted-foreground">名称</dt>
                <dd>{form.name}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 text-muted-foreground">模板</dt>
                <dd>{templates?.data.find((t) => t.id === form.templateId)?.name ?? form.templateId}</dd>
              </div>
              {form.subject && (
                <div className="flex gap-2">
                  <dt className="w-24 shrink-0 text-muted-foreground">主题</dt>
                  <dd>{form.subject}</dd>
                </div>
              )}
              {form.fromEmail && (
                <div className="flex gap-2">
                  <dt className="w-24 shrink-0 text-muted-foreground">发件人</dt>
                  <dd>{form.fromEmail}</dd>
                </div>
              )}
              {form.tagFilter && (
                <div className="flex gap-2">
                  <dt className="w-24 shrink-0 text-muted-foreground">标签</dt>
                  <dd>{form.tagFilter} ({form.tagFilterMode})</dd>
                </div>
              )}
              {form.segmentId && (
                <div className="flex gap-2">
                  <dt className="w-24 shrink-0 text-muted-foreground">分群</dt>
                  <dd>{segments?.data.find((s) => s.id === form.segmentId)?.name ?? form.segmentId}</dd>
                </div>
              )}
              {form.isAbTest && (
                <div className="flex gap-2">
                  <dt className="w-24 shrink-0 text-muted-foreground">A/B 测试</dt>
                  <dd>{form.variants.length} 个变体，{form.winnerCriteria === "OPEN_RATE" ? "打开率" : "点击率"}胜出</dd>
                </div>
              )}
            </dl>
          </div>
        )}
      </div>

      <div className="flex justify-between">
        <Button
          variant="outline"
          disabled={step === 0}
          onClick={() => setStep((s) => s - 1)}
          data-testid="btn-prev"
        >
          上一步
        </Button>
        {step < 3 ? (
          <Button
            disabled={!canNext()}
            onClick={() => setStep((s) => s + 1)}
            data-testid="btn-next"
          >
            下一步
          </Button>
        ) : (
          <Button
            disabled={submitting}
            onClick={() => void handleSubmit()}
            data-testid="btn-create"
          >
            {submitting ? "创建中..." : "创建活动"}
          </Button>
        )}
      </div>
    </section>
  );
}
