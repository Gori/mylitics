import { query } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "./auth";

async function getUserId(ctx: any) {
  const userId = await getAuthUserId(ctx);
  return userId || null;
}

async function validateAppOwnership(ctx: any, appId: string) {
  const userId = await getUserId(ctx);
  if (!userId) throw new Error("Not authenticated");
  
  const app = await ctx.db.get(appId);
  if (!app) throw new Error("App not found");
  if (app.userId !== userId) throw new Error("Not authorized");
  
  return app;
}

function getWeekStart(date: Date, weekStartDay: "monday" | "sunday"): Date {
  const weekStart = new Date(date);
  if (weekStartDay === "monday") {
    const dayOfWeek = date.getDay();
    const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    weekStart.setDate(date.getDate() - daysFromMonday);
  } else {
    weekStart.setDate(date.getDate() - date.getDay());
  }
  return weekStart;
}

// Shared churn rate calculation - single source of truth
// Formula: (churn count / starting paid subscribers) × 100
function calculateChurnRate(churnCount: number, startingPaidSubscribers: number): number {
  if (startingPaidSubscribers <= 0) return 0;
  const rate = (churnCount / startingPaidSubscribers) * 100;
  return Math.round((rate + Number.EPSILON) * 100) / 100; // Round to 2 decimals
}

// Shared ARPU calculation - single source of truth
// Formula: revenue / active subscribers
function calculateArpu(revenue: number, activeSubscribers: number): number {
  if (activeSubscribers <= 0) return 0;
  return Math.round((revenue / activeSubscribers + Number.EPSILON) * 100) / 100; // Round to 2 decimals
}

export const getLatestMetrics = query({
  args: { appId: v.id("apps") },
  handler: async (ctx, { appId }) => {
    await validateAppOwnership(ctx, appId);

    const now = new Date();
    const today = now.toISOString().split("T")[0];
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    
    const dateRangeStart = thirtyDaysAgo.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const dateRangeEnd = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

    const connections = await ctx.db
      .query("platformConnections")
      .withIndex("by_app", (q) => q.eq("appId", appId))
      .filter((q) => q.eq(q.field("isActive"), true))
      .collect();

    const lastSync = Math.max(...connections.map((c) => c.lastSync || 0));
    const activePlatforms = new Set(connections.map((c) => c.platform));

    // Flow metrics (sum over 30 days for monthly, 7 days for weekly)
    const flowMetrics = [
      "cancellations",
      "churn",
      "graceEvents",
      "firstPayments",
      "renewals",
      "weeklyChargedRevenue",
      "weeklyRevenue",
      "monthlyChargedRevenue",
      "monthlyRevenue",
    ];

    // Get the most recent snapshots for each platform (for stock metrics)
    const recentSnapshots = await ctx.db
      .query("metricsSnapshots")
      .withIndex("by_app_date", (q) => q.eq("appId", appId))
      .filter((q) => q.neq(q.field("platform"), "unified"))
      .order("desc")
      .take(100);

    // Get latest snapshot per platform for stock metrics
    // For Google Play, find the most recent snapshot with actual subscription data
    // (Google Play reports have ~2-3 day delay, so latest snapshot may have 0 subscribers)
    const latestByPlatform: Record<string, any> = {};
    const latestWithSubsByPlatform: Record<string, any> = {};
    
    for (const snap of recentSnapshots) {
      if (!latestByPlatform[snap.platform]) {
        latestByPlatform[snap.platform] = snap;
      }
      // Track the most recent snapshot with actual subscription data
      if (!latestWithSubsByPlatform[snap.platform] && snap.activeSubscribers > 0) {
        latestWithSubsByPlatform[snap.platform] = snap;
      }
    }
    
    // For Google Play, use subscription data from the most recent snapshot that has it
    if (latestByPlatform.googleplay) {
      const latest = latestByPlatform.googleplay;
      const latestWithSubs = latestWithSubsByPlatform.googleplay;
      
      // If latest has 0 subscribers but we have older data with subscribers, use that
      if (latest.activeSubscribers === 0 && latestWithSubs && latestWithSubs.activeSubscribers > 0) {
        latestByPlatform.googleplay = {
          ...latest,
          activeSubscribers: latestWithSubs.activeSubscribers,
          trialSubscribers: latestWithSubs.trialSubscribers,
          paidSubscribers: latestWithSubs.paidSubscribers,
          monthlySubscribers: latestWithSubs.monthlySubscribers,
          yearlySubscribers: latestWithSubs.yearlySubscribers,
          mrr: latestWithSubs.mrr,
        };
      }
    }

    // Get 30-day snapshots for summing flow metrics
    const snapshots30 = await ctx.db
      .query("metricsSnapshots")
      .withIndex("by_app_date", (q) => q.eq("appId", appId))
      .filter((q) => q.gte(q.field("date"), thirtyDaysAgo.toISOString().split("T")[0]))
      .filter((q) => q.neq(q.field("platform"), "unified"))
      .collect();

    // Find the most recent date with complete data from all active platforms
    const snapshotsByDate: Record<string, Set<string>> = {};
    for (const snap of snapshots30) {
      if (!snapshotsByDate[snap.date]) {
        snapshotsByDate[snap.date] = new Set();
      }
      snapshotsByDate[snap.date].add(snap.platform);
    }
    
    // Find the most recent date where all active platforms have data
    const sortedDates = Object.keys(snapshotsByDate).sort((a, b) => b.localeCompare(a)); // newest first
    let mostRecentCompleteDate = sortedDates[0] || today; // fallback to most recent date or today
    if (activePlatforms.size > 0) {
      for (const date of sortedDates) {
        const platformsOnDate = snapshotsByDate[date];
        const hasAllPlatforms = Array.from(activePlatforms).every(p => platformsOnDate.has(p));
        if (hasAllPlatforms) {
          mostRecentCompleteDate = date;
          break;
        }
      }
    }
    
    // Calculate 7-day date range ending at mostRecentCompleteDate
    const endDate = new Date(mostRecentCompleteDate);
    const sevenDaysAgo = new Date(endDate);
    sevenDaysAgo.setDate(endDate.getDate() - 6); // 7 days including the end date
    const sevenDaysAgoStr = sevenDaysAgo.toISOString().split("T")[0];

    // Filter snapshots for 7-day calculations
    const snapshots7 = snapshots30.filter(snap => 
      snap.date >= sevenDaysAgoStr && snap.date <= mostRecentCompleteDate
    );

    // Calculate 30-day sums for flow metrics by platform
    // Also track starting paid subscribers for churn rate calculation
    const flowSumsByPlatform: Record<string, any> = {};
    const startingPaidSubsByPlatform30: Record<string, number> = {};
    
    // Sort snapshots by date to find the earliest (starting) values
    const sortedSnapshots30 = [...snapshots30].sort((a, b) => a.date.localeCompare(b.date));
    
    for (const snap of sortedSnapshots30) {
      if (!flowSumsByPlatform[snap.platform]) {
        flowSumsByPlatform[snap.platform] = {
          cancellations: 0,
          churn: 0,
          graceEvents: 0,
          firstPayments: 0,
          renewals: 0,
          monthlyChargedRevenue: 0,
          monthlyRevenue: 0,
        };
        // First snapshot for this platform = starting paid subscribers
        startingPaidSubsByPlatform30[snap.platform] = snap.paidSubscribers || 0;
      }
      flowSumsByPlatform[snap.platform].cancellations += snap.cancellations;
      flowSumsByPlatform[snap.platform].churn += snap.churn;
      flowSumsByPlatform[snap.platform].graceEvents += snap.graceEvents;
      flowSumsByPlatform[snap.platform].firstPayments += snap.firstPayments;
      flowSumsByPlatform[snap.platform].renewals += (snap.renewals || 0);
      flowSumsByPlatform[snap.platform].monthlyChargedRevenue += snap.monthlyChargedRevenue;
      flowSumsByPlatform[snap.platform].monthlyRevenue += snap.monthlyRevenue;
    }

    // Calculate 7-day sums for weekly revenue and churn by platform
    const weeklySumsByPlatform: Record<string, any> = {};
    const startingPaidSubsByPlatform7: Record<string, number> = {};
    
    // Sort snapshots by date to find the earliest (starting) values
    const sortedSnapshots7 = [...snapshots7].sort((a, b) => a.date.localeCompare(b.date));
    
    for (const snap of sortedSnapshots7) {
      if (!weeklySumsByPlatform[snap.platform]) {
        weeklySumsByPlatform[snap.platform] = {
          weeklyChargedRevenue: 0,
          weeklyRevenue: 0,
          weeklyChurn: 0,
        };
        // First snapshot for this platform = starting paid subscribers
        startingPaidSubsByPlatform7[snap.platform] = snap.paidSubscribers || 0;
      }
      weeklySumsByPlatform[snap.platform].weeklyChargedRevenue += snap.monthlyChargedRevenue;
      weeklySumsByPlatform[snap.platform].weeklyRevenue += snap.monthlyRevenue;
      weeklySumsByPlatform[snap.platform].weeklyChurn += snap.churn || 0;
    }

    // Build platformMap with correct values for each metric type
    const platformMap: Record<string, any> = {};
    for (const platform of ["appstore", "googleplay", "stripe"]) {
      const latest = latestByPlatform[platform];
      const flowSums = flowSumsByPlatform[platform];
      const weeklySums = weeklySumsByPlatform[platform];
      
      // Only include platform in map if it has at least one snapshot
      if (!latest && !flowSums) {
        continue;
      }
      
      // Stock metrics from latest snapshot, flow metrics from 30-day sums, weekly from 7-day sums
      // Calculate churn rates using the shared helper function
      const monthlyChurnRate = calculateChurnRate(
        flowSums?.churn || 0,
        startingPaidSubsByPlatform30[platform] || 0
      );
      const weeklyChurnRate = calculateChurnRate(
        weeklySums?.weeklyChurn || 0,
        startingPaidSubsByPlatform7[platform] || 0
      );
      
      // Calculate ARPU: revenue / active subscribers
      const platformActiveSubscribers = latest?.activeSubscribers || 0;
      const monthlyArpu = calculateArpu(flowSums?.monthlyRevenue || 0, platformActiveSubscribers);
      const weeklyArpu = calculateArpu(weeklySums?.weeklyRevenue || 0, platformActiveSubscribers);
      
      platformMap[platform] = {
        activeSubscribers: platformActiveSubscribers,
        trialSubscribers: latest?.trialSubscribers || 0,
        paidSubscribers: latest?.paidSubscribers || 0,
        mrr: latest?.mrr || 0,
        cancellations: flowSums?.cancellations || 0,
        churn: flowSums?.churn || 0,
        churnRate: monthlyChurnRate,
        weeklyChurnRate: weeklyChurnRate,
        arpu: monthlyArpu,
        weeklyArpu: weeklyArpu,
        graceEvents: flowSums?.graceEvents || 0,
        firstPayments: flowSums?.firstPayments || 0,
        renewals: flowSums?.renewals || 0,
        weeklyChargedRevenue: weeklySums?.weeklyChargedRevenue || 0,
        weeklyRevenue: weeklySums?.weeklyRevenue || 0,
        monthlyChargedRevenue: flowSums?.monthlyChargedRevenue || 0,
        monthlyRevenue: flowSums?.monthlyRevenue || 0,
        monthlySubscribers: latest?.monthlySubscribers || 0,
        yearlySubscribers: latest?.yearlySubscribers || 0,
      };
    }

    // Calculate unified by summing all platforms (use 0 if platform not in map)
    // For churn rate, calculate from total churn / total starting subscribers (not average of rates)
    const totalChurn = (platformMap.appstore?.churn || 0) + (platformMap.googleplay?.churn || 0) + (platformMap.stripe?.churn || 0);
    const totalStartingPaidSubs30 = (startingPaidSubsByPlatform30.appstore || 0) + (startingPaidSubsByPlatform30.googleplay || 0) + (startingPaidSubsByPlatform30.stripe || 0);
    const totalWeeklyChurn = (weeklySumsByPlatform.appstore?.weeklyChurn || 0) + (weeklySumsByPlatform.googleplay?.weeklyChurn || 0) + (weeklySumsByPlatform.stripe?.weeklyChurn || 0);
    const totalStartingPaidSubs7 = (startingPaidSubsByPlatform7.appstore || 0) + (startingPaidSubsByPlatform7.googleplay || 0) + (startingPaidSubsByPlatform7.stripe || 0);
    
    // Calculate unified ARPU from total revenue / total active subscribers
    const totalActiveSubscribers = (platformMap.appstore?.activeSubscribers || 0) + (platformMap.googleplay?.activeSubscribers || 0) + (platformMap.stripe?.activeSubscribers || 0);
    const totalMonthlyRevenue = (platformMap.appstore?.monthlyRevenue || 0) + (platformMap.googleplay?.monthlyRevenue || 0) + (platformMap.stripe?.monthlyRevenue || 0);
    const totalWeeklyRevenue = (platformMap.appstore?.weeklyRevenue || 0) + (platformMap.googleplay?.weeklyRevenue || 0) + (platformMap.stripe?.weeklyRevenue || 0);
    
    const unified = {
      activeSubscribers: totalActiveSubscribers,
      trialSubscribers: (platformMap.appstore?.trialSubscribers || 0) + (platformMap.googleplay?.trialSubscribers || 0) + (platformMap.stripe?.trialSubscribers || 0),
      paidSubscribers: (platformMap.appstore?.paidSubscribers || 0) + (platformMap.googleplay?.paidSubscribers || 0) + (platformMap.stripe?.paidSubscribers || 0),
      cancellations: (platformMap.appstore?.cancellations || 0) + (platformMap.googleplay?.cancellations || 0) + (platformMap.stripe?.cancellations || 0),
      churn: totalChurn,
      churnRate: calculateChurnRate(totalChurn, totalStartingPaidSubs30),
      weeklyChurnRate: calculateChurnRate(totalWeeklyChurn, totalStartingPaidSubs7),
      arpu: calculateArpu(totalMonthlyRevenue, totalActiveSubscribers),
      weeklyArpu: calculateArpu(totalWeeklyRevenue, totalActiveSubscribers),
      graceEvents: (platformMap.appstore?.graceEvents || 0) + (platformMap.googleplay?.graceEvents || 0) + (platformMap.stripe?.graceEvents || 0),
      paybacks: 0,
      firstPayments: (platformMap.appstore?.firstPayments || 0) + (platformMap.googleplay?.firstPayments || 0) + (platformMap.stripe?.firstPayments || 0),
      renewals: (platformMap.appstore?.renewals || 0) + (platformMap.googleplay?.renewals || 0) + (platformMap.stripe?.renewals || 0),
      weeklyChargedRevenue: Math.round(((platformMap.appstore?.weeklyChargedRevenue || 0) + (platformMap.googleplay?.weeklyChargedRevenue || 0) + (platformMap.stripe?.weeklyChargedRevenue || 0) + Number.EPSILON) * 100) / 100,
      weeklyRevenue: Math.round((totalWeeklyRevenue + Number.EPSILON) * 100) / 100,
      mrr: Math.round(((platformMap.appstore?.mrr || 0) + (platformMap.googleplay?.mrr || 0) + (platformMap.stripe?.mrr || 0) + Number.EPSILON) * 100) / 100,
      monthlyChargedRevenue: Math.round(((platformMap.appstore?.monthlyChargedRevenue || 0) + (platformMap.googleplay?.monthlyChargedRevenue || 0) + (platformMap.stripe?.monthlyChargedRevenue || 0) + Number.EPSILON) * 100) / 100,
      monthlyRevenue: Math.round((totalMonthlyRevenue + Number.EPSILON) * 100) / 100,
      monthlySubscribers: (platformMap.appstore?.monthlySubscribers || 0) + (platformMap.googleplay?.monthlySubscribers || 0) + (platformMap.stripe?.monthlySubscribers || 0),
      yearlySubscribers: (platformMap.appstore?.yearlySubscribers || 0) + (platformMap.googleplay?.yearlySubscribers || 0) + (platformMap.stripe?.yearlySubscribers || 0),
    };

    return {
      unified,
      platformMap,
      flowMetrics,
      lastSync: lastSync || null,
      dateRange: `${dateRangeStart} - ${dateRangeEnd}`,
      connectedPlatforms: Array.from(activePlatforms),
    } as const;
  },
});

