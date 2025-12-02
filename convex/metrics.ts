import { v } from "convex/values";
import { mutation, query, internalMutation } from "./_generated/server";
import { Id } from "./_generated/dataModel";

// Helper to convert currency and round to 2 decimals
// This is the single source of truth for all currency conversions and rounding
async function convertAndRoundCurrency(ctx: any, amount: number, fromCurrency: string, toCurrency: string): Promise<number> {
  const from = fromCurrency.toUpperCase();
  const to = toCurrency.toUpperCase();
  
  // No conversion needed - same currency, just round
  if (from === to) {
    return Math.round((amount + Number.EPSILON) * 100) / 100;
  }
  
  // Get exchange rate
  const rate = await ctx.db
    .query("exchangeRates")
    .withIndex("by_pair", (q: any) => q.eq("fromCurrency", from).eq("toCurrency", to))
    .order("desc")
    .first();
  
  if (rate) {
    const converted = amount * rate.rate;
    return Math.round((converted + Number.EPSILON) * 100) / 100;
  }
  
  // Try inverse rate
  const inverseRate = await ctx.db
    .query("exchangeRates")
    .withIndex("by_pair", (q: any) => q.eq("fromCurrency", to).eq("toCurrency", from))
    .order("desc")
    .first();
  
  if (inverseRate) {
    const converted = amount / inverseRate.rate;
    return Math.round((converted + Number.EPSILON) * 100) / 100;
  }
  
  // If both currencies are not USD, try converting through USD
  if (from !== "USD" && to !== "USD") {
    const fromUSD = await ctx.db
      .query("exchangeRates")
      .withIndex("by_pair", (q: any) => q.eq("fromCurrency", "USD").eq("toCurrency", from))
      .order("desc")
      .first();
    
    const toUSD = await ctx.db
      .query("exchangeRates")
      .withIndex("by_pair", (q: any) => q.eq("fromCurrency", "USD").eq("toCurrency", to))
      .order("desc")
      .first();
    
    if (fromUSD && toUSD) {
      const amountInUSD = amount / fromUSD.rate;
      const converted = amountInUSD * toUSD.rate;
      return Math.round((converted + Number.EPSILON) * 100) / 100;
    }
  }
  
  // No rate found - throw error to prevent bad data
  throw new Error(`Exchange rate not found for ${from} -> ${to}. Please fetch exchange rates first by clicking "Fetch Rates" in the dashboard.`);
}

