import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getAuthUserId } from "./auth";

// Helper to get current authenticated user ID
async function getUserId(ctx: any) {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("Not authenticated");
  return userId;
}

// Helper to validate app ownership
async function validateAppOwnership(ctx: any, appId: string) {
  const userId = await getUserId(ctx);
  const app = await ctx.db.get(appId);
  
  if (!app) {
    throw new Error("App not found");
  }
  
  if (app.userId !== userId) {
    throw new Error("Not authorized to access this app");
  }
  
  return app;
}

// Get all apps for the current user
export const getUserApps = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getUserId(ctx);
    
    const apps = await ctx.db
      .query("apps")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    
    return apps.sort((a, b) => b.createdAt - a.createdAt);
  },
});

// Get a specific app by slug
export const getAppBySlug = query({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const userId = await getUserId(ctx);
    
    const app = await ctx.db
      .query("apps")
      .withIndex("by_user_slug", (q) => q.eq("userId", userId).eq("slug", slug))
      .first();
    
    if (!app) {
      throw new Error("App not found");
    }
    
    return app;
  },
});

// Get app by ID
export const getAppById = query({
  args: { appId: v.id("apps") },
  handler: async (ctx, { appId }) => {
    const app = await validateAppOwnership(ctx, appId);
    return app;
  },
});

// Create a new app
export const createApp = mutation({
  args: {
    name: v.string(),
    slug: v.string(),
    currency: v.optional(v.string()),
  },
  handler: async (ctx, { name, slug, currency }) => {
    const userId = await getUserId(ctx);
    
    // Validate slug is unique for this user
    const existing = await ctx.db
      .query("apps")
      .withIndex("by_user_slug", (q) => q.eq("userId", userId).eq("slug", slug))
      .first();
    
    if (existing) {
      throw new Error("An app with this slug already exists");
    }
    
    const now = Date.now();
    const appId = await ctx.db.insert("apps", {
      userId,
      name,
      slug,
      currency: currency || "USD",
      weekStartDay: "monday",
      createdAt: now,
      updatedAt: now,
    });
    
    return appId;
  },
});

// Update an app
export const updateApp = mutation({
  args: {
    appId: v.id("apps"),
    name: v.optional(v.string()),
    currency: v.optional(v.string()),
    weekStartDay: v.optional(v.union(v.literal("monday"), v.literal("sunday"))),
    useAppStoreRatioForGooglePlay: v.optional(v.boolean()),
  },
  handler: async (ctx, { appId, name, currency, weekStartDay, useAppStoreRatioForGooglePlay }) => {
    await validateAppOwnership(ctx, appId);
    
    const updates: any = {
      updatedAt: Date.now(),
    };
    
    if (name !== undefined) updates.name = name;
    if (currency !== undefined) updates.currency = currency;
    if (weekStartDay !== undefined) updates.weekStartDay = weekStartDay;
    if (useAppStoreRatioForGooglePlay !== undefined) updates.useAppStoreRatioForGooglePlay = useAppStoreRatioForGooglePlay;
    
    await ctx.db.patch(appId, updates);
    
    return appId;
  },
});

// Delete an app and all its associated data
export const deleteApp = mutation({
  args: { appId: v.id("apps") },
  handler: async (ctx, { appId }) => {
    await validateAppOwnership(ctx, appId);
    
    // Delete all platform connections
    const connections = await ctx.db
      .query("platformConnections")
      .withIndex("by_app", (q) => q.eq("appId", appId))
      .collect();
    
    for (const conn of connections) {
      await ctx.db.delete(conn._id);
    }
    
    // Delete all metrics snapshots
    const metrics = await ctx.db
      .query("metricsSnapshots")
      .withIndex("by_app_platform", (q) => q.eq("appId", appId))
      .collect();
    
    for (const metric of metrics) {
      await ctx.db.delete(metric._id);
    }
    
    // Delete all subscriptions
    const subscriptions = await ctx.db
      .query("subscriptions")
      .withIndex("by_app", (q) => q.eq("appId", appId))
      .collect();
    
    for (const sub of subscriptions) {
      await ctx.db.delete(sub._id);
    }
    
    // Delete all revenue events
    const revenueEvents = await ctx.db
      .query("revenueEvents")
      .withIndex("by_app", (q) => q.eq("appId", appId))
      .collect();
    
    for (const event of revenueEvents) {
      await ctx.db.delete(event._id);
    }
    
    // Delete all sync logs
    const syncLogs = await ctx.db
      .query("syncLogs")
      .withIndex("by_app_time", (q) => q.eq("appId", appId))
      .collect();
    
    for (const log of syncLogs) {
      await ctx.db.delete(log._id);
    }
    
    // Delete all app store reports
    const reports = await ctx.db
      .query("appStoreReports")
      .withIndex("by_app_date", (q) => q.eq("appId", appId))
      .collect();
    
    for (const report of reports) {
      await ctx.db.delete(report._id);
    }
    
    // Delete sync status
    const syncStatus = await ctx.db
      .query("syncStatus")
      .withIndex("by_app_status", (q) => q.eq("appId", appId))
      .collect();
    
    for (const status of syncStatus) {
      await ctx.db.delete(status._id);
    }
    
    // Finally, delete the app itself
    await ctx.db.delete(appId);
    
    return { success: true };
  },
});

