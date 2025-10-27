import { query } from "./_generated/server";
import { v } from "convex/values";

async function getUserId(ctx: any) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;

  const existing = await ctx.db
    .query("users")
    .withIndex("by_clerk_id", (q: any) => q.eq("clerkId", identity.subject))
    .first();

  if (existing) return existing._id;

  // Read-only path: if user doc missing, just return null; mutations will upsert/backfill.
  return null;
}

export const getLatestMetrics = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getUserId(ctx);
    if (!userId) return null;

    const now = new Date();
    const today = now.toISOString().split("T")[0];
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    
    const dateRangeStart = thirtyDaysAgo.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const dateRangeEnd = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

    const connections = await ctx.db
      .query("platformConnections")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .filter((q) => q.eq(q.field("isActive"), true))
      .collect();

    const lastSync = Math.max(...connections.map((c) => c.lastSync || 0));

    // Flow metrics (sum over 30 days or 7 days for weeklyRevenue)
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

    // Get the most recent snapshots for each platform (for stock metrics)
    const recentSnapshots = await ctx.db
      .query("metricsSnapshots")
      .withIndex("by_user_date", (q) => q.eq("userId", userId))
      .filter((q) => q.neq(q.field("platform"), "unified"))
      .order("desc")
      .take(100);

    // Get latest snapshot per platform for stock metrics
    const latestByPlatform: Record<string, any> = {};
    for (const snap of recentSnapshots) {
      if (!latestByPlatform[snap.platform]) {
        latestByPlatform[snap.platform] = snap;
      }
    }

    // Get 30-day snapshots for summing flow metrics
    const snapshots30 = await ctx.db
      .query("metricsSnapshots")
      .withIndex("by_user_date", (q) => q.eq("userId", userId))
      .filter((q) => q.gte(q.field("date"), thirtyDaysAgo.toISOString().split("T")[0]))
      .filter((q) => q.neq(q.field("platform"), "unified"))
      .collect();

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

    // Build platformMap with correct values for each metric type
    const platformMap: Record<string, any> = {};
    for (const platform of ["appstore", "googleplay", "stripe"]) {
      const latest = latestByPlatform[platform] || {};
      const flowSums = flowSumsByPlatform[platform] || {};
      
      // Stock metrics from latest snapshot, flow metrics from 30-day sums
      platformMap[platform] = {
        activeSubscribers: latest.activeSubscribers || 0,
        trialSubscribers: latest.trialSubscribers || 0,
        paidSubscribers: latest.paidSubscribers || 0,
        mrr: latest.mrr || 0,
        cancellations: flowSums.cancellations || 0,
        churn: flowSums.churn || 0,
        graceEvents: flowSums.graceEvents || 0,
        firstPayments: flowSums.firstPayments || 0,
        renewals: flowSums.renewals || 0,
        weeklyRevenue: flowSums.weeklyRevenue || 0,
        monthlyRevenueGross: flowSums.monthlyRevenueGross || 0,
        monthlyRevenueNet: flowSums.monthlyRevenueNet || 0,
        monthlySubscribers: latest.monthlySubscribers || 0,
        yearlySubscribers: latest.yearlySubscribers || 0,
      };
    }

    // Calculate unified by summing all platforms
    const unified = {
      activeSubscribers: platformMap.appstore.activeSubscribers + platformMap.googleplay.activeSubscribers + platformMap.stripe.activeSubscribers,
      trialSubscribers: platformMap.appstore.trialSubscribers + platformMap.googleplay.trialSubscribers + platformMap.stripe.trialSubscribers,
      paidSubscribers: platformMap.appstore.paidSubscribers + platformMap.googleplay.paidSubscribers + platformMap.stripe.paidSubscribers,
      cancellations: platformMap.appstore.cancellations + platformMap.googleplay.cancellations + platformMap.stripe.cancellations,
      churn: platformMap.appstore.churn + platformMap.googleplay.churn + platformMap.stripe.churn,
      graceEvents: platformMap.appstore.graceEvents + platformMap.googleplay.graceEvents + platformMap.stripe.graceEvents,
      paybacks: 0,
      firstPayments: platformMap.appstore.firstPayments + platformMap.googleplay.firstPayments + platformMap.stripe.firstPayments,
      renewals: platformMap.appstore.renewals + platformMap.googleplay.renewals + platformMap.stripe.renewals,
      weeklyRevenue: platformMap.appstore.weeklyRevenue + platformMap.googleplay.weeklyRevenue + platformMap.stripe.weeklyRevenue,
      mrr: platformMap.appstore.mrr + platformMap.googleplay.mrr + platformMap.stripe.mrr,
      monthlyRevenueGross: platformMap.appstore.monthlyRevenueGross + platformMap.googleplay.monthlyRevenueGross + platformMap.stripe.monthlyRevenueGross,
      monthlyRevenueNet: platformMap.appstore.monthlyRevenueNet + platformMap.googleplay.monthlyRevenueNet + platformMap.stripe.monthlyRevenueNet,
      monthlySubscribers: platformMap.appstore.monthlySubscribers + platformMap.googleplay.monthlySubscribers + platformMap.stripe.monthlySubscribers,
      yearlySubscribers: platformMap.appstore.yearlySubscribers + platformMap.googleplay.yearlySubscribers + platformMap.stripe.yearlySubscribers,
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
    days: v.optional(v.number()),
  },
  handler: async (ctx, { days = 30 }) => {
    const userId = await getUserId(ctx);
    if (!userId) return [];

    const snapshots = await ctx.db
      .query("metricsSnapshots")
      .withIndex("by_user_platform", (q) =>
        q.eq("userId", userId).eq("platform", "unified")
      )
      .order("desc")
      .take(days);

    return snapshots.reverse();
  },
});

