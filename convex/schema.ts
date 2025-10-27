import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    clerkId: v.optional(v.string()),
    email: v.string(),
  }).index("by_clerk_id", ["clerkId"]),

  platformConnections: defineTable({
    userId: v.id("users"),
    platform: v.union(
      v.literal("appstore"),
      v.literal("googleplay"),
      v.literal("stripe")
    ),
    credentials: v.string(), // Encrypted JSON string
    lastSync: v.optional(v.number()),
    isActive: v.boolean(),
  }).index("by_user", ["userId"]),

  metricsSnapshots: defineTable({
    userId: v.id("users"),
    date: v.string(), // ISO date string
    platform: v.union(
      v.literal("appstore"),
      v.literal("googleplay"),
      v.literal("stripe"),
      v.literal("unified")
    ),
    activeSubscribers: v.number(),
    trialSubscribers: v.number(),
    paidSubscribers: v.number(),
    cancellations: v.number(),
    churn: v.number(),
    graceEvents: v.number(),
    paybacks: v.number(),
    firstPayments: v.number(),
    renewals: v.number(),
    mrr: v.number(),
    weeklyRevenue: v.optional(v.number()), // Actual revenue received this day (for weekly aggregation)
    monthlyRevenueGross: v.number(),
    monthlyRevenueNet: v.number(),
    monthlySubscribers: v.optional(v.number()), // Count of monthly subscription subscribers
    yearlySubscribers: v.optional(v.number()), // Count of yearly subscription subscribers
  })
    .index("by_user_date", ["userId", "date"])
    .index("by_user_platform", ["userId", "platform"]),

  subscriptions: defineTable({
    userId: v.id("users"),
    platform: v.union(
      v.literal("appstore"),
      v.literal("googleplay"),
      v.literal("stripe")
    ),
    externalId: v.string(),
    customerId: v.optional(v.string()),
    status: v.string(),
    productId: v.string(),
    startDate: v.number(),
    endDate: v.optional(v.number()),
    isTrial: v.boolean(),
    willCancel: v.boolean(),
    isInGrace: v.boolean(),
    rawData: v.string(), // JSON string of raw platform data
  })
    .index("by_user", ["userId"])
    .index("by_user_platform", ["userId", "platform"])
    .index("by_external_id", ["platform", "externalId"]),

  revenueEvents: defineTable({
    userId: v.id("users"),
    platform: v.union(
      v.literal("appstore"),
      v.literal("googleplay"),
      v.literal("stripe")
    ),
    subscriptionId: v.id("subscriptions"),
    eventType: v.union(
      v.literal("first_payment"),
      v.literal("renewal"),
      v.literal("refund")
    ),
    amount: v.number(),
    currency: v.string(),
    timestamp: v.number(),
    rawData: v.string(),
  })
    .index("by_user", ["userId"])
    .index("by_user_platform", ["userId", "platform"])
    .index("by_user_platform_time", ["userId", "platform", "timestamp"]),

  // Logs for sync progress and status
  syncLogs: defineTable({
    userId: v.id("users"),
    timestamp: v.number(),
    message: v.string(),
    level: v.optional(v.string()), // info | error | success
  }).index("by_user_time", ["userId", "timestamp"]),

  // Raw App Store Server Notifications (V2) for ingestion
  appStoreNotifications: defineTable({
    userId: v.optional(v.id("users")),
    timestamp: v.number(),
    notificationType: v.string(),
    subtype: v.optional(v.string()),
    originalTransactionId: v.optional(v.string()),
    bundleId: v.optional(v.string()),
    environment: v.optional(v.string()),
    rawPayload: v.string(),
  }).index("by_user_time", ["userId", "timestamp"]),

  // Stored App Store Connect reports (raw content for audit/debug)
  appStoreReports: defineTable({
    userId: v.id("users"),
    reportType: v.string(), // e.g. SUBSCRIPTION
    reportSubType: v.string(), // e.g. SUMMARY
    frequency: v.string(), // DAILY | WEEKLY | MONTHLY
    vendorNumber: v.string(),
    reportDate: v.string(), // YYYY-MM-DD
    bundleId: v.optional(v.string()),
    content: v.string(), // TSV content (decompressed)
    createdAt: v.number(),
  }).index("by_user_date", ["userId", "reportDate"]),

  // Track active sync sessions to prevent concurrent syncs
  syncStatus: defineTable({
    userId: v.id("users"),
    startedAt: v.number(),
    status: v.union(v.literal("active"), v.literal("completed"), v.literal("cancelled")),
  }).index("by_user_status", ["userId", "status"]),
});

