import { v } from "convex/values";
import { mutation, internalQuery, internalMutation } from "./_generated/server";
import { api, internal } from "./_generated/api";

async function getUserId(ctx: any) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerk_id", (q: any) => q.eq("clerkId", identity.subject))
    .first();
  
  return user?._id ?? null;
}

export const triggerSync = mutation({
  args: {
    forceHistorical: v.optional(v.boolean()),
    platform: v.optional(v.union(v.literal("stripe"), v.literal("googleplay"), v.literal("appstore"))),
  },
  handler: async (ctx, { forceHistorical, platform }) => {
    const userId = await getUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    await ctx.scheduler.runAfter(0, api.sync.syncAllPlatforms, {
      userId,
      forceHistorical: forceHistorical || false,
      platform,
    });

    return { success: true };
  },
});

export const resetConnectionSyncs = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const connections = await ctx.db
      .query("platformConnections")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();

    for (const conn of connections) {
      await ctx.db.patch(conn._id, { lastSync: undefined });
    }

    return { success: true, reset: connections.length };
  },
});

export const getPlatformConnections = internalQuery({
  args: {
    userId: v.id("users"),
  },
  handler: async (ctx, { userId }) => {
    return await ctx.db
      .query("platformConnections")
      .withIndex("by_user", (q) => q.eq("userId", userId))
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
    userId: v.id("users"),
    message: v.string(),
    level: v.optional(v.string()),
  },
  handler: async (ctx, { userId, message, level }) => {
    await ctx.db.insert("syncLogs", {
      userId,
      timestamp: Date.now(),
      message,
      level,
    });
  },
});

export const getRecentSyncLogs = internalQuery({
  args: {
    userId: v.id("users"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { userId, limit = 50 }) => {
    return await ctx.db
      .query("syncLogs")
      .withIndex("by_user_time", (q) => q.eq("userId", userId))
      .order("desc")
      .take(limit);
  },
});

export const getAllUsersWithConnections = internalQuery({
  args: {},
  handler: async (ctx) => {
    const connections = await ctx.db.query("platformConnections").collect();
    const userIds = [...new Set(connections.map((c) => c.userId))];
    const users = await Promise.all(userIds.map((id) => ctx.db.get(id)));
    return users.filter((u) => u !== null);
  },
});

export const recordAppStoreNotification = internalMutation({
  args: {
    userId: v.optional(v.id("users")),
    notificationType: v.optional(v.string()),
    subtype: v.optional(v.string()),
    originalTransactionId: v.optional(v.string()),
    bundleId: v.optional(v.string()),
    environment: v.optional(v.string()),
    rawPayload: v.string(),
  },
  handler: async (
    ctx,
    { userId, notificationType, subtype, originalTransactionId, bundleId, environment, rawPayload }
  ) => {
    await ctx.db.insert("appStoreNotifications", {
      userId,
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
    userId: v.id("users"),
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
    userId: v.id("users"),
  },
  handler: async (ctx, { userId }) => {
    return await ctx.db
      .query("metricsSnapshots")
      .withIndex("by_user_platform", (q) => q.eq("userId", userId).eq("platform", "appstore"))
      .order("desc")
      .first();
  },
});

export const startSync = internalMutation({
  args: {
    userId: v.id("users"),
  },
  handler: async (ctx, { userId }) => {
    // Cancel any existing active syncs
    const existingSync = await ctx.db
      .query("syncStatus")
      .withIndex("by_user_status", (q) => q.eq("userId", userId).eq("status", "active"))
      .first();
    
    if (existingSync) {
      await ctx.db.patch(existingSync._id, { status: "cancelled" });
    }
    
    // Create new sync status
    const syncId = await ctx.db.insert("syncStatus", {
      userId,
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

