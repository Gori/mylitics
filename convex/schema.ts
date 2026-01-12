import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    email: v.string(),
    name: v.optional(v.string()),
    image: v.optional(v.string()),
    revenueFormat: v.optional(v.union(v.literal("whole"), v.literal("twoDecimals"))),
    chartType: v.optional(v.union(v.literal("line"), v.literal("area"))),
  }).index("by_email", ["email"]),

  apps: defineTable({
    userId: v.id("users"),
    name: v.string(),
    slug: v.string(),
    currency: v.optional(v.string()),
    weekStartDay: v.optional(v.union(v.literal("monday"), v.literal("sunday"))),
    useAppStoreRatioForGooglePlay: v.optional(v.boolean()), // Derive Google Play plan split from App Store ratio
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_user_slug", ["userId", "slug"]),

  platformConnections: defineTable({
    appId: v.id("apps"),
    platform: v.union(
      v.literal("appstore"),
      v.literal("googleplay"),
      v.literal("stripe")
    ),
    credentials: v.string(), // Encrypted JSON string
    lastSync: v.optional(v.number()),
    isActive: v.boolean(),
  }).index("by_app", ["appId"]),

  metricsSnapshots: defineTable({
    appId: v.id("apps"),
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
    paybacks: v.number(),
    firstPayments: v.number(),
    renewals: v.number(),
    refunds: v.optional(v.number()), // Count of refund events
    graceEvents: v.optional(v.number()), // Legacy field for backward compatibility
    mrr: v.number(),
    // Revenue fields
    monthlyChargedRevenue: v.number(), // Gross revenue (what customer paid, including VAT)
    monthlyRevenue: v.number(), // Net revenue (excluding VAT, but including platform fees)
    monthlyProceeds: v.optional(v.number()), // Actual payout (after VAT and platform fees)
    weeklyChargedRevenue: v.optional(v.number()), // Weekly gross
    weeklyRevenue: v.optional(v.number()), // Weekly net
    weeklyProceeds: v.optional(v.number()), // Weekly proceeds
    // Subscriber breakdown
    monthlySubscribers: v.optional(v.number()), // Count of monthly subscription subscribers
    yearlySubscribers: v.optional(v.number()), // Count of yearly subscription subscribers
    // Revenue breakdown by plan type (monthly vs yearly)
    monthlyPlanChargedRevenue: v.optional(v.number()), // Charged revenue from monthly plans
    yearlyPlanChargedRevenue: v.optional(v.number()), // Charged revenue from yearly plans
    monthlyPlanRevenue: v.optional(v.number()), // Revenue (excl VAT) from monthly plans
    yearlyPlanRevenue: v.optional(v.number()), // Revenue (excl VAT) from yearly plans
    monthlyPlanProceeds: v.optional(v.number()), // Proceeds from monthly plans
    yearlyPlanProceeds: v.optional(v.number()), // Proceeds from yearly plans
  })
    .index("by_app_date", ["appId", "date"])
    .index("by_app_platform", ["appId", "platform"]),

  subscriptions: defineTable({
    appId: v.id("apps"),
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
    isInGrace: v.optional(v.boolean()), // Legacy field for backward compatibility
    willCancel: v.boolean(),
    rawData: v.optional(v.string()), // JSON string of raw platform data
    // Stripe-specific fields for efficient MRR calculation
    trialEnd: v.optional(v.number()),
    priceAmount: v.optional(v.number()), // Price in smallest currency unit
    priceInterval: v.optional(v.string()), // "month" or "year"
    priceCurrency: v.optional(v.string()), // Currency code
  })
    .index("by_app", ["appId"])
    .index("by_app_platform", ["appId", "platform"])
    .index("by_external_id", ["platform", "externalId"]),

  revenueEvents: defineTable({
    appId: v.id("apps"),
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
    amount: v.number(), // Charged amount (including VAT)
    amountExcludingTax: v.optional(v.number()), // Amount excluding VAT
    amountProceeds: v.optional(v.number()), // Amount after platform fees (what you receive)
    currency: v.string(),
    country: v.optional(v.string()), // ISO country code for VAT calculation
    timestamp: v.number(),
    rawData: v.optional(v.string()),
    externalId: v.optional(v.string()), // Invoice ID or transaction ID
  })
    .index("by_app", ["appId"])
    .index("by_app_platform", ["appId", "platform"])
    .index("by_app_platform_time", ["appId", "platform", "timestamp"])
    .index("by_external_id", ["platform", "externalId"]),

  // Logs for sync progress and status
  syncLogs: defineTable({
    appId: v.id("apps"),
    timestamp: v.number(),
    message: v.string(),
    level: v.optional(v.string()), // info | error | success
  }).index("by_app_time", ["appId", "timestamp"]),

  // Raw App Store Server Notifications (V2) for ingestion
  appStoreNotifications: defineTable({
    appId: v.optional(v.id("apps")),
    timestamp: v.number(),
    notificationType: v.string(),
    subtype: v.optional(v.string()),
    originalTransactionId: v.optional(v.string()),
    bundleId: v.optional(v.string()),
    environment: v.optional(v.string()),
    rawPayload: v.string(),
  }).index("by_app_time", ["appId", "timestamp"]),

  // Stored App Store Connect reports (raw content for audit/debug)
  appStoreReports: defineTable({
    appId: v.optional(v.id("apps")),
    userId: v.optional(v.string()),
    reportType: v.string(), // e.g. SUBSCRIPTION
    reportSubType: v.string(), // e.g. SUMMARY
    frequency: v.string(), // DAILY | WEEKLY | MONTHLY
    vendorNumber: v.string(),
    reportDate: v.string(), // YYYY-MM-DD
    bundleId: v.optional(v.string()),
    content: v.string(), // TSV content (decompressed)
    createdAt: v.number(),
  }).index("by_app_date", ["appId", "reportDate"]),

  // Track active sync sessions to prevent concurrent syncs
  syncStatus: defineTable({
    appId: v.optional(v.id("apps")),
    startedAt: v.number(),
    status: v.union(v.literal("active"), v.literal("completed"), v.literal("cancelled")),
  }).index("by_app_status", ["appId", "status"]),

  // Exchange rates for currency conversion
  exchangeRates: defineTable({
    fromCurrency: v.string(), // e.g. "USD"
    toCurrency: v.string(), // e.g. "EUR"
    rate: v.number(), // e.g. 0.85
    timestamp: v.number(), // when this rate was fetched
    yearMonth: v.optional(v.string()), // e.g. "2024-01" for historical rates
  })
    .index("by_pair", ["fromCurrency", "toCurrency"])
    .index("by_pair_month", ["fromCurrency", "toCurrency", "yearMonth"]),

  // Track chunked sync progress for App Store
  syncProgress: defineTable({
    appId: v.id("apps"),
    platform: v.union(
      v.literal("appstore"),
      v.literal("googleplay"),
      v.literal("stripe")
    ),
    connectionId: v.id("platformConnections"),
    syncId: v.optional(v.id("syncStatus")),
    status: v.optional(v.union(v.literal("active"), v.literal("completed"), v.literal("failed"))),
    phase: v.optional(v.string()),
    credentials: v.string(),
    startDate: v.string(), // ISO date string
    totalDays: v.number(),
    processedDays: v.number(),
    currentChunk: v.number(),
    totalChunks: v.number(),
    lastProcessedDate: v.optional(v.string()),
    error: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_app_platform", ["appId", "platform"])
    .index("by_status", ["status"]),
});