export const getMetricsHistory = query({
  args: {
    appId: v.id("apps"),
    days: v.optional(v.number()),
  },
  handler: async (ctx, { appId, days = 30 }) => {
    await validateAppOwnership(ctx, appId);

    const snapshots = await ctx.db
      .query("metricsSnapshots")
      .withIndex("by_app_platform", (q) =>
        q.eq("appId", appId).eq("platform", "unified")
      )
      .order("desc")
      .take(days);

    return snapshots.reverse();
  },
});

export const getPlatformConnections = query({
  args: { appId: v.id("apps") },
  handler: async (ctx, { appId }) => {
    await validateAppOwnership(ctx, appId);

    const connections = await ctx.db
      .query("platformConnections")
      .withIndex("by_app", (q) => q.eq("appId", appId))
      .filter((q) => q.eq(q.field("isActive"), true))
      .collect();

    return connections.map((c) => ({
      _id: c._id,
      platform: c.platform,
      lastSync: c.lastSync,
      credentials: c.credentials,
    }));
  },
});

export const getUserPreferences = query({
  args: { appId: v.id("apps") },
  handler: async (ctx, { appId }) => {
    const app = await validateAppOwnership(ctx, appId);
    
    return {
      currency: app.currency || "USD",
    };
  },
});

export const getSyncLogs = query({
  args: {
    appId: v.id("apps"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { appId, limit = 50 }) => {
    await validateAppOwnership(ctx, appId);
    return await ctx.db
      .query("syncLogs")
      .withIndex("by_app_time", (q) => q.eq("appId", appId))
      .order("desc")
      .take(limit);
  },
});

export const getWeeklyMetricsHistory = query({
  args: {
    appId: v.id("apps"),
    metric: v.string(),
  },
  handler: async (ctx, { appId, metric }) => {
    const app = await validateAppOwnership(ctx, appId);

    const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    
    // Determine which platforms actually have data by checking for snapshots
    // (not just active connections, since a platform might be connected but not synced yet)
    const allSnapshots = await ctx.db
      .query("metricsSnapshots")
      .withIndex("by_app_date", (q) => q.eq("appId", appId))
      .filter((q) => q.gte(q.field("date"), oneYearAgo))
      .collect();
    
    const platformsWithData = new Set(
      allSnapshots
        .filter((s) => s.platform !== "unified")
        .map((s) => s.platform)
    );
    
    const activePlatforms = platformsWithData;
    
    // Special handling for churnRate and arpu - they're calculated metrics
    const isChurnRate = metric === "churnRate";
    const isArpu = metric === "arpu";
    
    // Determine if this is a flow metric (sum weekly) or stock metric (last value)
    const flowMetrics = [
      "cancellations",
      "churn",
      "graceEvents",
      "firstPayments",
      "renewals",
      "weeklyRevenue",
      "monthlyChargedRevenue",
      "monthlyRevenue",
    ];
    const isFlowMetric = flowMetrics.includes(metric) || isChurnRate || isArpu; // churnRate and arpu use flow logic

    // Use the snapshots we already fetched
    const snapshots = allSnapshots;

    // Group by week and platform
    // For churnRate, we need both churn (sum) and paidSubscribers (first value of week)
    // For arpu, we need revenue (sum) and activeSubscribers (last value of week)
    const weeklyData: Record<string, Record<string, { sum: number; last: number; lastDate: string; churnSum?: number; startingPaidSubs?: number; firstDate?: string; revenueSum?: number; lastActiveSubscribers?: number }>> = {};
    
    for (const snap of snapshots) {
      // Skip unified platform - we'll calculate it from the sum of platforms
      if (snap.platform === "unified") continue;

      const date = new Date(snap.date);
      const weekStart = getWeekStart(date, app.weekStartDay || "monday");
      const weekKey = weekStart.toISOString().split("T")[0];
      
      if (!weeklyData[weekKey]) weeklyData[weekKey] = {} as any;
      const value = (isChurnRate || isArpu) ? 0 : ((snap as any)[metric] || 0); // For calculated metrics, we calculate separately
      const entry = weeklyData[weekKey][snap.platform] || { sum: 0, last: 0, lastDate: "", churnSum: 0, startingPaidSubs: 0, firstDate: "9999-99-99", revenueSum: 0, lastActiveSubscribers: 0 };
      entry.sum += value;
      // Only update last if this is a more recent date
      if (snap.date >= entry.lastDate) {
        entry.last = value;
        entry.lastDate = snap.date;
      }
      
      // For churnRate calculation: track churn sum and starting paid subscribers
      if (isChurnRate) {
        entry.churnSum = (entry.churnSum || 0) + (snap.churn || 0);
        // Track the earliest date's paidSubscribers as "starting"
        if (snap.date < (entry.firstDate || "9999-99-99")) {
          entry.startingPaidSubs = snap.paidSubscribers || 0;
          entry.firstDate = snap.date;
        }
      }
      
      // For arpu calculation: track revenue sum and last active subscribers
      if (isArpu) {
        entry.revenueSum = (entry.revenueSum || 0) + (snap.monthlyRevenue || 0);
        // Track the most recent date's activeSubscribers
        if (snap.date >= entry.lastDate) {
          entry.lastActiveSubscribers = snap.activeSubscribers || 0;
        }
      }
      
      weeklyData[weekKey][snap.platform] = entry;
    }

    // Stock metrics that should show null (line stops) when value is 0 for Google Play
    // These are subscription counts that come from delayed reports
    const stockMetrics = [
      "activeSubscribers",
      "trialSubscribers", 
      "paidSubscribers",
      "monthlySubscribers",
      "yearlySubscribers",
      "mrr",
    ];
    const isStockMetric = stockMetrics.includes(metric);

    // Convert to array, filter incomplete weeks, and sort by date
    const result = Object.entries(weeklyData)
      .map(([week, platforms]) => {
        // Check if all active platforms have data for this week
        const platformsInWeek = new Set(Object.keys(platforms));
        const hasAllPlatforms = Array.from(activePlatforms).every((p) => platformsInWeek.has(p));
        
        // For churnRate, calculate using the shared helper
        if (isChurnRate) {
          const getChurnRate = (p?: { churnSum?: number; startingPaidSubs?: number }) => {
            if (!p) return null;
            return calculateChurnRate(p.churnSum || 0, p.startingPaidSubs || 0);
          };
          const appstore = getChurnRate((platforms as any).appstore);
          const googleplay = getChurnRate((platforms as any).googleplay);
          const stripe = getChurnRate((platforms as any).stripe);
          
          // Calculate unified churn rate from totals (not average of rates)
          const totalChurn = ((platforms as any).appstore?.churnSum || 0) + ((platforms as any).googleplay?.churnSum || 0) + ((platforms as any).stripe?.churnSum || 0);
          const totalStartingSubs = ((platforms as any).appstore?.startingPaidSubs || 0) + ((platforms as any).googleplay?.startingPaidSubs || 0) + ((platforms as any).stripe?.startingPaidSubs || 0);
          const unified = calculateChurnRate(totalChurn, totalStartingSubs);
          
          return {
            week,
            appstore,
            googleplay,
            stripe,
            unified,
            hasAllPlatforms,
            hasValidStockData: true, // churnRate is always valid if we have data
          };
        }
        
        // For arpu, calculate using the shared helper
        if (isArpu) {
          const getArpu = (p?: { revenueSum?: number; lastActiveSubscribers?: number }) => {
            if (!p) return null;
            return calculateArpu(p.revenueSum || 0, p.lastActiveSubscribers || 0);
          };
          const appstore = getArpu((platforms as any).appstore);
          const googleplay = getArpu((platforms as any).googleplay);
          const stripe = getArpu((platforms as any).stripe);
          
          // Calculate unified ARPU from total revenue / total active subscribers
          const totalRevenue = ((platforms as any).appstore?.revenueSum || 0) + ((platforms as any).googleplay?.revenueSum || 0) + ((platforms as any).stripe?.revenueSum || 0);
          const totalActiveSubs = ((platforms as any).appstore?.lastActiveSubscribers || 0) + ((platforms as any).googleplay?.lastActiveSubscribers || 0) + ((platforms as any).stripe?.lastActiveSubscribers || 0);
          const unified = calculateArpu(totalRevenue, totalActiveSubs);
          
          return {
            week,
            appstore,
            googleplay,
            stripe,
            unified,
            hasAllPlatforms,
            hasValidStockData: true, // arpu is always valid if we have data
          };
        }
        
        // For flow metrics, use sum of all days in the week; for stock metrics, use last day
        // Return null if platform has no data for this week (so chart line stops instead of dropping to 0)
        const val = (p?: { sum: number; last: number; lastDate: string }) => (p ? (isFlowMetric ? p.sum : p.last) : null);
        const appstore = val((platforms as any).appstore);
        let googleplay = val((platforms as any).googleplay);
        const stripe = val((platforms as any).stripe);
        
        // For Google Play subscriber/stock metrics, treat 0 as null (no data) so line stops
        // Google Play subscription reports have delays, so 0 means no data, not zero subscribers
        // MRR is calculated from subscriber data, so 0 MRR also indicates missing data
        const googlePlayDelayedMetrics = ["activeSubscribers", "trialSubscribers", "paidSubscribers", "monthlySubscribers", "yearlySubscribers", "mrr"];
        if (googlePlayDelayedMetrics.includes(metric) && googleplay === 0) {
          googleplay = null;
        }
        
        // Round currency values to 2 decimals
        const isCurrencyMetric = ["mrr", "weeklyRevenue", "monthlyChargedRevenue", "monthlyRevenue"].includes(metric);
        // Sum only platforms that have data (null values are excluded)
        const sum = (appstore ?? 0) + (googleplay ?? 0) + (stripe ?? 0);
        const unified = isCurrencyMetric 
          ? Math.round((sum + Number.EPSILON) * 100) / 100
          : sum;
        
        // For stock metrics, check if all active platforms have valid (non-null) values
        // This is crucial for accurate percentage change calculations
        const hasValidStockData = !isStockMetric || Array.from(activePlatforms).every((p) => {
          if (p === 'appstore') return appstore !== null;
          if (p === 'googleplay') return googleplay !== null;
          if (p === 'stripe') return stripe !== null;
          return true;
        });
        
        return {
          week,
          appstore,
          googleplay,
          stripe,
          unified,
          hasAllPlatforms,
          hasValidStockData,
        };
      })
      .map((w) => {
        // Check if week is incomplete: missing platforms, current/future week, or missing stock data
        const weekEnd = new Date(w.week);
        weekEnd.setDate(weekEnd.getDate() + 6); // End of week
        const isCurrentOrFutureWeek = weekEnd >= new Date();
        const isIncomplete = !w.hasAllPlatforms || isCurrentOrFutureWeek || !w.hasValidStockData;
        
        return { ...w, isIncomplete };
      })
      .sort((a, b) => a.week.localeCompare(b.week))
      .slice(-52); // Keep last 52 weeks

    return result;
  },
});

export const getMonthlyMetricsHistory = query({
  args: {
    appId: v.id("apps"),
    metric: v.string(),
  },
  handler: async (ctx, { appId, metric }) => {
    await validateAppOwnership(ctx, appId);

    const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    
    const allSnapshots = await ctx.db
      .query("metricsSnapshots")
      .withIndex("by_app_date", (q) => q.eq("appId", appId))
      .filter((q) => q.gte(q.field("date"), oneYearAgo))
      .collect();
    
    const platformsWithData = new Set(
      allSnapshots
        .filter((s) => s.platform !== "unified")
        .map((s) => s.platform)
    );
    
    const activePlatforms = platformsWithData;
    
    // Special handling for churnRate and arpu - they're calculated metrics
    const isChurnRate = metric === "churnRate";
    const isArpu = metric === "arpu";
    
    const flowMetrics = [
      "cancellations",
      "churn",
      "graceEvents",
      "firstPayments",
      "renewals",
      "weeklyRevenue",
      "monthlyChargedRevenue",
      "monthlyRevenue",
    ];
    const isFlowMetric = flowMetrics.includes(metric) || isChurnRate || isArpu; // churnRate and arpu use flow logic

    const snapshots = allSnapshots;

    // Group by month (YYYY-MM) and platform
    // For churnRate, we need both churn (sum) and paidSubscribers (first value of month)
    // For arpu, we need revenue (sum) and activeSubscribers (last value of month)
    const monthlyData: Record<string, Record<string, { sum: number; last: number; lastDate: string; churnSum?: number; startingPaidSubs?: number; firstDate?: string; revenueSum?: number; lastActiveSubscribers?: number }>> = {};
    
    for (const snap of snapshots) {
      if (snap.platform === "unified") continue;

      // Extract YYYY-MM from date
      const monthKey = snap.date.substring(0, 7);
      
      if (!monthlyData[monthKey]) monthlyData[monthKey] = {} as any;
      const value = (isChurnRate || isArpu) ? 0 : ((snap as any)[metric] || 0); // For calculated metrics, we calculate separately
      const entry = monthlyData[monthKey][snap.platform] || { sum: 0, last: 0, lastDate: "", churnSum: 0, startingPaidSubs: 0, firstDate: "9999-99-99", revenueSum: 0, lastActiveSubscribers: 0 };
      entry.sum += value;
      if (snap.date >= entry.lastDate) {
        entry.last = value;
        entry.lastDate = snap.date;
      }
      
      // For churnRate calculation: track churn sum and starting paid subscribers
      if (isChurnRate) {
        entry.churnSum = (entry.churnSum || 0) + (snap.churn || 0);
        // Track the earliest date's paidSubscribers as "starting"
        if (snap.date < (entry.firstDate || "9999-99-99")) {
          entry.startingPaidSubs = snap.paidSubscribers || 0;
          entry.firstDate = snap.date;
        }
      }
      
      // For arpu calculation: track revenue sum and last active subscribers
      if (isArpu) {
        entry.revenueSum = (entry.revenueSum || 0) + (snap.monthlyRevenue || 0);
        // Track the most recent date's activeSubscribers
        if (snap.date >= entry.lastDate) {
          entry.lastActiveSubscribers = snap.activeSubscribers || 0;
        }
      }
      
      monthlyData[monthKey][snap.platform] = entry;
    }

    const stockMetrics = [
      "activeSubscribers",
      "trialSubscribers", 
      "paidSubscribers",
      "monthlySubscribers",
      "yearlySubscribers",
      "mrr",
    ];
    const isStockMetric = stockMetrics.includes(metric);

    const result = Object.entries(monthlyData)
      .map(([month, platforms]) => {
        const platformsInMonth = new Set(Object.keys(platforms));
        const hasAllPlatforms = Array.from(activePlatforms).every((p) => platformsInMonth.has(p));
        
        // For churnRate, calculate using the shared helper
        if (isChurnRate) {
          const getChurnRate = (p?: { churnSum?: number; startingPaidSubs?: number }) => {
            if (!p) return null;
            return calculateChurnRate(p.churnSum || 0, p.startingPaidSubs || 0);
          };
          const appstore = getChurnRate((platforms as any).appstore);
          const googleplay = getChurnRate((platforms as any).googleplay);
          const stripe = getChurnRate((platforms as any).stripe);
          
          // Calculate unified churn rate from totals (not average of rates)
          const totalChurn = ((platforms as any).appstore?.churnSum || 0) + ((platforms as any).googleplay?.churnSum || 0) + ((platforms as any).stripe?.churnSum || 0);
          const totalStartingSubs = ((platforms as any).appstore?.startingPaidSubs || 0) + ((platforms as any).googleplay?.startingPaidSubs || 0) + ((platforms as any).stripe?.startingPaidSubs || 0);
          const unified = calculateChurnRate(totalChurn, totalStartingSubs);
          
          return {
            month,
            appstore,
            googleplay,
            stripe,
            unified,
            hasAllPlatforms,
            hasValidStockData: true, // churnRate is always valid if we have data
          };
        }
        
        // For arpu, calculate using the shared helper
        if (isArpu) {
          const getArpu = (p?: { revenueSum?: number; lastActiveSubscribers?: number }) => {
            if (!p) return null;
            return calculateArpu(p.revenueSum || 0, p.lastActiveSubscribers || 0);
          };
          const appstore = getArpu((platforms as any).appstore);
          const googleplay = getArpu((platforms as any).googleplay);
          const stripe = getArpu((platforms as any).stripe);
          
          // Calculate unified ARPU from total revenue / total active subscribers
          const totalRevenue = ((platforms as any).appstore?.revenueSum || 0) + ((platforms as any).googleplay?.revenueSum || 0) + ((platforms as any).stripe?.revenueSum || 0);
          const totalActiveSubs = ((platforms as any).appstore?.lastActiveSubscribers || 0) + ((platforms as any).googleplay?.lastActiveSubscribers || 0) + ((platforms as any).stripe?.lastActiveSubscribers || 0);
          const unified = calculateArpu(totalRevenue, totalActiveSubs);
          
          return {
            month,
            appstore,
            googleplay,
            stripe,
            unified,
            hasAllPlatforms,
            hasValidStockData: true, // arpu is always valid if we have data
          };
        }
        
        const val = (p?: { sum: number; last: number; lastDate: string }) => (p ? (isFlowMetric ? p.sum : p.last) : null);
        const appstore = val((platforms as any).appstore);
        let googleplay = val((platforms as any).googleplay);
        const stripe = val((platforms as any).stripe);
        
        // For Google Play subscriber/stock metrics, treat 0 as null (no data)
        // MRR is calculated from subscriber data, so 0 MRR also indicates missing data
        const googlePlayDelayedMetrics = ["activeSubscribers", "trialSubscribers", "paidSubscribers", "monthlySubscribers", "yearlySubscribers", "mrr"];
        if (googlePlayDelayedMetrics.includes(metric) && googleplay === 0) {
          googleplay = null;
        }
        
        const isCurrencyMetric = ["mrr", "weeklyRevenue", "monthlyChargedRevenue", "monthlyRevenue"].includes(metric);
        const sum = (appstore ?? 0) + (googleplay ?? 0) + (stripe ?? 0);
        const unified = isCurrencyMetric 
          ? Math.round((sum + Number.EPSILON) * 100) / 100
          : sum;
        
        // For stock metrics, check if all active platforms have valid (non-null) values
        const hasValidStockData = !isStockMetric || Array.from(activePlatforms).every((p) => {
          if (p === 'appstore') return appstore !== null;
          if (p === 'googleplay') return googleplay !== null;
          if (p === 'stripe') return stripe !== null;
          return true;
        });
        
        return {
          month,
          appstore,
          googleplay,
          stripe,
          unified,
          hasAllPlatforms,
          hasValidStockData,
        };
      })
      .map((m) => {
        // Check if month is incomplete: current month, missing platforms, or missing stock data
        const now = new Date();
        const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        const isCurrentMonth = m.month === currentMonth;
        const isIncomplete = !m.hasAllPlatforms || isCurrentMonth || !m.hasValidStockData;
        
        return { ...m, isIncomplete };
      })
      .sort((a, b) => a.month.localeCompare(b.month))
      .slice(-12); // Keep last 12 months

    return result;
  },
});

export const getExchangeRate = query({
  args: {
    fromCurrency: v.string(),
    toCurrency: v.string(),
  },
  handler: async (ctx, { fromCurrency, toCurrency }) => {
    // Same currency, no conversion needed
    if (fromCurrency.toUpperCase() === toCurrency.toUpperCase()) {
      return 1;
    }

    // Get the most recent exchange rate
    const rate = await ctx.db
      .query("exchangeRates")
      .withIndex("by_pair", (q) => 
        q.eq("fromCurrency", fromCurrency.toUpperCase()).eq("toCurrency", toCurrency.toUpperCase())
      )
      .order("desc")
      .first();

    if (rate) {
      return rate.rate;
    }

    // If no direct rate, try inverse
    const inverseRate = await ctx.db
      .query("exchangeRates")
      .withIndex("by_pair", (q) => 
        q.eq("fromCurrency", toCurrency.toUpperCase()).eq("toCurrency", fromCurrency.toUpperCase())
      )
      .order("desc")
      .first();

    if (inverseRate) {
      return 1 / inverseRate.rate;
    }

    // Default to 1 if no rate found (will need to be fetched)
    return 1;
  },
});

export const getAllDebugData = query({
  args: { appId: v.id("apps") },
  handler: async (ctx, { appId }) => {
    const app = await validateAppOwnership(ctx, appId);

    const metrics = [
      "activeSubscribers",
      "trialSubscribers",
      "paidSubscribers",
      "monthlySubscribers",
      "yearlySubscribers",
      "cancellations",
      "churn",
      "churnRate", // Calculated metric: (churn / starting paid subscribers) × 100
      "graceEvents",
      "firstPayments",
      "renewals",
      "weeklyRevenue",
      "mrr",
      "monthlyChargedRevenue",
      "monthlyRevenue",
    ];

    const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const today = new Date().toISOString().split("T")[0];

    // Get active platform connections to determine which platforms should have data
    const connections = await ctx.db
      .query("platformConnections")
      .withIndex("by_app", (q) => q.eq("appId", appId))
      .filter((q) => q.eq(q.field("isActive"), true))
      .collect();
    
    const activePlatforms = new Set(connections.map((c) => c.platform));

    const flowMetrics = [
      "cancellations",
      "churn",
      "graceEvents",
      "firstPayments",
      "renewals",
      "weeklyRevenue",
      "monthlyChargedRevenue",
      "monthlyRevenue",
    ];

    // Get all snapshots from past year for weekly data
    const snapshots = await ctx.db
      .query("metricsSnapshots")
      .withIndex("by_app_date", (q) => q.eq("appId", appId))
      .filter((q) => q.gte(q.field("date"), oneYearAgo))
      .collect();

    // Get the most recent snapshots for each platform (for stock metrics like activeSubscribers, MRR)
    const recentSnapshots = await ctx.db
      .query("metricsSnapshots")
      .withIndex("by_app_date", (q) => q.eq("appId", appId))
      .filter((q) => q.neq(q.field("platform"), "unified"))
      .order("desc")
      .take(100);

    // Get latest snapshot per platform for stock metrics
    const latestByPlatform: Record<string, any> = {};
    const latestWithSubsByPlatform: Record<string, any> = {};
    
    for (const snap of recentSnapshots) {
      if (!latestByPlatform[snap.platform]) {
        latestByPlatform[snap.platform] = snap;
      }
      if (!latestWithSubsByPlatform[snap.platform] && snap.activeSubscribers > 0) {
        latestWithSubsByPlatform[snap.platform] = snap;
      }
    }
    
    // For Google Play, prefer the snapshot with actual subscription data for stock metrics
    if (latestByPlatform.googleplay && latestWithSubsByPlatform.googleplay) {
      const latest = latestByPlatform.googleplay;
      const latestWithSubs = latestWithSubsByPlatform.googleplay;
      
      if (latest.activeSubscribers === 0 && latestWithSubs.activeSubscribers > 0) {
        latestByPlatform.googleplay = {
          ...latest,
          activeSubscribers: latestWithSubs.activeSubscribers,
          trialSubscribers: latestWithSubs.trialSubscribers,
          paidSubscribers: latestWithSubs.paidSubscribers,
          monthlySubscribers: latestWithSubs.monthlySubscribers,
          yearlySubscribers: latestWithSubs.yearlySubscribers,
          mrr: latestWithSubs.mrr,
        };
      }
    }

    // Get 30-day snapshots for summing flow metrics
    const snapshots30 = snapshots.filter((s) => s.date >= thirtyDaysAgo && s.platform !== "unified");

    // Calculate 30-day sums for flow metrics by platform
    const flowSumsByPlatform: Record<string, any> = {};
    for (const snap of snapshots30) {
      if (!flowSumsByPlatform[snap.platform]) {
        flowSumsByPlatform[snap.platform] = {
          cancellations: 0,
          churn: 0,
          graceEvents: 0,
          firstPayments: 0,
          renewals: 0,
          weeklyChargedRevenue: 0,
          weeklyRevenue: 0,
          monthlyChargedRevenue: 0,
          monthlyRevenue: 0,
        };
      }
      flowSumsByPlatform[snap.platform].cancellations += snap.cancellations;
      flowSumsByPlatform[snap.platform].churn += snap.churn;
      flowSumsByPlatform[snap.platform].graceEvents += snap.graceEvents;
      flowSumsByPlatform[snap.platform].firstPayments += snap.firstPayments;
      flowSumsByPlatform[snap.platform].renewals += (snap.renewals || 0);
      // weeklyRevenue is optional - fallback to monthlyRevenue for old data
      flowSumsByPlatform[snap.platform].weeklyChargedRevenue += (snap.weeklyChargedRevenue !== undefined ? snap.weeklyChargedRevenue : snap.monthlyChargedRevenue);
      flowSumsByPlatform[snap.platform].weeklyRevenue += (snap.weeklyRevenue !== undefined ? snap.weeklyRevenue : snap.monthlyRevenue);
      flowSumsByPlatform[snap.platform].monthlyChargedRevenue += snap.monthlyChargedRevenue;
      flowSumsByPlatform[snap.platform].monthlyRevenue += snap.monthlyRevenue;
    }

    // Calculate weekly data for each metric
    const weeklyDataByMetric: Record<string, any[]> = {};
    // Calculate monthly data for each metric
    const monthlyDataByMetric: Record<string, any[]> = {};

    // Stock metrics that should show null when value is 0 for Google Play
    const stockMetrics = [
      "activeSubscribers",
      "trialSubscribers", 
      "paidSubscribers",
      "monthlySubscribers",
      "yearlySubscribers",
      "mrr",
    ];

    for (const metric of metrics) {
      // Special handling for churnRate - it's a calculated metric
      const isChurnRate = metric === "churnRate";
      const weeklyData: Record<string, Record<string, { sum: number; last: number; lastDate: string; churnSum?: number; startingPaidSubs?: number; firstDate?: string }>> = {};
      const monthlyData: Record<string, Record<string, { sum: number; last: number; lastDate: string; churnSum?: number; startingPaidSubs?: number; firstDate?: string }>> = {};
      const isFlowMetric = flowMetrics.includes(metric) || isChurnRate;
      const isStockMetric = stockMetrics.includes(metric);

      for (const snap of snapshots) {
        if (snap.platform === "unified") continue;

        const date = new Date(snap.date);
        const weekStart = getWeekStart(date, app.weekStartDay || "monday");
        const weekKey = weekStart.toISOString().split("T")[0];
        const monthKey = snap.date.substring(0, 7); // YYYY-MM

        const value = isChurnRate ? 0 : ((snap as any)[metric] || 0);

        // Weekly aggregation
        if (!weeklyData[weekKey]) weeklyData[weekKey] = {} as any;
        const weekEntry = weeklyData[weekKey][snap.platform] || { sum: 0, last: 0, lastDate: "", churnSum: 0, startingPaidSubs: 0, firstDate: "9999-99-99" };
        weekEntry.sum += value;
        if (snap.date >= weekEntry.lastDate) {
          weekEntry.last = value;
          weekEntry.lastDate = snap.date;
        }
        // For churnRate calculation
        if (isChurnRate) {
          weekEntry.churnSum = (weekEntry.churnSum || 0) + (snap.churn || 0);
          if (snap.date < (weekEntry.firstDate || "9999-99-99")) {
            weekEntry.startingPaidSubs = snap.paidSubscribers || 0;
            weekEntry.firstDate = snap.date;
          }
        }
        weeklyData[weekKey][snap.platform] = weekEntry;

        // Monthly aggregation
        if (!monthlyData[monthKey]) monthlyData[monthKey] = {} as any;
        const monthEntry = monthlyData[monthKey][snap.platform] || { sum: 0, last: 0, lastDate: "", churnSum: 0, startingPaidSubs: 0, firstDate: "9999-99-99" };
        monthEntry.sum += value;
        if (snap.date >= monthEntry.lastDate) {
          monthEntry.last = value;
          monthEntry.lastDate = snap.date;
        }
        // For churnRate calculation
        if (isChurnRate) {
          monthEntry.churnSum = (monthEntry.churnSum || 0) + (snap.churn || 0);
          if (snap.date < (monthEntry.firstDate || "9999-99-99")) {
            monthEntry.startingPaidSubs = snap.paidSubscribers || 0;
            monthEntry.firstDate = snap.date;
          }
        }
        monthlyData[monthKey][snap.platform] = monthEntry;
      }

      // Process weekly data
      const weeklyResult = Object.entries(weeklyData)
        .map(([week, platforms]) => {
          const platformsInWeek = new Set(Object.keys(platforms));
          const hasAllPlatforms = Array.from(activePlatforms).every((p) => platformsInWeek.has(p));
          
          // For churnRate, calculate using the shared helper
          if (isChurnRate) {
            const getChurnRate = (p?: { churnSum?: number; startingPaidSubs?: number }) => {
              if (!p) return null;
              return calculateChurnRate(p.churnSum || 0, p.startingPaidSubs || 0);
            };
            const appstore = getChurnRate((platforms as any).appstore);
            const googleplay = getChurnRate((platforms as any).googleplay);
            const stripe = getChurnRate((platforms as any).stripe);
            
            // Calculate unified churn rate from totals
            const totalChurn = ((platforms as any).appstore?.churnSum || 0) + ((platforms as any).googleplay?.churnSum || 0) + ((platforms as any).stripe?.churnSum || 0);
            const totalStartingSubs = ((platforms as any).appstore?.startingPaidSubs || 0) + ((platforms as any).googleplay?.startingPaidSubs || 0) + ((platforms as any).stripe?.startingPaidSubs || 0);
            const unified = calculateChurnRate(totalChurn, totalStartingSubs);
            
            return { week, appstore, googleplay, stripe, unified, hasAllPlatforms, hasValidStockData: true };
          }
          
          const val = (p?: { sum: number; last: number; lastDate: string }) => (p ? (isFlowMetric ? p.sum : p.last) : null);
          const appstore = val((platforms as any).appstore);
          let googleplay = val((platforms as any).googleplay);
          const stripe = val((platforms as any).stripe);
          
          // For Google Play subscriber/stock metrics, treat 0 as null (no data)
          // MRR is calculated from subscriber data, so 0 MRR also indicates missing data
          const googlePlayDelayedMetrics = ["activeSubscribers", "trialSubscribers", "paidSubscribers", "monthlySubscribers", "yearlySubscribers", "mrr"];
          if (googlePlayDelayedMetrics.includes(metric) && googleplay === 0) {
            googleplay = null;
          }
          
          const sum = (appstore ?? 0) + (googleplay ?? 0) + (stripe ?? 0);
          const unified = sum;
          
          // For stock metrics, check if all active platforms have valid (non-null) values
          const hasValidStockData = !isStockMetric || Array.from(activePlatforms).every((p) => {
            if (p === 'appstore') return appstore !== null;
            if (p === 'googleplay') return googleplay !== null;
            if (p === 'stripe') return stripe !== null;
            return true;
          });
          
          return { week, appstore, googleplay, stripe, unified, hasAllPlatforms, hasValidStockData };
        })
        .map((w) => {
          const weekEnd = new Date(w.week);
          weekEnd.setDate(weekEnd.getDate() + 6);
          const isCurrentOrFutureWeek = weekEnd >= new Date();
          const isIncomplete = !w.hasAllPlatforms || isCurrentOrFutureWeek || !w.hasValidStockData;
          
          return { ...w, isIncomplete };
        })
        .sort((a, b) => a.week.localeCompare(b.week))
        .slice(-52);

      weeklyDataByMetric[metric] = weeklyResult;

      // Process monthly data
      const now = new Date();
      const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

      const monthlyResult = Object.entries(monthlyData)
        .map(([month, platforms]) => {
          const platformsInMonth = new Set(Object.keys(platforms));
          const hasAllPlatforms = Array.from(activePlatforms).every((p) => platformsInMonth.has(p));
          
          // For churnRate, calculate using the shared helper
          if (isChurnRate) {
            const getChurnRate = (p?: { churnSum?: number; startingPaidSubs?: number }) => {
              if (!p) return null;
              return calculateChurnRate(p.churnSum || 0, p.startingPaidSubs || 0);
            };
            const appstore = getChurnRate((platforms as any).appstore);
            const googleplay = getChurnRate((platforms as any).googleplay);
            const stripe = getChurnRate((platforms as any).stripe);
            
            // Calculate unified churn rate from totals
            const totalChurn = ((platforms as any).appstore?.churnSum || 0) + ((platforms as any).googleplay?.churnSum || 0) + ((platforms as any).stripe?.churnSum || 0);
            const totalStartingSubs = ((platforms as any).appstore?.startingPaidSubs || 0) + ((platforms as any).googleplay?.startingPaidSubs || 0) + ((platforms as any).stripe?.startingPaidSubs || 0);
            const unified = calculateChurnRate(totalChurn, totalStartingSubs);
            
            return { month, appstore, googleplay, stripe, unified, hasAllPlatforms, hasValidStockData: true };
          }
          
          const val = (p?: { sum: number; last: number; lastDate: string }) => (p ? (isFlowMetric ? p.sum : p.last) : null);
          const appstore = val((platforms as any).appstore);
          let googleplay = val((platforms as any).googleplay);
          const stripe = val((platforms as any).stripe);
          
          // For Google Play subscriber/stock metrics, treat 0 as null (no data)
          // MRR is calculated from subscriber data, so 0 MRR also indicates missing data
          const googlePlayDelayedMetrics = ["activeSubscribers", "trialSubscribers", "paidSubscribers", "monthlySubscribers", "yearlySubscribers", "mrr"];
          if (googlePlayDelayedMetrics.includes(metric) && googleplay === 0) {
            googleplay = null;
          }
          
          const sum = (appstore ?? 0) + (googleplay ?? 0) + (stripe ?? 0);
          const unified = sum;
          
          // For stock metrics, check if all active platforms have valid (non-null) values
          const hasValidStockData = !isStockMetric || Array.from(activePlatforms).every((p) => {
            if (p === 'appstore') return appstore !== null;
            if (p === 'googleplay') return googleplay !== null;
            if (p === 'stripe') return stripe !== null;
            return true;
          });
          
          return { month, appstore, googleplay, stripe, unified, hasAllPlatforms, hasValidStockData };
        })
        .map((m) => {
          const isCurrentMonth = m.month === currentMonth;
          const isIncomplete = !m.hasAllPlatforms || isCurrentMonth || !m.hasValidStockData;
          
          return { ...m, isIncomplete };
        })
        .sort((a, b) => a.month.localeCompare(b.month))
        .slice(-12);

      monthlyDataByMetric[metric] = monthlyResult;
    }

    return {
      weeklyDataByMetric,
      monthlyDataByMetric,
      latestByPlatform,
      flowSumsByPlatform,
      flowMetrics,
      activePlatforms: Array.from(activePlatforms),
    };
  },
});

export const getChatContext = query({
  args: { appId: v.id("apps") },
  handler: async (ctx, { appId }) => {
    const app = await validateAppOwnership(ctx, appId);

    const currency = app.currency || "USD";

    // Get ALL latest snapshots (including platform-specific ones)
    const now = new Date();
    const today = now.toISOString().split("T")[0];
    
    const allLatestSnapshots = await ctx.db
      .query("metricsSnapshots")
      .withIndex("by_app_date", (q) => q.eq("appId", appId))
      .order("desc")
      .take(100);

    // Group by platform and get the most recent for each
    const latestByPlatform: Record<string, any> = {};
    const latestWithSubsByPlatform: Record<string, any> = {};
    
    for (const snap of allLatestSnapshots) {
      if (!latestByPlatform[snap.platform]) {
        latestByPlatform[snap.platform] = snap;
      }
      // Track the most recent snapshot with actual subscription data
      if (!latestWithSubsByPlatform[snap.platform] && snap.activeSubscribers > 0) {
        latestWithSubsByPlatform[snap.platform] = snap;
      }
    }
    
    // For Google Play, prefer the snapshot with actual subscription data for stock metrics
    if (latestByPlatform.googleplay && latestWithSubsByPlatform.googleplay) {
      const latest = latestByPlatform.googleplay;
      const latestWithSubs = latestWithSubsByPlatform.googleplay;
      
      if (latest.activeSubscribers === 0 && latestWithSubs.activeSubscribers > 0) {
        latestByPlatform.googleplay = {
          ...latest,
          activeSubscribers: latestWithSubs.activeSubscribers,
          trialSubscribers: latestWithSubs.trialSubscribers,
          paidSubscribers: latestWithSubs.paidSubscribers,
          monthlySubscribers: latestWithSubs.monthlySubscribers,
          yearlySubscribers: latestWithSubs.yearlySubscribers,
          mrr: latestWithSubs.mrr,
        };
      }
    }

    const latestMetrics = latestByPlatform.unified ? {
      ...latestByPlatform.unified,
      platformBreakdown: {
        appstore: latestByPlatform.appstore || null,
        googleplay: latestByPlatform.googleplay || null,
        stripe: latestByPlatform.stripe || null,
      }
    } : null;
    
    // Get 52 weeks of historical data
    const oneYearAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
    
    const snapshots = await ctx.db
      .query("metricsSnapshots")
      .withIndex("by_app_date", (q) => q.eq("appId", appId))
      .filter((q) => q.gte(q.field("date"), oneYearAgo.toISOString().split("T")[0]))
      .collect();

    const metrics = [
      "activeSubscribers",
      "trialSubscribers",
      "paidSubscribers",
      "monthlySubscribers",
      "yearlySubscribers",
      "cancellations",
      "churn",
      "graceEvents",
      "firstPayments",
      "renewals",
      "mrr",
      "monthlyChargedRevenue",
      "monthlyRevenue",
    ];

    const flowMetrics = [
      "cancellations",
      "churn",
      "graceEvents",
      "firstPayments",
      "renewals",
      "monthlyChargedRevenue",
      "monthlyRevenue",
    ];

    // Calculate weekly data for each metric
    const weeklyData: Record<string, any[]> = {};

    for (const metric of metrics) {
      const weeklyDataMap: Record<string, Record<string, { sum: number; last: number; lastDate: string }>> = {};
      const isFlowMetric = flowMetrics.includes(metric);

      for (const snap of snapshots) {
        if (snap.platform === "unified") continue;

        const date = new Date(snap.date);
        const weekStart = getWeekStart(date, app.weekStartDay || "monday");
        const weekKey = weekStart.toISOString().split("T")[0];

        if (!weeklyDataMap[weekKey]) weeklyDataMap[weekKey] = {} as any;
        const value = (snap as any)[metric] || 0;
        const entry = weeklyDataMap[weekKey][snap.platform] || { sum: 0, last: 0, lastDate: "" };
        entry.sum += value;
        if (snap.date >= entry.lastDate) {
          entry.last = value;
          entry.lastDate = snap.date;
        }
        weeklyDataMap[weekKey][snap.platform] = entry;
      }

      // Stock metrics that should show null when value is 0 for Google Play
      const stockMetrics = [
        "activeSubscribers",
        "trialSubscribers", 
        "paidSubscribers",
        "monthlySubscribers",
        "yearlySubscribers",
        "mrr",
      ];
      const isStockMetric = stockMetrics.includes(metric);

      const result = Object.entries(weeklyDataMap)
        .map(([week, platforms]) => {
          const val = (p?: { sum: number; last: number; lastDate: string }) => (p ? (isFlowMetric ? p.sum : p.last) : 0);
          const appstore = val((platforms as any).appstore);
          let googleplay: number | null = val((platforms as any).googleplay);
          const stripe = val((platforms as any).stripe);
          
          // For Google Play subscriber/stock metrics, treat 0 as null (no data)
          // MRR is calculated from subscriber data, so 0 MRR also indicates missing data
          const googlePlayDelayedMetrics = ["activeSubscribers", "trialSubscribers", "paidSubscribers", "monthlySubscribers", "yearlySubscribers", "mrr"];
          if (googlePlayDelayedMetrics.includes(metric) && googleplay === 0) {
            googleplay = null;
          }
          
          const unified = appstore + (googleplay ?? 0) + stripe;
          return { week, appstore, googleplay, stripe, unified };
        })
        .sort((a, b) => a.week.localeCompare(b.week))
        .slice(-52);

      weeklyData[metric] = result;
    }

    return {
      currency,
      latestMetrics,
      weeklyData,
      metricDefinitions: {
        activeSubscribers: "Total active subscriptions (trial + paid)",
        trialSubscribers: "Subscriptions currently in trial period",
        paidSubscribers: "Active paying subscriptions",
        monthlySubscribers: "Subscribers on monthly billing plans",
        yearlySubscribers: "Subscribers on yearly billing plans",
        cancellations: "Total cancellations in period",
        churn: "Subscribers who canceled (ended)",
        graceEvents: "Subscriptions in grace/retry period",
        firstPayments: "New paying customers",
        renewals: "Subscription renewals",
        mrr: "Monthly Recurring Revenue",
        monthlyChargedRevenue: "Total charged to customers (including VAT)",
        monthlyRevenue: "Revenue excluding VAT (still includes platform fees)",
      },
    };
  },
});

export const debugRevenueCalculation = query({
  args: { appId: v.id("apps") },
  handler: async (ctx, { appId }) => {
    await validateAppOwnership(ctx, appId);

    const now = Date.now();
    const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const today = new Date(now).toISOString().split("T")[0];

    // Get all snapshots for the past 30 days
    const snapshots = await ctx.db
      .query("metricsSnapshots")
      .withIndex("by_app_date", (q) => q.eq("appId", appId))
      .filter((q) => q.gte(q.field("date"), thirtyDaysAgo))
      .collect();

    // Get all revenue events for the past 30 days (all platforms)
    const allRevenueEvents = await ctx.db
      .query("revenueEvents")
      .withIndex("by_app_platform", (q) => q.eq("appId", appId))
      .filter((q) => q.gte(q.field("timestamp"), new Date(thirtyDaysAgo).getTime()))
      .collect();

    const stripeEvents = allRevenueEvents.filter(e => e.platform === "stripe");
    const appstoreEvents = allRevenueEvents.filter(e => e.platform === "appstore");
    const googleplayEvents = allRevenueEvents.filter(e => e.platform === "googleplay");

    // Group snapshots by date and platform
    const snapshotsByDate: Record<string, any[]> = {};
    for (const snap of snapshots) {
      if (!snapshotsByDate[snap.date]) {
        snapshotsByDate[snap.date] = [];
      }
      snapshotsByDate[snap.date].push({
        platform: snap.platform,
        monthlyChargedRevenue: snap.monthlyChargedRevenue,
        monthlyRevenue: snap.monthlyRevenue,
        firstPayments: snap.firstPayments,
        renewals: snap.renewals,
      });
    }

    // Group revenue events by date and platform
    const eventsByDate: Record<string, any[]> = {};
    for (const event of allRevenueEvents) {
      const date = new Date(event.timestamp).toISOString().split("T")[0];
      const key = `${date}_${event.platform}`;
      if (!eventsByDate[key]) {
        eventsByDate[key] = [];
      }
      eventsByDate[key].push({
        platform: event.platform,
        eventType: event.eventType,
        amount: event.amount,
        currency: event.currency,
        timestamp: event.timestamp,
      });
    }

    // Check for duplicate snapshots (same date + platform)
    const snapshotsByDatePlatform: Record<string, number> = {};
    const duplicates: Array<{date: string, platform: string, count: number}> = [];
    
    for (const snap of snapshots) {
      const key = `${snap.date}_${snap.platform}`;
      snapshotsByDatePlatform[key] = (snapshotsByDatePlatform[key] || 0) + 1;
    }
    
    for (const [key, count] of Object.entries(snapshotsByDatePlatform)) {
      if (count > 1) {
        const [date, platform] = key.split('_');
        duplicates.push({ date, platform, count });
      }
    }

    // Calculate totals from snapshots
    const snapshotTotals = {
      stripe: { gross: 0, net: 0, count: 0 },
      appstore: { gross: 0, net: 0, count: 0 },
      googleplay: { gross: 0, net: 0, count: 0 },
      unified: { gross: 0, net: 0, count: 0 },
    };

    for (const snap of snapshots) {
      if (snap.platform === "stripe" || snap.platform === "appstore" || snap.platform === "googleplay") {
        snapshotTotals[snap.platform].gross += snap.monthlyChargedRevenue;
        snapshotTotals[snap.platform].net += snap.monthlyRevenue;
        snapshotTotals[snap.platform].count += 1;
      }
      if (snap.platform === "unified") {
        snapshotTotals.unified.gross += snap.monthlyChargedRevenue;
        snapshotTotals.unified.net += snap.monthlyRevenue;
        snapshotTotals.unified.count += 1;
      }
    }

    // Calculate totals from raw revenue events by platform
    const eventTotals = {
      stripe: {
        total: 0,
        byType: { first_payment: 0, renewal: 0, refund: 0 },
        count: stripeEvents.length,
      },
      appstore: {
        total: 0,
        byType: { first_payment: 0, renewal: 0, refund: 0 },
        count: appstoreEvents.length,
      },
      googleplay: {
        total: 0,
        byType: { first_payment: 0, renewal: 0, refund: 0 },
        count: googleplayEvents.length,
      },
    };

    for (const event of stripeEvents) {
      eventTotals.stripe.total += event.amount;
      eventTotals.stripe.byType[event.eventType] += event.amount;
    }
    
    for (const event of appstoreEvents) {
      eventTotals.appstore.total += event.amount;
      eventTotals.appstore.byType[event.eventType] += event.amount;
    }
    
    for (const event of googleplayEvents) {
      eventTotals.googleplay.total += event.amount;
      eventTotals.googleplay.byType[event.eventType] += event.amount;
    }

    return {
      dateRange: { start: thirtyDaysAgo, end: today },
      snapshotCount: snapshots.length,
      revenueEventCount: allRevenueEvents.length,
      duplicates,
      hasDuplicates: duplicates.length > 0,
      snapshotTotals,
      eventTotals,
      snapshotsByDate: Object.entries(snapshotsByDate)
        .sort(([a], [b]) => b.localeCompare(a))
        .slice(0, 10), // Last 10 days
      eventsByDate: Object.entries(eventsByDate)
        .sort(([a], [b]) => b.localeCompare(a))
        .slice(0, 10), // Last 10 days
      sampleSnapshotsStripe: snapshots
        .filter((s) => s.platform === "stripe")
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, 5)
        .map((s) => ({
          date: s.date,
          platform: s.platform,
          monthlyChargedRevenue: s.monthlyChargedRevenue,
          monthlyRevenue: s.monthlyRevenue,
          firstPayments: s.firstPayments,
          renewals: s.renewals,
        })),
      sampleSnapshotsAppStore: snapshots
        .filter((s) => s.platform === "appstore")
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, 5)
        .map((s) => ({
          date: s.date,
          platform: s.platform,
          monthlyChargedRevenue: s.monthlyChargedRevenue,
          monthlyRevenue: s.monthlyRevenue,
          firstPayments: s.firstPayments,
          renewals: s.renewals,
        })),
      sampleSnapshotsGooglePlay: snapshots
        .filter((s) => s.platform === "googleplay")
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, 5)
        .map((s) => ({
          date: s.date,
          platform: s.platform,
          monthlyChargedRevenue: s.monthlyChargedRevenue,
          monthlyRevenue: s.monthlyRevenue,
          firstPayments: s.firstPayments,
          renewals: s.renewals,
        })),
      sampleEvents: allRevenueEvents
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, 10)
        .map((e) => ({
          date: new Date(e.timestamp).toISOString().split("T")[0],
          platform: e.platform,
          eventType: e.eventType,
          amount: e.amount,
          currency: e.currency,
        })),
    };
  },
});

