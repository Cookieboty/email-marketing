"use client";

import useSWR from "swr";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { swrFetcher } from "@/lib/api-client";
import { swrKeys } from "@/lib/swr-keys";

interface ListResp {
  total: number;
}

interface DomainStatItem {
  id: string;
  domain: string;
  totalSent: number;
  bounceRate: number;
  complaintRate: number;
}

interface DomainStatsResp {
  data: DomainStatItem[];
  total: number;
}

function StatCard({
  title,
  value,
  loading,
  testId,
}: {
  title: string;
  value: string | number;
  loading: boolean;
  testId: string;
}) {
  return (
    <Card data-testid={testId}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-8 w-20" />
        ) : (
          <div className="text-2xl font-bold">{value}</div>
        )}
      </CardContent>
    </Card>
  );
}

export default function DashboardHomePage() {
  const { data: sending, isLoading: loadingSending } = useSWR<ListResp>(
    swrKeys.campaigns({ status: "SENDING", pageSize: 1 }),
    swrFetcher,
  );
  const { data: all, isLoading: loadingAll } = useSWR<ListResp>(
    swrKeys.campaigns({ pageSize: 1 }),
    swrFetcher,
  );
  const { data: alerts, isLoading: loadingAlerts } = useSWR<ListResp>(
    swrKeys.deliverabilityAlerts({ resolved: "false", pageSize: 1 }),
    swrFetcher,
  );
  const { data: domains, isLoading: loadingDomains } = useSWR<DomainStatsResp>(
    swrKeys.domainStats({ pageSize: 5, sortBy: "totalSent", sortDir: "desc" }),
    swrFetcher,
  );

  return (
    <section data-testid="dashboard-home" className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">控制台</h1>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          title="发送中活动"
          value={sending?.total ?? 0}
          loading={loadingSending}
          testId="stat-sending"
        />
        <StatCard
          title="总活动数"
          value={all?.total ?? 0}
          loading={loadingAll}
          testId="stat-total"
        />
        <StatCard
          title="未解决告警"
          value={alerts?.total ?? 0}
          loading={loadingAlerts}
          testId="stat-alerts"
        />
      </div>

      <div className="space-y-3">
        <h2 className="text-lg font-medium">域名发送统计（Top 5）</h2>
        {loadingDomains ? (
          <div className="space-y-2" data-testid="domains-loading">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : !domains?.data.length ? (
          <div
            className="flex h-24 items-center justify-center rounded-md border bg-muted/20 text-sm text-muted-foreground"
            data-testid="domains-empty"
          >
            暂无域名统计数据
          </div>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm" data-testid="domains-table">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-4 py-2 text-left font-medium">域名</th>
                  <th className="px-4 py-2 text-right font-medium">总发送</th>
                  <th className="px-4 py-2 text-right font-medium">退信率</th>
                  <th className="px-4 py-2 text-right font-medium">投诉率</th>
                </tr>
              </thead>
              <tbody>
                {domains.data.map((d) => (
                  <tr key={d.id} className="border-b last:border-0">
                    <td className="px-4 py-2">{d.domain}</td>
                    <td className="px-4 py-2 text-right">{d.totalSent.toLocaleString()}</td>
                    <td className="px-4 py-2 text-right">{(d.bounceRate * 100).toFixed(2)}%</td>
                    <td className="px-4 py-2 text-right">{(d.complaintRate * 100).toFixed(2)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
