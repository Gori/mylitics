import { v } from "convex/values";
import { mutation, internalMutation } from "./_generated/server";
import { requireUserId, validateAppOwnership } from "./lib/authHelpers";

export const deleteMetricsSnapshot = mutation({
  args: {
    snapshotId: v.id("metricsSnapshots"),
  },
  handler: async (ctx, { snapshotId }) => {
    // First get the snapshot to find its appId
    const snapshot = await ctx.db.get(snapshotId);
    if (!snapshot) throw new Error("Snapshot not found");

    // Validate the user owns the app this snapshot belongs to
    await validateAppOwnership(ctx, snapshot.appId);

    await ctx.db.delete(snapshotId);
    return { success: true };
  },
});

export const deleteMetricsSnapshotInternal = internalMutation({
  args: {
    snapshotId: v.id("metricsSnapshots"),
  },
  handler: async (ctx, { snapshotId }) => {
    await ctx.db.delete(snapshotId);
    return { success: true };
  },
});

export const addPlatformConnection = mutation({
  args: {
    appId: v.id("apps"),
    platform: v.union(
      v.literal("appstore"),
      v.literal("googleplay"),
      v.literal("stripe")
    ),
    credentials: v.string(),
  },
  handler: async (ctx, { appId, platform, credentials }) => {
    await validateAppOwnership(ctx, appId);

    // Check if connection already exists
    const existing = await ctx.db
      .query("platformConnections")
      .withIndex("by_app", (q) => q.eq("appId", appId))
      .filter((q) => q.eq(q.field("platform"), platform))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        credentials,
        isActive: true,
      });
      return existing._id;
    }

    return await ctx.db.insert("platformConnections", {
      appId,
      platform,
      credentials,
      isActive: true,
    });
  },
});

export const removePlatformConnection = mutation({
  args: {
    appId: v.id("apps"),
    connectionId: v.id("platformConnections"),
  },
  handler: async (ctx, { appId, connectionId }) => {
    await validateAppOwnership(ctx, appId);

    const connection = await ctx.db.get(connectionId);
    if (!connection) throw new Error("Connection not found");

    if (connection.appId !== appId) {
      throw new Error("Unauthorized");
    }

    await ctx.db.patch(connectionId, { isActive: false });
  },
});

export const updateAppCurrency = mutation({
  args: {
    appId: v.id("apps"),
    currency: v.string(),
  },
  handler: async (ctx, { appId, currency }) => {
    await validateAppOwnership(ctx, appId);

    await ctx.db.patch(appId, { currency, updatedAt: Date.now() });
    return { success: true };
  },
});

export const updateUserPreferences = mutation({
  args: {
    revenueFormat: v.optional(v.union(v.literal("whole"), v.literal("twoDecimals"))),
    chartType: v.optional(v.union(v.literal("line"), v.literal("area"))),
  },
  handler: async (ctx, { revenueFormat, chartType }) => {
    const userId = await requireUserId(ctx);
    const updates: Record<string, "whole" | "twoDecimals" | "line" | "area"> = {};

    if (revenueFormat !== undefined) {
      updates.revenueFormat = revenueFormat;
    }

    if (chartType !== undefined) {
      updates.chartType = chartType;
    }

    if (Object.keys(updates).length === 0) {
      return { success: true };
    }

    await ctx.db.patch(userId, updates);
    return { success: true };
  },
});

export const storeExchangeRates = internalMutation({
  args: {
    rates: v.array(v.object({
      fromCurrency: v.string(),
      toCurrency: v.string(),
      rate: v.number(),
    })),
    yearMonth: v.optional(v.string()), // Optional: specific month for historical rates (YYYY-MM)
  },
  handler: async (ctx, { rates, yearMonth }) => {
    const timestamp = Date.now();
    // Use provided yearMonth or derive from current date
    const month = yearMonth || new Date().toISOString().substring(0, 7);
    
    let stored = 0;
    for (const { fromCurrency, toCurrency, rate } of rates) {
      const from = fromCurrency.toUpperCase();
      const to = toCurrency.toUpperCase();
      
      // Check if we already have a rate for this month (avoid duplicates)
      const existing = await ctx.db
        .query("exchangeRates")
        .withIndex("by_pair_month", (q) => q.eq("fromCurrency", from).eq("toCurrency", to).eq("yearMonth", month))
        .first();
      
      if (!existing) {
        await ctx.db.insert("exchangeRates", {
          fromCurrency: from,
          toCurrency: to,
          rate,
          timestamp,
          yearMonth: month,
        });
        stored++;
      }
    }
    
    return { success: true, count: stored, skipped: rates.length - stored };
  },
});

