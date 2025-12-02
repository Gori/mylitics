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
      "weeklyRevenueGross",
      "weeklyRevenueNet",
      "monthlyRevenueGross",
      "monthlyRevenueNet",
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
    const flowSumsByPlatform: Record<string, any> = {};
    for (const snap of snapshots30) {
      if (!flowSumsByPlatform[snap.platform]) {
        flowSumsByPlatform[snap.platform] = {
          cancellations: 0,
          churn: 0,
          graceEvents: 0,
          firstPayments: 0,
          renewals: 0,
          monthlyRevenueGross: 0,
          monthlyRevenueNet: 0,
        };
      }
      flowSumsByPlatform[snap.platform].cancellations += snap.cancellations;
      flowSumsByPlatform[snap.platform].churn += snap.churn;
      flowSumsByPlatform[snap.platform].graceEvents += snap.graceEvents;
      flowSumsByPlatform[snap.platform].firstPayments += snap.firstPayments;
      flowSumsByPlatform[snap.platform].renewals += (snap.renewals || 0);
      flowSumsByPlatform[snap.platform].monthlyRevenueGross += snap.monthlyRevenueGross;
      flowSumsByPlatform[snap.platform].monthlyRevenueNet += snap.monthlyRevenueNet;
    }

    // Calculate 7-day sums for weekly revenue by platform
    const weeklySumsByPlatform: Record<string, any> = {};
    for (const snap of snapshots7) {
      if (!weeklySumsByPlatform[snap.platform]) {
        weeklySumsByPlatform[snap.platform] = {
          weeklyRevenueGross: 0,
          weeklyRevenueNet: 0,
        };
      }
      weeklySumsByPlatform[snap.platform].weeklyRevenueGross += snap.monthlyRevenueGross;
      weeklySumsByPlatform[snap.platform].weeklyRevenueNet += snap.monthlyRevenueNet;
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
      platformMap[platform] = {
        activeSubscribers: latest?.activeSubscribers || 0,
        trialSubscribers: latest?.trialSubscribers || 0,
        paidSubscribers: latest?.paidSubscribers || 0,
        mrr: latest?.mrr || 0,
        cancellations: flowSums?.cancellations || 0,
        churn: flowSums?.churn || 0,
        graceEvents: flowSums?.graceEvents || 0,
        firstPayments: flowSums?.firstPayments || 0,
        renewals: flowSums?.renewals || 0,
        weeklyRevenueGross: weeklySums?.weeklyRevenueGross || 0,
        weeklyRevenueNet: weeklySums?.weeklyRevenueNet || 0,
        monthlyRevenueGross: flowSums?.monthlyRevenueGross || 0,
        monthlyRevenueNet: flowSums?.monthlyRevenueNet || 0,
        monthlySubscribers: latest?.monthlySubscribers || 0,
        yearlySubscribers: latest?.yearlySubscribers || 0,
      };
    }

    // Calculate unified by summing all platforms (use 0 if platform not in map)
    const unified = {
      activeSubscribers: (platformMap.appstore?.activeSubscribers || 0) + (platformMap.googleplay?.activeSubscribers || 0) + (platformMap.stripe?.activeSubscribers || 0),
      trialSubscribers: (platformMap.appstore?.trialSubscribers || 0) + (platformMap.googleplay?.trialSubscribers || 0) + (platformMap.stripe?.trialSubscribers || 0),
      paidSubscribers: (platformMap.appstore?.paidSubscribers || 0) + (platformMap.googleplay?.paidSubscribers || 0) + (platformMap.stripe?.paidSubscribers || 0),
      cancellations: (platformMap.appstore?.cancellations || 0) + (platformMap.googleplay?.cancellations || 0) + (platformMap.stripe?.cancellations || 0),
      churn: (platformMap.appstore?.churn || 0) + (platformMap.googleplay?.churn || 0) + (platformMap.stripe?.churn || 0),
      graceEvents: (platformMap.appstore?.graceEvents || 0) + (platformMap.googleplay?.graceEvents || 0) + (platformMap.stripe?.graceEvents || 0),
      paybacks: 0,
      firstPayments: (platformMap.appstore?.firstPayments || 0) + (platformMap.googleplay?.firstPayments || 0) + (platformMap.stripe?.firstPayments || 0),
      renewals: (platformMap.appstore?.renewals || 0) + (platformMap.googleplay?.renewals || 0) + (platformMap.stripe?.renewals || 0),
      weeklyRevenueGross: Math.round(((platformMap.appstore?.weeklyRevenueGross || 0) + (platformMap.googleplay?.weeklyRevenueGross || 0) + (platformMap.stripe?.weeklyRevenueGross || 0) + Number.EPSILON) * 100) / 100,
      weeklyRevenueNet: Math.round(((platformMap.appstore?.weeklyRevenueNet || 0) + (platformMap.googleplay?.weeklyRevenueNet || 0) + (platformMap.stripe?.weeklyRevenueNet || 0) + Number.EPSILON) * 100) / 100,
      mrr: Math.round(((platformMap.appstore?.mrr || 0) + (platformMap.googleplay?.mrr || 0) + (platformMap.stripe?.mrr || 0) + Number.EPSILON) * 100) / 100,
      monthlyRevenueGross: Math.round(((platformMap.appstore?.monthlyRevenueGross || 0) + (platformMap.googleplay?.monthlyRevenueGross || 0) + (platformMap.stripe?.monthlyRevenueGross || 0) + Number.EPSILON) * 100) / 100,
      monthlyRevenueNet: Math.round(((platformMap.appstore?.monthlyRevenueNet || 0) + (platformMap.googleplay?.monthlyRevenueNet || 0) + (platformMap.stripe?.monthlyRevenueNet || 0) + Number.EPSILON) * 100) / 100,
      monthlySubscribers: (platformMap.appstore?.monthlySubscribers || 0) + (platformMap.googleplay?.monthlySubscribers || 0) + (platformMap.stripe?.monthlySubscribers || 0),
      yearlySubscribers: (platformMap.appstore?.yearlySubscribers || 0) + (platformMap.googleplay?.yearlySubscribers || 0) + (platformMap.stripe?.yearlySubscribers || 0),
    };

    return {
      unified,
      platformMap,
      flowMetrics,
      lastSync: lastSync || null,
      dateRange: `${dateRangeStart} - ${dateRangeEnd}`,
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
    
    // Determine if this is a flow metric (sum weekly) or stock metric (last value)
    const flowMetrics = [
      "cancellations",
      "churn",
      "graceEvents",
      "firstPayments",
      "renewals",
      "weeklyRevenue",
      "monthlyRevenueGross",
      "monthlyRevenueNet",
    ];
    const isFlowMetric = flowMetrics.includes(metric);

    // Use the snapshots we already fetched
    const snapshots = allSnapshots;

    // Group by week and platform
    const weeklyData: Record<string, Record<string, { sum: number; last: number; lastDate: string }>> = {};
    
    for (const snap of snapshots) {
      // Skip unified platform - we'll calculate it from the sum of platforms
      if (snap.platform === "unified") continue;

      const date = new Date(snap.date);
      const weekStart = getWeekStart(date, app.weekStartDay || "monday");
      const weekKey = weekStart.toISOString().split("T")[0];
      
      if (!weeklyData[weekKey]) weeklyData[weekKey] = {} as any;
      const value = (snap as any)[metric] || 0;
      const entry = weeklyData[weekKey][snap.platform] || { sum: 0, last: 0, lastDate: "" };
      entry.sum += value;
      // Only update last if this is a more recent date
      if (snap.date >= entry.lastDate) {
        entry.last = value;
        entry.lastDate = snap.date;
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
        
        // For flow metrics, use sum of all days in the week; for stock metrics, use last day
        // Return null if platform has no data for this week (so chart line stops instead of dropping to 0)
        const val = (p?: { sum: number; last: number; lastDate: string }) => (p ? (isFlowMetric ? p.sum : p.last) : null);
        const appstore = val((platforms as any).appstore);
        let googleplay = val((platforms as any).googleplay);
        const stripe = val((platforms as any).stripe);
        
        // For Google Play subscriber metrics, treat 0 as null (no data) so line stops
        // Google Play subscription reports have delays, so 0 means no data, not zero subscribers
        // BUT: MRR is a calculated value, so 0 is valid (not missing data)
        const subscriberMetrics = ["activeSubscribers", "trialSubscribers", "paidSubscribers", "monthlySubscribers", "yearlySubscribers"];
        const isSubscriberMetric = subscriberMetrics.includes(metric);
        if (isSubscriberMetric && googleplay === 0) {
          googleplay = null;
        }
        
        // Round currency values to 2 decimals
        const isCurrencyMetric = ["mrr", "weeklyRevenue", "monthlyRevenueGross", "monthlyRevenueNet"].includes(metric);
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
    
    const flowMetrics = [
      "cancellations",
      "churn",
      "graceEvents",
      "firstPayments",
      "renewals",
      "weeklyRevenue",
      "monthlyRevenueGross",
      "monthlyRevenueNet",
    ];
    const isFlowMetric = flowMetrics.includes(metric);

    const snapshots = allSnapshots;

    // Group by month (YYYY-MM) and platform
    const monthlyData: Record<string, Record<string, { sum: number; last: number; lastDate: string }>> = {};
    
    for (const snap of snapshots) {
      if (snap.platform === "unified") continue;

      // Extract YYYY-MM from date
      const monthKey = snap.date.substring(0, 7);
      
      if (!monthlyData[monthKey]) monthlyData[monthKey] = {} as any;
      const value = (snap as any)[metric] || 0;
      const entry = monthlyData[monthKey][snap.platform] || { sum: 0, last: 0, lastDate: "" };
      entry.sum += value;
      if (snap.date >= entry.lastDate) {
        entry.last = value;
        entry.lastDate = snap.date;
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
        
        const val = (p?: { sum: number; last: number; lastDate: string }) => (p ? (isFlowMetric ? p.sum : p.last) : null);
        const appstore = val((platforms as any).appstore);
        let googleplay = val((platforms as any).googleplay);
        const stripe = val((platforms as any).stripe);
        
        // For Google Play subscriber metrics, treat 0 as null (no data)
        // MRR is calculated, so 0 is valid
        const subscriberMetrics = ["activeSubscribers", "trialSubscribers", "paidSubscribers", "monthlySubscribers", "yearlySubscribers"];
        if (subscriberMetrics.includes(metric) && googleplay === 0) {
          googleplay = null;
        }
        
        const isCurrencyMetric = ["mrr", "weeklyRevenue", "monthlyRevenueGross", "monthlyRevenueNet"].includes(metric);
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
      "graceEvents",
      "firstPayments",
      "renewals",
      "weeklyRevenue",
      "mrr",
      "monthlyRevenueGross",
      "monthlyRevenueNet",
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
      "monthlyRevenueGross",
      "monthlyRevenueNet",
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
          weeklyRevenue: 0,
          monthlyRevenueGross: 0,
          monthlyRevenueNet: 0,
        };
      }
      flowSumsByPlatform[snap.platform].cancellations += snap.cancellations;
      flowSumsByPlatform[snap.platform].churn += snap.churn;
      flowSumsByPlatform[snap.platform].graceEvents += snap.graceEvents;
      flowSumsByPlatform[snap.platform].firstPayments += snap.firstPayments;
      flowSumsByPlatform[snap.platform].renewals += (snap.renewals || 0);
      // weeklyRevenue is optional - fallback to monthlyRevenueNet for old data
      flowSumsByPlatform[snap.platform].weeklyRevenue += (snap.weeklyRevenue !== undefined ? snap.weeklyRevenue : snap.monthlyRevenueNet);
      flowSumsByPlatform[snap.platform].monthlyRevenueGross += snap.monthlyRevenueGross;
      flowSumsByPlatform[snap.platform].monthlyRevenueNet += snap.monthlyRevenueNet;
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
      const weeklyData: Record<string, Record<string, { sum: number; last: number; lastDate: string }>> = {};
      const monthlyData: Record<string, Record<string, { sum: number; last: number; lastDate: string }>> = {};
      const isFlowMetric = flowMetrics.includes(metric);
      const isStockMetric = stockMetrics.includes(metric);

      for (const snap of snapshots) {
        if (snap.platform === "unified") continue;

        const date = new Date(snap.date);
        const weekStart = getWeekStart(date, app.weekStartDay || "monday");
        const weekKey = weekStart.toISOString().split("T")[0];
        const monthKey = snap.date.substring(0, 7); // YYYY-MM

        const value = (snap as any)[metric] || 0;

        // Weekly aggregation
        if (!weeklyData[weekKey]) weeklyData[weekKey] = {} as any;
        const weekEntry = weeklyData[weekKey][snap.platform] || { sum: 0, last: 0, lastDate: "" };
        weekEntry.sum += value;
        if (snap.date >= weekEntry.lastDate) {
          weekEntry.last = value;
          weekEntry.lastDate = snap.date;
        }
        weeklyData[weekKey][snap.platform] = weekEntry;

        // Monthly aggregation
        if (!monthlyData[monthKey]) monthlyData[monthKey] = {} as any;
        const monthEntry = monthlyData[monthKey][snap.platform] || { sum: 0, last: 0, lastDate: "" };
        monthEntry.sum += value;
        if (snap.date >= monthEntry.lastDate) {
          monthEntry.last = value;
          monthEntry.lastDate = snap.date;
        }
        monthlyData[monthKey][snap.platform] = monthEntry;
      }

      // Process weekly data
      const weeklyResult = Object.entries(weeklyData)
        .map(([week, platforms]) => {
          const platformsInWeek = new Set(Object.keys(platforms));
          const hasAllPlatforms = Array.from(activePlatforms).every((p) => platformsInWeek.has(p));
          
          const val = (p?: { sum: number; last: number; lastDate: string }) => (p ? (isFlowMetric ? p.sum : p.last) : null);
          const appstore = val((platforms as any).appstore);
          let googleplay = val((platforms as any).googleplay);
          const stripe = val((platforms as any).stripe);
          
          // For Google Play subscriber metrics, treat 0 as null (no data)
          // MRR is calculated, so 0 is valid
          const subscriberMetrics = ["activeSubscribers", "trialSubscribers", "paidSubscribers", "monthlySubscribers", "yearlySubscribers"];
          if (subscriberMetrics.includes(metric) && googleplay === 0) {
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
          
          const val = (p?: { sum: number; last: number; lastDate: string }) => (p ? (isFlowMetric ? p.sum : p.last) : null);
          const appstore = val((platforms as any).appstore);
          let googleplay = val((platforms as any).googleplay);
          const stripe = val((platforms as any).stripe);
          
          // For Google Play subscriber metrics, treat 0 as null (no data)
          // MRR is calculated, so 0 is valid
          const subscriberMetrics = ["activeSubscribers", "trialSubscribers", "paidSubscribers", "monthlySubscribers", "yearlySubscribers"];
          if (subscriberMetrics.includes(metric) && googleplay === 0) {
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
      "monthlyRevenueGross",
      "monthlyRevenueNet",
    ];

    const flowMetrics = [
      "cancellations",
      "churn",
      "graceEvents",
      "firstPayments",
      "renewals",
      "monthlyRevenueGross",
      "monthlyRevenueNet",
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
          
          // For Google Play subscriber metrics, treat 0 as null (no data)
          // MRR is calculated, so 0 is valid
          const subscriberMetrics = ["activeSubscribers", "trialSubscribers", "paidSubscribers", "monthlySubscribers", "yearlySubscribers"];
          if (subscriberMetrics.includes(metric) && googleplay === 0) {
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
        monthlyRevenueGross: "Total revenue before fees",
        monthlyRevenueNet: "Revenue after platform fees",
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
        monthlyRevenueGross: snap.monthlyRevenueGross,
        monthlyRevenueNet: snap.monthlyRevenueNet,
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
        snapshotTotals[snap.platform].gross += snap.monthlyRevenueGross;
        snapshotTotals[snap.platform].net += snap.monthlyRevenueNet;
        snapshotTotals[snap.platform].count += 1;
      }
      if (snap.platform === "unified") {
        snapshotTotals.unified.gross += snap.monthlyRevenueGross;
        snapshotTotals.unified.net += snap.monthlyRevenueNet;
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
          monthlyRevenueGross: s.monthlyRevenueGross,
          monthlyRevenueNet: s.monthlyRevenueNet,
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
          monthlyRevenueGross: s.monthlyRevenueGross,
          monthlyRevenueNet: s.monthlyRevenueNet,
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
          monthlyRevenueGross: s.monthlyRevenueGross,
          monthlyRevenueNet: s.monthlyRevenueNet,
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
      octTotals[snap.platform].gross += snap.monthlyRevenueGross;
      octTotals[snap.platform].net += snap.monthlyRevenueNet;
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
          gross: snap.monthlyRevenueGross,
          net: snap.monthlyRevenueNet,
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
