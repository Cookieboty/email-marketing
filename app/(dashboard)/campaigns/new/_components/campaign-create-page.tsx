"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { apiPost, swrFetcher } from "@/lib/api-client";
import {
  LOCALE_LABELS,
  TEMPLATE_LOCALES,
  type Locale,
} from "@/app/(dashboard)/templates/_components/types";
import {
  buildCampaignPayload,
  forcedLocaleOptions,
  summarizeCoverageWarnings,
  type CampaignFormState,
  type LocaleStrategy,
  type TemplateOption,
  type VariantInput,
  type VariantLocaleContent,
} from "./campaign-multilingual-helpers";

interface SegmentOption {
  id: string;
  name: string;
}

interface LocaleCoverageResponse {
  totalRecipients: number;
  countsByUserLocale: Record<Locale | "null", number>;
  countsByResolvedLocale: Record<Locale, number>;
  fallbackCount: number;
  variantMissingLocaleWarningCount: number;
}

const STEPS = ["基本信息", "语言策略", "收件人", "发送选项", "预览"] as const;

function asMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return "操作失败";
}

function emptyVariantLocale(): VariantLocaleContent {
  return { subject: "", htmlContent: "", textContent: "" };
}

function makeInitialVariant(name: string, samplePercentage: number): VariantInput {
  return {
    variantName: name,
    samplePercentage,
    locales: { zh: emptyVariantLocale() },
  };
}

const INITIAL: CampaignFormState = {
  name: "",
  templateId: "",
  subjects: {},
  localeStrategy: "AUTO",
  forcedLocale: "",
  fromEmail: "",
  replyTo: "",
  sendingChannelId: "",
  tagFilter: "",
  tagFilterMode: "ANY",
  segmentId: "",
  subscriptionCategory: "",
  isAbTest: false,
  variants: [makeInitialVariant("A", 25), makeInitialVariant("B", 25)],
  utmSource: "",
  utmMedium: "email",
  utmCampaign: "",
  abTestConfig: {
    winnerMetric: "open",
    testDurationHours: 4,
    autoSendWinner: true,
    confidenceLevel: 0.95,
  },
};