// Validation query to cross-reference with actual platform dashboards
export const validateRevenueData = query({
  args: { appId: v.id("apps") },
  handler: async (ctx, { appId }) => {
    await validateAppOwnership(ctx, appId);
    const app = await ctx.db.get(appId);
    const userCurrency = app?.currency || "USD";

    // Get snapshots for October 2025 (a recent full month for validation)
    const octStart = "2025-10-01";
    const octEnd = "2025-10-31";
    
    const octSnapshots = await ctx.db
      .query("metricsSnapshots")
      .withIndex("by_app_date", (q) => q.eq("appId", appId))
      .filter((q) => q.and(
        q.gte(q.field("date"), octStart),
        q.lte(q.field("date"), octEnd)
      ))
      .filter((q) => q.neq(q.field("platform"), "unified"))
      .collect();

    // Calculate October totals by platform
    const octTotals: Record<string, { gross: number; net: number; days: number; avgDaily: number }> = {};
    for (const snap of octSnapshots) {
      if (!octTotals[snap.platform]) {
        octTotals[snap.platform] = { gross: 0, net: 0, days: 0, avgDaily: 0 };
      }
      octTotals[snap.platform].gross += snap.monthlyChargedRevenue;
      octTotals[snap.platform].net += snap.monthlyRevenue;
      octTotals[snap.platform].days += 1;
    }
    
    // Calculate averages
    for (const platform of Object.keys(octTotals)) {
      if (octTotals[platform].days > 0) {
        octTotals[platform].avgDaily = octTotals[platform].gross / octTotals[platform].days;
      }
    }

    // Get a few specific days of snapshots for manual verification
    const sampleDates = ["2025-10-15", "2025-10-20", "2025-10-25"];
    const sampleSnapshots: Record<string, Record<string, { gross: number; net: number }>> = {};
    
    for (const snap of octSnapshots) {
      if (sampleDates.includes(snap.date)) {
        if (!sampleSnapshots[snap.date]) sampleSnapshots[snap.date] = {};
        sampleSnapshots[snap.date][snap.platform] = {
          gross: snap.monthlyChargedRevenue,
          net: snap.monthlyRevenue,
        };
      }
    }

    // Calculate revenue split percentage
    const totalGross = Object.values(octTotals).reduce((sum, t) => sum + t.gross, 0);
    const revenueSplit: Record<string, string> = {};
    for (const [platform, totals] of Object.entries(octTotals)) {
      revenueSplit[platform] = totalGross > 0 
        ? `${((totals.gross / totalGross) * 100).toFixed(1)}%` 
        : "0%";
    }

    return {
      currency: userCurrency,
      period: "October 2025",
      instructions: "Compare these totals against your App Store Connect and Google Play Console reports for October 2025",
      octoberTotals: octTotals,
      revenueSplitPercentage: revenueSplit,
      totalAllPlatforms: {
        gross: totalGross,
        net: Object.values(octTotals).reduce((sum, t) => sum + t.net, 0),
      },
      sampleDaysForVerification: sampleSnapshots,
      snapshotCountByPlatform: Object.fromEntries(
        Object.entries(octTotals).map(([p, t]) => [p, t.days])
      ),
    };
  },
});

