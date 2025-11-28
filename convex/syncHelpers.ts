import { v } from "convex/values";
import { mutation, query, internalQuery, internalMutation } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { getAuthUserId } from "./auth";

async function getUserId(ctx: any) {
  const userId = await getAuthUserId(ctx);
  return userId || null;
}

// Helper to check if exchange rate exists for a currency
async function hasExchangeRate(ctx: any, currency: string): Promise<boolean> {
  const targetCurrency = currency.toUpperCase();
  
  // USD always has rates (base currency)
  if (targetCurrency === "USD") return true;
  
  // Check if USD -> targetCurrency exists
  const directRate = await ctx.db
    .query("exchangeRates")
    .withIndex("by_pair", (q: any) => q.eq("fromCurrency", "USD").eq("toCurrency", targetCurrency))
    .order("desc")
    .first();
  
  if (directRate) return true;
  
  // Check if targetCurrency -> USD exists (inverse)
  const inverseRate = await ctx.db
    .query("exchangeRates")
    .withIndex("by_pair", (q: any) => q.eq("fromCurrency", targetCurrency).eq("toCurrency", "USD"))
    .order("desc")
    .first();
  
  return !!inverseRate;
}

export const triggerSync = mutation({
  args: {
    appId: v.id("apps"),
    forceHistorical: v.optional(v.boolean()),
    platform: v.optional(v.union(v.literal("stripe"), v.literal("googleplay"), v.literal("appstore"))),
  },
  handler: async (ctx, { appId, forceHistorical, platform }) => {
    const userId = await getUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    // Validate app ownership
    const app = await ctx.db.get(appId);
    if (!app || app.userId !== userId) {
      throw new Error("Not authorized");
    }

    // Check if exchange rates exist for the app's currency
    const appCurrency = app.currency || "USD";
    const hasRate = await hasExchangeRate(ctx, appCurrency);
    
    if (!hasRate) {
      throw new Error(`Exchange rates not available for ${appCurrency}. Please fetch exchange rates first by clicking "Fetch Rates".`);
    }

    await ctx.scheduler.runAfter(0, api.sync.syncAllPlatforms, {
      appId,
      forceHistorical: forceHistorical || false,
      platform,
    });

    return { success: true };
  },
});

export const triggerExchangeRatesFetch = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    await ctx.scheduler.runAfter(0, api.crons.fetchExchangeRates, {});

    return { success: true };
  },
});

export const resetConnectionSyncs = mutation({
  args: { appId: v.id("apps") },
  handler: async (ctx, { appId }) => {
    const userId = await getUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    // Validate app ownership
    const app = await ctx.db.get(appId);
    if (!app || app.userId !== userId) {
      throw new Error("Not authorized");
    }

    const connections = await ctx.db
      .query("platformConnections")
      .withIndex("by_app", (q) => q.eq("appId", appId))
      .collect();

    for (const conn of connections) {
      await ctx.db.patch(conn._id, { lastSync: undefined });
    }

    return { success: true, reset: connections.length };
  },
});

export const getPlatformConnections = internalQuery({
  args: {
    appId: v.id("apps"),
  },
  handler: async (ctx, { appId }) => {
    return await ctx.db
      .query("platformConnections")
      .withIndex("by_app", (q) => q.eq("appId", appId))
      .filter((q) => q.eq(q.field("isActive"), true))
      .collect();
  },
});

export const updateLastSync = internalMutation({
  args: {
    connectionId: v.id("platformConnections"),
  },
  handler: async (ctx, { connectionId }) => {
    await ctx.db.patch(connectionId, {
      lastSync: Date.now(),
    });
  },
});

export const appendSyncLog = internalMutation({
  args: {
    appId: v.id("apps"),
    message: v.string(),
    level: v.optional(v.string()),
  },
  handler: async (ctx, { appId, message, level }) => {
    await ctx.db.insert("syncLogs", {
      appId,
      timestamp: Date.now(),
      message,
      level,
    });
  },
});

