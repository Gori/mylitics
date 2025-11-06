"use client";

import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useApp } from "@/app/apps/[slug]/layout";
import { useMemo, useState, useEffect } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, ResponsiveContainer } from "recharts";
import { Card, CardContent } from "@/components/ui/card";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useRouter } from "next/navigation";
import { DebugDataTable } from "@/app/dashboard/components/DebugDataTable";
import { MetricsDefinitions } from "@/app/dashboard/components/MetricsDefinitions";
import { ChatSidebar } from "@/app/dashboard/components/chat/ChatSidebar";
import { SidebarProvider, SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { CalendarDays, ChevronDown, Loader2 } from "lucide-react";

export default function DashboardPage() {
  const router = useRouter();
  const { appId, currency, appName } = useApp();
  const metrics = useQuery(api.queries.getLatestMetrics, { appId });
  const userPreferences = useQuery(api.queries.getUserPreferences, { appId });
  const debugData = useQuery(api.queries.getAllDebugData, { appId });
  const logs = useQuery(api.queries.getSyncLogs, { appId, limit: 50 });
  const activeSyncStatus = useQuery(api.syncHelpers.getActiveSyncStatus, { appId });
  const chatContext = useQuery(api.queries.getChatContext, { appId });
  const triggerSync = useMutation(api.syncHelpers.triggerSync);
  const cancelSync = useMutation(api.syncHelpers.cancelSync);
  const triggerExchangeRates = useMutation(api.syncHelpers.triggerExchangeRatesFetch);
  const [syncing, setSyncing] = useState(false);
  const [fetchingRates, setFetchingRates] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  // Monitor logs for sync completion or cancellation
  useEffect(() => {
    if (logs && logs.length > 0 && syncing) {
      const lastLog = logs[0];
      if (lastLog.message === "Sync completed" || lastLog.message.includes("cancelled")) {
        setSyncing(false);
      }
    }
  }, [logs, syncing]);

  // Monitor active sync status
  useEffect(() => {
    if (activeSyncStatus?.active) {
      setSyncing(true);
    } else if (activeSyncStatus?.active === false && syncing) {
      setSyncing(false);
    }
  }, [activeSyncStatus, syncing]);

  const handleSync = async (forceHistorical = false, platform?: "stripe" | "googleplay" | "appstore") => {
    setSyncError(null);
    setSyncing(true);
    try {
      await triggerSync({ appId, forceHistorical, platform });
    } catch (error: any) {
      setSyncError(error.message || "Failed to start sync");
      setSyncing(false);
    }
  };

  const handleCancelSync = async () => {
    try {
      await cancelSync({ appId });
      setSyncing(false);
    } catch (error: any) {
      console.error("Failed to cancel sync:", error);
    }
  };

  const handleFetchExchangeRates = async () => {
    setFetchingRates(true);
    try {
      await triggerExchangeRates({});
      await new Promise(resolve => setTimeout(resolve, 2000));
    } finally {
      setFetchingRates(false);
    }
  };

  const formatDate = (timestamp: number | null) => {
    if (!timestamp) return "Never";
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(timestamp));
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  };

  const connectedPlatforms = useMemo(() => {
    if (!metrics?.platformMap) return [];
    return Object.keys(metrics.platformMap).filter(platform => {
      const platformData = metrics.platformMap[platform];
      if (!platformData) return false;
      // Check if platform has any non-zero values
      return Object.values(platformData).some(value => typeof value === 'number' && value > 0);
    });
  }, [metrics]);

  const platformCounts = {
    appstore: metrics?.platformMap?.appstore?.activeSubscribers ?? 0,
    googleplay: metrics?.platformMap?.googleplay?.activeSubscribers ?? 0,
    stripe: metrics?.platformMap?.stripe?.activeSubscribers ?? 0,
  };

  const platformLabels: Record<string, string> = {
    appstore: "App Store",
    googleplay: "Google Play",
    stripe: "Stripe",
  };

  const rightBlock = (key: string, isCurrency = false) => {
    const pick = (platform: string) => {
      return metrics?.platformMap?.[platform]?.[key] ?? 0;
    };
    
    return (
      <div className="text-xs text-right text-gray-500 leading-4">
        {connectedPlatforms.map((platform) => {
          const value = pick(platform);
          return (
            <div key={platform}>
              {platformLabels[platform]}: {isCurrency ? formatCurrency(value) : value}
            </div>
          );
        })}
      </div>
    );
  };

  const syncMenuItems = [
    {
      label: "Sync Now",
      description: "Refresh the latest updates",
      action: () => handleSync(false),
    },
    {
      label: "Full Sync",
      description: "Fetch 365 days of history",
      action: () => handleSync(true),
    },
    ...(["stripe", "appstore", "googleplay"] as const).map((platform) => ({
      label: `Full Sync: ${platform === "appstore" ? "App Store" : platform === "googleplay" ? "Google Play" : "Stripe"}`,
      description: `Only ${platform === "appstore" ? "App Store" : platform === "googleplay" ? "Google Play" : "Stripe"} data`,
      action: () => handleSync(true, platform),
    })),
  ];

  return (
    <SidebarProvider defaultOpen={false}>
      <SidebarInset>
        <div className="px-4 pt-16">
          <div className="max-w-6xl mx-auto space-y-6">
          <h1 className="text-4xl font-semibold text-foreground">{appName}</h1>
        <div className="sticky top-0 z-50 flex flex-col mb-2 bg-white/80 backdrop-blur-sm py-4 -mx-4 px-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-col gap-2">
              
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Last Sync</span>
                <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <CalendarDays className="h-4 w-4 text-muted-foreground" />
                  <span>{metrics?.lastSync ? formatDate(metrics.lastSync) : "No sync yet"}</span>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                onClick={handleFetchExchangeRates}
                disabled={fetchingRates}
                variant="outline"
                size="sm"
                title="Fetch latest exchange rates for currency conversion"
              >
                {fetchingRates ? "Fetching..." : "Fetch Rates"}
              </Button>
              {syncing ? (
                <Button onClick={handleCancelSync} variant="destructive" size="sm">
                  Stop Sync
                </Button>
              ) : (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm" className="gap-2">
                      Sync
                      <ChevronDown className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56">
                    {syncMenuItems.map((item) => (
                      <DropdownMenuItem
                        key={item.label}
                        className="flex flex-col items-start gap-1"
                        onSelect={() => {
                          void item.action();
                        }}
                      >
                        <span className="text-sm font-medium text-foreground">{item.label}</span>
                        <span className="text-xs text-muted-foreground">{item.description}</span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              <SidebarTrigger />
            </div>
          </div>
          {syncError && (
            <div className="flex items-center gap-2 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-600">
              {syncError}
            </div>
          )}
        </div>

        {metrics === undefined ? (
          <div className="text-center py-12">
            <Loader2 className="h-8 w-8 animate-spin mx-auto mb-4 text-gray-600" />
            <p className="text-gray-600">Loading metrics...</p>
          </div>
        ) : !metrics?.unified ? (
          <div className="text-center py-12">
            <p className="text-gray-600 mb-4">No data yet</p>
            <Button onClick={() => router.push("./settings")}>
              Connect Platforms
            </Button>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
              <MetricCard
                label="Active Subscribers"
                value={metrics.unified.activeSubscribers}
                metricKey="activeSubscribers"
                appId={appId}
                connectedPlatforms={connectedPlatforms}
                right={
                  <div className="text-xs text-right text-gray-500 leading-4">
                    {connectedPlatforms.map((platform) => (
                      <div key={platform}>
                        {platformLabels[platform]}: {platformCounts[platform as keyof typeof platformCounts]}
                      </div>
                    ))}
                  </div>
                }
              />
              <MetricCard
                label="Trial Subscribers"
                value={metrics.unified.trialSubscribers}
                metricKey="trialSubscribers"
                appId={appId}
                connectedPlatforms={connectedPlatforms}
                right={rightBlock("trialSubscribers")}
              />
              <MetricCard
                label="Paid Subscribers"
                value={metrics.unified.paidSubscribers}
                metricKey="paidSubscribers"
                appId={appId}
                connectedPlatforms={connectedPlatforms}
                right={rightBlock("paidSubscribers")}
              />
              <MetricCard
                label="Monthly Subs"
                value={metrics.unified.monthlySubscribers}
                metricKey="monthlySubscribers"
                appId={appId}
                connectedPlatforms={connectedPlatforms}
                right={rightBlock("monthlySubscribers")}
              />
              <MetricCard
                label="Yearly Subs"
                value={metrics.unified.yearlySubscribers}
                metricKey="yearlySubscribers"
                appId={appId}
                connectedPlatforms={connectedPlatforms}
                right={rightBlock("yearlySubscribers")}
              />
              <MetricCard
                label="Cancellations"
                value={metrics.unified.cancellations}
                metricKey="cancellations"
                appId={appId}
                connectedPlatforms={connectedPlatforms}
                right={rightBlock("cancellations")}
              />
              <MetricCard
                label="Grace Events"
                value={metrics.unified.graceEvents}
                metricKey="graceEvents"
                appId={appId}
                connectedPlatforms={connectedPlatforms}
                right={rightBlock("graceEvents")}
              />
              <MetricCard
                label="First Payments"
                value={metrics.unified.firstPayments}
                metricKey="firstPayments"
                appId={appId}
                connectedPlatforms={connectedPlatforms}
                right={rightBlock("firstPayments")}
              />
              <MetricCard
                label="Renewals"
                value={metrics.unified.renewals}
                metricKey="renewals"
                appId={appId}
                connectedPlatforms={connectedPlatforms}
                right={rightBlock("renewals")}
              />
              <MetricCard
                label="MRR"
                value={formatCurrency(metrics.unified.mrr)}
                metricKey="mrr"
                appId={appId}
                connectedPlatforms={connectedPlatforms}
                right={rightBlock("mrr", true)}
              />
              <MetricCard
                label="Monthly Rev. (Gross)"
                value={formatCurrency(metrics.unified.monthlyRevenueGross)}
                metricKey="monthlyRevenueGross"
                appId={appId}
                connectedPlatforms={connectedPlatforms}
                right={rightBlock("monthlyRevenueGross", true)}
              />
              <MetricCard
                label="Monthly Rev. (Net)"
                value={formatCurrency(metrics.unified.monthlyRevenueNet)}
                metricKey="monthlyRevenueNet"
                appId={appId}
                connectedPlatforms={connectedPlatforms}
                right={rightBlock("monthlyRevenueNet", true)}
              />
            </div>

            <div className="mt-8">
              <div className="text-sm font-semibold mb-2">Recent sync logs</div>
              <div className="border border-gray-200 rounded p-3 max-h-64 overflow-auto text-sm bg-white font-mono">
                {!logs || logs.length === 0 ? (
                  <div className="text-gray-500">No logs yet</div>
                ) : (
                  logs.map((l) => (
                    <div key={l._id} className="py-1">
                      <span
                        className={`mr-2 ${l.level === "error"
                          ? "text-red-600"
                          : l.level === "success"
                            ? "text-green-600"
                            : "text-gray-700"
                          }`}
                      >
                        [{new Date(l.timestamp).toLocaleTimeString()}]
                      </span>
                      <span className="text-gray-800">{l.message}</span>
                    </div>
                  ))
                )}
              </div>
            </div>

            <MetricsDefinitions />

            <div className="mt-8 flex gap-4">
              <Button
                onClick={() => router.push("./settings")}
                variant="outline"
              >
                Settings
              </Button>
            </div>

            <div className="mt-12">
              <h2 className="text-xl font-semibold mb-4">Debug: All Metrics Data</h2>
              <DebugDataTable debugData={debugData} userCurrency={currency} />
            </div>
          </>
        )}
          </div>
        </div>
      </SidebarInset>
      <ChatSidebar
        chatContext={chatContext}
        debugData={debugData}
      />
    </SidebarProvider>
  );
}


const FLOW_METRICS = new Set([
  "cancellations",
  "graceEvents",
  "firstPayments",
  "renewals",
  "monthlyRevenueGross",
  "monthlyRevenueNet",
]);

const parseWeekDate = (week: string) => new Date(`${week}T00:00:00Z`);
const subtractDays = (date: Date, days: number) => new Date(date.getTime() - days * 86_400_000);

function MetricCard({
  label,
  value,
  metricKey,
  appId,
  right,
  connectedPlatforms,
}: {
  label: string;
  value: string | number;
  metricKey: string;
  appId: any;
  right?: React.ReactNode;
  connectedPlatforms: string[];
}) {
  const chartData = useQuery(api.queries.getWeeklyMetricsHistory, { appId, metric: metricKey });

  const change = useMemo(() => {
    if (!chartData || chartData.length === 0) return null;

    const sorted = [...chartData].sort((a, b) => a.week.localeCompare(b.week));
    const latestPoint = sorted[sorted.length - 1];
    if (!latestPoint) return null;

    const latestValue = latestPoint.unified ?? 0;
    const latestWeekDate = parseWeekDate(latestPoint.week);

    if (FLOW_METRICS.has(metricKey)) {
      const currentWindowStart = subtractDays(latestWeekDate, 28);
      const previousWindowEnd = subtractDays(currentWindowStart, 1);
      const previousWindowStart = subtractDays(previousWindowEnd, 28);

      const sumRange = (start: Date, end: Date) =>
        sorted.reduce((sum, point) => {
          const weekDate = parseWeekDate(point.week);
          if (weekDate > start && weekDate <= end) {
            return sum + (point.unified ?? 0);
          }
          return sum;
        }, 0);

      const currentSum = sumRange(currentWindowStart, latestWeekDate);
      const previousSum = sumRange(previousWindowStart, previousWindowEnd);
      if (previousSum === 0) return null;

      const percentChange = ((currentSum - previousSum) / previousSum) * 100;
      return {
        value: percentChange,
        type: percentChange >= 0 ? "positive" : "negative",
        formatted: `${percentChange >= 0 ? "+" : ""}${percentChange.toFixed(1)}%`,
      };
    }

    const targetDate = subtractDays(latestWeekDate, 30);
    const previousPoint = [...sorted]
      .reverse()
      .find((point) => parseWeekDate(point.week) <= targetDate);
    if (!previousPoint) return null;

    const previousValue = previousPoint.unified ?? 0;
    if (previousValue === 0) return null;

    const percentChange = ((latestValue - previousValue) / previousValue) * 100;
    return {
      value: percentChange,
      type: percentChange >= 0 ? "positive" : "negative",
      formatted: `${percentChange >= 0 ? "+" : ""}${percentChange.toFixed(1)}%`,
    };
  }, [chartData, metricKey]);

  return (
    <Card className="p-0 gap-0">
      <CardContent className="p-6">
        <dd className="flex items-start justify-between space-x-2">
          <div className="truncate font-medium text-sm text-muted-foreground">
            {label}

            <HoverCard>
              <HoverCardTrigger asChild>
                <div className="text-4xl font-semibold text-foreground cursor-help">
                  {value}
                </div>
              </HoverCardTrigger>
              {right && (
                <HoverCardContent side="right" align="center" className="w-auto">
                  {right}
                </HoverCardContent>
              )}
            </HoverCard>
          </div>
          {change && (
            <span
              className={cn(
                "text-xl font-medium",
                change.type === "positive"
                  ? "text-emerald-700 dark:text-emerald-500"
                  : "text-red-700 dark:text-red-500"
              )}
            >
              {change.formatted}
            </span>
          )}
        </dd>

        <ChartContainer
          className="h-32 mt-4 !aspect-auto"
          config={{
            unified: { label: "Total", color: "#000000" },
            appstore: { label: "App Store", color: "#0071e3" },
            googleplay: { label: "Google Play", color: "#34a853" },
            stripe: { label: "Stripe", color: "#635bff" },
          } satisfies ChartConfig}
        >
          {chartData && chartData.length > 0 ? (
            <LineChart data={chartData}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="week" hide />
              <YAxis hide />
              <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel />} />
              <Line type="linear" dataKey="unified" stroke="var(--color-unified)" strokeWidth={2} dot={false} isAnimationActive={false} />
              {connectedPlatforms.includes("appstore") && (
                <Line type="linear" dataKey="appstore" stroke="var(--color-appstore)" strokeWidth={1} dot={false} isAnimationActive={false} />
              )}
              {connectedPlatforms.includes("googleplay") && (
                <Line type="linear" dataKey="googleplay" stroke="var(--color-googleplay)" strokeWidth={1} dot={false} isAnimationActive={false} />
              )}
              {connectedPlatforms.includes("stripe") && (
                <Line type="linear" dataKey="stripe" stroke="var(--color-stripe)" strokeWidth={1} dot={false} isAnimationActive={false} />
              )}
            </LineChart>
          ) : (
            <div />
          )}
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

