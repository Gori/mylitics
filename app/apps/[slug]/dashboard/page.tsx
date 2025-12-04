"use client";

import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useApp } from "@/app/apps/[slug]/layout";
import { useMemo, useState, useEffect } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, ResponsiveContainer } from "recharts";
import { Card, CardContent } from "@/components/ui/card";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { ChartContainer, ChartTooltip, ChartTooltipContent, ChartFooter, type ChartConfig } from "@/components/ui/chart";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useRouter } from "next/navigation";
import { DebugDataTable } from "@/app/dashboard/components/DebugDataTable";
import { MetricsDefinitions } from "@/app/dashboard/components/MetricsDefinitions";
import { ChatSidebar } from "@/app/dashboard/components/chat/ChatSidebar";
import { SidebarProvider, SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CalendarDays, ChevronDown, Loader2 } from "lucide-react";

export default function DashboardPage() {
  const router = useRouter();
  const { appId, currency, appName } = useApp();
  const metrics = useQuery(api.queries.getLatestMetrics, { appId });
  const userPreferences = useQuery(api.queries.getUserPreferences, { appId });
  const debugData = useQuery(api.queries.getAllDebugData, { appId });
  const debugRevenue = useQuery(api.queries.debugRevenueCalculation, { appId });
  const debugChurnRate = useQuery(api.queries.debugChurnRate, { appId });
  const validateRevenue = useQuery(api.queries.validateRevenueData, { appId });
  const logs = useQuery(api.queries.getSyncLogs, { appId, limit: 50 });
  const activeSyncStatus = useQuery(api.syncHelpers.getActiveSyncStatus, { appId });
  const chatContext = useQuery(api.queries.getChatContext, { appId });
  const triggerSync = useMutation(api.syncHelpers.triggerSync);
  const cancelSync = useMutation(api.syncHelpers.cancelSync);
  const triggerExchangeRates = useMutation(api.syncHelpers.triggerExchangeRatesFetch);
  const cleanupDuplicates = useMutation(api.mutations.cleanupDuplicateSnapshots);
  const fixAppStoreRevenue = useMutation(api.mutations.fixAppStoreRevenue);
  const [syncing, setSyncing] = useState(false);
  const [fetchingRates, setFetchingRates] = useState(false);
  const [cleaningUp, setCleaningUp] = useState(false);
  const [fixingAppStore, setFixingAppStore] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [cleanupResult, setCleanupResult] = useState<any>(null);
  const [appStoreFixResult, setAppStoreFixResult] = useState<any>(null);
  const [viewMode, setViewMode] = useState<"monthly" | "weekly">("monthly");

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

  const handleCleanupDuplicates = async () => {
    setCleaningUp(true);
    setCleanupResult(null);
    try {
      const result = await cleanupDuplicates({ appId });
      setCleanupResult(result);
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (error: any) {
      setCleanupResult({ error: error.message });
    } finally {
      setCleaningUp(false);
    }
  };

  const handleFixAppStoreRevenue = async () => {
    setFixingAppStore(true);
    setAppStoreFixResult(null);
    try {
      const result = await fixAppStoreRevenue({ appId });
      setAppStoreFixResult(result);
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (error: any) {
      setAppStoreFixResult({ error: error.message });
    } finally {
      setFixingAppStore(false);
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

  // Use connected platforms from backend (actual platform connections)
  // Fallback to deriving from platformMap if backend hasn't synced yet
  const connectedPlatforms = useMemo(() => {
    if (metrics?.connectedPlatforms?.length) {
      return metrics.connectedPlatforms;
    }
    // Fallback: derive from platformMap
    if (!metrics?.platformMap) return [];
    return Object.keys(metrics.platformMap).filter(platform => {
      const platformData = metrics.platformMap[platform];
      if (!platformData) return false;
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

  // Check if Google Play has any subscription data (used for warning icons)
  const googlePlayHasSubscriptionData = useMemo(() => {
    if (!metrics?.platformMap?.googleplay) return false;
    const gp = metrics.platformMap.googleplay;
    return (gp.activeSubscribers ?? 0) > 0;
  }, [metrics]);

  // Check which subscription metrics Google Play has data for
  // Google Play might have activeSubscribers but not the breakdown (trial/paid/monthly/yearly)
  const googlePlayMetricsAvailable = useMemo(() => {
    if (!metrics?.platformMap?.googleplay) return new Set<string>();
    const gp = metrics.platformMap.googleplay;
    const available = new Set<string>();
    
    // Check each metric - only mark as available if > 0 or if it's a flow metric that could legitimately be 0
    if ((gp.activeSubscribers ?? 0) > 0) available.add("activeSubscribers");
    if ((gp.trialSubscribers ?? 0) > 0) available.add("trialSubscribers");
    if ((gp.paidSubscribers ?? 0) > 0) available.add("paidSubscribers");
    if ((gp.monthlySubscribers ?? 0) > 0) available.add("monthlySubscribers");
    if ((gp.yearlySubscribers ?? 0) > 0) available.add("yearlySubscribers");
    
    // Flow metrics - these could legitimately be 0, so check if GP has any subscription data at all
    const hasAnySubscriptionData = available.size > 0;
    if (hasAnySubscriptionData) {
      // If GP has subscription data, assume flow metrics are available (0 is valid)
      available.add("cancellations");
      available.add("churnRate");
      available.add("graceEvents");
      available.add("firstPayments");
      available.add("renewals");
    }
    
    // Revenue metrics are always available if GP is in platformMap
    available.add("monthlyChargedRevenue");
    available.add("monthlyRevenue");
    available.add("weeklyChargedRevenue");
    available.add("weeklyRevenue");
    available.add("mrr");
    available.add("arpu");
    
    return available;
  }, [metrics]);

  // Determine which platforms have data for each metric type
  const getPlatformsWithData = (metricKey: string): string[] => {
    return connectedPlatforms.filter(platform => {
      // Check if platform exists in platformMap
      if (!metrics?.platformMap?.[platform]) {
        return false;
      }
      // For Google Play, check if this specific metric is available
      if (platform === "googleplay" && !googlePlayMetricsAvailable.has(metricKey)) {
        return false;
      }
      return true;
    });
  };

  const rightBlock = (key: string, isCurrency = false) => {
    const pick = (platform: string) => {
      return metrics?.platformMap?.[platform]?.[key] ?? 0;
    };
    
    // For non-revenue metrics, check if Google Play has data
    const isRevenueMetric = key === 'monthlyChargedRevenue' || key === 'monthlyRevenue' || key === 'weeklyChargedRevenue' || key === 'weeklyRevenue';
    
    return (
      <div className="text-xs text-right text-gray-500 leading-4">
        {connectedPlatforms.map((platform) => {
          const value = pick(platform);
          const showWarning = platform === 'googleplay' && !isRevenueMetric && !googlePlayHasSubscriptionData && value === 0;
          
          return (
            <div key={platform} className="flex items-center justify-end gap-1">
              <span>
                {platformLabels[platform]}: {isCurrency ? formatCurrency(value) : value}
              </span>
              {showWarning && (
                <span 
                  className="text-yellow-600 cursor-help" 
                  title="Google Play subscription metrics not available - only revenue data found in bucket"
                >
                  ⓘ
                </span>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  // Format churn rate as percentage
  const formatPercent = (value: number) => `${value.toFixed(2)}%`;
  
  // Right block for churn rate (shows percentage per platform)
  const rightBlockChurnRate = (viewMode: "monthly" | "weekly") => {
    const key = viewMode === "monthly" ? "churnRate" : "weeklyChurnRate";
    return (
      <div className="text-xs text-right text-gray-500 leading-4">
        {connectedPlatforms.map((platform) => {
          const value = metrics?.platformMap?.[platform]?.[key] ?? 0;
          return (
            <div key={platform}>
              {platformLabels[platform]}: {formatPercent(value)}
            </div>
          );
        })}
      </div>
    );
  };

  // Right block for ARPU (shows currency per platform)
  const rightBlockArpu = (viewMode: "monthly" | "weekly") => {
    const key = viewMode === "monthly" ? "arpu" : "weeklyArpu";
    return (
      <div className="text-xs text-right text-gray-500 leading-4">
        {connectedPlatforms.map((platform) => {
          const value = metrics?.platformMap?.[platform]?.[key] ?? 0;
          return (
            <div key={platform}>
              {platformLabels[platform]}: {formatCurrency(value)}
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
        <div className="px-4 pt-14">
          <div className="max-w-6xl mx-auto space-y-6">
          <h1 className="text-5xl font-bold text-foreground mb-1">{appName}</h1>
          <div className="flex items-center gap-2 text-sm font-medium text-foreground pb-2">
            <CalendarDays className="h-4 w-4 text-muted-foreground" />
            <span>{metrics?.lastSync ? formatDate(metrics.lastSync) : "No sync yet"}</span>
          </div>
        <div className="sticky top-0 z-40 flex flex-col mb-2 bg-white/80 backdrop-blur-sm py-4 -mx-4 px-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-6">
              <Tabs value={viewMode} onValueChange={(v) => setViewMode(v as "monthly" | "weekly")}>
                <TabsList>
                  <TabsTrigger value="monthly">Monthly</TabsTrigger>
                  <TabsTrigger value="weekly">Weekly</TabsTrigger>
                </TabsList>
              </Tabs>
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
            <div className="space-y-4 mb-8">
              <div className="grid grid-cols-1 md:grid-cols-1 gap-4">
                <MetricCard currency={currency}
                  label="Active Subscribers"
                  value={metrics.unified.activeSubscribers}
                  metricKey="activeSubscribers"
                  appId={appId}
                  connectedPlatforms={connectedPlatforms}
                  viewMode={viewMode}
                  platformsWithData={getPlatformsWithData("activeSubscribers")}
                  right={
                    <div className="text-xs text-right text-gray-500 leading-4">
                      {connectedPlatforms.map((platform) => {
                        const count = platformCounts[platform as keyof typeof platformCounts];
                        const showWarning = platform === 'googleplay' && !googlePlayHasSubscriptionData && count === 0;
                        
                        return (
                          <div key={platform} className="flex items-center justify-end gap-1">
                            <span>
                              {platformLabels[platform]}: {count}
                            </span>
                            {showWarning && (
                              <span 
                                className="text-yellow-600 cursor-help" 
                                title="Google Play subscription metrics not available - only revenue data found in bucket"
                              >
                                ⓘ
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  }
                />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <MetricCard currency={currency}
                  label="Trial Subscribers"
                  value={metrics.unified.trialSubscribers}
                  metricKey="trialSubscribers"
                  appId={appId}
                  connectedPlatforms={connectedPlatforms}
                  viewMode={viewMode}
                  platformsWithData={getPlatformsWithData("trialSubscribers")}
                  right={rightBlock("trialSubscribers")}
                />
                <MetricCard currency={currency}
                  label="Paid Subscribers"
                  value={metrics.unified.paidSubscribers}
                  metricKey="paidSubscribers"
                  appId={appId}
                  connectedPlatforms={connectedPlatforms}
                  viewMode={viewMode}
                  platformsWithData={getPlatformsWithData("paidSubscribers")}
                  right={rightBlock("paidSubscribers")}
                />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <MetricCard currency={currency}
                  label="Monthly Subs"
                  value={metrics.unified.monthlySubscribers}
                  metricKey="monthlySubscribers"
                  appId={appId}
                  connectedPlatforms={connectedPlatforms}
                  viewMode={viewMode}
                  platformsWithData={getPlatformsWithData("monthlySubscribers")}
                  right={rightBlock("monthlySubscribers")}
                />
                <MetricCard currency={currency}
                  label="Yearly Subs"
                  value={metrics.unified.yearlySubscribers}
                  metricKey="yearlySubscribers"
                  appId={appId}
                  connectedPlatforms={connectedPlatforms}
                  viewMode={viewMode}
                  platformsWithData={getPlatformsWithData("yearlySubscribers")}
                  right={rightBlock("yearlySubscribers")}
                />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <MetricCard currency={currency}
                  label="Cancellations"
                  value={metrics.unified.cancellations}
                  metricKey="cancellations"
                  appId={appId}
                  connectedPlatforms={connectedPlatforms}
                  viewMode={viewMode}
                  platformsWithData={getPlatformsWithData("cancellations")}
                  right={rightBlock("cancellations")}
                />
                <MetricCard currency={currency}
                  label="Grace Events"
                  value={metrics.unified.graceEvents}
                  metricKey="graceEvents"
                  appId={appId}
                  connectedPlatforms={connectedPlatforms}
                  viewMode={viewMode}
                  platformsWithData={getPlatformsWithData("graceEvents")}
                  right={rightBlock("graceEvents")}
                />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <MetricCard currency={currency}
                  label="Churn Rate"
                  value={formatPercent(viewMode === "monthly" ? metrics.unified.churnRate : metrics.unified.weeklyChurnRate)}
                  metricKey="churnRate"
                  appId={appId}
                  connectedPlatforms={connectedPlatforms}
                  viewMode={viewMode}
                  platformsWithData={getPlatformsWithData("churnRate")}
                  right={rightBlockChurnRate(viewMode)}
                />
                <MetricCard currency={currency}
                  label="ARPU"
                  value={formatCurrency(viewMode === "monthly" ? metrics.unified.arpu : metrics.unified.weeklyArpu)}
                  metricKey="arpu"
                  appId={appId}
                  connectedPlatforms={connectedPlatforms}
                  viewMode={viewMode}
                  platformsWithData={getPlatformsWithData("arpu")}
                  right={rightBlockArpu(viewMode)}
                />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <MetricCard currency={currency}
                  label="First Payments"
                  value={metrics.unified.firstPayments}
                  metricKey="firstPayments"
                  appId={appId}
                  connectedPlatforms={connectedPlatforms}
                  viewMode={viewMode}
                  platformsWithData={getPlatformsWithData("firstPayments")}
                  right={rightBlock("firstPayments")}
                />
                <MetricCard currency={currency}
                  label="Renewals"
                  value={metrics.unified.renewals}
                  metricKey="renewals"
                  appId={appId}
                  connectedPlatforms={connectedPlatforms}
                  viewMode={viewMode}
                  platformsWithData={getPlatformsWithData("renewals")}
                  right={rightBlock("renewals")}
                />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <MetricCard currency={currency}
                  label={viewMode === "monthly" ? "Charged Revenue" : "Weekly Charged Rev."}
                  value={formatCurrency(viewMode === "monthly" ? metrics.unified.monthlyChargedRevenue : metrics.unified.weeklyChargedRevenue)}
                  metricKey="monthlyChargedRevenue"
                  appId={appId}
                  connectedPlatforms={connectedPlatforms}
                  viewMode={viewMode}
                  platformsWithData={getPlatformsWithData("monthlyChargedRevenue")}
                  right={rightBlock(viewMode === "monthly" ? "monthlyChargedRevenue" : "weeklyChargedRevenue", true)}
                />
                <MetricCard currency={currency}
                  label={viewMode === "monthly" ? "Revenue" : "Weekly Revenue"}
                  value={formatCurrency(viewMode === "monthly" ? metrics.unified.monthlyRevenue : metrics.unified.weeklyRevenue)}
                  metricKey="monthlyRevenue"
                  appId={appId}
                  connectedPlatforms={connectedPlatforms}
                  viewMode={viewMode}
                  platformsWithData={getPlatformsWithData("monthlyRevenue")}
                  right={rightBlock(viewMode === "monthly" ? "monthlyRevenue" : "weeklyRevenue", true)}
                />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-1 gap-4">
                <MetricCard currency={currency}
                  label="MRR"
                  value={formatCurrency(metrics.unified.mrr)}
                  metricKey="mrr"
                  appId={appId}
                  connectedPlatforms={connectedPlatforms}
                  viewMode={viewMode}
                  platformsWithData={getPlatformsWithData("mrr")}
                  right={rightBlock("mrr", true)}
                />
              </div>
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

            {validateRevenue && (
              <div className="mt-12">
                <h2 className="text-xl font-semibold mb-4">🔍 Revenue Validation (October 2025)</h2>
                <p className="text-sm text-gray-600 mb-4">{validateRevenue.instructions}</p>
                <div className="border border-blue-200 rounded p-4 bg-blue-50 space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    {Object.entries(validateRevenue.octoberTotals).map(([platform, totals]: [string, any]) => (
                      <div key={platform} className="bg-white p-3 rounded border">
                        <div className="font-semibold text-lg capitalize">{platform}</div>
                        <div className="text-sm font-mono">
                          <div>Gross: {formatCurrency(totals.gross)}</div>
                          <div>Net: {formatCurrency(totals.net)}</div>
                          <div>Days: {totals.days}</div>
                          <div>Avg Daily: {formatCurrency(totals.avgDaily)}</div>
                        </div>
                        <div className="text-lg font-bold text-blue-700 mt-2">
                          {validateRevenue.revenueSplitPercentage[platform]} of total
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="bg-white p-3 rounded border">
                    <div className="font-semibold">Total All Platforms (Oct 2025)</div>
                    <div className="text-xl font-mono">
                      Gross: {formatCurrency(validateRevenue.totalAllPlatforms.gross)} | 
                      Net: {formatCurrency(validateRevenue.totalAllPlatforms.net)}
                    </div>
                  </div>
                  <div className="bg-white p-3 rounded border">
                    <div className="font-semibold mb-2">Sample Days for Manual Verification</div>
                    <div className="text-sm font-mono space-y-2">
                      {Object.entries(validateRevenue.sampleDaysForVerification).map(([date, platforms]: [string, any]) => (
                        <div key={date} className="border-b pb-2">
                          <div className="font-bold">{date}:</div>
                          {Object.entries(platforms).map(([p, v]: [string, any]) => (
                            <div key={p} className="ml-4">
                              {p}: Gross {formatCurrency(v.gross)}, Net {formatCurrency(v.net)}
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {debugRevenue && (
              <div className="mt-12">
                <h2 className="text-xl font-semibold mb-4">Debug: Revenue Calculation (30 Days)</h2>
                {debugRevenue.hasDuplicates && (
                  <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded">
                    <h3 className="font-semibold text-red-800 mb-2">⚠️ Duplicate Snapshots Detected!</h3>
                    <p className="text-sm text-red-700 mb-2">Found {debugRevenue.duplicates.length} dates with duplicate snapshots. This will cause revenue to be counted multiple times.</p>
                    <div className="text-sm font-mono space-y-1 mb-3">
                      {debugRevenue.duplicates.slice(0, 10).map((dup: any, idx: number) => (
                        <div key={idx}>
                          {dup.date} ({dup.platform}): {dup.count} snapshots
                        </div>
                      ))}
                      {debugRevenue.duplicates.length > 10 && (
                        <div className="text-gray-600">...and {debugRevenue.duplicates.length - 10} more</div>
                      )}
                    </div>
                    <Button
                      onClick={handleCleanupDuplicates}
                      disabled={cleaningUp}
                      variant="destructive"
                      size="sm"
                    >
                      {cleaningUp ? "Cleaning..." : "Fix: Remove Duplicates"}
                    </Button>
                    {cleanupResult && (
                      <div className={`mt-2 p-2 rounded text-sm ${cleanupResult.error ? 'bg-red-100 text-red-800' : 'bg-green-100 text-green-800'}`}>
                        {cleanupResult.error ? (
                          `Error: ${cleanupResult.error}`
                        ) : (
                          `✓ Deleted ${cleanupResult.duplicatesDeleted} duplicate snapshots. Refresh the page to see updated metrics.`
                        )}
                      </div>
                    )}
                  </div>
                )}
                {debugRevenue.snapshotTotals.appstore.gross > 0 && (
                  <div className="mb-4 p-4 bg-yellow-50 border border-yellow-200 rounded">
                    <h3 className="font-semibold text-yellow-800 mb-2">⚠️ Incorrect App Store Revenue Detected!</h3>
                    <p className="text-sm text-yellow-700 mb-2">
                      App Store shows NOK {formatCurrency(debugRevenue.snapshotTotals.appstore.net)} revenue, but App Store SUMMARY reports don't contain actual transaction data. 
                      This is incorrectly calculated cumulative subscription values, not daily revenue.
                    </p>
                    <Button
                      onClick={handleFixAppStoreRevenue}
                      disabled={fixingAppStore}
                      variant="default"
                      size="sm"
                    >
                      {fixingAppStore ? "Fixing..." : "Fix: Reset App Store Revenue to 0"}
                    </Button>
                    {appStoreFixResult && (
                      <div className={`mt-2 p-2 rounded text-sm ${appStoreFixResult.error ? 'bg-red-100 text-red-800' : 'bg-green-100 text-green-800'}`}>
                        {appStoreFixResult.error ? (
                          `Error: ${appStoreFixResult.error}`
                        ) : (
                          `✓ Fixed ${appStoreFixResult.snapshotsFixed} App Store snapshots. Removed ${formatCurrency(appStoreFixResult.totalRevenueRemoved)} in incorrect revenue. Refresh to see updated metrics.`
                        )}
                      </div>
                    )}
                  </div>
                )}
                <div className="border border-gray-200 rounded p-4 bg-white space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <h3 className="font-semibold mb-2">Snapshot Totals (Sum of 30 days)</h3>
                      <div className="text-sm space-y-1 font-mono">
                        <div>Stripe: {debugRevenue.snapshotTotals.stripe.count} snapshots</div>
                        <div>Stripe Gross: {formatCurrency(debugRevenue.snapshotTotals.stripe.gross)}</div>
                        <div>Stripe Net: {formatCurrency(debugRevenue.snapshotTotals.stripe.net)}</div>
                        <div className="mt-2">App Store: {debugRevenue.snapshotTotals.appstore.count} snapshots</div>
                        <div>App Store Gross: {formatCurrency(debugRevenue.snapshotTotals.appstore.gross)}</div>
                        <div>App Store Net: {formatCurrency(debugRevenue.snapshotTotals.appstore.net)}</div>
                        <div className="font-bold mt-2">Total Net: {formatCurrency(debugRevenue.snapshotTotals.stripe.net + debugRevenue.snapshotTotals.appstore.net)}</div>
                        <div className="text-xs text-gray-600 mt-2">Expected: ~30 snapshots per platform for 30 days</div>
                      </div>
                    </div>
                    <div>
                      <h3 className="font-semibold mb-2">Raw Event Totals (30 Days)</h3>
                      <div className="text-sm space-y-1 font-mono">
                        <div className="font-semibold">Stripe ({debugRevenue.eventTotals.stripe.count} events):</div>
                        <div className="ml-2">Total: {formatCurrency(debugRevenue.eventTotals.stripe.total)}</div>
                        <div className="ml-2">First: {formatCurrency(debugRevenue.eventTotals.stripe.byType.first_payment)} | Renewals: {formatCurrency(debugRevenue.eventTotals.stripe.byType.renewal)}</div>
                        
                        <div className="font-semibold mt-2">App Store ({debugRevenue.eventTotals.appstore.count} events):</div>
                        <div className="ml-2">Total: {formatCurrency(debugRevenue.eventTotals.appstore.total)}</div>
                        <div className="ml-2">First: {formatCurrency(debugRevenue.eventTotals.appstore.byType.first_payment)} | Renewals: {formatCurrency(debugRevenue.eventTotals.appstore.byType.renewal)}</div>
                        
                        {debugRevenue.eventTotals.googleplay.count > 0 && (
                          <>
                            <div className="font-semibold mt-2">Google Play ({debugRevenue.eventTotals.googleplay.count} events):</div>
                            <div className="ml-2">Total: {formatCurrency(debugRevenue.eventTotals.googleplay.total)}</div>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                  
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <h3 className="font-semibold mb-2">Recent Snapshots - Stripe (Last 5 Days)</h3>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead className="bg-gray-50">
                            <tr>
                              <th className="px-2 py-1 text-left">Date</th>
                              <th className="px-2 py-1 text-right">Gross</th>
                              <th className="px-2 py-1 text-right">Net</th>
                            </tr>
                          </thead>
                          <tbody className="font-mono">
                            {debugRevenue.sampleSnapshotsStripe.map((snap: any) => (
                              <tr key={snap.date} className="border-t">
                                <td className="px-2 py-1">{snap.date}</td>
                                <td className="px-2 py-1 text-right">{formatCurrency(snap.monthlyChargedRevenue)}</td>
                                <td className="px-2 py-1 text-right">{formatCurrency(snap.monthlyRevenue)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                    
                    <div>
                      <h3 className="font-semibold mb-2">Recent Snapshots - App Store (Last 5 Days)</h3>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead className="bg-gray-50">
                            <tr>
                              <th className="px-2 py-1 text-left">Date</th>
                              <th className="px-2 py-1 text-right">Gross</th>
                              <th className="px-2 py-1 text-right">Net</th>
                            </tr>
                          </thead>
                          <tbody className="font-mono">
                            {debugRevenue.sampleSnapshotsAppStore.map((snap: any) => (
                              <tr key={snap.date} className="border-t">
                                <td className="px-2 py-1">{snap.date}</td>
                                <td className="px-2 py-1 text-right">{formatCurrency(snap.monthlyChargedRevenue)}</td>
                                <td className="px-2 py-1 text-right">{formatCurrency(snap.monthlyRevenue)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>

                  <div>
                    <h3 className="font-semibold mb-2">Recent Revenue Events (Last 10)</h3>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="px-2 py-1 text-left">Date</th>
                            <th className="px-2 py-1 text-left">Platform</th>
                            <th className="px-2 py-1 text-left">Type</th>
                            <th className="px-2 py-1 text-right">Amount</th>
                          </tr>
                        </thead>
                        <tbody className="font-mono">
                          {debugRevenue.sampleEvents.map((event: any, idx: number) => (
                            <tr key={idx} className="border-t">
                              <td className="px-2 py-1">{event.date}</td>
                              <td className="px-2 py-1">{event.platform}</td>
                              <td className="px-2 py-1">{event.eventType}</td>
                              <td className="px-2 py-1 text-right">{formatCurrency(event.amount)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {debugChurnRate && (
              <div className="mt-12">
                <h2 className="text-xl font-semibold mb-4">Debug: Churn Rate Calculation</h2>
                <p className="text-sm text-gray-600 mb-4">{debugChurnRate.explanation}</p>
                <p className="text-sm text-yellow-700 bg-yellow-50 p-2 rounded mb-4">{debugChurnRate.note}</p>
                <div className="border border-gray-200 rounded p-4 bg-white space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="bg-blue-50 p-3 rounded border">
                      <div className="font-semibold text-lg">30-Day Unified</div>
                      <div className="text-sm font-mono space-y-1">
                        <div>Total Churn: <span className="font-bold">{debugChurnRate.unified30Day.totalChurn}</span></div>
                        <div>Starting Paid Subs: <span className="font-bold">{debugChurnRate.unified30Day.startingSubs}</span></div>
                        <div>Ending Paid Subs: <span className="font-bold">{debugChurnRate.unified30Day.endingSubs}</span></div>
                        <div>Subscriber Delta: <span className={`font-bold ${debugChurnRate.unified30Day.subscriberDelta < 0 ? 'text-red-600' : 'text-green-600'}`}>{debugChurnRate.unified30Day.subscriberDelta}</span></div>
                        <div className="text-lg font-bold text-blue-700 mt-2">
                          Churn Rate: {debugChurnRate.unified30Day.calculatedChurnRate}%
                        </div>
                      </div>
                    </div>
                    <div className="bg-green-50 p-3 rounded border">
                      <div className="font-semibold text-lg">7-Day Unified</div>
                      <div className="text-sm font-mono space-y-1">
                        <div>Total Churn: <span className="font-bold">{debugChurnRate.unified7Day.totalChurn}</span></div>
                        <div>Starting Paid Subs: <span className="font-bold">{debugChurnRate.unified7Day.startingSubs}</span></div>
                        <div>Ending Paid Subs: <span className="font-bold">{debugChurnRate.unified7Day.endingSubs}</span></div>
                        <div>Subscriber Delta: <span className={`font-bold ${debugChurnRate.unified7Day.subscriberDelta < 0 ? 'text-red-600' : 'text-green-600'}`}>{debugChurnRate.unified7Day.subscriberDelta}</span></div>
                        <div className="text-lg font-bold text-green-700 mt-2">
                          Churn Rate: {debugChurnRate.unified7Day.calculatedChurnRate}%
                        </div>
                      </div>
                    </div>
                  </div>
                  
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    {Object.entries(debugChurnRate.platformBreakdown).map(([platform, data]: [string, any]) => (
                      <div key={platform} className="bg-gray-50 p-3 rounded border">
                        <div className="font-semibold capitalize">{platform}</div>
                        <div className="text-xs font-mono space-y-1 mt-2">
                          <div className="font-semibold">30-Day:</div>
                          <div className="ml-2">Churn: {data.totalChurn30d}</div>
                          <div className="ml-2">Start Subs: {data.startingPaidSubs30d}</div>
                          <div className="ml-2">Rate: <span className="font-bold">{data.calculatedChurnRate30d}%</span></div>
                          <div className="font-semibold mt-2">7-Day:</div>
                          <div className="ml-2">Churn: {data.totalChurn7d}</div>
                          <div className="ml-2">Start Subs: {data.startingPaidSubs7d}</div>
                          <div className="ml-2">Rate: <span className="font-bold">{data.calculatedChurnRate7d}%</span></div>
                        </div>
                        <div className="mt-2 text-xs">
                          <div className="font-semibold">Last 10 Days:</div>
                          <div className="max-h-32 overflow-y-auto">
                            {data.dailySnapshots.map((snap: any) => (
                              <div key={snap.date} className="flex justify-between font-mono">
                                <span>{snap.date.slice(5)}</span>
                                <span>churn:{snap.churn} subs:{snap.paidSubs}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                  
                  <p className="text-sm text-orange-700 bg-orange-50 p-2 rounded">{debugChurnRate.suggestion}</p>
                </div>
              </div>
            )}

            <div className="mt-12">
              <h2 className="text-xl font-semibold mb-4">Debug: Monthly Metrics Data</h2>
              <DebugDataTable debugData={debugData} userCurrency={currency} periodType="monthly" />
            </div>

            <div className="mt-12">
              <h2 className="text-xl font-semibold mb-4">Debug: Weekly Metrics Data</h2>
              <DebugDataTable debugData={debugData} userCurrency={currency} periodType="weekly" />
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


const CustomChartTooltip = ({ active, payload, label, currency, config, metricKey, connectedPlatforms, viewMode }: any) => {
  if (!active || !payload || !payload.length) return null;

  const isCurrency = metricKey.toLowerCase().includes("revenue") || metricKey === "mrr" || metricKey === "arpu";
  const isPercent = metricKey === "churnRate";
  const formatValue = (val: number) => {
    if (isPercent) {
      return `${val.toFixed(2)}%`;
    }
    if (isCurrency) {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: currency,
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      }).format(val);
    }
    return new Intl.NumberFormat("en-US").format(val);
  };

  const formatLabel = (dateStr: string) => {
    try {
      if (viewMode === "monthly") {
        // dateStr is "YYYY-MM"
        const [year, month] = dateStr.split("-");
        const date = new Date(parseInt(year), parseInt(month) - 1);
        return date.toLocaleDateString("en-US", {
          month: "long",
          year: "numeric",
        });
      } else {
        // dateStr is "YYYY-MM-DD"
        const date = new Date(dateStr);
        // Fix timezone offset issues by ensuring we interpret as local date components or UTC
        // Assuming dateStr is ISO YYYY-MM-DD. 
        // To match the user request "Week of March 23, 2025", we just need correct day.
        // Using the timezone offset approach to ensure "2025-03-23" is treated as local March 23.
        const userTimezoneOffset = date.getTimezoneOffset() * 60000;
        const localDate = new Date(date.getTime() + userTimezoneOffset);
        return `Week of ${localDate.toLocaleDateString("en-US", {
          month: "long",
          day: "numeric",
          year: "numeric",
        })}`;
      }
    } catch {
      return dateStr;
    }
  };

  // For churn rate, get the unified value from the data point (not sum of percentages)
  // For other metrics, sum the platform values
  const getTotal = () => {
    if (isPercent && payload.length > 0 && payload[0].payload?.unified !== undefined) {
      // Use the pre-calculated unified churn rate from the data
      return payload[0].payload.unified;
    }
    // Sum for other metrics
    return payload.reduce((acc: number, item: any) => acc + (item.value || 0), 0);
  };
  const total = getTotal();

  return (
    <div className="border-border/50 bg-background grid min-w-[13rem] items-start gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs shadow-xl">
      <div className="font-medium mb-1">{formatLabel(label)}</div>
      <div className="grid gap-1.5">
        {payload.map((item: any) => {
          const key = item.dataKey || item.name;
          const itemConfig = config[key];
          const itemLabel = itemConfig?.label || item.name;
          const color = itemConfig?.color || item.stroke || item.fill;

          return (
            <div key={key} className="flex w-full items-center gap-2">
              <div
                className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
                style={{ backgroundColor: color }}
              />
              <div className="text-muted-foreground">{itemLabel}</div>
              <div className="ml-auto font-mono font-medium tabular-nums text-foreground">
                {formatValue(item.value)}
              </div>
            </div>
          );
        })}
        {connectedPlatforms.length > 1 && (
          <div className="mt-2 flex w-full items-center gap-2 border-t pt-2 font-medium">
            <div className="text-foreground">{isPercent ? "Unified" : "Total"}</div>
            <div className="ml-auto font-mono font-medium tabular-nums text-foreground">
              {formatValue(total)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// Revenue-based metrics that are marked as LOW TRUST
const LOW_TRUST_METRICS = new Set([
  "monthlyChargedRevenue",
  "monthlyRevenue",
  "weeklyChargedRevenue", 
  "weeklyRevenue",
  "mrr",
]);

function MetricCard({
  label,
  value,
  metricKey,
  appId,
  right,
  connectedPlatforms,
  viewMode,
  currency,
  platformsWithData,
}: {
  label: string;
  value: string | number;
  metricKey: string;
  appId: any;
  right?: React.ReactNode;
  connectedPlatforms: string[];
  viewMode: "monthly" | "weekly";
  currency: string;
  platformsWithData?: string[];
}) {
  const isLowTrust = LOW_TRUST_METRICS.has(metricKey);
  const isIncomplete = platformsWithData 
    ? connectedPlatforms.some(p => !platformsWithData.includes(p))
    : false;
  const weeklyData = useQuery(api.queries.getWeeklyMetricsHistory, { appId, metric: metricKey });
  const monthlyData = useQuery(api.queries.getMonthlyMetricsHistory, { appId, metric: metricKey });
  
  const chartData = viewMode === "monthly" ? monthlyData : weeklyData;
  const dateKey = viewMode === "monthly" ? "month" : "week";

  const change = useMemo(() => {
    if (!chartData || chartData.length < 2) return null;

    // Sort by date (oldest to newest)
    const sorted = [...chartData].sort((a, b) => {
      const aKey = (a as any)[dateKey];
      const bKey = (b as any)[dateKey];
      return aKey.localeCompare(bKey);
    });

    // Filter to only complete periods for accurate comparison
    // Incomplete periods (current week/month) have partial data and would show misleading % changes
    const completePeriods = sorted.filter((p: any) => !p.isIncomplete);
    
    if (completePeriods.length < 2) return null;

    // Compare the last two complete periods
    const currentPoint = completePeriods[completePeriods.length - 1];
    const previousPoint = completePeriods[completePeriods.length - 2];
    if (!currentPoint || !previousPoint) return null;

    const currentValue = currentPoint.unified ?? 0;
    const previousValue = previousPoint.unified ?? 0;
    if (previousValue === 0) return null;

    const percentChange = ((currentValue - previousValue) / previousValue) * 100;
    return {
      value: percentChange,
      type: percentChange >= 0 ? "positive" : "negative",
      formatted: `${percentChange >= 0 ? "+" : ""}${percentChange.toFixed(1)}%`,
    };
  }, [chartData, dateKey]);

  const chartConfig = {
    appstore: { label: "iOS App Store", color: "var(--color-platform-appstore)" },
    googleplay: { label: "Google Play", color: "var(--color-platform-googleplay)" },
    stripe: { label: "Stripe", color: "var(--color-platform-stripe)" },
  } satisfies ChartConfig;

  return (
    <Card className="p-0 gap-0">
      <CardContent className="p-6 pb-5">
        <dd className="flex items-start justify-between space-x-2">
          <div className="truncate font-medium text-base text-muted-foreground">
            <div className="flex items-center gap-2">
              {label}
              {isIncomplete && (
                <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-amber-100 text-amber-700 rounded">
                  Incomplete
                </span>
              )}
              {isLowTrust && (
                <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-rose-100 text-rose-700 rounded">
                  Low Trust
                </span>
              )}
            </div>

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
          config={chartConfig}
        >
          {chartData && chartData.length > 0 ? (
            <LineChart data={chartData} margin={{ left: 0, right: 0, top: 5, bottom: 5 }}>
              <CartesianGrid vertical={false} />
              <XAxis 
                dataKey={dateKey}
                hide={false}
                tickMargin={8}
                minTickGap={16}
                tickFormatter={(value) => {
                  try {
                    if (viewMode === "monthly") {
                      // Format YYYY-MM as "Jan 2024"
                      const [year, month] = value.split("-");
                      const date = new Date(parseInt(year), parseInt(month) - 1, 1);
                      return date.toLocaleDateString("en-US", {
                        month: "short",
                        year: "numeric",
                      });
                    }
                    const date = new Date(value);
                    if (!isNaN(date.getTime())) {
                      return date.toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                      });
                    }
                  } catch {
                    // fallback
                  }
                  return value;
                }}
              />
              <YAxis hide />
              <ChartTooltip
                cursor={false}
                content={
                  <CustomChartTooltip
                    currency={currency}
                    config={chartConfig}
                    metricKey={metricKey}
                    connectedPlatforms={connectedPlatforms}
                    viewMode={viewMode}
                  />
                }
              />
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

