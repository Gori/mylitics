import { v } from "convex/values";
import { mutation, internalMutation } from "./_generated/server";
import { getAuthUserId } from "./auth";

async function getUserId(ctx: any) {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("Not authenticated");
  return userId;
}

async function validateAppOwnership(ctx: any, appId: string) {
  const userId = await getUserId(ctx);
  
  const app = await ctx.db.get(appId);
  if (!app) throw new Error("App not found");
  if (app.userId !== userId) throw new Error("Not authorized");
  
  return app;
}

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

export const storeExchangeRates = internalMutation({
  args: {
    rates: v.array(v.object({
      fromCurrency: v.string(),
      toCurrency: v.string(),
      rate: v.number(),
    })),
  },
  handler: async (ctx, { rates }) => {
    const timestamp = Date.now();
    
    for (const { fromCurrency, toCurrency, rate } of rates) {
      await ctx.db.insert("exchangeRates", {
        fromCurrency: fromCurrency.toUpperCase(),
        toCurrency: toCurrency.toUpperCase(),
        rate,
        timestamp,
      });
    }
    
    return { success: true, count: rates.length };
  },
});