// Debug query for churn rate calculation
export const debugChurnRate = query({
  args: { appId: v.id("apps") },
  handler: async (ctx, { appId }) => {
    await validateAppOwnership(ctx, appId);

    const now = Date.now();
    const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

    // Get all snapshots for the past 30 days
    const snapshots = await ctx.db
      .query("metricsSnapshots")
      .withIndex("by_app_date", (q) => q.eq("appId", appId))
      .filter((q) => q.gte(q.field("date"), thirtyDaysAgo))
      .filter((q) => q.neq(q.field("platform"), "unified"))
      .collect();

    // Sort by date
    const sorted = [...snapshots].sort((a, b) => a.date.localeCompare(b.date));

    // Group by platform
    const byPlatform: Record<string, typeof snapshots> = {};
    for (const snap of sorted) {
      if (!byPlatform[snap.platform]) byPlatform[snap.platform] = [];
      byPlatform[snap.platform].push(snap);
    }

    // Calculate churn rate breakdown for each platform
    const breakdown: Record<string, {
      totalChurn30d: number;
      startingPaidSubs30d: number;
      endingPaidSubs30d: number;
      calculatedChurnRate30d: number;
      totalChurn7d: number;
      startingPaidSubs7d: number;
      endingPaidSubs7d: number;
      calculatedChurnRate7d: number;
      dailySnapshots: Array<{ date: string; churn: number; paidSubs: number }>;
    }> = {};

    for (const [platform, snaps] of Object.entries(byPlatform)) {
      // 30-day data
      const first30d = snaps[0];
      const last30d = snaps[snaps.length - 1];
      const totalChurn30d = snaps.reduce((sum, s) => sum + (s.churn || 0), 0);
      const startingPaidSubs30d = first30d?.paidSubscribers || 0;
      const endingPaidSubs30d = last30d?.paidSubscribers || 0;
      
      // 7-day data
      const snaps7d = snaps.filter(s => s.date >= sevenDaysAgo);
      const first7d = snaps7d[0];
      const last7d = snaps7d[snaps7d.length - 1];
      const totalChurn7d = snaps7d.reduce((sum, s) => sum + (s.churn || 0), 0);
      const startingPaidSubs7d = first7d?.paidSubscribers || 0;
      const endingPaidSubs7d = last7d?.paidSubscribers || 0;

      breakdown[platform] = {
        totalChurn30d,
        startingPaidSubs30d,
        endingPaidSubs30d,
        calculatedChurnRate30d: calculateChurnRate(totalChurn30d, startingPaidSubs30d),
        totalChurn7d,
        startingPaidSubs7d,
        endingPaidSubs7d,
        calculatedChurnRate7d: calculateChurnRate(totalChurn7d, startingPaidSubs7d),
        // Include daily snapshots for debugging
        dailySnapshots: snaps.slice(-10).map(s => ({
          date: s.date,
          churn: s.churn || 0,
          paidSubs: s.paidSubscribers || 0,
        })),
      };
    }

    // Calculate unified totals
    const allPlatforms = Object.keys(breakdown);
    const unified30d = {
      totalChurn: allPlatforms.reduce((sum, p) => sum + breakdown[p].totalChurn30d, 0),
      startingSubs: allPlatforms.reduce((sum, p) => sum + breakdown[p].startingPaidSubs30d, 0),
      endingSubs: allPlatforms.reduce((sum, p) => sum + breakdown[p].endingPaidSubs30d, 0),
    };
    const unified7d = {
      totalChurn: allPlatforms.reduce((sum, p) => sum + breakdown[p].totalChurn7d, 0),
      startingSubs: allPlatforms.reduce((sum, p) => sum + breakdown[p].startingPaidSubs7d, 0),
      endingSubs: allPlatforms.reduce((sum, p) => sum + breakdown[p].endingPaidSubs7d, 0),
    };

    return {
      explanation: "Churn Rate = (Total Churn Count / Starting Paid Subscribers) × 100",
      note: "If churn rate seems too low, check if the 'churn' field is capturing all churned subscribers. The 'churn' field counts subscriptions that ended on each day.",
      platformBreakdown: breakdown,
      unified30Day: {
        ...unified30d,
        calculatedChurnRate: calculateChurnRate(unified30d.totalChurn, unified30d.startingSubs),
        subscriberDelta: unified30d.endingSubs - unified30d.startingSubs,
      },
      unified7Day: {
        ...unified7d,
        calculatedChurnRate: calculateChurnRate(unified7d.totalChurn, unified7d.startingSubs),
        subscriberDelta: unified7d.endingSubs - unified7d.startingSubs,
      },
      suggestion: "Compare 'subscriberDelta' (ending - starting) with 'totalChurn'. If delta is larger (more negative), there may be churned subscribers not captured in the 'churn' field.",
    };
  },
});
