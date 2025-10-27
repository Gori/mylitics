"use client";

import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { useRouter } from "next/navigation";
import { useUser, UserButton } from "@clerk/nextjs";
import { useEffect, useMemo, useState } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DebugDataTable } from "./components/DebugDataTable";
import { MetricsDefinitions } from "./components/MetricsDefinitions";

function Dashboard() {
  const router = useRouter();
  const { isSignedIn, isLoaded } = useUser();
  const metrics = useQuery(api.queries.getLatestMetrics);
  const debugData = useQuery(api.queries.getAllDebugData);
  const triggerSync = useMutation(api.syncHelpers.triggerSync);
  const [syncing, setSyncing] = useState(false);
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

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
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
    <div className="min-h-screen bg-white p-4 md:p-8">
      <div className="max-w-6xl mx-auto">
        <div className="flex justify-between items-center mb-8">
          <UserButton />
          <div className="flex items-center gap-4">
            <div className="text-sm text-gray-600">
              {metrics?.lastSync ? formatDate(metrics.lastSync) : "No sync yet"}
            </div>
            <button
              onClick={() => handleSync(false)}
              disabled={syncing}
              className={`px-4 py-2 rounded ${syncing ? "bg-gray-300 text-gray-600 cursor-not-allowed" : "bg-black text-white"}`}
            >
              {syncing ? "Syncing..." : "Sync"}
            </button>
            <button
              onClick={() => handleSync(true)}
              disabled={syncing}
              className={`px-4 py-2 rounded border ${syncing ? "bg-gray-100 text-gray-400 cursor-not-allowed border-gray-200" : "bg-white text-black border-black"}`}
              title="Force full historical sync (365 days)"
            >
              Full Sync
            </button>
            <div className="flex gap-2">
              <button
                onClick={() => handleSync(true, "stripe")}
                disabled={syncing}
                className={`px-3 py-2 rounded border ${syncing ? "bg-gray-100 text-gray-400 cursor-not-allowed border-gray-200" : "bg-white text-black border-black"}`}
                title="Full Sync: Stripe"
              >
                Full Stripe
              </button>
              <button
                onClick={() => handleSync(true, "appstore")}
                disabled={syncing}
                className={`px-3 py-2 rounded border ${syncing ? "bg-gray-100 text-gray-400 cursor-not-allowed border-gray-200" : "bg-white text-black border-black"}`}
                title="Full Sync: App Store"
              >
                Full App Store
              </button>
              <button
                onClick={() => handleSync(true, "googleplay")}
                disabled={syncing}
                className={`px-3 py-2 rounded border ${syncing ? "bg-gray-100 text-gray-400 cursor-not-allowed border-gray-200" : "bg-white text-black border-black"}`}
                title="Full Sync: Google Play"
              >
                Full Google
              </button>
            </div>
          </div>
        </div>

        {!metrics?.unified ? (
          <div className="text-center py-12">
            <p className="text-gray-600 mb-4">No data yet</p>
            <button
              onClick={() => router.push("/dashboard/connections")}
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
              value={formatCurrency(Math.round((metrics.unified.mrr + Number.EPSILON) * 100) / 100)}
              metricKey="mrr"
              right={rightBlock("mrr", true)}
            />
            <MetricCard
              label="Monthly Rev. (Gross)"
              value={formatCurrency(Math.round((metrics.unified.monthlyRevenueGross + Number.EPSILON) * 100) / 100)}
              metricKey="monthlyRevenueGross"
              right={rightBlock("monthlyRevenueGross", true)}
            />
            <MetricCard
              label="Monthly Rev. (Net)"
              value={formatCurrency(Math.round((metrics.unified.monthlyRevenueNet + Number.EPSILON) * 100) / 100)}
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
            onClick={() => router.push("/dashboard/connections")}
            className="px-4 py-2 border border-gray-300 rounded"
          >
            Connections
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
          <DebugDataTable debugData={debugData} />
        </div>
      </div>
    </div>
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

  return (
    <Card>
      <CardHeader className="pb-0">
        <div className="flex items-start justify-between">
          <div>
            <CardTitle className="text-2xl">
              {label}
            </CardTitle>
            {dateRange && (
              <div className="text-sm text-muted-foreground/80">({dateRange})</div>
            )}
          </div>
          {right}
        </div>
      </CardHeader>
      <CardContent>
        <div className="text-4xl font-semibold mb-2">{value}</div>
        {chartData && chartData.length > 0 && (
          <div className="h-32">
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

