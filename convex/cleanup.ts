import { mutation } from "./_generated/server";

// Cleanup mutations to remove old data - run each one separately
// This is a one-time migration helper - delete this file after running all cleanup functions

const BATCH_SIZE = 20; // Very small batch size to avoid size limits with large content fields

export const cleanupAppStoreReports = mutation({
  args: {},
  handler: async (ctx) => {
    let deleted = 0;
    // Ultra-small batch for reports with large content fields
    const SMALL_BATCH = 5;
    
    const records = await ctx.db.query("appStoreReports").take(SMALL_BATCH);
    if (records.length === 0) {
      return { deleted: 0, done: true };
    }
    
    for (const record of records) {
      await ctx.db.delete(record._id);
      deleted++;
    }
    
    return { deleted, done: records.length < SMALL_BATCH };
  },
});

export const cleanupAppStoreNotifications = mutation({
  args: {},
  handler: async (ctx) => {
    let deleted = 0;
    let hasMore = true;
    
    while (hasMore) {
      const records = await ctx.db.query("appStoreNotifications").take(BATCH_SIZE);
      if (records.length === 0) break;
      
      for (const record of records) {
        await ctx.db.delete(record._id);
        deleted++;
      }
      
      if (records.length < BATCH_SIZE) hasMore = false;
    }
    
    return { deleted };
  },
});

export const cleanupMetricsSnapshots = mutation({
  args: {},
  handler: async (ctx) => {
    let deleted = 0;
    let hasMore = true;
    
    while (hasMore) {
      const records = await ctx.db.query("metricsSnapshots").take(BATCH_SIZE);
      if (records.length === 0) break;
      
      for (const record of records) {
        await ctx.db.delete(record._id);
        deleted++;
      }
      
      if (records.length < BATCH_SIZE) hasMore = false;
    }
    
    return { deleted };
  },
});

export const cleanupSubscriptions = mutation({
  args: {},
  handler: async (ctx) => {
    let deleted = 0;
    let hasMore = true;
    
    while (hasMore) {
      const records = await ctx.db.query("subscriptions").take(BATCH_SIZE);
      if (records.length === 0) break;
      
      for (const record of records) {
        await ctx.db.delete(record._id);
        deleted++;
      }
      
      if (records.length < BATCH_SIZE) hasMore = false;
    }
    
    return { deleted };
  },
});

export const cleanupRevenueEvents = mutation({
  args: {},
  handler: async (ctx) => {
    let deleted = 0;
    let hasMore = true;
    
    while (hasMore) {
      const records = await ctx.db.query("revenueEvents").take(BATCH_SIZE);
      if (records.length === 0) break;
      
      for (const record of records) {
        await ctx.db.delete(record._id);
        deleted++;
      }
      
      if (records.length < BATCH_SIZE) hasMore = false;
    }
    
    return { deleted };
  },
});

export const cleanupSyncLogs = mutation({
  args: {},
  handler: async (ctx) => {
    let deleted = 0;
    let hasMore = true;
    
    while (hasMore) {
      const records = await ctx.db.query("syncLogs").take(BATCH_SIZE);
      if (records.length === 0) break;
      
      for (const record of records) {
        await ctx.db.delete(record._id);
        deleted++;
      }
      
      if (records.length < BATCH_SIZE) hasMore = false;
    }
    
    return { deleted };
  },
});

export const cleanupSyncStatus = mutation({
  args: {},
  handler: async (ctx) => {
    let deleted = 0;
    let hasMore = true;
    
    while (hasMore) {
      const records = await ctx.db.query("syncStatus").take(BATCH_SIZE);
      if (records.length === 0) break;
      
      for (const record of records) {
        await ctx.db.delete(record._id);
        deleted++;
      }
      
      if (records.length < BATCH_SIZE) hasMore = false;
    }
    
    return { deleted };
  },
});

export const cleanupPlatformConnections = mutation({
  args: {},
  handler: async (ctx) => {
    let deleted = 0;
    let hasMore = true;
    
    while (hasMore) {
      const records = await ctx.db.query("platformConnections").take(BATCH_SIZE);
      if (records.length === 0) break;
      
      for (const record of records) {
        await ctx.db.delete(record._id);
        deleted++;
      }
      
      if (records.length < BATCH_SIZE) hasMore = false;
    }
    
    return { deleted };
  },
});

export const cleanupApps = mutation({
  args: {},
  handler: async (ctx) => {
    let deleted = 0;
    let hasMore = true;
    
    while (hasMore) {
      const records = await ctx.db.query("apps").take(BATCH_SIZE);
      if (records.length === 0) break;
      
      for (const record of records) {
        await ctx.db.delete(record._id);
        deleted++;
      }
      
      if (records.length < BATCH_SIZE) hasMore = false;
    }
    
    return { deleted };
  },
});

export const cleanupUsers = mutation({
  args: {},
  handler: async (ctx) => {
    let deleted = 0;
    let hasMore = true;
    
    while (hasMore) {
      const records = await ctx.db.query("users").take(BATCH_SIZE);
      if (records.length === 0) break;
      
      for (const record of records) {
        await ctx.db.delete(record._id);
        deleted++;
      }
      
      if (records.length < BATCH_SIZE) hasMore = false;
    }
    
    return { deleted };
  },
});

