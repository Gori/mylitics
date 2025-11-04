"use client";

import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { useRouter } from "next/navigation";
import { useUser, UserButton } from "@clerk/nextjs";
import { useEffect, useMemo, useState } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { DebugDataTable } from "./components/DebugDataTable";
import { MetricsDefinitions } from "./components/MetricsDefinitions";
import { ChatSidebar } from "./components/chat/ChatSidebar";
import { SidebarProvider, SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";

function Dashboard() {
  const router = useRouter();
  const { isSignedIn, isLoaded } = useUser();
  const metrics = useQuery(api.queries.getLatestMetrics);
  const debugData = useQuery(api.queries.getAllDebugData);
  const userPreferences = useQuery(api.queries.getUserPreferences);
  const chatContext = useQuery(api.queries.getChatContext);
  const triggerSync = useMutation(api.syncHelpers.triggerSync);
  const triggerExchangeRates = useMutation(api.syncHelpers.triggerExchangeRatesFetch);
  const [syncing, setSyncing] = useState(false);
  const [fetchingRates, setFetchingRates] = useState(false);
  const logs = useQuery(api.queries.getSyncLogs, { limit: 50 });

  useEffect(() => {
    if (isLoaded && !isSignedIn) {
      router.replace("/sign-in");
    }
  }, [isLoaded, isSignedIn, router]);

  // Monitor logs for sync completion
  useEffect(() => {
    if (logs && logs.length > 0 && syncing) {
      const lastLog = logs[0];
      if (lastLog.message === "Sync completed" || lastLog.level === "success") {
        const isCompleted = lastLog.message.includes("completed");
        if (isCompleted) {
          setSyncing(false);
        }
      }
    }
  }, [logs, syncing]);

  if (!isLoaded || !isSignedIn) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white">
        <div>Loading...</div>
      </div>
    );
  }

  const handleSync = async (forceHistorical = false, platform?: "stripe" | "googleplay" | "appstore") => {
    setSyncing(true);
    await triggerSync({ forceHistorical, platform });
  };

  const handleFetchExchangeRates = async () => {
    setFetchingRates(true);
    try {
      await triggerExchangeRates({});
      // Wait a bit for the action to complete
      await new Promise(resolve => setTimeout(resolve, 2000));
    } finally {
      setFetchingRates(false);
    }
  };

  const formatCurrency = (amount: number) => {
    const currency = userPreferences?.currency || "USD";
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
        <div>
          App Store: {isCurrency ? formatCurrency(a) : a}
        </div>
        <div>
          Google Play: {isCurrency ? formatCurrency(g) : g}
        </div>
        <div>
          Stripe: {isCurrency ? formatCurrency(s) : s}
        </div>
      </div>
    );
  };

  const formatDate = (timestamp: number | null) => {
    if (!timestamp) return "Never";
    return new Date(timestamp).toLocaleString();
  };

  return (
    <SidebarProvider defaultOpen={false}>
      <SidebarInset>
        <header className="w-full border-b bg-white">
          <div className="flex items-center justify-between px-4 md:px-8 h-16">
            <div className="flex items-center">
              <UserButton />
            </div>
            <div className="flex items-center gap-4 flex-1 justify-center">
              <div className="text-sm text-muted-foreground">
                {metrics?.lastSync ? formatDate(metrics.lastSync) : "No sync yet"}
              </div>
              <Button
                onClick={handleFetchExchangeRates}
                disabled={fetchingRates}
                variant="outline"
                size="sm"
                title="Fetch latest exchange rates for currency conversion"
              >
                {fetchingRates ? "Fetching..." : "Fetch Rates"}
              </Button>
              <Button
                onClick={() => handleSync(false)}
                disabled={syncing}
                variant="default"
                size="sm"
              >
                {syncing ? "Syncing..." : "Sync"}
              </Button>
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
            <div className="flex items-center">
              <SidebarTrigger />
            </div>
          </div>
        </header>
        <div className="min-h-screen bg-white p-4 md:p-8">

          <div className="max-w-6xl mx-auto">
          {!metrics?.unified ? (
          <div className="text-center py-12">
            <p className="text-gray-600 mb-4">No data yet</p>
            <button
              onClick={() => router.push("/dashboard/settings")}
              className="px-4 py-2 bg-black text-white rounded"
            >
              Connect Platforms
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <MetricCard
              label="Active Subscribers"
              value={metrics.unified.activeSubscribers}
              metricKey="activeSubscribers"
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
              right={rightBlock("trialSubscribers")}
            />
            <MetricCard
              label="Paid Subscribers"
              value={metrics.unified.paidSubscribers}
              metricKey="paidSubscribers"
              right={rightBlock("paidSubscribers")}
            />
            <MetricCard
              label="Monthly Subs"
              value={metrics.unified.monthlySubscribers}
              metricKey="monthlySubscribers"
              right={rightBlock("monthlySubscribers")}
            />
            <MetricCard
              label="Yearly Subs"
              value={metrics.unified.yearlySubscribers}
              metricKey="yearlySubscribers"
              right={rightBlock("yearlySubscribers")}
            />
            <MetricCard
              label="Cancellations"
              value={metrics.unified.cancellations}
              metricKey="cancellations"
              right={rightBlock("cancellations")}
            />
            <MetricCard
              label="Grace Events"
              value={metrics.unified.graceEvents}
              metricKey="graceEvents"
              right={rightBlock("graceEvents")}
            />
            <MetricCard
              label="First Payments"
              value={metrics.unified.firstPayments}
              metricKey="firstPayments"
              right={rightBlock("firstPayments")}
            />
            <MetricCard
              label="Renewals"
              value={metrics.unified.renewals}
              metricKey="renewals"
              right={rightBlock("renewals")}
            />
            <MetricCard
              label="MRR"
              value={formatCurrency(metrics.unified.mrr)}
              metricKey="mrr"
              right={rightBlock("mrr", true)}
            />
            <MetricCard
              label="Monthly Rev. (Gross)"
              value={formatCurrency(metrics.unified.monthlyRevenueGross)}
              metricKey="monthlyRevenueGross"
              right={rightBlock("monthlyRevenueGross", true)}
            />
            <MetricCard
              label="Monthly Rev. (Net)"
              value={formatCurrency(metrics.unified.monthlyRevenueNet)}
              metricKey="monthlyRevenueNet"
              right={rightBlock("monthlyRevenueNet", true)}
            />
          </div>
        )}

        <MetricsDefinitions />

        <div className="mt-8">
          <div className="text-sm font-semibold mb-2">Recent sync logs</div>
          <div className="border border-gray-200 rounded p-3 max-h-64 overflow-auto text-sm bg-white font-mono">
            {!logs || logs.length === 0 ? (
              <div className="text-gray-500">No logs yet</div>
            ) : (
              logs.map((l) => (
                <div key={l._id} className="py-1">
                  <span className={`mr-2 ${l.level === "error" ? "text-red-600" : l.level === "success" ? "text-green-600" : "text-gray-700"}`}>
                    [{new Date(l.timestamp).toLocaleTimeString()}]
                  </span>
                  <span className="text-gray-800">{l.message}</span>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="mt-8 flex gap-4">
          <button
            onClick={() => router.push("/dashboard/settings")}
            className="px-4 py-2 border border-gray-300 rounded"
          >
            Settings
          </button>
          <button
            onClick={() => router.push("/dashboard/history")}
            className="px-4 py-2 border border-gray-300 rounded"
          >
            History
          </button>
        </div>

          <div className="mt-12">
            <h2 className="text-xl font-semibold mb-4">Debug: All Metrics Data</h2>
            <DebugDataTable debugData={debugData} userCurrency={userPreferences?.currency || "USD"} />
          </div>
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

function MetricCard({
  label,
  value,
  metricKey,
  dateRange,
  right,
}: {
  label: string;
  value: string | number;
  metricKey: string;
  dateRange?: string;
  right?: React.ReactNode;
}) {
  const chartData = useQuery(api.queries.getWeeklyMetricsHistory, { metric: metricKey });

  // Calculate change from chart data
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

export default function DashboardPage() {
  return <Dashboard />;
}