export const processAndStoreMetrics = internalMutation({
  args: {
    appId: v.id("apps"),
    platform: v.union(
      v.literal("appstore"),
      v.literal("googleplay"),
      v.literal("stripe")
    ),
    subscriptions: v.array(
      v.object({
        externalId: v.string(),
        customerId: v.optional(v.string()),
        status: v.string(),
        productId: v.string(),
        startDate: v.number(),
        endDate: v.optional(v.number()),
        isTrial: v.boolean(),
        willCancel: v.boolean(),
        isInGrace: v.boolean(),
        rawData: v.string(),
      })
    ),
    revenueEvents: v.array(
      v.object({
        subscriptionExternalId: v.string(),
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
    ),
    snapshotDate: v.optional(v.string()),
  },
  handler: async (ctx, { appId, platform, subscriptions, revenueEvents, snapshotDate }) => {
    const now = new Date();
    const today = snapshotDate || now.toISOString().split("T")[0];

    // Get app's preferred currency
    const app = await ctx.db.get(appId);
    const userCurrency = app?.currency || "USD";

    // Store raw subscription data
    console.log(`[Metrics ${platform}] Storing ${subscriptions.length} subscriptions...`);
    for (const sub of subscriptions) {
    const existing = await ctx.db
      .query("subscriptions")
      .withIndex("by_external_id", (q) =>
        q.eq("platform", platform).eq("externalId", sub.externalId)
      )
      .filter((q) => q.eq(q.field("appId"), appId))
      .first();

      if (existing) {
        await ctx.db.patch(existing._id, {
          status: sub.status,
          endDate: sub.endDate,
          willCancel: sub.willCancel,
          isInGrace: sub.isInGrace,
          rawData: sub.rawData,
        });
      } else {
        await ctx.db.insert("subscriptions", {
          appId,
          platform,
          ...sub,
        });
      }
    }
    
    // Store revenue events (with deduplication)
    console.log(`[Metrics ${platform}] Storing ${revenueEvents.length} revenue events...`);
    let revenueStored = 0;
    let revenueSkippedDuplicate = 0;
    let revenueSkippedNoSub = 0;
    
    console.log(`[Metrics ${platform}] Processing ${revenueEvents.length} revenue events from API`);
    
    // Sample first revenue event to debug
    if (revenueEvents.length > 0) {
      console.log(`[Metrics ${platform}] Sample revenue event: subscriptionExternalId="${revenueEvents[0].subscriptionExternalId}", eventType="${revenueEvents[0].eventType}", amount=${revenueEvents[0].amount}, timestamp=${revenueEvents[0].timestamp}`);
    }
    
    // Get all subscriptions for this user/platform for debugging
    const allSubs = await ctx.db
      .query("subscriptions")
      .withIndex("by_app_platform", (q) => q.eq("appId", appId).eq("platform", platform))
      .collect();
    console.log(`[Metrics ${platform}] Found ${allSubs.length} subscriptions in database for matching`);
    if (allSubs.length > 0 && allSubs.length <= 5) {
      console.log(`[Metrics ${platform}] Sample subscription externalIds: ${allSubs.map(s => s.externalId).join(", ")}`);
    }
    
    // Load all existing revenue events for this user/platform ONCE to avoid repeated queries
    const existingRevenue = await ctx.db
      .query("revenueEvents")
      .withIndex("by_app_platform", (q) => q.eq("appId", appId).eq("platform", platform))
      .collect();
    
    // Create a Set for fast duplicate checking: "subId_timestamp_amount"
    const existingKeys = new Set(
      existingRevenue.map(r => `${r.subscriptionId}_${r.timestamp}_${r.amount}`)
    );
    console.log(`[Metrics ${platform}] Found ${existingRevenue.length} existing revenue events in database`);
    
    // Create a map of externalId -> subscription for fast lookup
    const subMap = new Map(allSubs.map(s => [s.externalId, s]));
    
    for (const event of revenueEvents) {
      const sub = subMap.get(event.subscriptionExternalId);
      
      if (sub) {
        // Check if this revenue event already exists using the Set
        const key = `${sub._id}_${event.timestamp}_${event.amount}`;
        
        if (!existingKeys.has(key)) {
          await ctx.db.insert("revenueEvents", {
            appId,
            platform,
            subscriptionId: sub._id,
            eventType: event.eventType,
            amount: event.amount,
            currency: event.currency,
            timestamp: event.timestamp,
            rawData: event.rawData,
          });
          revenueStored++;
        } else {
          revenueSkippedDuplicate++;
        }
      } else {
        revenueSkippedNoSub++;
        // Log first few mismatches to debug
        if (revenueSkippedNoSub <= 3) {
          console.log(`[Metrics ${platform}] MISMATCH: Revenue event for subscriptionExternalId="${event.subscriptionExternalId}" (amount=${event.amount}) has no matching subscription in database`);
        }
      }
    }
    console.log(`[Metrics ${platform}] Revenue events: ${revenueStored} stored, ${revenueSkippedDuplicate} duplicates skipped, ${revenueSkippedNoSub} skipped (no subscription found)`);
    if (revenueSkippedNoSub > 0) {
      console.log(`[Metrics ${platform}] WARNING: ${revenueSkippedNoSub} revenue events could not be linked to subscriptions - they will not appear in metrics`);
    }
    console.log(`[Metrics ${platform}] Total revenue events in database: ${existingRevenue.length + revenueStored}`);
    
    const thirtyDaysAgo = now.getTime() - 30 * 24 * 60 * 60 * 1000;

    // ========== CALCULATE EVERYTHING FROM FRESH API DATA ONLY ==========
    
    // Current snapshot metrics
    const activeSubscribers = subscriptions.filter(
      (s) => s.status === "active" || s.status === "trialing"
    ).length;
    const trialSubscribers = subscriptions.filter((s) => s.isTrial).length;
    const paidSubscribers = activeSubscribers - trialSubscribers;

    // Track monthly vs yearly subscribers
    let monthlySubscribers = 0;
    let yearlySubscribers = 0;
    for (const s of subscriptions) {
      if (s.isTrial) continue;
      if (!(s.status === "active" || s.status === "trialing")) continue;
      
      try {
        const raw = JSON.parse(s.rawData);
        const interval = raw?.items?.data?.[0]?.price?.recurring?.interval;
        if (interval === "year") {
          yearlySubscribers++;
        } else if (interval === "month") {
          monthlySubscribers++;
        }
      } catch {}
    }

    // Flow metrics from subscription states (snapshot metrics - current counts)
    const cancellations = subscriptions.filter((s) => s.willCancel).length;
    const graceEvents = subscriptions.filter((s) => s.isInGrace).length;
    
    // Flow metrics from today's events only
    const todayStart = new Date(today).getTime();  // Start of day (00:00:00)
    const todayEnd = todayStart + 24 * 60 * 60 * 1000 - 1;  // End of day (23:59:59.999)
    const churn = subscriptions.filter((s) => s.status === "canceled" && s.endDate && s.endDate >= todayStart && s.endDate <= todayEnd).length;
    const firstPayments = revenueEvents.filter((e) => e.eventType === "first_payment" && e.timestamp >= todayStart && e.timestamp <= todayEnd).length;
    const renewals = revenueEvents.filter((e) => e.eventType === "renewal" && e.timestamp >= todayStart && e.timestamp <= todayEnd).length;

    // MRR from current active PAID subscription prices (exclude trials)
    let mrr = 0;
    for (const s of subscriptions) {
      // Skip trials entirely - they're not paying yet
      if (s.isTrial) continue;
      // Only include active subscriptions (not trialing, canceled, etc.)
      if (s.status !== "active") continue;
      try {
        const raw = JSON.parse(s.rawData);
        const items = raw?.items?.data || [];
        // Sum ALL items in the subscription (handles multi-item subscriptions)
        for (const item of items) {
          const unit = item?.price?.unit_amount;
          const interval = item?.price?.recurring?.interval;
          const intervalCount = item?.price?.recurring?.interval_count || 1;
          const currency = item?.price?.currency || "usd";
          if (typeof unit === "number") {
            // Convert to monthly amount based on interval
            let monthlyAmount: number;
            switch (interval) {
              case "day":
                monthlyAmount = (unit / 100) * (30 / intervalCount);
                break;
              case "week":
                monthlyAmount = (unit / 100) * (4.33 / intervalCount);
                break;
              case "month":
                monthlyAmount = (unit / 100) / intervalCount;
                break;
              case "year":
                monthlyAmount = (unit / 100) / (12 * intervalCount);
                break;
              default:
                monthlyAmount = unit / 100; // Assume monthly if unknown
            }
            const convertedAmount = await convertAndRoundCurrency(ctx, monthlyAmount, currency, userCurrency);
            mrr += convertedAmount;
          }
        }
      } catch {}
    }
    mrr = Math.round((mrr + Number.EPSILON) * 100) / 100;

    // Daily revenue from today's revenue events only
    // (We'll aggregate to monthly/weekly at display time)
    const todayRevenue = revenueEvents.filter((e) => e.timestamp >= todayStart && e.timestamp <= todayEnd);
    let monthlyRevenueGross = 0;
    let monthlyRevenueNet = 0;
    
    console.log(`[Metrics ${platform}] Date calculation - today: ${today}, todayStart: ${todayStart} (${new Date(todayStart).toISOString()}), todayEnd: ${todayEnd} (${new Date(todayEnd).toISOString()})`);
    console.log(`[Metrics ${platform}] Processing ${todayRevenue.length} revenue events for ${today} (from ${revenueEvents.length} total events passed from API, range ${todayStart}-${todayEnd})`);
    
    if (revenueEvents.length > 0 && todayRevenue.length === 0) {
      console.log(`[Metrics ${platform}] WARNING: We have ${revenueEvents.length} revenue events from API but 0 match today's date!`);
      console.log(`[Metrics ${platform}] Sample event timestamp: ${revenueEvents[0].timestamp} (${new Date(revenueEvents[0].timestamp).toISOString()})`);
    }
    
    if (todayRevenue.length > 0) {
      console.log(`[Metrics ${platform}] Sample revenue event: ${JSON.stringify(todayRevenue[0])}`);
    }
    
    for (const e of todayRevenue) {
      const convertedAmount = await convertAndRoundCurrency(ctx, e.amount, e.currency, userCurrency);
      
      if (e.eventType === "refund") {
        monthlyRevenueGross -= convertedAmount;
        monthlyRevenueNet -= convertedAmount * 0.85;
      } else {
        monthlyRevenueGross += convertedAmount;
        monthlyRevenueNet += convertedAmount * 0.85;
      }
    }
    
    monthlyRevenueGross = Math.round((monthlyRevenueGross + Number.EPSILON) * 100) / 100;
    monthlyRevenueNet = Math.round((monthlyRevenueNet + Number.EPSILON) * 100) / 100;

    // Weekly revenue is the net revenue for this day (will be summed over weeks for display)
    const weeklyRevenue = monthlyRevenueNet;

    console.log(`[Metrics ${platform}] Calculated - Active: ${activeSubscribers}, Trial: ${trialSubscribers}, Paid: ${paidSubscribers}, Cancellations: ${cancellations}, Churn: ${churn}, Grace: ${graceEvents}, First: ${firstPayments}, Renewals: ${renewals}, MRR: ${mrr}, Revenue: ${weeklyRevenue}`);
    console.log(`[Metrics ${platform}] Revenue breakdown - Gross: ${monthlyRevenueGross}, Net: ${monthlyRevenueNet}, Weekly: ${weeklyRevenue}`);

    // Store snapshot - find ALL existing snapshots for this date/platform
    const existingSnapshots = await ctx.db
      .query("metricsSnapshots")
      .withIndex("by_app_platform", (q) =>
        q.eq("appId", appId).eq("platform", platform)
      )
      .filter((q) => q.eq(q.field("date"), today))
      .collect();

    const snapshotData = {
      appId,
      date: today,
      platform,
      activeSubscribers,
      trialSubscribers,
      paidSubscribers,
      cancellations,
      churn,
      graceEvents,
      paybacks: 0,
      firstPayments,
      renewals,
      mrr,
      weeklyRevenue,
      monthlyRevenueGross,
      monthlyRevenueNet,
      monthlySubscribers,
      yearlySubscribers,
    };

    if (existingSnapshots.length > 0) {
      // Update the first one and delete any duplicates
      await ctx.db.patch(existingSnapshots[0]._id, snapshotData);
      for (let i = 1; i < existingSnapshots.length; i++) {
        console.log(`[Metrics ${platform}] Removing duplicate snapshot for ${today}`);
        await ctx.db.delete(existingSnapshots[i]._id);
      }
    } else {
      await ctx.db.insert("metricsSnapshots", snapshotData);
    }

    return {
      success: true,
      snapshot: snapshotData,
    };
  },
});

export const createUnifiedSnapshot = internalMutation({
  args: {
    appId: v.id("apps"),
  },
  handler: async (ctx, { appId }) => {
    const today = new Date().toISOString().split("T")[0];

    const platformSnapshots = await ctx.db
      .query("metricsSnapshots")
      .withIndex("by_app_date", (q) => q.eq("appId", appId).eq("date", today))
      .filter((q) => q.neq(q.field("platform"), "unified"))
      .collect();

    if (platformSnapshots.length === 0) return;

    const unified = {
      appId,
      date: today,
      platform: "unified" as const,
      activeSubscribers: platformSnapshots.reduce((acc, s) => acc + s.activeSubscribers, 0),
      trialSubscribers: platformSnapshots.reduce((acc, s) => acc + s.trialSubscribers, 0),
      paidSubscribers: platformSnapshots.reduce((acc, s) => acc + s.paidSubscribers, 0),
      cancellations: platformSnapshots.reduce((acc, s) => acc + s.cancellations, 0),
      churn: platformSnapshots.reduce((acc, s) => acc + s.churn, 0),
      graceEvents: platformSnapshots.reduce((acc, s) => acc + s.graceEvents, 0),
      paybacks: platformSnapshots.reduce((acc, s) => acc + s.paybacks, 0),
      firstPayments: platformSnapshots.reduce((acc, s) => acc + s.firstPayments, 0),
      renewals: platformSnapshots.reduce((acc, s) => acc + s.renewals, 0),
      mrr: Math.round((platformSnapshots.reduce((acc, s) => acc + s.mrr, 0) + Number.EPSILON) * 100) / 100,
      weeklyRevenue: Math.round((platformSnapshots.reduce((acc, s) => acc + (s.weeklyRevenue || s.monthlyRevenueNet || 0), 0) + Number.EPSILON) * 100) / 100,
      monthlyRevenueGross: Math.round((platformSnapshots.reduce((acc, s) => acc + s.monthlyRevenueGross, 0) + Number.EPSILON) * 100) / 100,
      monthlyRevenueNet: Math.round((platformSnapshots.reduce((acc, s) => acc + s.monthlyRevenueNet, 0) + Number.EPSILON) * 100) / 100,
      monthlySubscribers: platformSnapshots.reduce((acc, s) => acc + (s.monthlySubscribers || 0), 0),
      yearlySubscribers: platformSnapshots.reduce((acc, s) => acc + (s.yearlySubscribers || 0), 0),
    };

    const existingUnified = await ctx.db
      .query("metricsSnapshots")
      .withIndex("by_app_platform", (q) =>
        q.eq("appId", appId).eq("platform", "unified")
      )
      .filter((q) => q.eq(q.field("date"), today))
      .collect();

    if (existingUnified.length > 0) {
      await ctx.db.patch(existingUnified[0]._id, unified);
      // Clean up any duplicates
      for (let i = 1; i < existingUnified.length; i++) {
        await ctx.db.delete(existingUnified[i]._id);
      }
    } else {
      await ctx.db.insert("metricsSnapshots", unified);
    }
  },
});

export const generateHistoricalSnapshots = internalMutation({
  args: {
    appId: v.id("apps"),
    platform: v.union(
      v.literal("appstore"),
      v.literal("googleplay"),
      v.literal("stripe"),
    ),
    startMs: v.number(),
    endMs: v.number(),
  },
  handler: async (ctx, { appId, platform, startMs, endMs }) => {
    const oneDayMs = 24 * 60 * 60 * 1000;
    const totalDays = Math.floor((endMs - startMs) / oneDayMs) + 1;
    const chunkStartTime = Date.now();
    console.log(
      `[Metrics ${platform}] Historical generation starting: ${new Date(startMs).toISOString()} → ${new Date(endMs).toISOString()} (${totalDays} days)`
    );

    // Get app's preferred currency
    const app = await ctx.db.get(appId);
    const userCurrency = app?.currency || "USD";

    const subs = await ctx.db
      .query("subscriptions")
      .withIndex("by_app_platform", (q) => q.eq("appId", appId).eq("platform", platform))
      .collect();

    const revenue = await ctx.db
      .query("revenueEvents")
      .withIndex("by_app_platform", (q) => q.eq("appId", appId).eq("platform", platform))
      .collect();
    
    console.log(`[Historical ${platform}] Found ${subs.length} subscriptions and ${revenue.length} revenue events in database for historical calculation`);
    if (revenue.length > 0) {
      const minTimestamp = Math.min(...revenue.map(r => r.timestamp));
      const maxTimestamp = Math.max(...revenue.map(r => r.timestamp));
      console.log(`[Historical ${platform}] Revenue events date range: ${new Date(minTimestamp).toISOString()} to ${new Date(maxTimestamp).toISOString()}`);
    }

    let daysProcessed = 0;
    let lastProcessedDate: string | null = null;

    for (let dayStart = startMs; dayStart <= endMs; dayStart += oneDayMs) {
      const dayDate = new Date(dayStart);
      const date = dayDate.toISOString().split("T")[0];
      const dayEnd = dayStart + oneDayMs - 1;

      // Active subscriptions on this day
      const activeSubs = subs.filter(
        (s) => s.startDate <= dayEnd && (!s.endDate || s.endDate > dayStart)
      );

      // Calculate trials and MRR from active subs
      let trialSubscribers = 0;
      let mrr = 0;
      for (const s of activeSubs) {
        try {
          const raw = JSON.parse(s.rawData);
          const trialEnd = raw?.trial_end ? raw.trial_end * 1000 : null;
          if (trialEnd && dayStart < trialEnd) trialSubscribers += 1;

          // Only include active PAID subscriptions in MRR (not trialing)
          if (!s.isTrial && s.status === "active") {
            const items = raw?.items?.data || [];
            // Sum ALL items in the subscription
            for (const item of items) {
              const unit = item?.price?.unit_amount;
              const interval = item?.price?.recurring?.interval;
              const intervalCount = item?.price?.recurring?.interval_count || 1;
              const currency = item?.price?.currency || "usd";
              if (typeof unit === "number") {
                // Convert to monthly amount based on interval
                let monthlyAmount: number;
                switch (interval) {
                  case "day":
                    monthlyAmount = (unit / 100) * (30 / intervalCount);
                    break;
                  case "week":
                    monthlyAmount = (unit / 100) * (4.33 / intervalCount);
                    break;
                  case "month":
                    monthlyAmount = (unit / 100) / intervalCount;
                    break;
                  case "year":
                    monthlyAmount = (unit / 100) / (12 * intervalCount);
                    break;
                  default:
                    monthlyAmount = unit / 100;
                }
                const convertedAmount = await convertAndRoundCurrency(ctx, monthlyAmount, currency, userCurrency);
                mrr += convertedAmount;
              }
            }
          }
        } catch {}
      }
      mrr = Math.round((mrr + Number.EPSILON) * 100) / 100;

      const activeSubscribers = activeSubs.length;
      const paidSubscribers = activeSubscribers - trialSubscribers;
      
      // Track monthly vs yearly subscribers
      let monthlySubscribers = 0;
      let yearlySubscribers = 0;
      for (const s of activeSubs) {
        if (s.isTrial) continue;
        if (!(s.status === "active" || s.status === "trialing")) continue;
        
        try {
          const raw = JSON.parse(s.rawData);
          const interval = raw?.items?.data?.[0]?.price?.recurring?.interval;
          if (interval === "year") {
            yearlySubscribers++;
          } else if (interval === "month") {
            monthlySubscribers++;
          }
        } catch {}
      }
      
      // Flow metrics for this day
      const cancellations = activeSubs.filter((s) => s.willCancel).length;
      const churn = subs.filter((s) => s.status === "canceled" && s.endDate && s.endDate >= dayStart && s.endDate <= dayEnd).length;
      const graceEvents = activeSubs.filter((s) => s.isInGrace).length;

      // Revenue events on this day
      const dayRevenue = revenue.filter((e) => e.timestamp >= dayStart && e.timestamp <= dayEnd);
      const firstPayments = dayRevenue.filter((e) => e.eventType === "first_payment").length;
      const renewals = dayRevenue.filter((e) => e.eventType === "renewal").length;

      // Monthly revenue calculation
      let monthlyRevenueGross = 0;
      let monthlyRevenueNet = 0;
      for (const e of dayRevenue) {
        const convertedAmount = await convertAndRoundCurrency(ctx, e.amount, e.currency, userCurrency);
        
        if (e.eventType === "refund") {
          monthlyRevenueGross -= convertedAmount;
          monthlyRevenueNet -= convertedAmount * 0.85;
        } else {
          monthlyRevenueGross += convertedAmount;
          monthlyRevenueNet += convertedAmount * 0.85;
        }
      }
      monthlyRevenueGross = Math.round((monthlyRevenueGross + Number.EPSILON) * 100) / 100;
      monthlyRevenueNet = Math.round((monthlyRevenueNet + Number.EPSILON) * 100) / 100;
      const weeklyRevenue = monthlyRevenueNet;

      // Find ALL existing snapshots for this date/platform
      const existingSnapshots = await ctx.db
        .query("metricsSnapshots")
        .withIndex("by_app_platform", (q) => q.eq("appId", appId).eq("platform", platform))
        .filter((q) => q.eq(q.field("date"), date))
        .collect();

      const snapshot = {
        appId,
        date,
        platform,
        activeSubscribers,
        trialSubscribers,
        paidSubscribers,
        cancellations,
        churn,
        graceEvents,
        paybacks: 0,
        firstPayments,
        renewals,
        mrr,
        weeklyRevenue,
        monthlyRevenueGross,
        monthlyRevenueNet,
        monthlySubscribers,
        yearlySubscribers,
      } as const;

      if (existingSnapshots.length > 0) {
        // Update the first one and delete any duplicates
        await ctx.db.patch(existingSnapshots[0]._id, snapshot);
        for (let i = 1; i < existingSnapshots.length; i++) {
          await ctx.db.delete(existingSnapshots[i]._id);
        }
      } else {
        await ctx.db.insert("metricsSnapshots", snapshot);
      }

      daysProcessed += 1;
      if (daysProcessed % 30 === 0) {
        console.log(`[Metrics ${platform}] Generated ${daysProcessed} daily snapshots so far...`);
      }
      lastProcessedDate = date;
    }

    const durationMs = Date.now() - chunkStartTime;
    console.log(
      `[Metrics ${platform}] Historical generation complete: ${daysProcessed} of ${totalDays} days processed, lastDate=${lastProcessedDate}, duration=${durationMs}ms`
    );
  },
});

export const processAppStoreReport = internalMutation({
  args: {
    appId: v.id("apps"),
    date: v.string(), // YYYY-MM-DD
    tsv: v.string(),
    eventData: v.optional(v.object({
      renewals: v.number(),
      firstPayments: v.number(),
      cancellations: v.number(),
      revenueGross: v.optional(v.number()),
      revenueNet: v.optional(v.number()),
    })),
  },
  handler: async (ctx, { appId, date, tsv, eventData }) => {
    const lines = tsv.trim().split(/\r?\n/);
    if (lines.length < 2) {
      console.log(`[App Store ${date}] Empty TSV - no data`);
      return;
    }

    // Get app's preferred currency
    const app = await ctx.db.get(appId);
    const userCurrency = app?.currency || "USD";

    // Get previous day's snapshot to calculate cancellations
    const prevDate = new Date(new Date(date).getTime() - 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const prevSnapshot = await ctx.db
      .query("metricsSnapshots")
      .withIndex("by_app_platform", (q) => q.eq("appId", appId).eq("platform", "appstore"))
      .filter((q) => q.eq(q.field("date"), prevDate))
      .first();

    const headers = lines[0].split("\t").map((h) => h.trim().toLowerCase());
    console.log(`[App Store ${date}] Headers found:`, JSON.stringify(headers));

    const idx = (name: RegExp) => headers.findIndex((h) => name.test(h));
    
    // Look for SUBSCRIBER COUNT columns (this is a snapshot report, not events!)
    const activeSubsIdx = idx(/active.*subscri|subscri.*active/i);
    const activeTrialIdx = idx(/active.*free.*trial|active.*trial|trial.*intro/i);
    const activePaidIdx = idx(/active.*standard.*price|active.*paid/i);
    const gracePeriodIdx = idx(/grace\s*period/i);
    const billingRetryIdx = idx(/billing\s*retry/i);
    const subscribersIdx = idx(/^subscribers$/i);
    
    // Look for EVENT columns (might not exist in snapshot reports)
    const eventIdx = idx(/event\s*type|subscription\s*event/i);
    const unitsIdx = idx(/^units$/i);
    
    // Look for REVENUE columns
    const proceedsIdx = idx(/developer\s*proceeds|proceeds/i);
    const customerPriceIdx = idx(/customer\s*price/i);
    
    // Look for PRODUCT ID columns
    const productIdIdx = idx(/product.*id|sku|product.*identifier|subscription.*name/i);
    const subscriptionDurationIdx = idx(/subscription.*duration|duration/i);

    console.log(`[App Store ${date}] Column indices:`, {
      activeSubscribers: activeSubsIdx,
      activeTrials: activeTrialIdx,
      activePaid: activePaidIdx,
      gracePeriod: gracePeriodIdx,
      billingRetry: billingRetryIdx,
      subscribers: subscribersIdx,
      event: eventIdx,
      units: unitsIdx,
      proceeds: proceedsIdx,
      customerPrice: customerPriceIdx,
      productId: productIdIdx,
      subscriptionDuration: subscriptionDurationIdx
    });

    // Initialize metrics
    let activeSubscribers = 0;
    let trialSubscribers = 0;
    let paidSubscribers = 0;
    let firstPayments = 0;
    let renewals = 0;
    let refunds = 0;
    let cancellations = 0;
    let graceEvents = 0;
    let monthlyRevenueGross = 0;
    let monthlyRevenueNet = 0;
    let monthlySubsCount = 0;
    let yearlySubsCount = 0;
    const eventTypes: Record<string, number> = {};
    const productIds = new Set<string>();
    const sampleRows: string[] = [];
    const unmatchedProductIds = new Set<string>();

    // Parse each row
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split("\t");
      
      // Capture sample rows for debugging (first 3 rows)
      if (i <= 3) {
        sampleRows.push(lines[i]);
      }
      
      // Extract product ID for monthly/yearly categorization
      let productId = "";
      if (productIdIdx >= 0) {
        productId = (cols[productIdIdx] || "").trim().toLowerCase();
        if (productId) {
          productIds.add(productId);
        }
      }
      
      // Extract subscriber counts if columns exist
      const rowActiveSubscribers = activeSubsIdx >= 0 ? Number(cols[activeSubsIdx] || 0) : 0;
      if (activeSubsIdx >= 0) {
        activeSubscribers += rowActiveSubscribers;
      }
      
      // Categorize monthly vs yearly subscriptions based on product ID patterns
      if (productId && rowActiveSubscribers > 0) {
        const isMonthly = /month|monthly|1m|30day|_m_|_mo_/i.test(productId);
        const isYearly = /year|yearly|annual|12m|365day|_y_|_yr_/i.test(productId);
        
        if (isMonthly) {
          monthlySubsCount += rowActiveSubscribers;
        } else if (isYearly) {
          yearlySubsCount += rowActiveSubscribers;
        } else {
          unmatchedProductIds.add(productId);
        }
      } else if (subscriptionDurationIdx >= 0) {
        // Fallback: check subscription duration column if available
        const duration = (cols[subscriptionDurationIdx] || "").toLowerCase().trim();
        if (duration && rowActiveSubscribers > 0) {
          if (duration.includes("month") || duration === "1 month") {
            monthlySubsCount += rowActiveSubscribers;
          } else if (duration.includes("year") || duration === "1 year") {
            yearlySubsCount += rowActiveSubscribers;
          }
        }
      }
      
      if (activeTrialIdx >= 0) {
        const value = Number(cols[activeTrialIdx] || 0);
        trialSubscribers += value;
      }
      
      if (activePaidIdx >= 0) {
        const value = Number(cols[activePaidIdx] || 0);
        paidSubscribers += value;
      }
      
      if (gracePeriodIdx >= 0) {
        const value = Number(cols[gracePeriodIdx] || 0);
        graceEvents += value;
      }
      
      if (billingRetryIdx >= 0) {
        const value = Number(cols[billingRetryIdx] || 0);
        graceEvents += value;
      }
      
      // Extract event data if columns exist
      if (eventIdx >= 0 && unitsIdx >= 0) {
        const event = (cols[eventIdx] || "").toLowerCase().trim();
        const units = Number(cols[unitsIdx] || 0);
        
        if (event) {
          eventTypes[event] = (eventTypes[event] || 0) + units;
          
          // Match First Payment events
          if (event.includes("initial") || 
              event.includes("subscribe") || 
              event.includes("new subscription") ||
              event.includes("initial purchase") ||
              event.includes("first purchase")) {
            firstPayments += units;
          }
          // Match Renewal events - be comprehensive
          else if (event.includes("renew") || 
                   event.includes("renewal") ||
                   event.includes("did renew") ||
                   event.includes("auto-renew") ||
                   event.includes("auto renew")) {
            renewals += units;
          }
          // Match Refund events
          else if (event.includes("refund")) {
            refunds += units;
          }
          // Match Cancellation events
          else if (event.includes("cancel")) {
            cancellations += units;
          }
          // Match Grace/Billing Retry events
          else if (event.includes("grace") || event.includes("billing retry")) {
            graceEvents += units;
          }
        }
      }
      
      // DO NOT extract revenue from SUMMARY reports!
      // The SUMMARY report shows SNAPSHOT data (current subscription states), not transactions.
      // The "Customer Price" column is the subscription tier price, not actual revenue collected.
      // Summing these values would give total ARR/MRR value, not daily revenue.
      // Revenue should only come from SUBSCRIBER reports (event-based) or Server Notifications.
      
      // NOTE: Commented out to prevent incorrect revenue calculation
      // const gross = customerPriceIdx >= 0 ? Number(cols[customerPriceIdx] || 0) : 0;
      // const netRaw = proceedsIdx >= 0 ? Number(cols[proceedsIdx] || 0) : null;
      // const net = netRaw === null || isNaN(netRaw) ? gross * 0.85 : netRaw;
      // const convertedGross = await convertAndRoundCurrency(ctx, gross, "USD", userCurrency);
      // const convertedNet = await convertAndRoundCurrency(ctx, net, "USD", userCurrency);
      // monthlyRevenueGross += convertedGross;
      // monthlyRevenueNet += convertedNet;
    }

    console.log(`[App Store ${date}] ===== PARSING SUMMARY =====`);
    console.log(`[App Store ${date}] Subscriber counts - Active: ${activeSubscribers}, Trial: ${trialSubscribers}, Paid: ${paidSubscribers}`);
    console.log(`[App Store ${date}] Monthly/Yearly breakdown - Monthly: ${monthlySubsCount}, Yearly: ${yearlySubsCount}`);
    console.log(`[App Store ${date}] Product IDs found (${productIds.size}):`, Array.from(productIds).join(", "));
    if (unmatchedProductIds.size > 0) {
      console.log(`[App Store ${date}] ⚠️ UNMATCHED Product IDs (${unmatchedProductIds.size}):`, Array.from(unmatchedProductIds).join(", "));
    }
    console.log(`[App Store ${date}] Event types found (${Object.keys(eventTypes).length}):`, JSON.stringify(eventTypes));
    console.log(`[App Store ${date}] Event counts - First: ${firstPayments}, Renewals: ${renewals}, Refunds: ${refunds}, Cancellations: ${cancellations}, Grace: ${graceEvents}`);
    console.log(`[App Store ${date}] Revenue - Gross: ${monthlyRevenueGross.toFixed(2)}, Net: ${monthlyRevenueNet.toFixed(2)}`);
    if (sampleRows.length > 0) {
      console.log(`[App Store ${date}] Sample data rows (first ${sampleRows.length}):`);
      sampleRows.forEach((row, idx) => {
        console.log(`[App Store ${date}]   Row ${idx + 1}: ${row.substring(0, 200)}${row.length > 200 ? "..." : ""}`);
      });
    }
    console.log(`[App Store ${date}] ===========================`);

    // Use extracted subscriber counts directly (TSV contains actual counts, not deltas)
    const finalActiveSubscribers = activeSubscribers;
    const finalTrialSubscribers = trialSubscribers;
    // Paid = Active - Trial (activePaidIdx points to same column as activeSubsIdx in this TSV format)
    const finalPaidSubscribers = Math.max(0, activeSubscribers - trialSubscribers);

    // Calculate flow metrics from day-to-day comparison (snapshot reports don't have event data)
    let finalCancellations = 0;
    let finalChurn = 0;
    let finalFirstPayments = 0;
    let finalRenewals = 0;
    
    // Use event data from SUBSCRIBER report for events AND revenue
    if (eventData) {
      if (eventData.renewals > 0) {
        console.log(`[App Store ${date}] Using SUBSCRIBER report: Renewals=${eventData.renewals}`);
        finalRenewals = eventData.renewals;
      }
      
      // Use cancellations from event data only if present
      if (eventData.cancellations > 0) {
        finalCancellations = eventData.cancellations;
        console.log(`[App Store ${date}] Using SUBSCRIBER report: Cancellations=${eventData.cancellations}`);
      }
      
      // Use first payments from event data if present
      if (eventData.firstPayments > 0) {
        finalFirstPayments = eventData.firstPayments;
      }
      
      // Use REVENUE from SUBSCRIBER report if available
      // NOTE: eventData.revenueGross/Net are ALREADY in userCurrency (converted in processAppStoreSubscriberReport)
      if (eventData.revenueGross !== undefined && eventData.revenueGross > 0) {
        monthlyRevenueGross = eventData.revenueGross;
        monthlyRevenueNet = eventData.revenueNet ?? (eventData.revenueGross * 0.85);
        
        console.log(`[App Store ${date}] Using SUBSCRIBER report revenue: Gross=${monthlyRevenueGross.toFixed(2)} ${userCurrency}, Net=${monthlyRevenueNet.toFixed(2)} ${userCurrency}`);
      }
    }
    
    // Check if we have event data from SUMMARY TSV columns (rare)
    if (firstPayments > 0 || renewals > 0 || cancellations > 0) {
      console.log(`[App Store ${date}] Using SUMMARY TSV event data: First=${firstPayments}, Renewals=${renewals}, Cancellations=${cancellations}`);
      if (firstPayments > 0) finalFirstPayments = firstPayments;
      if (renewals > 0) finalRenewals = renewals;
      if (cancellations > 0) finalCancellations = cancellations;
    }
    
    // Use day-over-day for any metrics still at 0
    if (prevSnapshot) {
      const paidDrop = prevSnapshot.paidSubscribers - finalPaidSubscribers;
      const paidGain = finalPaidSubscribers - prevSnapshot.paidSubscribers;
      
      // Cancellations from day-over-day if not already set
      if (finalCancellations === 0 && paidDrop > 0) {
        finalCancellations = paidDrop;
        console.log(`[App Store ${date}] Day-over-day Cancellations: ${finalCancellations}`);
      }
      
      // First Payments from day-over-day if not already set
      if (finalFirstPayments === 0 && paidGain > 0) {
        finalFirstPayments = paidGain;
        console.log(`[App Store ${date}] Day-over-day First Payments: ${finalFirstPayments}`);
      }
    }
    
    finalChurn = finalCancellations;

    // MRR: Calculate from ARPU (Average Revenue Per User) using 30-day rolling average
    // ARPU = (30-day total net revenue) ÷ (sum of daily paid subscribers over 30 days)
    // MRR = current paidSubscribers × ARPU
    let estimatedMRR = 0;
    if (finalPaidSubscribers > 0) {
      const thirtyDaysAgo = new Date(new Date(date).getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
      const recentSnapshots = await ctx.db
        .query("metricsSnapshots")
        .withIndex("by_app_platform", (q) => q.eq("appId", appId).eq("platform", "appstore"))
        .filter((q) => q.gte(q.field("date"), thirtyDaysAgo))
        .filter((q) => q.lt(q.field("date"), date)) // Exclude current date to avoid circular dependency
        .collect();
      
      if (recentSnapshots.length > 0) {
        const totalRevenue = recentSnapshots.reduce((sum, s) => sum + (s.monthlyRevenueNet || 0), 0) + monthlyRevenueNet;
        const totalPaidSubs = recentSnapshots.reduce((sum, s) => sum + (s.paidSubscribers || 0), 0) + finalPaidSubscribers;
        const avgPaidSubs = totalPaidSubs / (recentSnapshots.length + 1);
        
        if (avgPaidSubs > 0) {
          const arpu = totalRevenue / avgPaidSubs; // Revenue per subscriber over the period
          estimatedMRR = finalPaidSubscribers * arpu;
        }
      } else {
        // No historical data - estimate from today's revenue × 30
        estimatedMRR = monthlyRevenueNet * 30;
      }
    }
    
    const weeklyRevenue = Math.round((monthlyRevenueNet + Number.EPSILON) * 100) / 100;
    
    const snapshot = {
      appId,
      date,
      platform: "appstore" as const,
      activeSubscribers: finalActiveSubscribers,
      trialSubscribers: finalTrialSubscribers,
      paidSubscribers: finalPaidSubscribers,
      cancellations: finalCancellations,
      churn: finalChurn,
      graceEvents,
      paybacks: 0,
      firstPayments: finalFirstPayments,
      renewals: finalRenewals,
      mrr: Math.round((estimatedMRR + Number.EPSILON) * 100) / 100,
      weeklyRevenue,
      monthlyRevenueGross: Math.round((monthlyRevenueGross + Number.EPSILON) * 100) / 100,
      monthlyRevenueNet: Math.round((monthlyRevenueNet + Number.EPSILON) * 100) / 100,
      monthlySubscribers: monthlySubsCount,
      yearlySubscribers: yearlySubsCount,
    };

    console.log(`[App Store ${date}] ===== FINAL SNAPSHOT =====`);
    console.log(`[App Store ${date}]`, JSON.stringify(snapshot, null, 2));
    console.log(`[App Store ${date}] ============================`);

    const existing = await ctx.db
      .query("metricsSnapshots")
      .withIndex("by_app_platform", (q) => q.eq("appId", appId).eq("platform", "appstore"))
      .filter((q) => q.eq(q.field("date"), date))
      .collect();

    if (existing.length > 0) {
      await ctx.db.patch(existing[0]._id, snapshot);
      for (let i = 1; i < existing.length; i++) {
        await ctx.db.delete(existing[i]._id);
      }
    } else {
      await ctx.db.insert("metricsSnapshots", snapshot);
    }
  },
});

export const processAppStoreSubscriberReport = internalMutation({
  args: {
    appId: v.id("apps"),
    date: v.string(), // YYYY-MM-DD
    tsv: v.string(),
  },
  handler: async (ctx, { appId, date, tsv }) => {
    const lines = tsv.trim().split(/\r?\n/);
    if (lines.length < 2) {
      console.log(`[App Store Subscriber ${date}] Empty TSV - no event data`);
      return { renewals: 0, firstPayments: 0, cancellations: 0, revenueGross: 0, revenueNet: 0 };
    }

    // Get app's preferred currency for conversion
    const app = await ctx.db.get(appId);
    const userCurrency = app?.currency || "USD";

    const headers = lines[0].split("\t").map((h) => h.trim().toLowerCase());
    console.log(`[App Store Subscriber ${date}] Headers:`, JSON.stringify(headers));

    const idx = (name: RegExp) => headers.findIndex((h) => name.test(h));
    
    // Look for "Event" column which contains event types like "Renew", "Cancel", etc.
    const eventIdx = idx(/^event$/i);
    const eventDateIdx = idx(/event.*date/i);
    const quantityIdx = idx(/^quantity$/i);
    
    // Look for REVENUE columns
    const customerPriceIdx = idx(/customer\s*price/i);
    const developerProceedsIdx = idx(/developer\s*proceeds/i);
    const proceedsIdx = idx(/^proceeds$/i); // Fallback to just "proceeds"
    
    // Use developerProceedsIdx if available, otherwise try proceedsIdx
    const netRevenueIdx = developerProceedsIdx >= 0 ? developerProceedsIdx : proceedsIdx;
    
    // Look for CURRENCY columns to know what currency the prices are in
    const customerCurrencyIdx = idx(/customer\s*currency/i);
    const proceedsCurrencyIdx = idx(/proceeds\s*currency/i);
    
    // Fallback: If no "Event" column, try "proceeds reason" (older format)
    const proceedsReasonIdx = idx(/proceeds\s*reason/i);
    
    const eventColumnIdx = eventIdx >= 0 ? eventIdx : proceedsReasonIdx;
    
    if (eventColumnIdx < 0) {
      console.log(`[App Store Subscriber ${date}] No 'Event' or 'Proceeds Reason' column found - skipping`);
      console.log(`[App Store Subscriber ${date}] Available headers:`, headers.join(", "));
      return { renewals: 0, firstPayments: 0, cancellations: 0, revenueGross: 0, revenueNet: 0 };
    }

    // CRITICAL: If we can't filter by event date, we CANNOT extract revenue
    // because the SUBSCRIBER report contains events from multiple days.
    // Summing all rows would give us cumulative revenue, not daily revenue.
    const canFilterByDate = eventDateIdx >= 0;
    if (!canFilterByDate) {
      console.log(`[App Store Subscriber ${date}] ⚠️ No 'Event Date' column found - revenue extraction DISABLED to prevent inflation`);
      console.log(`[App Store Subscriber ${date}] Available headers:`, headers.join(", "));
    }

    console.log(`[App Store Subscriber ${date}] Column indices:`, {
      event: eventIdx,
      proceedsReason: proceedsReasonIdx,
      eventDate: eventDateIdx,
      quantity: quantityIdx,
      customerPrice: customerPriceIdx,
      customerCurrency: customerCurrencyIdx,
      developerProceeds: developerProceedsIdx,
      proceedsCurrency: proceedsCurrencyIdx,
      proceeds: proceedsIdx,
      usingColumn: eventIdx >= 0 ? "Event" : "Proceeds Reason",
      canExtractRevenue: canFilterByDate,
    });

    let renewals = 0;
    let firstPayments = 0;
    let cancellations = 0;
    let revenueGross = 0;
    let revenueNet = 0;
    const eventTypes: Record<string, number> = {};
    const sampleEvents: string[] = [];
    const currenciesSeen: Record<string, number> = {}; // Track currencies for debugging
    let rowsProcessed = 0;
    let rowsSkippedWrongDate = 0;

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split("\t");
      const eventValue = (cols[eventColumnIdx] || "").trim();
      const quantity = quantityIdx >= 0 ? Number(cols[quantityIdx] || 1) : 1;
      
      // Check if event date matches the target date (CRITICAL FIX!)
      if (eventDateIdx >= 0) {
        const eventDateStr = (cols[eventDateIdx] || "").trim();
        // Event date might be in format "YYYY-MM-DD" or "MM/DD/YYYY" or other formats
        // Extract YYYY-MM-DD if possible
        let normalizedEventDate = eventDateStr;
        if (eventDateStr.includes("/")) {
          // Convert MM/DD/YYYY to YYYY-MM-DD
          const parts = eventDateStr.split("/");
          if (parts.length === 3) {
            const month = parts[0].padStart(2, "0");
            const day = parts[1].padStart(2, "0");
            const year = parts[2];
            normalizedEventDate = `${year}-${month}-${day}`;
          }
        }
        
        // Only process events that occurred on the target date
        if (normalizedEventDate !== date) {
          rowsSkippedWrongDate++;
          continue; // Skip this row
        }
      }
      
      rowsProcessed++;
      
      // Extract revenue amounts for this row ONLY if we can filter by date
      // Otherwise we'd be summing cumulative revenue from multiple days
      let rowGross = 0;
      let rowNet = 0;
      if (canFilterByDate) {
        const rowGrossRaw = customerPriceIdx >= 0 ? Number(cols[customerPriceIdx] || 0) : 0;
        const rowNetRaw = netRevenueIdx >= 0 ? Number(cols[netRevenueIdx] || 0) : (rowGrossRaw * 0.85);
        // Read actual currency from the report - don't assume USD!
        const grossCurrency = customerCurrencyIdx >= 0 ? (cols[customerCurrencyIdx] || "USD").trim() : "USD";
        const netCurrency = proceedsCurrencyIdx >= 0 ? (cols[proceedsCurrencyIdx] || "USD").trim() : "USD";
        // Track currencies seen for debugging
        currenciesSeen[grossCurrency] = (currenciesSeen[grossCurrency] || 0) + 1;
        rowGross = await convertAndRoundCurrency(ctx, rowGrossRaw, grossCurrency, userCurrency);
        rowNet = await convertAndRoundCurrency(ctx, rowNetRaw, netCurrency, userCurrency);
      }
      
      if (eventValue) {
        const eventLower = eventValue.toLowerCase();
        eventTypes[eventValue] = (eventTypes[eventValue] || 0) + quantity;
        
        // Capture sample events for debugging (first 5)
        if (sampleEvents.length < 5 && !sampleEvents.includes(eventValue)) {
          sampleEvents.push(eventValue);
        }
        
        // Determine if this is a revenue-generating event (not a cancellation or refund)
        const isRevenueEvent = !eventLower.includes("cancel") && !eventLower.includes("refund");
        
        // Match renewal patterns
        if (eventLower === "renew" || 
            eventLower.includes("renewal") ||
            eventLower.includes("renewal from billing retry") ||
            eventLower.includes("rate after one year")) { // Higher revenue share after 1 year
          renewals += quantity;
          if (isRevenueEvent) {
            revenueGross += rowGross;
            revenueNet += rowNet;
          }
        } 
        // Match new subscription/first payment patterns
        else if (eventLower.includes("start introductory price") ||
                 eventLower.includes("paid subscription from introductory price") ||
                 eventLower.includes("start promotional offer") ||
                 eventLower.includes("initial") || 
                 eventLower.includes("new") || 
                 eventLower.includes("subscribe")) {
          firstPayments += quantity;
          if (isRevenueEvent) {
            revenueGross += rowGross;
            revenueNet += rowNet;
          }
        } 
        // Match cancellation/refund patterns (subtract revenue)
        else if (eventLower === "cancel" || 
                 eventLower.includes("canceled") ||
                 eventLower.includes("refund")) {
          cancellations += quantity;
          // Refunds are negative revenue
          revenueGross -= rowGross;
          revenueNet -= rowNet;
        }
      }
    }

    console.log(`[App Store Subscriber ${date}] ===== PROCESSING SUMMARY =====`);
    console.log(`[App Store Subscriber ${date}] Total rows in report: ${lines.length - 1}`);
    console.log(`[App Store Subscriber ${date}] Rows processed (matching date ${date}): ${rowsProcessed}`);
    console.log(`[App Store Subscriber ${date}] Rows skipped (wrong date): ${rowsSkippedWrongDate}`);
    console.log(`[App Store Subscriber ${date}] Currencies seen:`, JSON.stringify(currenciesSeen));
    console.log(`[App Store Subscriber ${date}] Event values found (${Object.keys(eventTypes).length}):`, JSON.stringify(eventTypes));
    console.log(`[App Store Subscriber ${date}] Sample events:`, sampleEvents.join(", "));
    console.log(`[App Store Subscriber ${date}] Counts - Renewals: ${renewals}, First Payments: ${firstPayments}, Cancellations: ${cancellations}`);
    console.log(`[App Store Subscriber ${date}] Revenue extraction enabled: ${canFilterByDate}`);
    console.log(`[App Store Subscriber ${date}] Revenue - Gross: ${revenueGross.toFixed(2)} ${userCurrency}, Net: ${revenueNet.toFixed(2)} ${userCurrency}`);

    return { 
      renewals, 
      firstPayments, 
      cancellations,
      revenueGross,
      revenueNet 
    };
  },
});

export const storeAppStoreReport = internalMutation({
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

export const generateUnifiedHistoricalSnapshots = internalMutation({
  args: {
    appId: v.id("apps"),
    daysBack: v.number(),
  },
  handler: async (ctx, { appId, daysBack }) => {
    const today = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;
    let created = 0;

    // Process each day from daysBack to yesterday (not today, that's handled separately)
    for (let i = daysBack; i >= 1; i--) {
      const dateMs = today - (i * oneDayMs);
      const dateStr = new Date(dateMs).toISOString().split("T")[0];

      // Get all platform snapshots for this date
      const platformSnapshots = await ctx.db
        .query("metricsSnapshots")
        .withIndex("by_app_date", (q) => q.eq("appId", appId).eq("date", dateStr))
        .filter((q) => q.neq(q.field("platform"), "unified"))
        .collect();

      // Skip if no platform data for this date
      if (platformSnapshots.length === 0) continue;

      // Sum up all platforms
      const unified = {
        appId,
        date: dateStr,
        platform: "unified" as const,
        activeSubscribers: platformSnapshots.reduce((acc, s) => acc + s.activeSubscribers, 0),
        trialSubscribers: platformSnapshots.reduce((acc, s) => acc + s.trialSubscribers, 0),
        paidSubscribers: platformSnapshots.reduce((acc, s) => acc + s.paidSubscribers, 0),
        cancellations: platformSnapshots.reduce((acc, s) => acc + s.cancellations, 0),
        churn: platformSnapshots.reduce((acc, s) => acc + s.churn, 0),
        graceEvents: platformSnapshots.reduce((acc, s) => acc + s.graceEvents, 0),
        paybacks: platformSnapshots.reduce((acc, s) => acc + s.paybacks, 0),
        firstPayments: platformSnapshots.reduce((acc, s) => acc + s.firstPayments, 0),
        renewals: platformSnapshots.reduce((acc, s) => acc + s.renewals, 0),
        mrr: Math.round((platformSnapshots.reduce((acc, s) => acc + s.mrr, 0) + Number.EPSILON) * 100) / 100,
        weeklyRevenue: Math.round((platformSnapshots.reduce((acc, s) => acc + (s.weeklyRevenue || s.monthlyRevenueNet || 0), 0) + Number.EPSILON) * 100) / 100,
        monthlyRevenueGross: Math.round((platformSnapshots.reduce((acc, s) => acc + s.monthlyRevenueGross, 0) + Number.EPSILON) * 100) / 100,
        monthlyRevenueNet: Math.round((platformSnapshots.reduce((acc, s) => acc + s.monthlyRevenueNet, 0) + Number.EPSILON) * 100) / 100,
        monthlySubscribers: platformSnapshots.reduce((acc, s) => acc + (s.monthlySubscribers || 0), 0),
        yearlySubscribers: platformSnapshots.reduce((acc, s) => acc + (s.yearlySubscribers || 0), 0),
      };

      // Check if unified snapshot already exists for this date
      const existingUnified = await ctx.db
        .query("metricsSnapshots")
        .withIndex("by_app_date", (q) =>
          q.eq("appId", appId).eq("date", dateStr)
        )
        .filter((q) => q.eq(q.field("platform"), "unified"))
        .collect();

      if (existingUnified.length > 0) {
        await ctx.db.patch(existingUnified[0]._id, unified);
        // Clean up duplicates
        for (let i = 1; i < existingUnified.length; i++) {
          await ctx.db.delete(existingUnified[i]._id);
        }
      } else {
        await ctx.db.insert("metricsSnapshots", unified);
      }
      
      created++;
    }

    return { created };
  },
});

export const createAppStoreSnapshotFromPrevious = internalMutation({
  args: {
    appId: v.id("apps"),
    date: v.string(),
    previousSnapshot: v.any(), // Accept any object and extract what we need
  },
  handler: async (ctx, { appId, date, previousSnapshot }) => {
    // Create snapshot with same subscriber counts but 0 revenue/events (no sales today)
    // Since no actual sales report, we can't calculate flow metrics from day-to-day
    const snapshot = {
      appId,
      date,
      platform: "appstore" as const,
      activeSubscribers: previousSnapshot.activeSubscribers,
      trialSubscribers: previousSnapshot.trialSubscribers,
      paidSubscribers: previousSnapshot.paidSubscribers,
      cancellations: 0, // No sales = no changes = no cancellations
      churn: 0,
      graceEvents: previousSnapshot.graceEvents,
      paybacks: 0,
      firstPayments: 0, // No sales = no new subscribers
      renewals: 0,
      mrr: previousSnapshot.mrr,
      weeklyRevenue: 0,
      monthlyRevenueGross: 0,
      monthlyRevenueNet: 0,
      monthlySubscribers: previousSnapshot.monthlySubscribers || 0,
      yearlySubscribers: previousSnapshot.yearlySubscribers || 0,
    };

    const existing = await ctx.db
      .query("metricsSnapshots")
      .withIndex("by_app_platform", (q) => q.eq("appId", appId).eq("platform", "appstore"))
      .filter((q) => q.eq(q.field("date"), date))
      .collect();

    if (existing.length > 0) {
      await ctx.db.patch(existing[0]._id, snapshot);
      for (let i = 1; i < existing.length; i++) {
        await ctx.db.delete(existing[i]._id);
      }
    } else {
      await ctx.db.insert("metricsSnapshots", snapshot);
    }
  },
});

// New comprehensive Google Play processor that handles both revenue and subscription data
export const processGooglePlayReports = internalMutation({
  args: {
    appId: v.id("apps"),
    revenueByDate: v.any(), // Record<string, { gross: number; net: number; transactions: number }>
    subscriptionMetricsByDate: v.any(), // Record<string, { active, trial, paid, monthly, yearly, newSubscriptions, canceledSubscriptions, renewals }>
    discoveredReportTypes: v.array(v.string()),
  },
  handler: async (ctx, { appId, revenueByDate, subscriptionMetricsByDate, discoveredReportTypes }) => {
    const app = await ctx.db.get(appId);
    const userCurrency = app?.currency || "USD";

    let snapshotsCreated = 0;
    let snapshotsUpdated = 0;

    const hasSubscriptionData = Object.keys(subscriptionMetricsByDate || {}).length > 0;
    const hasRevenueData = Object.keys(revenueByDate || {}).length > 0;

    console.log(`[Google Play] Processing reports - Revenue: ${hasRevenueData}, Subscriptions: ${hasSubscriptionData}`);
    console.log(`[Google Play] Report types: ${discoveredReportTypes.join(', ')}`);
    
    // Log a sample of what data we have
    if (hasSubscriptionData) {
      const sampleDate = Object.keys(subscriptionMetricsByDate)[0];
      const sample = subscriptionMetricsByDate[sampleDate];
      console.log(`[Google Play] Sample subscription data (${sampleDate}):`, JSON.stringify(sample));
    }

    // Get all unique dates from both revenue and subscription data
    const allDates = new Set([
      ...Object.keys(revenueByDate || {}),
      ...Object.keys(subscriptionMetricsByDate || {})
    ]);

    console.log(`[Google Play] Processing ${allDates.size} unique dates`);

    // OPTIMIZATION: Pre-fetch exchange rate once for all conversions
    // Google Play reports are in USD, so we only need one rate lookup
    let exchangeRate = 1.0;
    if (userCurrency.toUpperCase() !== "USD") {
      const rate = await ctx.db
        .query("exchangeRates")
        .withIndex("by_pair", (q: any) => q.eq("fromCurrency", "USD").eq("toCurrency", userCurrency.toUpperCase()))
        .order("desc")
        .first();
      
      if (rate) {
        exchangeRate = rate.rate;
        console.log(`[Google Play] Using exchange rate USD -> ${userCurrency}: ${exchangeRate}`);
      } else {
        // Try inverse
        const inverseRate = await ctx.db
          .query("exchangeRates")
          .withIndex("by_pair", (q: any) => q.eq("fromCurrency", userCurrency.toUpperCase()).eq("toCurrency", "USD"))
          .order("desc")
          .first();
        
        if (inverseRate) {
          exchangeRate = 1 / inverseRate.rate;
          console.log(`[Google Play] Using inverse exchange rate USD -> ${userCurrency}: ${exchangeRate}`);
        } else {
          console.warn(`[Google Play] No exchange rate found for USD -> ${userCurrency}, using 1:1`);
        }
      }
    }

    // Helper function for fast conversion using cached rate
    const convertCurrency = (amount: number): number => {
      const converted = amount * exchangeRate;
      return Math.round((converted + Number.EPSILON) * 100) / 100;
    };

    // OPTIMIZATION: Pre-fetch all existing snapshots to avoid 362 individual queries
    const existingSnapshots = await ctx.db
      .query("metricsSnapshots")
      .withIndex("by_app_platform", (q) => q.eq("appId", appId).eq("platform", "googleplay"))
      .collect();
    
    // Group by date - keep array of all snapshots per date to handle duplicates
    const existingByDate = new Map<string, any[]>();
    for (const snap of existingSnapshots) {
      const existing = existingByDate.get(snap.date) || [];
      existing.push(snap);
      existingByDate.set(snap.date, existing);
    }
    console.log(`[Google Play] Found ${existingSnapshots.length} existing snapshots (${existingByDate.size} unique dates)`);

    for (const date of Array.from(allDates).sort()) {
      const revenueData = revenueByDate?.[date];
      const subMetrics = subscriptionMetricsByDate?.[date];

      // Convert revenue to user's preferred currency using cached rate
      let convertedGross = 0;
      let convertedNet = 0;
      let weeklyRevenue = 0;

      if (revenueData) {
        convertedGross = convertCurrency(revenueData.gross);
        convertedNet = convertCurrency(revenueData.net);
        weeklyRevenue = Math.round((convertedNet + Number.EPSILON) * 100) / 100;
      }

      // Extract subscription metrics if available
      const activeSubscribers = subMetrics?.active || 0;
      const trialSubscribers = subMetrics?.trial || 0;
      const paidSubscribers = subMetrics?.paid || (activeSubscribers > 0 && trialSubscribers > 0 ? activeSubscribers - trialSubscribers : 0);
      const monthlySubscribers = subMetrics?.monthly || 0;
      const yearlySubscribers = subMetrics?.yearly || 0;
      const newSubscriptions = subMetrics?.newSubscriptions || 0;
      const canceledSubscriptions = subMetrics?.canceledSubscriptions || 0;
      
      // Calculate renewals: total transactions - new subscriptions
      // (Every charged transaction is either a new subscription or a renewal)
      const totalTransactions = revenueData?.transactions || 0;
      const renewals = totalTransactions > newSubscriptions 
        ? totalTransactions - newSubscriptions 
        : (subMetrics?.renewals || 0);

      // MRR: For Google Play, use 30-day rolling revenue as the MRR estimate
      // This is because Google Play doesn't provide reliable per-subscription pricing
      let mrr = 0;
      const thirtyDaysAgo = new Date(new Date(date).getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
      
      // Use pre-fetched snapshots to get 30-day revenue
      const recentSnapshots = existingSnapshots
        .filter((s) => s.date >= thirtyDaysAgo && s.date < date)
        .sort((a, b) => a.date.localeCompare(b.date));
      
      // Calculate 30-day rolling revenue (this IS the MRR for Google Play)
      const historicalRevenue = recentSnapshots.reduce((sum, s) => sum + (s.monthlyRevenueNet || 0), 0);
      const totalRevenue = historicalRevenue + convertedNet;
      
      if (totalRevenue > 0) {
        // MRR = 30-day rolling net revenue
        mrr = Math.round((totalRevenue + Number.EPSILON) * 100) / 100;
      } else if (convertedNet > 0) {
        // No historical data - estimate from daily revenue × 30
        mrr = Math.round((convertedNet * 30 + Number.EPSILON) * 100) / 100;
      }

      const snapshot = {
        appId,
        date,
        platform: "googleplay" as const,
        // Subscription metrics - from subscription reports or 0
        activeSubscribers,
        trialSubscribers,
        paidSubscribers,
        cancellations: canceledSubscriptions,
        churn: activeSubscribers > 0 ? Math.round((canceledSubscriptions / activeSubscribers) * 10000) / 100 : 0,
        graceEvents: 0, // Not available in standard reports
        paybacks: 0, // Not available
        firstPayments: newSubscriptions,
        renewals,
        mrr,
        // Revenue metrics - from financial reports
        weeklyRevenue,
        monthlyRevenueGross: Math.round((convertedGross + Number.EPSILON) * 100) / 100,
        monthlyRevenueNet: Math.round((convertedNet + Number.EPSILON) * 100) / 100,
        monthlySubscribers,
        yearlySubscribers,
      };

      // Check if snapshot already exists for this date (using pre-fetched map)
      const existingForDate = existingByDate.get(date);

      if (existingForDate && existingForDate.length > 0) {
        await ctx.db.patch(existingForDate[0]._id, snapshot);
        snapshotsUpdated++;
        // Clean up any duplicates
        for (let i = 1; i < existingForDate.length; i++) {
          await ctx.db.delete(existingForDate[i]._id);
        }
      } else {
        await ctx.db.insert("metricsSnapshots", snapshot);
        snapshotsCreated++;
      }
    }

    console.log(`[Google Play] Created ${snapshotsCreated} snapshots, updated ${snapshotsUpdated} snapshots`);

    return { snapshotsCreated, snapshotsUpdated };
  },
});

// Legacy function kept for backwards compatibility
export const processGooglePlayFinancialReport = internalMutation({
  args: {
    appId: v.id("apps"),
    revenueByDate: v.any(),
  },
  handler: async (ctx, { appId, revenueByDate }) => {
    // Call the new processor directly with the same logic
    const app = await ctx.db.get(appId);
    const userCurrency = app?.currency || "USD";

    let snapshotsCreated = 0;
    let snapshotsUpdated = 0;

    console.log(`[Google Play] Processing ${Object.keys(revenueByDate).length} days of revenue data`);

    for (const [date, data] of Object.entries(revenueByDate)) {
      const { gross, net, transactions } = data as { gross: number; net: number; transactions: number };

      const convertedGross = await convertAndRoundCurrency(ctx, gross, "USD", userCurrency);
      const convertedNet = await convertAndRoundCurrency(ctx, net, "USD", userCurrency);

      const snapshot = {
        appId,
        date,
        platform: "googleplay" as const,
        activeSubscribers: 0,
        trialSubscribers: 0,
        paidSubscribers: 0,
        cancellations: 0,
        churn: 0,
        graceEvents: 0,
        paybacks: 0,
        firstPayments: 0,
        renewals: 0,
        mrr: 0,
        weeklyRevenue: Math.round((convertedNet + Number.EPSILON) * 100) / 100,
        monthlyRevenueGross: Math.round((convertedGross + Number.EPSILON) * 100) / 100,
        monthlyRevenueNet: Math.round((convertedNet + Number.EPSILON) * 100) / 100,
        monthlySubscribers: 0,
        yearlySubscribers: 0,
      };

      const existing = await ctx.db
        .query("metricsSnapshots")
        .withIndex("by_app_platform", (q) => q.eq("appId", appId).eq("platform", "googleplay"))
        .filter((q) => q.eq(q.field("date"), date))
        .first();

      if (existing) {
        await ctx.db.patch(existing._id, snapshot);
        snapshotsUpdated++;
      } else {
        await ctx.db.insert("metricsSnapshots", snapshot);
        snapshotsCreated++;
      }
    }

    console.log(`[Google Play] Created ${snapshotsCreated} snapshots, updated ${snapshotsUpdated} snapshots`);

    return { snapshotsCreated, snapshotsUpdated };
  },
});

