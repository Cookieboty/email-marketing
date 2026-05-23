export const swrKeys = {
  users: (params?: Record<string, string | number | undefined>) => {
    if (!params) return "/api/users";
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === "") continue;
      sp.set(k, String(v));
    }
    const qs = sp.toString();
    return qs ? `/api/users?${qs}` : "/api/users";
  },
  user: (id: string) => `/api/users/${id}`,
  tags: () => "/api/tags",
  tagUsers: (id: string) => `/api/tags/${id}/users`,
  templates: (params?: Record<string, string | number | undefined>) => {
    if (!params) return "/api/templates";
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === "") continue;
      sp.set(k, String(v));
    }
    const qs = sp.toString();
    return qs ? `/api/templates?${qs}` : "/api/templates";
  },
  template: (id: string) => `/api/templates/${id}`,
  templateBlocks: () => "/api/template-blocks",
  media: (params?: Record<string, string | number | undefined>) => {
    if (!params) return "/api/media";
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === "") continue;
      sp.set(k, String(v));
    }
    const qs = sp.toString();
    return qs ? `/api/media?${qs}` : "/api/media";
  },
  segments: (params?: Record<string, string | number | undefined>) => {
    if (!params) return "/api/segments";
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === "") continue;
      sp.set(k, String(v));
    }
    const qs = sp.toString();
    return qs ? `/api/segments?${qs}` : "/api/segments";
  },
  segment: (id: string) => `/api/segments/${id}`,
  segmentUsers: (id: string, limit?: number) =>
    limit ? `/api/segments/${id}/users?limit=${limit}` : `/api/segments/${id}/users`,
  subscriptionCategories: (params?: Record<string, string | number | undefined>) => {
    if (!params) return "/api/subscription-categories";
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === "") continue;
      sp.set(k, String(v));
    }
    const qs = sp.toString();
    return qs ? `/api/subscription-categories?${qs}` : "/api/subscription-categories";
  },
  subscriptionCategory: (id: string) => `/api/subscription-categories/${id}`,
  userSubscriptions: (userId: string) => `/api/users/${userId}/subscriptions`,
  campaigns: (params?: Record<string, string | number | undefined>) => {
    if (!params) return "/api/campaigns";
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === "") continue;
      sp.set(k, String(v));
    }
    const qs = sp.toString();
    return qs ? `/api/campaigns?${qs}` : "/api/campaigns";
  },
  campaign: (id: string) => `/api/campaigns/${id}`,
  campaignRecipients: (id: string, params?: Record<string, string | number | undefined>) => {
    const base = `/api/campaigns/${id}/recipients`;
    if (!params) return base;
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === "") continue;
      sp.set(k, String(v));
    }
    const qs = sp.toString();
    return qs ? `${base}?${qs}` : base;
  },
  auditLog: (params?: Record<string, string | number | undefined>) => {
    if (!params) return "/api/audit-log";
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === "") continue;
      sp.set(k, String(v));
    }
    const qs = sp.toString();
    return qs ? `/api/audit-log?${qs}` : "/api/audit-log";
  },
  domainStats: (params?: Record<string, string | number | undefined>) => {
    if (!params) return "/api/domain-stats";
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === "") continue;
      sp.set(k, String(v));
    }
    const qs = sp.toString();
    return qs ? `/api/domain-stats?${qs}` : "/api/domain-stats";
  },
  deliverabilityAlerts: (params?: Record<string, string | number | undefined>) => {
    if (!params) return "/api/deliverability-alerts";
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === "") continue;
      sp.set(k, String(v));
    }
    const qs = sp.toString();
    return qs ? `/api/deliverability-alerts?${qs}` : "/api/deliverability-alerts";
  },
  automations: (params?: Record<string, string | number | undefined>) => {
    if (!params) return "/api/automations";
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === "") continue;
      sp.set(k, String(v));
    }
    const qs = sp.toString();
    return qs ? `/api/automations?${qs}` : "/api/automations";
  },
  apiClients: (params?: Record<string, string | number | undefined>) => {
    if (!params) return "/api/api-clients";
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === "") continue;
      sp.set(k, String(v));
    }
    const qs = sp.toString();
    return qs ? `/api/api-clients?${qs}` : "/api/api-clients";
  },
  apiClient: (id: string) => `/api/api-clients/${id}`,
  smtpConfigs: (params?: Record<string, string | number | undefined>) => {
    if (!params) return "/api/smtp-configs";
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === "") continue;
      sp.set(k, String(v));
    }
    const qs = sp.toString();
    return qs ? `/api/smtp-configs?${qs}` : "/api/smtp-configs";
  },
  smtpConfig: (id: string) => `/api/smtp-configs/${id}`,
  mailProviderSetting: () => "/api/smtp-configs/activate",
  importSources: () => "/api/import-sources",
  importSource: (id: string) => `/api/import-sources/${id}`,
  importJobs: (
    sourceId: string,
    params?: Record<string, string | number | undefined>,
  ) => {
    const base = `/api/import-sources/${sourceId}/jobs`;
    if (!params) return base;
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === "") continue;
      sp.set(k, String(v));
    }
    const qs = sp.toString();
    return qs ? `${base}?${qs}` : base;
  },
};