export const getPlatformConnections = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getUserId(ctx);
    if (!userId) return [];

    const connections = await ctx.db
      .query("platformConnections")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .filter((q) => q.eq(q.field("isActive"), true))
      .collect();

    return connections.map((c) => ({
      _id: c._id,
      platform: c.platform,
      lastSync: c.lastSync,
    }));
  },
});

export const getSyncLogs = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { limit = 50 }) => {
    const userId = await getUserId(ctx);
    if (!userId) return [];
    return await ctx.db
      .query("syncLogs")
      .withIndex("by_user_time", (q) => q.eq("userId", userId))
      .order("desc")
      .take(limit);
  },
});

export const getWeeklyMetricsHistory = query({
  args: {
    metric: v.string(),
  },
  handler: async (ctx, { metric }) => {
    const userId = await getUserId(ctx);
    if (!userId) return [];

    const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    
    // Get active platform connections to determine which platforms should have data
    const connections = await ctx.db
      .query("platformConnections")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .filter((q) => q.eq(q.field("isActive"), true))
      .collect();
    
    const activePlatforms = new Set(connections.map((c) => c.platform));
    
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

    // Get all snapshots from past year
    const snapshots = await ctx.db
      .query("metricsSnapshots")
      .withIndex("by_user_date", (q) => q.eq("userId", userId))
      .filter((q) => q.gte(q.field("date"), oneYearAgo))
      .collect();

    // Group by week and platform
    const weeklyData: Record<string, Record<string, { sum: number; last: number; lastDate: string }>> = {};
    
    for (const snap of snapshots) {
      // Skip unified platform - we'll calculate it from the sum of platforms
      if (snap.platform === "unified") continue;

      const date = new Date(snap.date);
      const weekStart = new Date(date);
      weekStart.setDate(date.getDate() - date.getDay());
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

    // Convert to array, filter incomplete weeks, and sort by date
    const result = Object.entries(weeklyData)
      .map(([week, platforms]) => {
        // Check if all active platforms have data for this week
        const platformsInWeek = new Set(Object.keys(platforms));
        const hasAllPlatforms = Array.from(activePlatforms).every((p) => platformsInWeek.has(p));
        
        // For flow metrics, use sum of all days in the week; for stock metrics, use last day
        const val = (p?: { sum: number; last: number; lastDate: string }) => (p ? (isFlowMetric ? p.sum : p.last) : 0);
        const appstore = val((platforms as any).appstore);
        const googleplay = val((platforms as any).googleplay);
        const stripe = val((platforms as any).stripe);
        const unified = appstore + googleplay + stripe;
        return {
          week,
          appstore,
          googleplay,
          stripe,
          unified,
          hasAllPlatforms,
        };
      })
      .filter((w) => w.hasAllPlatforms) // Only include weeks with complete data
      .sort((a, b) => a.week.localeCompare(b.week))
      .slice(-52); // Keep last 52 weeks

    return result;
  },
});

export const getAllDebugData = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getUserId(ctx);
    if (!userId) return null;

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
      .withIndex("by_user", (q) => q.eq("userId", userId))
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
      .withIndex("by_user_date", (q) => q.eq("userId", userId))
      .filter((q) => q.gte(q.field("date"), oneYearAgo))
      .collect();

    // Get the most recent snapshots for each platform (for stock metrics like activeSubscribers, MRR)
    const recentSnapshots = await ctx.db
      .query("metricsSnapshots")
      .withIndex("by_user_date", (q) => q.eq("userId", userId))
      .filter((q) => q.neq(q.field("platform"), "unified"))
      .order("desc")
      .take(100);

    // Get latest snapshot per platform for stock metrics
    const latestByPlatform: Record<string, any> = {};
    for (const snap of recentSnapshots) {
      if (!latestByPlatform[snap.platform]) {
        latestByPlatform[snap.platform] = snap;
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

    for (const metric of metrics) {
      const weeklyData: Record<string, Record<string, { sum: number; last: number; lastDate: string }>> = {};
      const isFlowMetric = flowMetrics.includes(metric);

      for (const snap of snapshots) {
        // Skip unified platform - we'll calculate it from the sum of platforms
        if (snap.platform === "unified") continue;

        const date = new Date(snap.date);
        const weekStart = new Date(date);
        weekStart.setDate(date.getDate() - date.getDay());
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

      const result = Object.entries(weeklyData)
        .map(([week, platforms]) => {
          // Check if all active platforms have data for this week
          const platformsInWeek = new Set(Object.keys(platforms));
          const hasAllPlatforms = Array.from(activePlatforms).every((p) => platformsInWeek.has(p));
          
          // For flow metrics, use sum of all days in the week; for stock metrics, use last day
          const val = (p?: { sum: number; last: number; lastDate: string }) => (p ? (isFlowMetric ? p.sum : p.last) : 0);
          const appstore = val((platforms as any).appstore);
          const googleplay = val((platforms as any).googleplay);
          const stripe = val((platforms as any).stripe);
          const unified = appstore + googleplay + stripe;
          return { week, appstore, googleplay, stripe, unified, hasAllPlatforms };
        })
        .filter((w) => w.hasAllPlatforms) // Only include weeks with complete data
        .sort((a, b) => a.week.localeCompare(b.week))
        .slice(-52);

      weeklyDataByMetric[metric] = result;
    }

    return {
      weeklyDataByMetric,
      latestByPlatform,
      flowSumsByPlatform,
      flowMetrics,
      activePlatforms: Array.from(activePlatforms),
    };
  },
});