export const cleanupDuplicateSnapshots = mutation({
  args: {
    appId: v.id("apps"),
  },
  handler: async (ctx, { appId }) => {
    await validateAppOwnership(ctx, appId);

    console.log(`[Cleanup] Starting duplicate snapshot cleanup for app ${appId}`);

    // Get all snapshots for this app
    const allSnapshots = await ctx.db
      .query("metricsSnapshots")
      .withIndex("by_app_date", (q) => q.eq("appId", appId))
      .collect();

    console.log(`[Cleanup] Found ${allSnapshots.length} total snapshots`);

    // Group by date + platform
    const grouped: Record<string, any[]> = {};
    for (const snap of allSnapshots) {
      const key = `${snap.date}_${snap.platform}`;
      if (!grouped[key]) {
        grouped[key] = [];
      }
      grouped[key].push(snap);
    }

    let duplicatesFound = 0;
    let duplicatesDeleted = 0;

    // For each group with duplicates, keep the most recent one and delete the rest
    for (const [key, snapshots] of Object.entries(grouped)) {
      if (snapshots.length > 1) {
        duplicatesFound += snapshots.length - 1;
        
        // Sort by _creationTime descending (most recent first)
        snapshots.sort((a, b) => b._creationTime - a._creationTime);
        
        const [keep, ...toDelete] = snapshots;
        console.log(`[Cleanup] ${key}: Found ${snapshots.length} duplicates, keeping ${keep._id}, deleting ${toDelete.length}`);
        
        for (const snap of toDelete) {
          await ctx.db.delete(snap._id);
          duplicatesDeleted++;
        }
      }
    }

    console.log(`[Cleanup] Complete - Found ${duplicatesFound} duplicates, deleted ${duplicatesDeleted}`);

    return {
      success: true,
      duplicatesFound,
      duplicatesDeleted,
      totalSnapshots: allSnapshots.length,
      uniqueSnapshots: Object.keys(grouped).length,
    };
  },
});

export const fixAppStoreRevenue = mutation({
  args: {
    appId: v.id("apps"),
  },
  handler: async (ctx, { appId }) => {
    await validateAppOwnership(ctx, appId);

    console.log(`[Fix] Starting App Store revenue correction for app ${appId}`);

    // Get all App Store snapshots
    const appStoreSnapshots = await ctx.db
      .query("metricsSnapshots")
      .withIndex("by_app_platform", (q) => q.eq("appId", appId).eq("platform", "appstore"))
      .collect();

    console.log(`[Fix] Found ${appStoreSnapshots.length} App Store snapshots`);

    let fixed = 0;
    let totalRevenueRemoved = 0;

    for (const snap of appStoreSnapshots) {
      // Only fix if revenue is non-zero (indicating bad data)
      if (snap.monthlyChargedRevenue > 0 || snap.monthlyRevenue > 0) {
        totalRevenueRemoved += snap.monthlyRevenue;
        
        await ctx.db.patch(snap._id, {
          monthlyChargedRevenue: 0,
          monthlyRevenue: 0,
          weeklyChargedRevenue: 0,
          weeklyRevenue: 0,
        });
        
        fixed++;
      }
    }

    console.log(`[Fix] Fixed ${fixed} snapshots, removed ${totalRevenueRemoved.toFixed(2)} in incorrect revenue`);

    // Also update unified snapshots by recalculating them
    const dates = new Set(appStoreSnapshots.map(s => s.date));
    let unifiedFixed = 0;
    
    for (const date of dates) {
      const platformSnapshots = await ctx.db
        .query("metricsSnapshots")
        .withIndex("by_app_date", (q) => q.eq("appId", appId).eq("date", date))
        .filter((q) => q.neq(q.field("platform"), "unified"))
        .collect();

      if (platformSnapshots.length > 0) {
        const unified = {
          monthlyChargedRevenue: Math.round((platformSnapshots.reduce((acc, s) => acc + s.monthlyChargedRevenue, 0) + Number.EPSILON) * 100) / 100,
          monthlyRevenue: Math.round((platformSnapshots.reduce((acc, s) => acc + s.monthlyRevenue, 0) + Number.EPSILON) * 100) / 100,
          weeklyChargedRevenue: Math.round((platformSnapshots.reduce((acc, s) => acc + (s.weeklyChargedRevenue || s.monthlyChargedRevenue || 0), 0) + Number.EPSILON) * 100) / 100,
          weeklyRevenue: Math.round((platformSnapshots.reduce((acc, s) => acc + (s.weeklyRevenue || s.monthlyRevenue || 0), 0) + Number.EPSILON) * 100) / 100,
        };

        const existingUnified = await ctx.db
          .query("metricsSnapshots")
          .withIndex("by_app_date", (q) => q.eq("appId", appId).eq("date", date))
          .filter((q) => q.eq(q.field("platform"), "unified"))
          .first();

        if (existingUnified) {
          await ctx.db.patch(existingUnified._id, unified);
          unifiedFixed++;
        }
      }
    }

    console.log(`[Fix] Updated ${unifiedFixed} unified snapshots`);

    return {
      success: true,
      snapshotsFixed: fixed,
      totalRevenueRemoved,
      unifiedSnapshotsUpdated: unifiedFixed,
    };
  },
});

// Clear all metrics snapshots for revenue refactor migration
export const clearAllMetricsSnapshots = internalMutation({
  args: {},
  handler: async (ctx) => {
    const snapshots = await ctx.db.query("metricsSnapshots").collect();
    let deleted = 0;
    for (const snap of snapshots) {
      await ctx.db.delete(snap._id);
      deleted++;
    }
    console.log(`[Migration] Deleted ${deleted} metricsSnapshots`);
    return { deleted };
  },
});

// Clear all revenue events for revenue refactor migration
export const clearAllRevenueEvents = internalMutation({
  args: {},
  handler: async (ctx) => {
    const events = await ctx.db.query("revenueEvents").collect();
    let deleted = 0;
    for (const event of events) {
      await ctx.db.delete(event._id);
      deleted++;
    }
    console.log(`[Migration] Deleted ${deleted} revenueEvents`);
    return { deleted };
  },
});