export const getRecentSyncLogs = internalQuery({
  args: {
    appId: v.id("apps"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { appId, limit = 50 }) => {
    return await ctx.db
      .query("syncLogs")
      .withIndex("by_app_time", (q) => q.eq("appId", appId))
      .order("desc")
      .take(limit);
  },
});

export const getAllAppsWithConnections = internalQuery({
  args: {},
  handler: async (ctx) => {
    const connections = await ctx.db.query("platformConnections").collect();
    const appIds = [...new Set(connections.map((c) => c.appId).filter((id): id is NonNullable<typeof id> => id !== undefined))];
    const apps = await Promise.all(appIds.map((id) => ctx.db.get(id)));
    return apps.filter((a) => a !== null);
  },
});

export const recordAppStoreNotification = internalMutation({
  args: {
    appId: v.optional(v.id("apps")),
    notificationType: v.optional(v.string()),
    subtype: v.optional(v.string()),
    originalTransactionId: v.optional(v.string()),
    bundleId: v.optional(v.string()),
    environment: v.optional(v.string()),
    rawPayload: v.string(),
  },
  handler: async (
    ctx,
    { appId, notificationType, subtype, originalTransactionId, bundleId, environment, rawPayload }
  ) => {
    await ctx.db.insert("appStoreNotifications", {
      appId,
      timestamp: Date.now(),
      notificationType: notificationType ?? "unknown",
      subtype,
      originalTransactionId,
      bundleId,
      environment,
      rawPayload,
    });
  },
});

export const saveAppStoreReport = internalMutation({
  args: {
    appId: v.id("apps"),
    reportType: v.string(),
    reportSubType: v.string(),
    frequency: v.string(),
    vendorNumber: v.string(),
    reportDate: v.string(),
    bundleId: v.optional(v.string()),
    content: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("appStoreReports", {
      ...args,
      createdAt: Date.now(),
    });
  },
});

export const getLatestAppStoreSnapshot = internalQuery({
  args: {
    appId: v.id("apps"),
  },
  handler: async (ctx, { appId }) => {
    return await ctx.db
      .query("metricsSnapshots")
      .withIndex("by_app_platform", (q) => q.eq("appId", appId).eq("platform", "appstore"))
      .order("desc")
      .first();
  },
});

export const startSync = internalMutation({
  args: {
    appId: v.id("apps"),
  },
  handler: async (ctx, { appId }) => {
    // Cancel any existing active syncs
    const existingSync = await ctx.db
      .query("syncStatus")
      .withIndex("by_app_status", (q) => q.eq("appId", appId).eq("status", "active"))
      .first();
    
    if (existingSync) {
      await ctx.db.patch(existingSync._id, { status: "cancelled" });
    }
    
    // Create new sync status
    const syncId = await ctx.db.insert("syncStatus", {
      appId,
      startedAt: Date.now(),
      status: "active",
    });
    
    return syncId;
  },
});

export const checkSyncCancelled = internalQuery({
  args: {
    syncId: v.id("syncStatus"),
  },
  handler: async (ctx, { syncId }) => {
    const sync = await ctx.db.get(syncId);
    return sync?.status === "cancelled";
  },
});

export const completeSyncSession = internalMutation({
  args: {
    syncId: v.id("syncStatus"),
    status: v.union(v.literal("completed"), v.literal("cancelled")),
  },
  handler: async (ctx, { syncId, status }) => {
    await ctx.db.patch(syncId, { status });
  },
});

export const cancelSync = mutation({
  args: {
    appId: v.id("apps"),
  },
  handler: async (ctx, { appId }) => {
    const userId = await getUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    // Validate app ownership
    const app = await ctx.db.get(appId);
    if (!app || app.userId !== userId) {
      throw new Error("Not authorized");
    }

    // Find active sync and cancel it
    const activeSync = await ctx.db
      .query("syncStatus")
      .withIndex("by_app_status", (q) => q.eq("appId", appId).eq("status", "active"))
      .first();
    
    if (activeSync) {
      await ctx.db.patch(activeSync._id, { status: "cancelled" });
      return { success: true };
    }
    
    return { success: false, message: "No active sync to cancel" };
  },
});

export const getActiveSyncStatus = query({
  args: {
    appId: v.id("apps"),
  },
  handler: async (ctx, { appId }) => {
    const userId = await getUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    // Validate app ownership
    const app = await ctx.db.get(appId);
    if (!app || app.userId !== userId) {
      throw new Error("Not authorized");
    }

    const activeSync = await ctx.db
      .query("syncStatus")
      .withIndex("by_app_status", (q) => q.eq("appId", appId).eq("status", "active"))
      .first();
    
    return activeSync ? { active: true, syncId: activeSync._id, startedAt: activeSync.startedAt } : { active: false };
  },
});

// Get Google Play connection credentials for debugging
export const getGooglePlayCredentials = query({
  args: {
    appId: v.id("apps"),
  },
  handler: async (ctx, { appId }) => {
    const userId = await getUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const app = await ctx.db.get(appId);
    if (!app || app.userId !== userId) {
      throw new Error("Not authorized");
    }

    const connection = await ctx.db
      .query("platformConnections")
      .withIndex("by_app", (q) => q.eq("appId", appId))
      .filter((q) => q.eq(q.field("platform"), "googleplay"))
      .first();

    if (!connection) {
      return null;
    }

    const credentials = JSON.parse(connection.credentials);
    return {
      gcsBucketName: credentials.gcsBucketName,
      gcsReportPrefix: credentials.gcsReportPrefix || "",
      packageName: credentials.packageName,
      // Don't expose the service account JSON
    };
  },
});