export default function CampaignCreatePage() {
  const router = useRouter();
  const { toast } = useToast();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<CampaignFormState>(INITIAL);
  const [submitting, setSubmitting] = useState(false);
  const [pendingCampaignId, setPendingCampaignId] = useState<string | null>(null);
  const [coverage, setCoverage] = useState<LocaleCoverageResponse | null>(null);
  const [coverageOpen, setCoverageOpen] = useState(false);

  const { data: templates } = useSWR<{ data: TemplateOption[] }>(
    "/api/templates?pageSize=100",
    swrFetcher,
  );
  const { data: segments } = useSWR<{ data: SegmentOption[] }>(
    "/api/segments?pageSize=100",
    swrFetcher,
  );
  const { data: channelsData } = useSWR<{ data: Array<{ id: string; name: string; providerType: string; fromEmail: string; status: string }> }>(
    "/api/sending-channels",
    swrFetcher,
  );
  const activeChannels = useMemo(
    () => channelsData?.data?.filter((c) => c.status === "ACTIVE") ?? [],
    [channelsData],
  );

  const selectedTemplate = useMemo<TemplateOption | null>(() => {
    if (!form.templateId) return null;
    return templates?.data.find((t) => t.id === form.templateId) ?? null;
  }, [templates, form.templateId]);

  const availableLocales = useMemo<Locale[]>(
    () => forcedLocaleOptions(selectedTemplate),
    [selectedTemplate],
  );

  useEffect(() => {
    if (form.localeStrategy === "FORCE") {
      if (
        form.forcedLocale &&
        !availableLocales.includes(form.forcedLocale as Locale)
      ) {
        setForm((prev) => ({ ...prev, forcedLocale: availableLocales[0] ?? "" }));
      }
    }
  }, [availableLocales, form.localeStrategy, form.forcedLocale]);

  function upd(patch: Partial<CampaignFormState>) {
    setForm((prev) => ({ ...prev, ...patch }));
  }

  function updateSubject(locale: Locale, value: string) {
    setForm((prev) => ({
      ...prev,
      subjects: { ...prev.subjects, [locale]: value },
    }));
  }

  function updateVariant(idx: number, patch: Partial<VariantInput>) {
    setForm((prev) => ({
      ...prev,
      variants: prev.variants.map((v, i) =>
        i === idx ? { ...v, ...patch } : v,
      ),
    }));
  }

  function updateVariantLocale(
    idx: number,
    locale: Locale,
    patch: Partial<VariantLocaleContent>,
  ) {
    setForm((prev) => ({
      ...prev,
      variants: prev.variants.map((v, i) => {
        if (i !== idx) return v;
        const current = v.locales[locale] ?? emptyVariantLocale();
        return {
          ...v,
          locales: { ...v.locales, [locale]: { ...current, ...patch } },
        };
      }),
    }));
  }

  function addVariantLocale(idx: number, locale: Locale) {
    setForm((prev) => ({
      ...prev,
      variants: prev.variants.map((v, i) => {
        if (i !== idx) return v;
        if (v.locales[locale]) return v;
        return {
          ...v,
          locales: { ...v.locales, [locale]: emptyVariantLocale() },
        };
      }),
    }));
  }

  function removeVariantLocale(idx: number, locale: Locale) {
    setForm((prev) => ({
      ...prev,
      variants: prev.variants.map((v, i) => {
        if (i !== idx) return v;
        const next = { ...v.locales };
        delete next[locale];
        return { ...v, locales: next };
      }),
    }));
  }

  function addVariant() {
    if (form.variants.length >= 5) return;
    const letter = String.fromCharCode(65 + form.variants.length);
    setForm((prev) => ({
      ...prev,
      variants: [...prev.variants, makeInitialVariant(letter, 10)],
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
    if (step === 1) {
      if (form.localeStrategy === "FORCE") {
        return (
          form.forcedLocale !== "" &&
          availableLocales.includes(form.forcedLocale as Locale)
        );
      }
      return true;
    }
    return true;
  }

  async function fetchCoverage(id: string): Promise<LocaleCoverageResponse> {
    const res = await fetch(`/api/campaigns/${id}/locale-coverage`, {
      method: "GET",
      credentials: "include",
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || "获取语言覆盖失败");
    }
    return (await res.json()) as LocaleCoverageResponse;
  }

  async function handleSubmit() {
    setSubmitting(true);
    try {
      const { payload, errors } = buildCampaignPayload(form, selectedTemplate);
      if (!payload) {
        toast({
          title: "请检查表单",
          description: errors[0]?.message ?? "存在校验错误",
          variant: "destructive",
        });
        return;
      }

      const result = await apiPost<{ id: string }>("/api/campaigns", payload);
      toast({ title: "活动已创建" });

      try {
        const cov = await fetchCoverage(result.id);
        const warnings = summarizeCoverageWarnings({
          localeStrategy: form.localeStrategy,
          fallbackCount: cov.fallbackCount,
          variantMissingLocaleWarningCount: cov.variantMissingLocaleWarningCount,
        });
        if (warnings.length > 0) {
          setCoverage(cov);
          setPendingCampaignId(result.id);
          setCoverageOpen(true);
          return;
        }
      } catch (covErr) {
        console.warn("locale coverage fetch failed", covErr);
      }
      router.push(`/campaigns/${result.id}`);
    } catch (e) {
      toast({
        title: "创建失败",
        description: asMessage(e),
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  }

  function confirmCoverage() {
    setCoverageOpen(false);
    if (pendingCampaignId) {
      router.push(`/campaigns/${pendingCampaignId}`);
    }
  }

  return (
    <section className="mx-auto max-w-3xl space-y-6">
      <h1
        className="text-2xl font-semibold tracking-tight"
        data-testid="campaign-create-heading"
      >
        新建活动
      </h1>

      <div className="flex flex-wrap gap-2" data-testid="campaign-create-steps">
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
                  <option key={t.id} value={t.id}>
                    {t.name}（{t.availableLocales
                      .map((loc) => LOCALE_LABELS[loc])
                      .join(" / ")}）
                  </option>
                ))}
              </Select>
              {selectedTemplate ? (
                <p
                  className="text-xs text-muted-foreground"
                  data-testid="template-locale-summary"
                >
                  默认语言：{LOCALE_LABELS[selectedTemplate.defaultLocale]} ·
                  可用语言：
                  {selectedTemplate.availableLocales
                    .map((loc) => LOCALE_LABELS[loc])
                    .join(" / ")}
                </p>
              ) : null}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5 sm:col-span-2">
                <Label>发件通道 *</Label>
                <Select
                  value={form.sendingChannelId}
                  onChange={(e) => upd({ sendingChannelId: e.target.value })}
                  data-testid="select-channel"
                >
                  <option value="">请选择发件通道</option>
                  {activeChannels.map((ch) => (
                    <option key={ch.id} value={ch.id}>
                      {ch.name} ({ch.providerType} - {ch.fromEmail})
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>发件人邮箱</Label>
                <Input
                  value={form.fromEmail}
                  onChange={(e) => upd({ fromEmail: e.target.value })}
                  placeholder="留空使用通道默认"
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
          <div className="space-y-5" data-testid="step-locale">
            <div className="space-y-2">
              <Label>语言策略 *</Label>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="locale-strategy"
                    value="AUTO"
                    checked={form.localeStrategy === "AUTO"}
                    onChange={() =>
                      upd({ localeStrategy: "AUTO", forcedLocale: "" })
                    }
                    data-testid="radio-strategy-auto"
                  />
                  按收件人语言自动选择 (AUTO)
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="locale-strategy"
                    value="FORCE"
                    checked={form.localeStrategy === "FORCE"}
                    onChange={() =>
                      upd({
                        localeStrategy: "FORCE" as LocaleStrategy,
                        forcedLocale:
                          (form.forcedLocale as Locale | "") ||
                          availableLocales[0] ||
                          "",
                      })
                    }
                    data-testid="radio-strategy-force"
                  />
                  强制使用指定语言 (FORCE)
                </label>
              </div>
              <p className="text-xs text-muted-foreground">
                AUTO：按 User.locale → Campaign.forcedLocale →
                Template.defaultLocale 顺序解析；FORCE：所有收件人使用同一语言。
              </p>
            </div>

            {form.localeStrategy === "FORCE" && (
              <div className="space-y-1.5">
                <Label>强制语言 *</Label>
                <Select
                  value={form.forcedLocale}
                  onChange={(e) =>
                    upd({ forcedLocale: e.target.value as Locale | "" })
                  }
                  data-testid="select-forced-locale"
                >
                  <option value="">选择语言</option>
                  {availableLocales.map((loc) => (
                    <option key={loc} value={loc}>
                      {LOCALE_LABELS[loc]}
                    </option>
                  ))}
                </Select>
                {availableLocales.length === 0 && (
                  <p className="text-xs text-destructive">
                    模板没有可用语言，无法启用强制策略。
                  </p>
                )}
              </div>
            )}

            <div className="space-y-2">
              <Label>主题覆盖（可选）</Label>
              <p className="text-xs text-muted-foreground">
                留空则使用模板对应语言的主题。
              </p>
              <div className="space-y-2">
                {(form.localeStrategy === "FORCE" && form.forcedLocale
                  ? [form.forcedLocale as Locale]
                  : availableLocales
                ).map((loc) => (
                  <div
                    key={loc}
                    className="space-y-1"
                    data-testid={`subject-override-${loc}`}
                  >
                    <Label className="text-xs text-muted-foreground">
                      {LOCALE_LABELS[loc]} 主题
                    </Label>
                    <Input
                      value={form.subjects[loc] ?? ""}
                      onChange={(e) => updateSubject(loc, e.target.value)}
                      placeholder={`${LOCALE_LABELS[loc]} subject override`}
                      data-testid={`input-subject-${loc}`}
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {step === 2 && (
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
                onChange={(e) =>
                  upd({ tagFilterMode: e.target.value as "ANY" | "ALL" })
                }
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
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
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

        {step === 3 && (
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
                    <Label>胜出指标</Label>
                    <Select
                      value={form.abTestConfig.winnerMetric}
                      onChange={(e) =>
                        upd({
                          abTestConfig: {
                            ...form.abTestConfig,
                            winnerMetric: e.target.value as
                              | "open"
                              | "click"
                              | "conversion",
                          },
                        })
                      }
                    >
                      <option value="open">打开率</option>
                      <option value="click">点击率</option>
                      <option value="conversion">转化率</option>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>测试时长（小时）</Label>
                    <Input
                      type="number"
                      min={1}
                      max={168}
                      value={form.abTestConfig.testDurationHours}
                      onChange={(e) =>
                        upd({
                          abTestConfig: {
                            ...form.abTestConfig,
                            testDurationHours: Number(e.target.value),
                          },
                        })
                      }
                    />
                  </div>
                  <div className="flex items-end gap-2 pb-0.5">
                    <input
                      type="checkbox"
                      id="auto-send"
                      checked={form.abTestConfig.autoSendWinner}
                      onChange={(e) =>
                        upd({
                          abTestConfig: {
                            ...form.abTestConfig,
                            autoSendWinner: e.target.checked,
                          },
                        })
                      }
                      className="h-4 w-4 rounded border-gray-300"
                    />
                    <Label htmlFor="auto-send">自动发送胜出版本</Label>
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">变体</span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={addVariant}
                      disabled={form.variants.length >= 5}
                    >
                      添加变体
                    </Button>
                  </div>
                  {form.variants.map((v, i) => {
                    const presentLocales = TEMPLATE_LOCALES.filter(
                      (loc) =>
                        v.locales[loc] !== undefined &&
                        availableLocales.includes(loc),
                    );
                    const missingLocales = availableLocales.filter(
                      (loc) => v.locales[loc] === undefined,
                    );
                    return (
                      <div
                        key={i}
                        className="space-y-2 rounded-md border p-3"
                        data-testid={`variant-card-${i}`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium">
                            变体 {v.variantName}
                          </span>
                          {form.variants.length > 2 && (
                            <Button
                              type="button"
                              variant="destructive"
                              size="sm"
                              onClick={() => removeVariant(i)}
                            >
                              移除
                            </Button>
                          )}
                        </div>
                        <div className="grid gap-3 sm:grid-cols-2">
                          <div className="space-y-1.5">
                            <Label>变体名称</Label>
                            <Input
                              value={v.variantName}
                              onChange={(e) =>
                                updateVariant(i, {
                                  variantName: e.target.value,
                                })
                              }
                            />
                          </div>
                          <div className="space-y-1.5">
                            <Label>样本比例 (%)</Label>
                            <Input
                              type="number"
                              min={1}
                              max={50}
                              value={v.samplePercentage}
                              onChange={(e) =>
                                updateVariant(i, {
                                  samplePercentage: Number(e.target.value),
                                })
                              }
                            />
                          </div>
                        </div>

                        <div className="space-y-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs text-muted-foreground">
                              语言：
                            </span>
                            {presentLocales.map((loc) => (
                              <span
                                key={loc}
                                className="inline-flex items-center gap-1 rounded-md border bg-muted px-2 py-0.5 text-xs"
                              >
                                {LOCALE_LABELS[loc]}
                                {presentLocales.length > 1 && (
                                  <button
                                    type="button"
                                    aria-label={`移除 ${LOCALE_LABELS[loc]}`}
                                    className="text-muted-foreground hover:text-destructive"
                                    onClick={() =>
                                      removeVariantLocale(i, loc)
                                    }
                                    data-testid={`variant-${i}-remove-${loc}`}
                                  >
                                    ×
                                  </button>
                                )}
                              </span>
                            ))}
                            {missingLocales.map((loc) => (
                              <Button
                                key={loc}
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="text-xs"
                                onClick={() => addVariantLocale(i, loc)}
                                data-testid={`variant-${i}-add-${loc}`}
                              >
                                + {LOCALE_LABELS[loc]}
                              </Button>
                            ))}
                          </div>

                          {presentLocales.map((loc) => {
                            const content =
                              v.locales[loc] ?? emptyVariantLocale();
                            return (
                              <div
                                key={loc}
                                className="space-y-2 rounded border bg-muted/20 p-2"
                                data-testid={`variant-${i}-locale-${loc}`}
                              >
                                <div className="text-xs font-medium text-muted-foreground">
                                  {LOCALE_LABELS[loc]}
                                </div>
                                <div className="space-y-1.5">
                                  <Label>主题</Label>
                                  <Input
                                    value={content.subject}
                                    onChange={(e) =>
                                      updateVariantLocale(i, loc, {
                                        subject: e.target.value,
                                      })
                                    }
                                  />
                                </div>
                                <div className="space-y-1.5">
                                  <Label>HTML 内容</Label>
                                  <Textarea
                                    value={content.htmlContent}
                                    onChange={(e) =>
                                      updateVariantLocale(i, loc, {
                                        htmlContent: e.target.value,
                                      })
                                    }
                                    rows={4}
                                  />
                                </div>
                                <div className="space-y-1.5">
                                  <Label>纯文本内容（可选）</Label>
                                  <Textarea
                                    value={content.textContent}
                                    onChange={(e) =>
                                      updateVariantLocale(i, loc, {
                                        textContent: e.target.value,
                                      })
                                    }
                                    rows={2}
                                  />
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
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

        {step === 4 && (
          <div className="space-y-4" data-testid="step-preview">
            <h2 className="text-lg font-medium">确认信息</h2>
            <dl className="space-y-2 text-sm">
              <div className="flex gap-2">
                <dt className="w-28 shrink-0 text-muted-foreground">名称</dt>
                <dd>{form.name}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-28 shrink-0 text-muted-foreground">模板</dt>
                <dd>{selectedTemplate?.name ?? form.templateId}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-28 shrink-0 text-muted-foreground">语言策略</dt>
                <dd>
                  {form.localeStrategy === "AUTO"
                    ? "自动 (AUTO)"
                    : `强制 ${form.forcedLocale ? LOCALE_LABELS[form.forcedLocale as Locale] : ""}`}
                </dd>
              </div>
              {Object.entries(form.subjects).some(
                ([, val]) => val && val.trim().length > 0,
              ) && (
                <div className="flex gap-2">
                  <dt className="w-28 shrink-0 text-muted-foreground">
                    主题覆盖
                  </dt>
                  <dd>
                    {Object.entries(form.subjects)
                      .filter(([, val]) => val && val.trim().length > 0)
                      .map(
                        ([loc, val]) =>
                          `${LOCALE_LABELS[loc as Locale]}: ${val}`,
                      )
                      .join("； ")}
                  </dd>
                </div>
              )}
              {form.fromEmail && (
                <div className="flex gap-2">
                  <dt className="w-28 shrink-0 text-muted-foreground">发件人</dt>
                  <dd>{form.fromEmail}</dd>
                </div>
              )}
              {form.tagFilter && (
                <div className="flex gap-2">
                  <dt className="w-28 shrink-0 text-muted-foreground">标签</dt>
                  <dd>
                    {form.tagFilter} ({form.tagFilterMode})
                  </dd>
                </div>
              )}
              {form.segmentId && (
                <div className="flex gap-2">
                  <dt className="w-28 shrink-0 text-muted-foreground">分群</dt>
                  <dd>
                    {segments?.data.find((s) => s.id === form.segmentId)?.name ??
                      form.segmentId}
                  </dd>
                </div>
              )}
              {form.isAbTest && (
                <div className="flex gap-2">
                  <dt className="w-28 shrink-0 text-muted-foreground">A/B 测试</dt>
                  <dd>
                    {form.variants.length} 个变体，胜出指标：
                    {form.abTestConfig.winnerMetric}
                  </dd>
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
        {step < STEPS.length - 1 ? (
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

      <Dialog open={coverageOpen} onOpenChange={setCoverageOpen}>
        <DialogContent data-testid="coverage-dialog">
          <DialogHeader>
            <DialogTitle>语言覆盖提示</DialogTitle>
          </DialogHeader>
          {coverage ? (
            <div className="space-y-3 text-sm">
              <p>
                收件人合计：
                <span className="font-medium">{coverage.totalRecipients}</span>
              </p>
              {form.localeStrategy === "AUTO" && coverage.fallbackCount > 0 && (
                <p data-testid="coverage-fallback">
                  有 <span className="font-medium">{coverage.fallbackCount}</span>
                  位收件人因模板未提供其首选语言，将回退到模板默认语言。
                </p>
              )}
              {coverage.variantMissingLocaleWarningCount > 0 && (
                <p data-testid="coverage-variant-missing">
                  存在 {coverage.variantMissingLocaleWarningCount}
                  处变体语言缺失，这些收件人将收到主模板内容，但仍计入对应变体的分析数据。
                </p>
              )}
              <p className="text-muted-foreground">
                确认后将进入活动详情页，可在排程前继续调整。
              </p>
            </div>
          ) : null}
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => setCoverageOpen(false)}
              data-testid="coverage-cancel"
            >
              留在表单
            </Button>
            <Button onClick={confirmCoverage} data-testid="coverage-confirm">
              我已了解，前往详情
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
