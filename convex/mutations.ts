import { v } from "convex/values";
import { mutation } from "./_generated/server";

async function getUserId(ctx: any) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;

  const existing = await ctx.db
    .query("users")
    .withIndex("by_clerk_id", (q: any) => q.eq("clerkId", identity.subject))
    .first();

  if (existing) return existing._id;

  // Create the user document on first authenticated call
  // Backfill: if a user exists by email but missing clerkId, patch it
  if (identity.email) {
    const byEmail = await ctx.db
      .query("users")
      .filter((q: any) => q.eq(q.field("email"), identity.email))
      .first();
    if (byEmail) {
      await ctx.db.patch(byEmail._id, { clerkId: identity.subject });
      return byEmail._id;
    }
  }

  if (!identity.email) throw new Error("Authenticated user missing email");
  return await ctx.db.insert("users", {
    clerkId: identity.subject,
    email: identity.email,
  });
}

export const addPlatformConnection = mutation({
  args: {
    platform: v.union(
      v.literal("appstore"),
      v.literal("googleplay"),
      v.literal("stripe")
    ),
    credentials: v.string(),
  },
  handler: async (ctx, { platform, credentials }) => {
    const userId = await getUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    // Check if connection already exists
    const existing = await ctx.db
      .query("platformConnections")
      .withIndex("by_user", (q) => q.eq("userId", userId))
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
      userId,
      platform,
      credentials,
      isActive: true,
    });
  },
});

export const removePlatformConnection = mutation({
  args: {
    connectionId: v.id("platformConnections"),
  },
  handler: async (ctx, { connectionId }) => {
    const userId = await getUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const connection = await ctx.db.get(connectionId);
    if (!connection) throw new Error("Connection not found");

    if (connection.userId !== userId) {
      throw new Error("Unauthorized");
    }

    await ctx.db.patch(connectionId, { isActive: false });
  },
});

