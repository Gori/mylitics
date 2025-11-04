"use client";

import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useApp } from "@/app/apps/[slug]/layout";
import { useMemo, useState, useEffect } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useRouter } from "next/navigation";
import { DebugDataTable } from "@/app/dashboard/components/DebugDataTable";

export default function DashboardPage() {
  const router = useRouter();
  const { appId, currency } = useApp();
  const metrics = useQuery(api.queries.getLatestMetrics, { appId });
  const userPreferences = useQuery(api.queries.getUserPreferences, { appId });
  const debugData = useQuery(api.queries.getAllDebugData, { appId });
  const logs = useQuery(api.queries.getSyncLogs, { appId, limit: 50 });
  const activeSyncStatus = useQuery(api.syncHelpers.getActiveSyncStatus, { appId });
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
    return new Date(timestamp).toLocaleString();
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  };

  const platformCounts = {
    appstore: metrics?.platformMap?.appstore?.activeSubscribers ?? 0,
    googleplay: metrics?.platformMap?.googleplay?.activeSubscribers ?? 0,
    stripe: metrics?.platformMap?.stripe?.activeSubscribers ?? 0,
  };

  const rightBlock = (key: string, isCurrency = false) => {
    const pick = (platform: string) => {
      return metrics?.platformMap?.[platform]?.[key] ?? 0;
    };
    const a = pick("appstore");
    const g = pick("googleplay");
    const s = pick("stripe");
    return (
      <div className="text-xs text-right text-gray-500 leading-4">
        <div>App Store: {isCurrency ? formatCurrency(a) : a}</div>
        <div>Google Play: {isCurrency ? formatCurrency(g) : g}</div>
        <div>Stripe: {isCurrency ? formatCurrency(s) : s}</div>
      </div>
    );
  };

  return (
    <div className="p-4 md:p-8">
      <div className="max-w-6xl mx-auto">
        {/* Sync Controls */}
        <div className="mb-6 pb-4 border-b">
          <div className="flex items-center justify-between flex-wrap gap-4">
            <div className="text-sm text-muted-foreground">
              {metrics?.lastSync ? formatDate(metrics.lastSync) : "No sync yet"}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {syncError && (
                <div className="text-sm text-red-600 bg-red-50 px-3 py-1 rounded">
                  {syncError}
                </div>
              )}
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
                <Button
                  onClick={handleCancelSync}
                  variant="destructive"
                  size="sm"
                >
                  Stop Sync
                </Button>
              ) : (
                <Button
                  onClick={() => handleSync(false)}
                  disabled={syncing}
                  variant="default"
                  size="sm"
                >
                  Sync
                </Button>
              )}
              <Button
                onClick={() => handleSync(true)}
                disabled={syncing}
                variant="outline"
                size="sm"
                title="Force full historical sync (365 days)"
              >
                Full Sync
              </Button>
              <div className="flex items-center gap-2">
                <Button
                  onClick={() => handleSync(true, "stripe")}
                  disabled={syncing}
                  variant="outline"
                  size="sm"
                  title="Full Sync: Stripe"
                >
                  Stripe
                </Button>
                <Button
                  onClick={() => handleSync(true, "appstore")}
                  disabled={syncing}
                  variant="outline"
                  size="sm"
                  title="Full Sync: App Store"
                >
                  App Store
                </Button>
                <Button
                  onClick={() => handleSync(true, "googleplay")}
                  disabled={syncing}
                  variant="outline"
                  size="sm"
                  title="Full Sync: Google Play"
                >
                  Google Play
                </Button>
              </div>
            </div>
          </div>
        </div>

        {!metrics?.unified ? (
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
                right={
                  <div className="text-xs text-right text-gray-500 leading-4">
                    <div>App Store: {platformCounts.appstore}</div>
                    <div>Google Play: {platformCounts.googleplay}</div>
                    <div>Stripe: {platformCounts.stripe}</div>
                  </div>
                }
              />
              <MetricCard
                label="Trial Subscribers"
                value={metrics.unified.trialSubscribers}
                metricKey="trialSubscribers"
                appId={appId}
                right={rightBlock("trialSubscribers")}
              />
              <MetricCard
                label="Paid Subscribers"
                value={metrics.unified.paidSubscribers}
                metricKey="paidSubscribers"
                appId={appId}
                right={rightBlock("paidSubscribers")}
              />
              <MetricCard
                label="Monthly Subs"
                value={metrics.unified.monthlySubscribers}
                metricKey="monthlySubscribers"
                appId={appId}
                right={rightBlock("monthlySubscribers")}
              />
              <MetricCard
                label="Yearly Subs"
                value={metrics.unified.yearlySubscribers}
                metricKey="yearlySubscribers"
                appId={appId}
                right={rightBlock("yearlySubscribers")}
              />
              <MetricCard
                label="Cancellations"
                value={metrics.unified.cancellations}
                metricKey="cancellations"
                appId={appId}
                right={rightBlock("cancellations")}
              />
              <MetricCard
                label="Grace Events"
                value={metrics.unified.graceEvents}
                metricKey="graceEvents"
                appId={appId}
                right={rightBlock("graceEvents")}
              />
              <MetricCard
                label="First Payments"
                value={metrics.unified.firstPayments}
                metricKey="firstPayments"
                appId={appId}
                right={rightBlock("firstPayments")}
              />
              <MetricCard
                label="Renewals"
                value={metrics.unified.renewals}
                metricKey="renewals"
                appId={appId}
                right={rightBlock("renewals")}
              />
              <MetricCard
                label="MRR"
                value={formatCurrency(metrics.unified.mrr)}
                metricKey="mrr"
                appId={appId}
                right={rightBlock("mrr", true)}
              />
              <MetricCard
                label="Monthly Rev. (Gross)"
                value={formatCurrency(metrics.unified.monthlyRevenueGross)}
                metricKey="monthlyRevenueGross"
                appId={appId}
                right={rightBlock("monthlyRevenueGross", true)}
              />
              <MetricCard
                label="Monthly Rev. (Net)"
                value={formatCurrency(metrics.unified.monthlyRevenueNet)}
                metricKey="monthlyRevenueNet"
                appId={appId}
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
                        className={`mr-2 ${
                          l.level === "error"
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

            <div className="mt-12">
              <h2 className="text-xl font-semibold mb-4">Debug: All Metrics Data</h2>
              <DebugDataTable debugData={debugData} userCurrency={currency} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function MetricCard({
  label,
  value,
  metricKey,
  appId,
  right,
}: {
  label: string;
  value: string | number;
  metricKey: string;
  appId: any;
  right?: React.ReactNode;
}) {
  const chartData = useQuery(api.queries.getWeeklyMetricsHistory, { appId, metric: metricKey });

  const change = useMemo(() => {
    if (!chartData || chartData.length < 2) return null;
    const latest = chartData[0]?.unified ?? 0;
    const previous = chartData[1]?.unified ?? 0;
    if (previous === 0) return null;
    const percentChange = ((latest - previous) / previous) * 100;
    return {
      value: percentChange,
      type: percentChange >= 0 ? "positive" : "negative",
      formatted: `${percentChange >= 0 ? "+" : ""}${percentChange.toFixed(1)}%`,
    };
  }, [chartData]);

  return (
    <Card className="p-0 gap-0">
      <CardContent className="p-6">
        <dd className="flex items-start justify-between space-x-2">
          <span className="truncate text-sm text-muted-foreground">
            {label}
          </span>
          {change && (
            <span
              className={cn(
                "text-sm font-medium",
                change.type === "positive"
                  ? "text-emerald-700 dark:text-emerald-500"
                  : "text-red-700 dark:text-red-500"
              )}
            >
              {change.formatted}
            </span>
          )}
        </dd>
        <dd className="mt-1 text-3xl font-semibold text-foreground">
          {value}
        </dd>
        {right && (
          <div className="mt-2">
            {right}
          </div>
        )}
        {chartData && chartData.length > 0 && (
          <div className="h-32 mt-4">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData}>
                <XAxis dataKey="week" hide />
                <YAxis hide />
                <Tooltip />
                <Line type="monotone" dataKey="unified" stroke="#000000" strokeWidth={2} dot={false} name="Total" />
                <Line type="monotone" dataKey="appstore" stroke="#0071e3" strokeWidth={1} dot={false} name="App Store" />
                <Line type="monotone" dataKey="googleplay" stroke="#34a853" strokeWidth={1} dot={false} name="Google Play" />
                <Line type="monotone" dataKey="stripe" stroke="#635bff" strokeWidth={1} dot={false} name="Stripe" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

