import { v } from "convex/values";
import { mutation, query, internalMutation } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { calculateRevenueExcludingVat } from "./lib/vatRates";

// Helper to convert currency and round to 2 decimals
// This is the single source of truth for all currency conversions and rounding
// yearMonth is optional - when provided, uses historical rate for that month (format: "YYYY-MM")
async function convertAndRoundCurrency(ctx: any, amount: number, fromCurrency: string, toCurrency: string, yearMonth?: string): Promise<number> {
  const from = fromCurrency.toUpperCase();
  const to = toCurrency.toUpperCase();
  
  // No conversion needed - same currency, just round
  if (from === to) {
    return Math.round((amount + Number.EPSILON) * 100) / 100;
  }
  
  // Helper to get rate - tries historical first if yearMonth provided, then falls back to latest
  const getRate = async (fromC: string, toC: string) => {
    if (yearMonth) {
      // Try historical rate for specific month
      const historicalRate = await ctx.db
        .query("exchangeRates")
        .withIndex("by_pair_month", (q: any) => q.eq("fromCurrency", fromC).eq("toCurrency", toC).eq("yearMonth", yearMonth))
        .first();
      if (historicalRate) return historicalRate;
    }
    // Fall back to latest rate
    return await ctx.db
      .query("exchangeRates")
      .withIndex("by_pair", (q: any) => q.eq("fromCurrency", fromC).eq("toCurrency", toC))
      .order("desc")
      .first();
  };
  
  // Get exchange rate
  const rate = await getRate(from, to);
  
  if (rate) {
    const converted = amount * rate.rate;
    return Math.round((converted + Number.EPSILON) * 100) / 100;
  }
  
  // Try inverse rate
  const inverseRate = await getRate(to, from);
  
  if (inverseRate) {
    const converted = amount / inverseRate.rate;
    return Math.round((converted + Number.EPSILON) * 100) / 100;
  }
  
  // If both currencies are not USD, try converting through USD
  if (from !== "USD" && to !== "USD") {
    const fromUSD = await getRate("USD", from);
    const toUSD = await getRate("USD", to);
    
    if (fromUSD && toUSD) {
      const amountInUSD = amount / fromUSD.rate;
      const converted = amountInUSD * toUSD.rate;
      return Math.round((converted + Number.EPSILON) * 100) / 100;
    }
  }
  
  // No rate found - throw error to prevent bad data
  throw new Error(`Exchange rate not found for ${from} -> ${to}. Please fetch exchange rates first by clicking "Fetch Rates" in the dashboard.`);
}

// Unified MRR calculation: MRR = monthly revenue + (yearly revenue / 12)
function calculateMRR(monthlyRevenue: number, yearlyRevenue: number): number {
  return Math.round((monthlyRevenue + yearlyRevenue / 12 + Number.EPSILON) * 100) / 100;
}

// Delete a batch of revenue events for a platform (call multiple times until done)
export const deleteRevenueEventsForPlatform = internalMutation({
  args: {
    appId: v.id("apps"),
    platform: v.union(
      v.literal("appstore"),
      v.literal("googleplay"),
      v.literal("stripe")
    ),
    maxToDelete: v.optional(v.number()), // Max to delete in this call (default 500)
  },
  handler: async (ctx, { appId, platform, maxToDelete = 500 }) => {
    // Delete up to maxToDelete events in this single mutation
    const batch = await ctx.db
      .query("revenueEvents")
      .withIndex("by_app_platform", (q) => q.eq("appId", appId).eq("platform", platform))
      .take(maxToDelete);
    
    for (const event of batch) {
      await ctx.db.delete(event._id);
    }
    
    console.log(`[Cleanup ${platform}] Deleted ${batch.length} revenue events`);
    return { deleted: batch.length, hasMore: batch.length === maxToDelete };
  },
});

// Batch mutation for storing revenue events (to avoid 16MB read limit)
export const storeRevenueEventsBatch = internalMutation({
  args: {
    appId: v.id("apps"),
    platform: v.union(
      v.literal("appstore"),
      v.literal("googleplay"),
      v.literal("stripe")
    ),
    events: v.array(
      v.object({
        subscriptionExternalId: v.string(),
        eventType: v.union(
          v.literal("first_payment"),
          v.literal("renewal"),
          v.literal("refund")
        ),
        amount: v.number(),
        amountExcludingTax: v.optional(v.number()),
        amountProceeds: v.optional(v.number()),
        currency: v.string(),
        country: v.optional(v.string()),
        timestamp: v.number(),
        externalId: v.optional(v.string()),
      })
    ),
  },
  handler: async (ctx, { appId, platform, events }) => {
    if (events.length === 0) return { stored: 0, updated: 0, skipped: 0 };
    
    // Get subscriptions for mapping
    const allSubs = await ctx.db
      .query("subscriptions")
      .withIndex("by_app_platform", (q) => q.eq("appId", appId).eq("platform", platform))
      .collect();
    const subMap = new Map(allSubs.map(s => [s.externalId, s]));
    
    // Find timestamp range for existing event query
    let minTs = Infinity, maxTs = 0;
    for (const e of events) {
      if (e.timestamp < minTs) minTs = e.timestamp;
      if (e.timestamp > maxTs) maxTs = e.timestamp;
    }
    
    // Load existing events only in this batch's time range
    const existing = await ctx.db
      .query("revenueEvents")
      .withIndex("by_app_platform_time", (q) => 
        q.eq("appId", appId).eq("platform", platform).gte("timestamp", minTs).lte("timestamp", maxTs)
      )
      .collect();
    
    const existingMap = new Map<string, typeof existing[0]>();
    for (const ev of existing) {
      existingMap.set(`${ev.subscriptionId}|${ev.timestamp}|${ev.amount}`, ev);
    }
    
    let stored = 0, updated = 0, skipped = 0;
    
    for (const event of events) {
      const sub = subMap.get(event.subscriptionExternalId);
      if (!sub) { skipped++; continue; }
      
      const key = `${sub._id}|${event.timestamp}|${event.amount}`;
      const existingEvent = existingMap.get(key);
      
      if (!existingEvent) {
        await ctx.db.insert("revenueEvents", {
          appId,
          platform,
          subscriptionId: sub._id,
          eventType: event.eventType,
          amount: event.amount,
          amountExcludingTax: event.amountExcludingTax,
          amountProceeds: event.amountProceeds,
          currency: event.currency,
          country: event.country,
          timestamp: event.timestamp,
          externalId: event.externalId,
        });
        stored++;
      } else if (event.amountProceeds != null && existingEvent.amountProceeds == null) {
        await ctx.db.patch(existingEvent._id, { amountProceeds: event.amountProceeds });
        updated++;
      } else {
        skipped++;
      }
    }
    
    return { stored, updated, skipped };
  },
});

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
        // Extracted fields (new format)
        trialEnd: v.optional(v.number()),
        priceAmount: v.optional(v.number()),
        priceInterval: v.optional(v.string()),
        priceCurrency: v.optional(v.string()),
        rawData: v.optional(v.string()), // Deprecated: for backward compat
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
        amount: v.number(), // Charged amount (including VAT)
        amountExcludingTax: v.optional(v.number()), // Amount excluding VAT
        amountProceeds: v.optional(v.number()), // Amount after platform fees (what you receive)
        currency: v.string(),
        country: v.optional(v.string()), // ISO country code
        timestamp: v.number(),
        externalId: v.optional(v.string()), // Invoice ID (new format)
        rawData: v.optional(v.string()), // Deprecated: for backward compat
      })
    ),
    snapshotDate: v.optional(v.string()),
    skipRevenueEventStorage: v.optional(v.boolean()), // Skip storing events (they'll be stored in batches separately)
  },
  handler: async (ctx, { appId, platform, subscriptions, revenueEvents, snapshotDate, skipRevenueEventStorage }) => {
    const now = new Date();
    const today = snapshotDate || now.toISOString().split("T")[0];

    // Get app's preferred currency
    const app = await ctx.db.get(appId);
    const userCurrency = app?.currency || "USD";

    // Store subscription data with extracted fields
    console.log(`[Metrics ${platform}] Storing ${subscriptions.length} subscriptions...`);
    for (const sub of subscriptions) {
      // Extract fields from rawData if not provided (backward compat)
      let { trialEnd, priceAmount, priceInterval, priceCurrency } = sub;
      if (sub.rawData && (!priceAmount || !priceInterval)) {
        try {
          const raw = JSON.parse(sub.rawData);
          trialEnd = trialEnd ?? (raw.trial_end ? raw.trial_end * 1000 : undefined);
          const item = raw?.items?.data?.[0];
          priceAmount = priceAmount ?? item?.price?.unit_amount;
          priceInterval = priceInterval ?? item?.price?.recurring?.interval;
          priceCurrency = priceCurrency ?? item?.price?.currency;
        } catch {}
      }
      
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
          trialEnd,
          priceAmount,
          priceInterval,
          priceCurrency,
        });
      } else {
        await ctx.db.insert("subscriptions", {
          appId,
          platform,
          externalId: sub.externalId,
          customerId: sub.customerId,
          status: sub.status,
          productId: sub.productId,
          startDate: sub.startDate,
          endDate: sub.endDate,
          isTrial: sub.isTrial,
          willCancel: sub.willCancel,
          rawData: JSON.stringify(sub),
          trialEnd,
          priceAmount,
          priceInterval,
          priceCurrency,
        });
      }
    }
    
    // Store revenue events (with deduplication) - SKIP if handled separately in batches
    if (!skipRevenueEventStorage) {
      console.log(`[Metrics ${platform}] Storing ${revenueEvents.length} revenue events...`);
      let revenueStored = 0;
      let revenueSkippedDuplicate = 0;
      let revenueSkippedNoSub = 0;
      
      console.log(`[Metrics ${platform}] Processing ${revenueEvents.length} revenue events from API`);
      
      // Sample first revenue event to debug
      if (revenueEvents.length > 0) {
        console.log(`[Metrics ${platform}] Sample revenue event: subscriptionExternalId="${revenueEvents[0].subscriptionExternalId}", eventType="${revenueEvents[0].eventType}", amount=${revenueEvents[0].amount}, timestamp=${revenueEvents[0].timestamp}`);
      }
      
      // Get all subscriptions for this user/platform
      const allSubs = await ctx.db
        .query("subscriptions")
        .withIndex("by_app_platform", (q) => q.eq("appId", appId).eq("platform", platform))
        .collect();
      console.log(`[Metrics ${platform}] Found ${allSubs.length} subscriptions in database for matching`);
    
    // Create a map of externalId -> subscription for fast lookup
    const subMap = new Map(allSubs.map(s => [s.externalId, s]));
    
    // Find timestamp range of incoming events to limit the query
    let minTimestamp = Infinity;
    let maxTimestamp = 0;
    for (const event of revenueEvents) {
      if (event.timestamp < minTimestamp) minTimestamp = event.timestamp;
      if (event.timestamp > maxTimestamp) maxTimestamp = event.timestamp;
    }
    
    // Only load existing events in the relevant time range (not ALL events)
    // This avoids the 16MB read limit for historical syncs
    const existingEvents = minTimestamp !== Infinity
      ? await ctx.db
          .query("revenueEvents")
          .withIndex("by_app_platform_time", (q) => 
            q.eq("appId", appId).eq("platform", platform).gte("timestamp", minTimestamp).lte("timestamp", maxTimestamp)
          )
          .collect()
      : [];
    
    // Create dedup map: key = "subscriptionId|timestamp|amount" -> event
    const existingEventMap = new Map<string, typeof existingEvents[0]>();
    for (const ev of existingEvents) {
      const key = `${ev.subscriptionId}|${ev.timestamp}|${ev.amount}`;
      existingEventMap.set(key, ev);
    }
    console.log(`[Metrics ${platform}] Loaded ${existingEvents.length} existing events for time range ${new Date(minTimestamp).toISOString()} - ${new Date(maxTimestamp).toISOString()}`);
    
    // Count how many existing events are missing amountProceeds
    const existingWithoutProceeds = Array.from(existingEventMap.values()).filter(e => e.amountProceeds == null).length;
    const incomingWithProceeds = revenueEvents.filter(e => e.amountProceeds != null).length;
    console.log(`[Metrics ${platform}] PROCEEDS UPDATE CHECK: ${existingWithoutProceeds}/${existingEvents.length} existing events missing proceeds, ${incomingWithProceeds}/${revenueEvents.length} incoming have proceeds`);
    
    let proceedsUpdated = 0;
    
    // Process revenue events using in-memory deduplication
    for (const event of revenueEvents) {
      const sub = subMap.get(event.subscriptionExternalId);
      
      if (sub) {
        const key = `${sub._id}|${event.timestamp}|${event.amount}`;
        const existingEvent = existingEventMap.get(key);
        
        if (!existingEvent) {
          // Extract externalId from rawData if not provided (backward compat)
          let externalId = event.externalId;
          if (!externalId && event.rawData) {
            try {
              const parsed = JSON.parse(event.rawData);
              externalId = parsed.id;
            } catch {}
          }
          
          await ctx.db.insert("revenueEvents", {
            appId,
            platform,
            subscriptionId: sub._id,
            eventType: event.eventType,
            amount: event.amount,
            amountExcludingTax: event.amountExcludingTax,
            amountProceeds: event.amountProceeds,
            currency: event.currency,
            country: event.country,
            timestamp: event.timestamp,
            externalId,
          });
          revenueStored++;
        } else {
          // Update existing event if it's missing amountProceeds but new one has it
          // Use == null to catch both undefined AND null
          if (event.amountProceeds != null && existingEvent.amountProceeds == null) {
            await ctx.db.patch(existingEvent._id, {
              amountProceeds: event.amountProceeds,
            });
            proceedsUpdated++;
            revenueStored++; // Count as stored since we updated it
          } else {
            revenueSkippedDuplicate++;
          }
        }
      } else {
        revenueSkippedNoSub++;
        if (revenueSkippedNoSub <= 3) {
          console.log(`[Metrics ${platform}] MISMATCH: Revenue event for subscriptionExternalId="${event.subscriptionExternalId}" (amount=${event.amount}) has no matching subscription`);
        }
      }
    }
      console.log(`[Metrics ${platform}] Revenue events: ${revenueStored} stored (${proceedsUpdated} proceeds updated), ${revenueSkippedDuplicate} duplicates skipped, ${revenueSkippedNoSub} skipped (no subscription found)`);
    } else {
      console.log(`[Metrics ${platform}] Skipping revenue event storage (handled in batches)`);
    }
    
    const thirtyDaysAgo = now.getTime() - 30 * 24 * 60 * 60 * 1000;

    // ========== CALCULATE EVERYTHING FROM FRESH API DATA ONLY ==========
    
    // Current snapshot metrics
    const activeSubscribers = subscriptions.filter(
      (s) => s.status === "active" || s.status === "trialing"
    ).length;
    const trialSubscribers = subscriptions.filter((s) => s.isTrial).length;
    const paidSubscribers = activeSubscribers - trialSubscribers;

    // Track monthly vs yearly subscribers using extracted fields
    let monthlySubscribers = 0;
    let yearlySubscribers = 0;
    for (const s of subscriptions) {
      if (s.isTrial) continue;
      if (!(s.status === "active" || s.status === "trialing")) continue;
      
      if (s.priceInterval === "year") {
        yearlySubscribers++;
      } else if (s.priceInterval === "month") {
        monthlySubscribers++;
      }
    }

    // Flow metrics from today's events only
    const todayStart = new Date(today).getTime();  // Start of day (00:00:00)
    const todayEnd = todayStart + 24 * 60 * 60 * 1000 - 1;  // End of day (23:59:59.999)
    
    // Cancellations = subscriptions that actually ended/canceled today (not just scheduled to cancel)
    const churn = subscriptions.filter((s) => s.status === "canceled" && s.endDate && s.endDate >= todayStart && s.endDate <= todayEnd).length;
    const cancellations = churn; // Use actual cancellations, not pending (willCancel is cumulative snapshot, not daily flow)
    const firstPayments = revenueEvents.filter((e) => e.eventType === "first_payment" && e.timestamp >= todayStart && e.timestamp <= todayEnd).length;
    const renewals = revenueEvents.filter((e) => e.eventType === "renewal" && e.timestamp >= todayStart && e.timestamp <= todayEnd).length;
    const refunds = revenueEvents.filter((e) => e.eventType === "refund" && e.timestamp >= todayStart && e.timestamp <= todayEnd).length;

    // MRR from current active PAID subscription prices using extracted fields
    // Formula: MRR = monthly revenue + (yearly revenue / 12)
    let monthlyMRR = 0;
    let yearlyMRR = 0;
    for (const s of subscriptions) {
      if (s.isTrial) continue;
      if (s.status !== "active") continue;
      
      if (typeof s.priceAmount === "number") {
        const amount = s.priceAmount / 100;
        const currency = s.priceCurrency || "usd";
        const convertedAmount = await convertAndRoundCurrency(ctx, amount, currency, userCurrency);
        if (s.priceInterval === "year") {
          yearlyMRR += convertedAmount;
        } else {
          monthlyMRR += convertedAmount;
        }
      }
    }
    const mrr = calculateMRR(monthlyMRR, yearlyMRR);

    // Daily revenue from today's revenue events only
    // (We'll aggregate to monthly/weekly at display time)
    const todayRevenue = revenueEvents.filter((e) => e.timestamp >= todayStart && e.timestamp <= todayEnd);
    let monthlyChargedRevenue = 0; // What customers paid (including VAT)
    let monthlyRevenue = 0; // Revenue excluding VAT (still includes platform fees)
    let monthlyProceeds = 0; // Developer proceeds (what you actually receive after fees)
    
    // Revenue split by plan type (monthly vs yearly) - for Stripe, use priceInterval from subscription
    let monthlyPlanChargedRevenue = 0;
    let yearlyPlanChargedRevenue = 0;
    let monthlyPlanRevenue = 0;
    let yearlyPlanRevenue = 0;
    let monthlyPlanProceeds = 0;
    let yearlyPlanProceeds = 0;
    
    // Create map from subscription externalId to priceInterval for plan type lookup
    const subIntervalMap = new Map<string, string>();
    for (const s of subscriptions) {
      if (s.priceInterval) {
        subIntervalMap.set(s.externalId, s.priceInterval);
      }
    }
    
    console.log(`[Metrics ${platform}] Date calculation - today: ${today}, todayStart: ${todayStart} (${new Date(todayStart).toISOString()}), todayEnd: ${todayEnd} (${new Date(todayEnd).toISOString()})`);
    console.log(`[Metrics ${platform}] Processing ${todayRevenue.length} revenue events for ${today} (from ${revenueEvents.length} total events passed from API, range ${todayStart}-${todayEnd})`);
    
    if (revenueEvents.length > 0 && todayRevenue.length === 0) {
      console.log(`[Metrics ${platform}] WARNING: We have ${revenueEvents.length} revenue events from API but 0 match today's date!`);
      console.log(`[Metrics ${platform}] Sample event timestamp: ${revenueEvents[0].timestamp} (${new Date(revenueEvents[0].timestamp).toISOString()})`);
    }
    
    if (todayRevenue.length > 0) {
      // Debug: Show full sample event including amountProceeds
      const sample = todayRevenue[0];
      console.log(`[Metrics ${platform}] Sample revenue event: amount=${sample.amount}, amountProceeds=${sample.amountProceeds}, amountExcludingTax=${sample.amountExcludingTax}, currency=${sample.currency}`);
      
      // Count how many events have proceeds defined
      const eventsWithProceeds = todayRevenue.filter(e => e.amountProceeds !== undefined && e.amountProceeds !== null).length;
      console.log(`[Metrics ${platform}] PROCEEDS CHECK: ${eventsWithProceeds}/${todayRevenue.length} events have amountProceeds defined`);
      
      // Show a few sample amountProceeds values
      const proceedsSamples = todayRevenue.slice(0, 3).map(e => `${e.amount}→${e.amountProceeds}`);
      console.log(`[Metrics ${platform}] PROCEEDS SAMPLES: ${proceedsSamples.join(', ')}`);
    }
    
    // Also check ALL revenue events passed from API (not just today's)
    const allEventsWithProceeds = revenueEvents.filter(e => e.amountProceeds !== undefined && e.amountProceeds !== null).length;
    console.log(`[Metrics ${platform}] ALL EVENTS PROCEEDS: ${allEventsWithProceeds}/${revenueEvents.length} have amountProceeds from API`);
    
    for (const e of todayRevenue) {
      // Charged Revenue = amount (including VAT)
      const convertedCharged = await convertAndRoundCurrency(ctx, e.amount, e.currency, userCurrency);
      
      // Revenue = amount excluding VAT
      // Priority: 1) Use amountExcludingTax if Stripe Tax provided it
      //           2) Calculate from country VAT rate if country is available
      //           3) Fall back to amount (assumes no VAT)
      let amountExclTax: number;
      if (e.amountExcludingTax !== undefined && e.amountExcludingTax !== null) {
        // Stripe Tax provided the tax-excluded amount
        amountExclTax = e.amountExcludingTax;
      } else if (e.country) {
        // Calculate VAT from country
        amountExclTax = calculateRevenueExcludingVat(e.amount, e.country);
      } else {
        // No tax data and no country - use amount as-is
        amountExclTax = e.amount;
      }
      const convertedRevenue = await convertAndRoundCurrency(ctx, amountExclTax, e.currency, userCurrency);
      
      // Proceeds = Stripe's net amount (after fees) MINUS VAT
      // Stripe's balance_transaction.net = Charged - Stripe fee (but still includes VAT)
      // Correct Proceeds = amountProceeds - VAT = amountProceeds - (amount - amountExcludingTax)
      const vatAmount = e.amount - amountExclTax;
      let amountProceedsValue: number;
      if (e.amountProceeds != null) {
        // Stripe net minus VAT = true proceeds
        amountProceedsValue = e.amountProceeds - vatAmount;
      } else {
        // No Stripe proceeds data - estimate as revenue minus ~3% fee
        amountProceedsValue = amountExclTax * 0.97;
      }
      const convertedProceeds = await convertAndRoundCurrency(ctx, amountProceedsValue, e.currency, userCurrency);
      
      // Determine plan type from subscription
      const planInterval = subIntervalMap.get(e.subscriptionExternalId);
      const isYearlyPlan = planInterval === "year";
      const isMonthlyPlan = planInterval === "month";
      
      if (e.eventType === "refund") {
        monthlyChargedRevenue -= convertedCharged;
        monthlyRevenue -= convertedRevenue;
        monthlyProceeds -= convertedProceeds;
        // Split by plan type
        if (isYearlyPlan) {
          yearlyPlanChargedRevenue -= convertedCharged;
          yearlyPlanRevenue -= convertedRevenue;
          yearlyPlanProceeds -= convertedProceeds;
        } else if (isMonthlyPlan) {
          monthlyPlanChargedRevenue -= convertedCharged;
          monthlyPlanRevenue -= convertedRevenue;
          monthlyPlanProceeds -= convertedProceeds;
        }
      } else {
        monthlyChargedRevenue += convertedCharged;
        monthlyRevenue += convertedRevenue;
        monthlyProceeds += convertedProceeds;
        // Split by plan type
        if (isYearlyPlan) {
          yearlyPlanChargedRevenue += convertedCharged;
          yearlyPlanRevenue += convertedRevenue;
          yearlyPlanProceeds += convertedProceeds;
        } else if (isMonthlyPlan) {
          monthlyPlanChargedRevenue += convertedCharged;
          monthlyPlanRevenue += convertedRevenue;
          monthlyPlanProceeds += convertedProceeds;
        }
      }
    }
    
    monthlyChargedRevenue = Math.round((monthlyChargedRevenue + Number.EPSILON) * 100) / 100;
    monthlyRevenue = Math.round((monthlyRevenue + Number.EPSILON) * 100) / 100;
    monthlyProceeds = Math.round((monthlyProceeds + Number.EPSILON) * 100) / 100;
    
    // Round plan-split revenue
    monthlyPlanChargedRevenue = Math.round((monthlyPlanChargedRevenue + Number.EPSILON) * 100) / 100;
    yearlyPlanChargedRevenue = Math.round((yearlyPlanChargedRevenue + Number.EPSILON) * 100) / 100;
    monthlyPlanRevenue = Math.round((monthlyPlanRevenue + Number.EPSILON) * 100) / 100;
    yearlyPlanRevenue = Math.round((yearlyPlanRevenue + Number.EPSILON) * 100) / 100;
    monthlyPlanProceeds = Math.round((monthlyPlanProceeds + Number.EPSILON) * 100) / 100;
    yearlyPlanProceeds = Math.round((yearlyPlanProceeds + Number.EPSILON) * 100) / 100;

    // Weekly revenue metrics for this day (will be summed over weeks for display)
    const weeklyChargedRevenue = monthlyChargedRevenue;
    const weeklyRevenue = monthlyRevenue;
    const weeklyProceeds = monthlyProceeds;

    console.log(`[Metrics ${platform}] Calculated - Active: ${activeSubscribers}, Trial: ${trialSubscribers}, Paid: ${paidSubscribers}, Cancellations: ${cancellations}, Churn: ${churn}, First: ${firstPayments}, Renewals: ${renewals}, MRR: ${mrr}, Revenue: ${weeklyRevenue}`);
    console.log(`[Metrics ${platform}] Revenue breakdown - ChargedRevenue: ${monthlyChargedRevenue}, Revenue: ${monthlyRevenue}, Proceeds: ${monthlyProceeds}, Weekly: ${weeklyRevenue}`);

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
      paybacks: 0,
      firstPayments,
      renewals,
      refunds,
      mrr,
      weeklyChargedRevenue,
      weeklyRevenue,
      weeklyProceeds,
      monthlyChargedRevenue,
      monthlyRevenue,
      monthlyProceeds,
      monthlySubscribers,
      yearlySubscribers,
      // Revenue split by plan type
      monthlyPlanChargedRevenue,
      yearlyPlanChargedRevenue,
      monthlyPlanRevenue,
      yearlyPlanRevenue,
      monthlyPlanProceeds,
      yearlyPlanProceeds,
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
      paybacks: platformSnapshots.reduce((acc, s) => acc + s.paybacks, 0),
      firstPayments: platformSnapshots.reduce((acc, s) => acc + s.firstPayments, 0),
      renewals: platformSnapshots.reduce((acc, s) => acc + s.renewals, 0),
      refunds: platformSnapshots.reduce((acc, s) => acc + (s.refunds || 0), 0),
      mrr: Math.round((platformSnapshots.reduce((acc, s) => acc + s.mrr, 0) + Number.EPSILON) * 100) / 100,
      weeklyChargedRevenue: Math.round((platformSnapshots.reduce((acc, s) => acc + (s.weeklyChargedRevenue || s.monthlyChargedRevenue || 0), 0) + Number.EPSILON) * 100) / 100,
      weeklyRevenue: Math.round((platformSnapshots.reduce((acc, s) => acc + (s.weeklyRevenue || s.monthlyRevenue || 0), 0) + Number.EPSILON) * 100) / 100,
      weeklyProceeds: Math.round((platformSnapshots.reduce((acc, s) => acc + (s.weeklyProceeds || s.monthlyProceeds || 0), 0) + Number.EPSILON) * 100) / 100,
      monthlyChargedRevenue: Math.round((platformSnapshots.reduce((acc, s) => acc + s.monthlyChargedRevenue, 0) + Number.EPSILON) * 100) / 100,
      monthlyRevenue: Math.round((platformSnapshots.reduce((acc, s) => acc + s.monthlyRevenue, 0) + Number.EPSILON) * 100) / 100,
      monthlyProceeds: Math.round((platformSnapshots.reduce((acc, s) => acc + (s.monthlyProceeds || 0), 0) + Number.EPSILON) * 100) / 100,
      monthlySubscribers: platformSnapshots.reduce((acc, s) => acc + (s.monthlySubscribers || 0), 0),
      yearlySubscribers: platformSnapshots.reduce((acc, s) => acc + (s.yearlySubscribers || 0), 0),
      // Revenue split by plan type
      monthlyPlanChargedRevenue: Math.round((platformSnapshots.reduce((acc, s) => acc + (s.monthlyPlanChargedRevenue || 0), 0) + Number.EPSILON) * 100) / 100,
      yearlyPlanChargedRevenue: Math.round((platformSnapshots.reduce((acc, s) => acc + (s.yearlyPlanChargedRevenue || 0), 0) + Number.EPSILON) * 100) / 100,
      monthlyPlanRevenue: Math.round((platformSnapshots.reduce((acc, s) => acc + (s.monthlyPlanRevenue || 0), 0) + Number.EPSILON) * 100) / 100,
      yearlyPlanRevenue: Math.round((platformSnapshots.reduce((acc, s) => acc + (s.yearlyPlanRevenue || 0), 0) + Number.EPSILON) * 100) / 100,
      monthlyPlanProceeds: Math.round((platformSnapshots.reduce((acc, s) => acc + (s.monthlyPlanProceeds || 0), 0) + Number.EPSILON) * 100) / 100,
      yearlyPlanProceeds: Math.round((platformSnapshots.reduce((acc, s) => acc + (s.yearlyPlanProceeds || 0), 0) + Number.EPSILON) * 100) / 100,
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

    // Only load revenue events within the date range being processed to avoid 16MB limit
    const revenue = await ctx.db
      .query("revenueEvents")
      .withIndex("by_app_platform_time", (q) => 
        q.eq("appId", appId).eq("platform", platform).gte("timestamp", startMs).lte("timestamp", endMs)
      )
      .collect();
    
    // Debug: count how many events have amountProceeds set vs falling back to amount
    const eventsWithProceeds = revenue.filter(e => e.amountProceeds != null).length;
    console.log(`[Historical ${platform}] Found ${subs.length} subscriptions and ${revenue.length} revenue events for date range`);
    console.log(`[Historical ${platform}] PROCEEDS IN DB: ${eventsWithProceeds}/${revenue.length} events have amountProceeds set`);
    if (revenue.length > 0 && eventsWithProceeds < revenue.length) {
      // Show sample of events WITHOUT proceeds
      const withoutProceeds = revenue.filter(e => e.amountProceeds == null).slice(0, 3);
      for (const e of withoutProceeds) {
        console.log(`[Historical ${platform}] Event WITHOUT proceeds: id=${e.externalId}, amount=${e.amount}, timestamp=${new Date(e.timestamp).toISOString()}`);
      }
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

      // Calculate trials and MRR from active subs using extracted fields
      // Formula: MRR = monthly revenue + (yearly revenue / 12)
      let trialSubscribers = 0;
      let monthlyMRR = 0;
      let yearlyMRR = 0;
      let monthlySubscribers = 0;
      let yearlySubscribers = 0;
      const yearMonth = date.substring(0, 7);
      
      for (const s of activeSubs) {
        // Count trials using extracted trialEnd field
        if (s.trialEnd && dayStart < s.trialEnd) {
          trialSubscribers += 1;
        }

        // MRR and subscriber type from extracted fields
        if (!s.isTrial && s.status === "active") {
          if (typeof s.priceAmount === "number") {
            const amount = s.priceAmount / 100;
            const currency = s.priceCurrency || "usd";
            const convertedAmount = await convertAndRoundCurrency(ctx, amount, currency, userCurrency, yearMonth);
            if (s.priceInterval === "year") {
              yearlyMRR += convertedAmount;
              yearlySubscribers++;
            } else {
              monthlyMRR += convertedAmount;
              monthlySubscribers++;
            }
          }
        }
      }
      const mrr = calculateMRR(monthlyMRR, yearlyMRR);

      const activeSubscribers = activeSubs.length;
      const paidSubscribers = activeSubscribers - trialSubscribers;
      
      // Flow metrics for this day
      const churn = subs.filter((s) => s.status === "canceled" && s.endDate && s.endDate >= dayStart && s.endDate <= dayEnd).length;
      const cancellations = churn; // Use actual cancellations (not willCancel which is cumulative)

      // Revenue events on this day
      const dayRevenue = revenue.filter((e) => e.timestamp >= dayStart && e.timestamp <= dayEnd);
      const firstPayments = dayRevenue.filter((e) => e.eventType === "first_payment").length;
      const renewals = dayRevenue.filter((e) => e.eventType === "renewal").length;
      const refunds = dayRevenue.filter((e) => e.eventType === "refund").length;

      // Create map from subscription ID to priceInterval for plan type lookup
      const subIntervalMapHistorical = new Map<string, string>();
      for (const s of subs) {
        if (s.priceInterval) {
          subIntervalMapHistorical.set(s._id, s.priceInterval);
        }
      }

      // Revenue calculation
      let monthlyChargedRevenue = 0;
      let monthlyRevenue = 0;
      let monthlyProceeds = 0;
      // Revenue split by plan type
      let monthlyPlanChargedRevenue = 0;
      let yearlyPlanChargedRevenue = 0;
      let monthlyPlanRevenue = 0;
      let yearlyPlanRevenue = 0;
      let monthlyPlanProceeds = 0;
      let yearlyPlanProceeds = 0;
      
      for (const e of dayRevenue) {
        // Charged Revenue = amount (including VAT)
        const convertedCharged = await convertAndRoundCurrency(ctx, e.amount, e.currency, userCurrency, yearMonth);
        
        // Revenue = amount excluding VAT
        let amountExclTax: number;
        if (e.amountExcludingTax !== undefined && e.amountExcludingTax !== null) {
          amountExclTax = e.amountExcludingTax;
        } else if (e.country) {
          amountExclTax = calculateRevenueExcludingVat(e.amount, e.country);
        } else {
          amountExclTax = e.amount;
        }
        const convertedRevenue = await convertAndRoundCurrency(ctx, amountExclTax, e.currency, userCurrency, yearMonth);
        
        // Proceeds = Stripe's net (after fees) MINUS VAT
        const vatAmount = e.amount - amountExclTax;
        let amountProceedsValue: number;
        if (e.amountProceeds != null) {
          amountProceedsValue = e.amountProceeds - vatAmount;
        } else {
          amountProceedsValue = amountExclTax * 0.97;
        }
        const convertedProceeds = await convertAndRoundCurrency(ctx, amountProceedsValue, e.currency, userCurrency, yearMonth);
        
        // Determine plan type from subscription
        const planInterval = subIntervalMapHistorical.get(e.subscriptionId);
        const isYearlyPlan = planInterval === "year";
        const isMonthlyPlan = planInterval === "month";
        
        if (e.eventType === "refund") {
          monthlyChargedRevenue -= convertedCharged;
          monthlyRevenue -= convertedRevenue;
          monthlyProceeds -= convertedProceeds;
          // Split by plan type
          if (isYearlyPlan) {
            yearlyPlanChargedRevenue -= convertedCharged;
            yearlyPlanRevenue -= convertedRevenue;
            yearlyPlanProceeds -= convertedProceeds;
          } else if (isMonthlyPlan) {
            monthlyPlanChargedRevenue -= convertedCharged;
            monthlyPlanRevenue -= convertedRevenue;
            monthlyPlanProceeds -= convertedProceeds;
          }
        } else {
          monthlyChargedRevenue += convertedCharged;
          monthlyRevenue += convertedRevenue;
          monthlyProceeds += convertedProceeds;
          // Split by plan type
          if (isYearlyPlan) {
            yearlyPlanChargedRevenue += convertedCharged;
            yearlyPlanRevenue += convertedRevenue;
            yearlyPlanProceeds += convertedProceeds;
          } else if (isMonthlyPlan) {
            monthlyPlanChargedRevenue += convertedCharged;
            monthlyPlanRevenue += convertedRevenue;
            monthlyPlanProceeds += convertedProceeds;
          }
        }
      }
      monthlyChargedRevenue = Math.round((monthlyChargedRevenue + Number.EPSILON) * 100) / 100;
      monthlyRevenue = Math.round((monthlyRevenue + Number.EPSILON) * 100) / 100;
      monthlyProceeds = Math.round((monthlyProceeds + Number.EPSILON) * 100) / 100;
      // Round plan-split revenue
      monthlyPlanChargedRevenue = Math.round((monthlyPlanChargedRevenue + Number.EPSILON) * 100) / 100;
      yearlyPlanChargedRevenue = Math.round((yearlyPlanChargedRevenue + Number.EPSILON) * 100) / 100;
      monthlyPlanRevenue = Math.round((monthlyPlanRevenue + Number.EPSILON) * 100) / 100;
      yearlyPlanRevenue = Math.round((yearlyPlanRevenue + Number.EPSILON) * 100) / 100;
      monthlyPlanProceeds = Math.round((monthlyPlanProceeds + Number.EPSILON) * 100) / 100;
      yearlyPlanProceeds = Math.round((yearlyPlanProceeds + Number.EPSILON) * 100) / 100;
      
      const weeklyChargedRevenue = monthlyChargedRevenue;
      const weeklyRevenue = monthlyRevenue;
      const weeklyProceeds = monthlyProceeds;

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
        paybacks: 0,
        firstPayments,
        renewals,
        refunds,
        mrr,
        weeklyChargedRevenue,
        weeklyRevenue,
        weeklyProceeds,
        monthlyChargedRevenue,
        monthlyRevenue,
        monthlyProceeds,
        monthlySubscribers,
        yearlySubscribers,
        // Revenue split by plan type
        monthlyPlanChargedRevenue,
        yearlyPlanChargedRevenue,
        monthlyPlanRevenue,
        yearlyPlanRevenue,
        monthlyPlanProceeds,
        yearlyPlanProceeds,
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
      refunds: v.optional(v.number()),
      revenueGross: v.optional(v.number()),
      revenueNet: v.optional(v.number()),
      revenueProceeds: v.optional(v.number()), // Developer Proceeds - what Apple pays you
      // Revenue split by plan type
      revenueGrossMonthly: v.optional(v.number()),
      revenueGrossYearly: v.optional(v.number()),
      revenueNetMonthly: v.optional(v.number()),
      revenueNetYearly: v.optional(v.number()),
      revenueProceedsMonthly: v.optional(v.number()),
      revenueProceedsYearly: v.optional(v.number()),
      // Additional data for chunk summary
      rowsTotal: v.optional(v.number()),
      rowsProcessed: v.optional(v.number()),
      rowsSkipped: v.optional(v.number()),
      currenciesSeen: v.optional(v.any()),
      eventTypes: v.optional(v.any()),
      sampleEvents: v.optional(v.array(v.string())),
      eventClassification: v.optional(v.any()),
    })),
    // SUBSCRIPTION_EVENT report data (Subscribe, Cancel events)
    subscriptionEventData: v.optional(v.object({
      newSubscriptions: v.number(),
      cancellations: v.number(),
      conversions: v.number(),
      trialStarts: v.number(),
      eventCounts: v.optional(v.any()),
    })),
  },
  handler: async (ctx, { appId, date, tsv, eventData, subscriptionEventData }) => {
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

    const idx = (name: RegExp) => headers.findIndex((h) => name.test(h));
    
    // Look for SUBSCRIBER COUNT columns (this is a snapshot report, not events!)
    const activeSubsIdx = idx(/active.*subscri|subscri.*active/i);
    const activeTrialIdx = idx(/active.*free.*trial|active.*trial|trial.*intro/i);
    const activePaidIdx = idx(/active.*standard.*price|active.*paid/i);
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
    
    // Look for CURRENCY column - CRITICAL for MRR calculation!
    // Apple reports Customer Price in local currency (JPY, EUR, etc.)
    const customerCurrencyIdx = idx(/customer\s*currency/i);

    // Initialize metrics
    let activeSubscribers = 0;
    let trialSubscribers = 0;
    let paidSubscribers = 0;
    let firstPayments = 0;
    let renewals = 0;
    let refunds = 0;
    let cancellations = 0;
    let monthlyChargedRevenue = 0; // Customer price (including VAT)
    let monthlyRevenue = 0; // Revenue excluding VAT
    let monthlyProceeds = 0; // Developer Proceeds - what Apple pays you (after VAT and fees)
    let monthlySubsCount = 0;
    let yearlySubsCount = 0;
    let monthlyMRR = 0;
    let yearlyMRR = 0;
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
      
      // Categorize monthly vs yearly subscriptions and track MRR
      // Get customer price for this row (price per subscription)
      // CRITICAL: Customer Price is in LOCAL CURRENCY (JPY, EUR, etc.) - must convert to USD!
      const rowCustomerPriceRaw = customerPriceIdx >= 0 ? Number(cols[customerPriceIdx] || 0) : 0;
      const rowCurrency = customerCurrencyIdx >= 0 ? (cols[customerCurrencyIdx] || "USD").trim().toUpperCase() : "USD";
      const yearMonth = date.substring(0, 7);
      
      // Convert to USD (base currency) before summing - this is critical for JPY, EUR, etc.
      const rowCustomerPrice = rowCustomerPriceRaw > 0 
        ? await convertAndRoundCurrency(ctx, rowCustomerPriceRaw, rowCurrency, "USD", yearMonth)
        : 0;
      
      if (productId && rowActiveSubscribers > 0) {
        const isMonthly = /month|monthly|1m|30day|_m_|_mo_/i.test(productId);
        const isYearly = /year|yearly|annual|12m|365day|_y_|_yr_/i.test(productId);
        
        if (isMonthly) {
          monthlySubsCount += rowActiveSubscribers;
          monthlyMRR += rowCustomerPrice * rowActiveSubscribers;
        } else if (isYearly) {
          yearlySubsCount += rowActiveSubscribers;
          yearlyMRR += rowCustomerPrice * rowActiveSubscribers;
        } else {
          unmatchedProductIds.add(productId);
        }
      } else if (subscriptionDurationIdx >= 0) {
        // Fallback: check subscription duration column if available
        const duration = (cols[subscriptionDurationIdx] || "").toLowerCase().trim();
        if (duration && rowActiveSubscribers > 0) {
          if (duration.includes("month") || duration === "1 month") {
            monthlySubsCount += rowActiveSubscribers;
            monthlyMRR += rowCustomerPrice * rowActiveSubscribers;
          } else if (duration.includes("year") || duration === "1 year") {
            yearlySubsCount += rowActiveSubscribers;
            yearlyMRR += rowCustomerPrice * rowActiveSubscribers;
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

    // Return parsing results for chunk aggregation (no per-day logging - chunk will summarize)

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
    
    // Revenue split by plan type (from SUBSCRIBER report)
    let monthlyPlanChargedRevenue = 0;
    let yearlyPlanChargedRevenue = 0;
    let monthlyPlanRevenue = 0;
    let yearlyPlanRevenue = 0;
    let monthlyPlanProceeds = 0;
    let yearlyPlanProceeds = 0;
    
    // Use event data from SUBSCRIBER report for events AND revenue
    if (eventData) {
      if (eventData.renewals > 0) {
        finalRenewals = eventData.renewals;
      }
      if (eventData.cancellations > 0) {
        finalCancellations = eventData.cancellations;
      }
      if (eventData.firstPayments > 0) {
        finalFirstPayments = eventData.firstPayments;
      }
      // Use refunds from SUBSCRIBER report (from "refund" events or negative revenue)
      if (eventData.refunds !== undefined && eventData.refunds > 0) {
        refunds = eventData.refunds;
      }
      // Use REVENUE from SUBSCRIBER report if available
      // NOTE: eventData.revenueGross/Net/Proceeds are ALREADY in userCurrency (converted in processAppStoreSubscriberReport)
      // revenueGross = Charged Revenue (what customer paid, including VAT)
      // revenueNet = Revenue (excluding VAT, calculated using country-based VAT rates)
      // revenueProceeds = Developer Proceeds (what Apple pays you after VAT and fees)
      if (eventData.revenueGross !== undefined && eventData.revenueGross > 0) {
        monthlyChargedRevenue = eventData.revenueGross;
        monthlyRevenue = eventData.revenueNet ?? eventData.revenueGross; // Fallback to gross if no VAT calc
        monthlyProceeds = eventData.revenueProceeds ?? 0; // Developer Proceeds from Apple
      }
      // Extract plan-split revenue
      monthlyPlanChargedRevenue = eventData.revenueGrossMonthly ?? 0;
      yearlyPlanChargedRevenue = eventData.revenueGrossYearly ?? 0;
      monthlyPlanRevenue = eventData.revenueNetMonthly ?? 0;
      yearlyPlanRevenue = eventData.revenueNetYearly ?? 0;
      monthlyPlanProceeds = eventData.revenueProceedsMonthly ?? 0;
      yearlyPlanProceeds = eventData.revenueProceedsYearly ?? 0;
    }
    
    // PRIORITY 1: Use SUBSCRIPTION_EVENT report data (most accurate for cancellations/new subs)
    if (subscriptionEventData) {
      // Cancellations from actual Cancel events
      if (subscriptionEventData.cancellations > 0) {
        finalCancellations = subscriptionEventData.cancellations;
        console.log(`[App Store ${date}] Using SUBSCRIPTION_EVENT cancellations: ${finalCancellations}`);
      }
      // New subscriptions (Subscribe events) - this is the TRUE first payment count
      if (subscriptionEventData.newSubscriptions > 0) {
        finalFirstPayments = subscriptionEventData.newSubscriptions;
        console.log(`[App Store ${date}] Using SUBSCRIPTION_EVENT newSubscriptions: ${finalFirstPayments}`);
      }
    }
    
    // PRIORITY 2: Use event data from SUMMARY TSV columns (rare)
    if (firstPayments > 0 || renewals > 0 || cancellations > 0) {
      if (finalFirstPayments === 0 && firstPayments > 0) finalFirstPayments = firstPayments;
      if (renewals > 0) finalRenewals = renewals;
      if (finalCancellations === 0 && cancellations > 0) finalCancellations = cancellations;
    }
    
    // PRIORITY 3 (FALLBACK): Use day-over-day comparison for any metrics still at 0
    // NOTE: This is less accurate as it conflates multiple effects
    if (prevSnapshot) {
      const paidDrop = prevSnapshot.paidSubscribers - finalPaidSubscribers;
      const paidGain = finalPaidSubscribers - prevSnapshot.paidSubscribers;
      
      if (finalCancellations === 0 && paidDrop > 0) {
        finalCancellations = paidDrop;
        console.log(`[App Store ${date}] Using day-over-day FALLBACK for cancellations: ${finalCancellations}`);
      }
      if (finalFirstPayments === 0 && paidGain > 0) {
        finalFirstPayments = paidGain;
        console.log(`[App Store ${date}] Using day-over-day FALLBACK for firstPayments: ${finalFirstPayments}`);
      }
    }
    
    finalChurn = finalCancellations;

    // MRR: Calculate using unified formula
    // Formula: MRR = monthly revenue + (yearly revenue / 12)
    // Convert to user's preferred currency (monthlyMRR/yearlyMRR are already in USD from per-row conversion)
    const yearMonthFinal = date.substring(0, 7);
    const convertedMonthlyMRR = await convertAndRoundCurrency(ctx, monthlyMRR, "USD", userCurrency, yearMonthFinal);
    const convertedYearlyMRR = await convertAndRoundCurrency(ctx, yearlyMRR, "USD", userCurrency, yearMonthFinal);
    const mrr = calculateMRR(convertedMonthlyMRR, convertedYearlyMRR);
    
    // Diagnostic log for MRR calculation
    console.log(`[App Store ${date}] MRR Calc: monthlyUSD=${monthlyMRR.toFixed(2)} yearlyUSD=${yearlyMRR.toFixed(2)} → monthly${userCurrency}=${convertedMonthlyMRR.toFixed(2)} yearly${userCurrency}=${convertedYearlyMRR.toFixed(2)} → MRR=${mrr.toFixed(2)} (subs: ${monthlySubsCount} monthly, ${yearlySubsCount} yearly)`);
    
    const weeklyChargedRevenue = Math.round((monthlyChargedRevenue + Number.EPSILON) * 100) / 100;
    const weeklyRevenue = Math.round((monthlyRevenue + Number.EPSILON) * 100) / 100;
    const weeklyProceeds = Math.round((monthlyProceeds + Number.EPSILON) * 100) / 100;
    
    const snapshot = {
      appId,
      date,
      platform: "appstore" as const,
      activeSubscribers: finalActiveSubscribers,
      trialSubscribers: finalTrialSubscribers,
      paidSubscribers: finalPaidSubscribers,
      cancellations: finalCancellations,
      churn: finalChurn,
      paybacks: 0,
      firstPayments: finalFirstPayments,
      renewals: finalRenewals,
      refunds, // From TSV parsing
      mrr,
      weeklyChargedRevenue,
      weeklyRevenue,
      weeklyProceeds,
      monthlyChargedRevenue: Math.round((monthlyChargedRevenue + Number.EPSILON) * 100) / 100,
      monthlyRevenue: Math.round((monthlyRevenue + Number.EPSILON) * 100) / 100,
      monthlyProceeds: Math.round((monthlyProceeds + Number.EPSILON) * 100) / 100,
      monthlySubscribers: monthlySubsCount,
      yearlySubscribers: yearlySubsCount,
      // Revenue split by plan type
      monthlyPlanChargedRevenue: Math.round((monthlyPlanChargedRevenue + Number.EPSILON) * 100) / 100,
      yearlyPlanChargedRevenue: Math.round((yearlyPlanChargedRevenue + Number.EPSILON) * 100) / 100,
      monthlyPlanRevenue: Math.round((monthlyPlanRevenue + Number.EPSILON) * 100) / 100,
      yearlyPlanRevenue: Math.round((yearlyPlanRevenue + Number.EPSILON) * 100) / 100,
      monthlyPlanProceeds: Math.round((monthlyPlanProceeds + Number.EPSILON) * 100) / 100,
      yearlyPlanProceeds: Math.round((yearlyPlanProceeds + Number.EPSILON) * 100) / 100,
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
    
    // Return comprehensive data for chunk aggregation
    return {
      date,
      snapshot,
      parsing: {
        productIds: Array.from(productIds),
        eventTypes,
        rowCount: lines.length - 1,
        monthlySubsCount,
        yearlySubsCount,
      },
    };
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
      return { renewals: 0, firstPayments: 0, cancellations: 0, revenueGross: 0, revenueNet: 0, revenueProceeds: 0 };
    }

    // Get app's preferred currency for conversion
    const app = await ctx.db.get(appId);
    const userCurrency = app?.currency || "USD";

    const headers = lines[0].split("\t").map((h) => h.trim().toLowerCase());

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
    
    // Look for COUNTRY/STOREFRONT column for VAT calculation
    const storefrontIdx = idx(/storefront/i);
    const countryIdx = idx(/country/i);
    const customerCountryIdx = storefrontIdx >= 0 ? storefrontIdx : countryIdx;
    
    // Look for PRODUCT ID column to classify monthly vs yearly plans
    const productIdIdx = idx(/product.*id|sku|subscription.*name|subscription.*apple.*id/i);
    const subscriptionDurationIdx = idx(/subscription.*duration|duration/i);
    
    // Fallback: If no "Event" column, try "proceeds reason" (older format)
    const proceedsReasonIdx = idx(/proceeds\s*reason/i);
    
    const eventColumnIdx = eventIdx >= 0 ? eventIdx : proceedsReasonIdx;
    
    if (eventColumnIdx < 0) {
      console.log(`[App Store Subscriber ${date}] No 'Event' or 'Proceeds Reason' column found - skipping`);
      return { renewals: 0, firstPayments: 0, cancellations: 0, revenueGross: 0, revenueNet: 0, revenueProceeds: 0, revenueGrossMonthly: 0, revenueGrossYearly: 0, revenueNetMonthly: 0, revenueNetYearly: 0, revenueProceedsMonthly: 0, revenueProceedsYearly: 0 };
    }

    // CRITICAL: If we can't filter by event date, we CANNOT extract revenue
    // because the SUBSCRIBER report contains events from multiple days.
    // Summing all rows would give us cumulative revenue, not daily revenue.
    const canFilterByDate = eventDateIdx >= 0;

    let renewals = 0;
    let firstPayments = 0;
    let cancellations = 0;
    let refunds = 0;
    let revenueGross = 0;
    let revenueNet = 0;
    let revenueProceeds = 0; // Developer Proceeds - what you actually receive from Apple
    // Revenue split by plan type
    let revenueGrossMonthly = 0;
    let revenueGrossYearly = 0;
    let revenueNetMonthly = 0;
    let revenueNetYearly = 0;
    let revenueProceedsMonthly = 0;
    let revenueProceedsYearly = 0;
    const eventTypes: Record<string, number> = {};
    const sampleEvents: string[] = [];
    const currenciesSeen: Record<string, number> = {}; // Track currencies for debugging
    let rowsProcessed = 0;
    let rowsSkippedWrongDate = 0;
    
    // Helper to detect plan type from product ID
    const detectPlanType = (productId: string, duration?: string): "monthly" | "yearly" | null => {
      const pid = productId.toLowerCase();
      const dur = (duration || "").toLowerCase();
      
      // Pattern matching for monthly plans
      if (/month|monthly|1m|30day|_m_|_mo_/i.test(pid) || dur.includes("month") || dur === "1 month") {
        return "monthly";
      }
      // Pattern matching for yearly plans
      if (/year|yearly|annual|12m|365day|_y_|_yr_/i.test(pid) || dur.includes("year") || dur === "1 year") {
        return "yearly";
      }
      return null;
    };

    // DEBUG: Track all unique event values for logging
    const eventValueCounts: Record<string, { count: number; revenue: number; classification: string }> = {};
    
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split("\t");
      const eventValue = (cols[eventColumnIdx] || "").trim();
      const quantity = quantityIdx >= 0 ? Number(cols[quantityIdx] || 1) : 1;
      
      // Extract product ID for plan type classification
      const productId = productIdIdx >= 0 ? (cols[productIdIdx] || "").trim() : "";
      const duration = subscriptionDurationIdx >= 0 ? (cols[subscriptionDurationIdx] || "").trim() : "";
      const planType = detectPlanType(productId, duration);
      
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
      let rowGross = 0; // Charged Revenue (what customer paid, including VAT)
      let rowNet = 0; // Revenue (excluding VAT, but still including platform fees)
      let rowProceeds = 0; // Developer Proceeds (what you actually receive after VAT and Apple's fee)
      if (canFilterByDate) {
        const rowGrossRaw = customerPriceIdx >= 0 ? Number(cols[customerPriceIdx] || 0) : 0;
        // Read actual currency from the report - don't assume USD!
        const grossCurrency = customerCurrencyIdx >= 0 ? (cols[customerCurrencyIdx] || "USD").trim() : "USD";
        // Track currencies seen for debugging
        currenciesSeen[grossCurrency] = (currenciesSeen[grossCurrency] || 0) + 1;
        const yearMonth = date.substring(0, 7);
        
        // Convert gross (Charged Revenue) to user currency
        rowGross = await convertAndRoundCurrency(ctx, rowGrossRaw, grossCurrency, userCurrency, yearMonth);
        
        // Calculate Revenue (excl VAT) using country-based VAT rates
        // Note: We DON'T use developerProceeds for Revenue because that also deducts Apple's 15-30% fee
        // We want: Revenue = CustomerPrice - VAT (still including Apple's fee)
        const countryCode = customerCountryIdx >= 0 ? (cols[customerCountryIdx] || "").trim().toUpperCase() : "";
        if (countryCode && rowGrossRaw > 0) {
          // Calculate revenue excluding VAT based on country
          const revenueExclVat = calculateRevenueExcludingVat(rowGrossRaw, countryCode);
          rowNet = await convertAndRoundCurrency(ctx, revenueExclVat, grossCurrency, userCurrency, yearMonth);
        } else {
          // No country info - use gross as fallback (assumes no VAT or VAT already excluded)
          rowNet = rowGross;
        }
        
        // Extract Developer Proceeds directly from the report - this is what Apple pays you
        // This is AFTER Apple's 15-30% fee AND after tax handling
        if (netRevenueIdx >= 0) {
          const rowProceedsRaw = Number(cols[netRevenueIdx] || 0);
          // Proceeds are typically in the proceeds currency (usually USD)
          const proceedsCurrency = proceedsCurrencyIdx >= 0 ? (cols[proceedsCurrencyIdx] || "USD").trim() : "USD";
          rowProceeds = await convertAndRoundCurrency(ctx, rowProceedsRaw, proceedsCurrency, userCurrency, yearMonth);
        }
      }
      
      // Track event types for debugging
      const eventLower = (eventValue || "").toLowerCase().trim();
      const eventLabel = eventValue?.trim() || "(empty)";
      eventTypes[eventLabel] = (eventTypes[eventLabel] || 0) + quantity;
      
      // Capture sample events for debugging (first 5)
      if (sampleEvents.length < 5 && !sampleEvents.includes(eventLabel)) {
        sampleEvents.push(eventLabel);
      }
      
      // CRITICAL FIX: In Apple's SUBSCRIBER report, each row with a positive customer price
      // is a revenue event. The "proceeds reason" column (which we read as "event") only
      // explains WHY the developer gets that commission rate, not WHETHER it's revenue.
      // - "Rate After One Year" = subscriber > 1 year, developer gets 85% instead of 70%
      // - Empty/blank = regular subscription, developer gets standard rate
      // So we must count ALL rows with positive prices as revenue!
      
      // Check for cancellation/refund (negative revenue events)
      const isCancellation = eventLower.includes("cancel") || eventLower.includes("canceled");
      const isRefund = eventLower.includes("refund") || rowGross < 0;
      
      // DEBUG: Determine classification for logging
      let classification = "skipped";
      
      if (isRefund) {
        // Refunds are negative revenue (rowGross might already be negative)
        refunds += quantity;
        revenueGross += Math.min(rowGross, 0); // Ensure negative
        revenueNet += Math.min(rowNet, 0);
        revenueProceeds += Math.min(rowProceeds, 0);
        classification = "refund";
        // Split by plan type
        if (planType === "yearly") {
          revenueGrossYearly += Math.min(rowGross, 0);
          revenueNetYearly += Math.min(rowNet, 0);
          revenueProceedsYearly += Math.min(rowProceeds, 0);
        } else if (planType === "monthly") {
          revenueGrossMonthly += Math.min(rowGross, 0);
          revenueNetMonthly += Math.min(rowNet, 0);
          revenueProceedsMonthly += Math.min(rowProceeds, 0);
        }
      } else if (isCancellation) {
        // Cancellations don't generate revenue but we track them
        cancellations += quantity;
        classification = "cancellation";
      } else if (rowGross > 0) {
        // ALL rows with positive customer price are revenue events
        // Categorize for analytics based on event/proceeds reason
        if (eventLower.includes("rate after one year") ||
            eventLower === "renew" || 
            eventLower.includes("renewal")) {
          renewals += quantity;
          classification = "renewal";
        } else if (eventLower.includes("start introductory price") ||
                   eventLower.includes("paid subscription from introductory price") ||
                   eventLower.includes("start promotional offer") ||
                   eventLower.includes("initial") || 
                   eventLower.includes("new") || 
                   eventLower.includes("subscribe")) {
          firstPayments += quantity;
          classification = "first_payment";
        } else {
          // Empty event or unknown = regular renewal payment
          // This is the CRITICAL fix - these were being skipped before!
          renewals += quantity;
          classification = "renewal_default";
        }
        
        // Add revenue for all non-refund, non-cancellation rows with positive price
        revenueGross += rowGross;
        revenueNet += rowNet;
        revenueProceeds += rowProceeds;
        // Split by plan type
        if (planType === "yearly") {
          revenueGrossYearly += rowGross;
          revenueNetYearly += rowNet;
          revenueProceedsYearly += rowProceeds;
        } else if (planType === "monthly") {
          revenueGrossMonthly += rowGross;
          revenueNetMonthly += rowNet;
          revenueProceedsMonthly += rowProceeds;
        }
      }
      
      // DEBUG: Track event value counts
      const eventKey = eventValue || "(empty)";
      if (!eventValueCounts[eventKey]) {
        eventValueCounts[eventKey] = { count: 0, revenue: 0, classification: classification };
      }
      eventValueCounts[eventKey].count += quantity;
      eventValueCounts[eventKey].revenue += rowGross;
      // Update classification to most common (first seen)
    }

    // DEBUG: Log comprehensive event classification breakdown
    console.log(`[App Store Subscriber ${date}] ========== EVENT CLASSIFICATION BREAKDOWN ==========`);
    console.log(`[App Store Subscriber ${date}] Total rows: ${lines.length - 1}, Processed: ${rowsProcessed}, Skipped (wrong date): ${rowsSkippedWrongDate}`);
    console.log(`[App Store Subscriber ${date}] Results: firstPayments=${firstPayments}, renewals=${renewals}, cancellations=${cancellations}, refunds=${refunds}`);
    console.log(`[App Store Subscriber ${date}] Revenue: gross=${revenueGross.toFixed(2)}, net=${revenueNet.toFixed(2)}, proceeds=${revenueProceeds.toFixed(2)}`);
    
    // Log each unique event value and how it was classified
    const sortedEvents = Object.entries(eventValueCounts)
      .sort((a, b) => b[1].count - a[1].count);
    
    console.log(`[App Store Subscriber ${date}] Event value breakdown (${sortedEvents.length} unique values):`);
    for (const [eventVal, stats] of sortedEvents.slice(0, 15)) { // Top 15
      console.log(`[App Store Subscriber ${date}]   "${eventVal}": count=${stats.count}, revenue=${stats.revenue.toFixed(2)}, classified=${stats.classification}`);
    }
    if (sortedEvents.length > 15) {
      console.log(`[App Store Subscriber ${date}]   ... and ${sortedEvents.length - 15} more event types`);
    }
    console.log(`[App Store Subscriber ${date}] =================================================`);

    // Return comprehensive data for chunk aggregation
    return { 
      renewals, 
      firstPayments, 
      cancellations,
      refunds,
      revenueGross,
      revenueNet,
      revenueProceeds, // Developer Proceeds - what Apple actually pays you
      // Revenue split by plan type
      revenueGrossMonthly,
      revenueGrossYearly,
      revenueNetMonthly,
      revenueNetYearly,
      revenueProceedsMonthly,
      revenueProceedsYearly,
      // Additional data for chunk summary
      rowsTotal: lines.length - 1,
      rowsProcessed,
      rowsSkipped: rowsSkippedWrongDate,
      currenciesSeen,
      eventTypes,
      sampleEvents,
      // DEBUG: Include event classification for inspection
      eventClassification: Object.fromEntries(
        sortedEvents.map(([k, v]) => [k, { count: v.count, classification: v.classification }])
      ),
    };
  },
});

// Process SUBSCRIPTION_EVENT report - actual subscription events (Subscribe, Cancel, Conversion)
export const processAppStoreSubscriptionEventReport = internalMutation({
  args: {
    appId: v.id("apps"),
    date: v.string(), // YYYY-MM-DD
    tsv: v.string(),
  },
  handler: async (ctx, { appId, date, tsv }) => {
    const lines = tsv.trim().split(/\r?\n/);
    if (lines.length < 2) {
      console.log(`[App Store Event ${date}] Empty TSV - no event data`);
      return { newSubscriptions: 0, cancellations: 0, conversions: 0, trialStarts: 0 };
    }

    const headers = lines[0].split("\t").map((h) => h.trim().toLowerCase());
    const idx = (name: RegExp) => headers.findIndex((h) => name.test(h));

    // SUBSCRIPTION_EVENT report columns
    const eventDateIdx = idx(/event.*date/i);
    const eventIdx = idx(/^event$/i);
    const quantityIdx = idx(/^quantity$|^units$/i);
    
    console.log(`[App Store Event ${date}] Headers: ${headers.join(", ")}`);
    console.log(`[App Store Event ${date}] Column indices: eventDate=${eventDateIdx}, event=${eventIdx}, quantity=${quantityIdx}`);

    let newSubscriptions = 0;
    let cancellations = 0;
    let conversions = 0;
    let trialStarts = 0;
    const eventCounts: Record<string, number> = {};

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split("\t");
      
      // Filter by event date matching target date
      if (eventDateIdx >= 0 && eventDateIdx < cols.length) {
        const eventDate = cols[eventDateIdx].trim();
        if (eventDate !== date) continue;
      }
      
      const eventType = (eventIdx >= 0 && eventIdx < cols.length ? cols[eventIdx] : "").trim().toLowerCase();
      const quantity = quantityIdx >= 0 && quantityIdx < cols.length ? parseInt(cols[quantityIdx]) || 1 : 1;
      
      // Track all event types
      eventCounts[eventType] = (eventCounts[eventType] || 0) + quantity;
      
      // Classify events based on Apple's SUBSCRIPTION_EVENT types
      // See: https://developer.apple.com/help/app-store-connect/reference/reporting/subscription-events
      
      // NEW SUBSCRIPTIONS (activations)
      if (eventType === "subscribe" || 
          eventType.includes("start introductory") ||
          eventType.includes("start offer code") ||
          eventType === "opt-in") {
        newSubscriptions += quantity;
        if (eventType.includes("introductory") || eventType.includes("free trial")) {
          trialStarts += quantity;
        }
      }
      
      // CANCELLATIONS
      else if (eventType === "cancel" ||
               eventType.includes("canceled from billing") ||
               eventType.includes("canceled after renewal")) {
        cancellations += quantity;
      }
      
      // CONVERSIONS (trial to paid)
      else if (eventType.includes("paid subscription from introductory") ||
               eventType.includes("paid subscription from opt-in") ||
               eventType.includes("paid subscription from promotional")) {
        conversions += quantity;
      }
    }
    
    console.log(`[App Store Event ${date}] Results: newSubscriptions=${newSubscriptions}, cancellations=${cancellations}, conversions=${conversions}, trialStarts=${trialStarts}`);
    console.log(`[App Store Event ${date}] Event breakdown: ${JSON.stringify(eventCounts)}`);
    
    return {
      newSubscriptions,
      cancellations,
      conversions,
      trialStarts,
      eventCounts,
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
        paybacks: platformSnapshots.reduce((acc, s) => acc + s.paybacks, 0),
        firstPayments: platformSnapshots.reduce((acc, s) => acc + s.firstPayments, 0),
        renewals: platformSnapshots.reduce((acc, s) => acc + s.renewals, 0),
        mrr: Math.round((platformSnapshots.reduce((acc, s) => acc + s.mrr, 0) + Number.EPSILON) * 100) / 100,
        weeklyChargedRevenue: Math.round((platformSnapshots.reduce((acc, s) => acc + (s.weeklyChargedRevenue || s.monthlyChargedRevenue || 0), 0) + Number.EPSILON) * 100) / 100,
        weeklyRevenue: Math.round((platformSnapshots.reduce((acc, s) => acc + (s.weeklyRevenue || s.monthlyRevenue || 0), 0) + Number.EPSILON) * 100) / 100,
        weeklyProceeds: Math.round((platformSnapshots.reduce((acc, s) => acc + (s.weeklyProceeds || s.monthlyProceeds || 0), 0) + Number.EPSILON) * 100) / 100,
        monthlyChargedRevenue: Math.round((platformSnapshots.reduce((acc, s) => acc + s.monthlyChargedRevenue, 0) + Number.EPSILON) * 100) / 100,
        monthlyRevenue: Math.round((platformSnapshots.reduce((acc, s) => acc + s.monthlyRevenue, 0) + Number.EPSILON) * 100) / 100,
        monthlyProceeds: Math.round((platformSnapshots.reduce((acc, s) => acc + (s.monthlyProceeds || 0), 0) + Number.EPSILON) * 100) / 100,
        monthlySubscribers: platformSnapshots.reduce((acc, s) => acc + (s.monthlySubscribers || 0), 0),
        yearlySubscribers: platformSnapshots.reduce((acc, s) => acc + (s.yearlySubscribers || 0), 0),
        // Revenue split by plan type
        monthlyPlanChargedRevenue: Math.round((platformSnapshots.reduce((acc, s) => acc + (s.monthlyPlanChargedRevenue || 0), 0) + Number.EPSILON) * 100) / 100,
        yearlyPlanChargedRevenue: Math.round((platformSnapshots.reduce((acc, s) => acc + (s.yearlyPlanChargedRevenue || 0), 0) + Number.EPSILON) * 100) / 100,
        monthlyPlanRevenue: Math.round((platformSnapshots.reduce((acc, s) => acc + (s.monthlyPlanRevenue || 0), 0) + Number.EPSILON) * 100) / 100,
        yearlyPlanRevenue: Math.round((platformSnapshots.reduce((acc, s) => acc + (s.yearlyPlanRevenue || 0), 0) + Number.EPSILON) * 100) / 100,
        monthlyPlanProceeds: Math.round((platformSnapshots.reduce((acc, s) => acc + (s.monthlyPlanProceeds || 0), 0) + Number.EPSILON) * 100) / 100,
        yearlyPlanProceeds: Math.round((platformSnapshots.reduce((acc, s) => acc + (s.yearlyPlanProceeds || 0), 0) + Number.EPSILON) * 100) / 100,
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

// Chunked version of generateUnifiedHistoricalSnapshots for avoiding timeouts
export const generateUnifiedHistoricalSnapshotsChunk = internalMutation({
  args: {
    appId: v.id("apps"),
    startDayBack: v.number(), // e.g., 365 (oldest)
    endDayBack: v.number(),   // e.g., 266 (more recent)
  },
  handler: async (ctx, { appId, startDayBack, endDayBack }) => {
    const today = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;
    let created = 0;

    // Process each day in this chunk (from oldest to newest)
    for (let i = startDayBack; i >= endDayBack; i--) {
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
        paybacks: platformSnapshots.reduce((acc, s) => acc + s.paybacks, 0),
        firstPayments: platformSnapshots.reduce((acc, s) => acc + s.firstPayments, 0),
        renewals: platformSnapshots.reduce((acc, s) => acc + s.renewals, 0),
        mrr: Math.round((platformSnapshots.reduce((acc, s) => acc + s.mrr, 0) + Number.EPSILON) * 100) / 100,
        weeklyChargedRevenue: Math.round((platformSnapshots.reduce((acc, s) => acc + (s.weeklyChargedRevenue || s.monthlyChargedRevenue || 0), 0) + Number.EPSILON) * 100) / 100,
        weeklyRevenue: Math.round((platformSnapshots.reduce((acc, s) => acc + (s.weeklyRevenue || s.monthlyRevenue || 0), 0) + Number.EPSILON) * 100) / 100,
        weeklyProceeds: Math.round((platformSnapshots.reduce((acc, s) => acc + (s.weeklyProceeds || s.monthlyProceeds || 0), 0) + Number.EPSILON) * 100) / 100,
        monthlyChargedRevenue: Math.round((platformSnapshots.reduce((acc, s) => acc + s.monthlyChargedRevenue, 0) + Number.EPSILON) * 100) / 100,
        monthlyRevenue: Math.round((platformSnapshots.reduce((acc, s) => acc + s.monthlyRevenue, 0) + Number.EPSILON) * 100) / 100,
        monthlyProceeds: Math.round((platformSnapshots.reduce((acc, s) => acc + (s.monthlyProceeds || 0), 0) + Number.EPSILON) * 100) / 100,
        monthlySubscribers: platformSnapshots.reduce((acc, s) => acc + (s.monthlySubscribers || 0), 0),
        yearlySubscribers: platformSnapshots.reduce((acc, s) => acc + (s.yearlySubscribers || 0), 0),
        // Revenue split by plan type
        monthlyPlanChargedRevenue: Math.round((platformSnapshots.reduce((acc, s) => acc + (s.monthlyPlanChargedRevenue || 0), 0) + Number.EPSILON) * 100) / 100,
        yearlyPlanChargedRevenue: Math.round((platformSnapshots.reduce((acc, s) => acc + (s.yearlyPlanChargedRevenue || 0), 0) + Number.EPSILON) * 100) / 100,
        monthlyPlanRevenue: Math.round((platformSnapshots.reduce((acc, s) => acc + (s.monthlyPlanRevenue || 0), 0) + Number.EPSILON) * 100) / 100,
        yearlyPlanRevenue: Math.round((platformSnapshots.reduce((acc, s) => acc + (s.yearlyPlanRevenue || 0), 0) + Number.EPSILON) * 100) / 100,
        monthlyPlanProceeds: Math.round((platformSnapshots.reduce((acc, s) => acc + (s.monthlyPlanProceeds || 0), 0) + Number.EPSILON) * 100) / 100,
        yearlyPlanProceeds: Math.round((platformSnapshots.reduce((acc, s) => acc + (s.yearlyPlanProceeds || 0), 0) + Number.EPSILON) * 100) / 100,
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
        for (let j = 1; j < existingUnified.length; j++) {
          await ctx.db.delete(existingUnified[j]._id);
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
      paybacks: 0,
      firstPayments: 0, // No sales = no new subscribers
      renewals: 0,
      refunds: 0,
      mrr: previousSnapshot.mrr,
      weeklyChargedRevenue: 0,
      weeklyRevenue: 0,
      weeklyProceeds: 0,
      monthlyChargedRevenue: 0,
      monthlyRevenue: 0,
      monthlyProceeds: 0,
      monthlySubscribers: previousSnapshot.monthlySubscribers || 0,
      yearlySubscribers: previousSnapshot.yearlySubscribers || 0,
      // Revenue split by plan type (0 because no sales today)
      monthlyPlanChargedRevenue: 0,
      yearlyPlanChargedRevenue: 0,
      monthlyPlanRevenue: 0,
      yearlyPlanRevenue: 0,
      monthlyPlanProceeds: 0,
      yearlyPlanProceeds: 0,
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
    refundsByDate: v.optional(v.any()), // Record<string, number> - count of refunds per date
    discoveredReportTypes: v.array(v.string()),
  },
  handler: async (ctx, { appId, revenueByDate, subscriptionMetricsByDate, refundsByDate, discoveredReportTypes }) => {
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
    
    // Debug: Check if proceeds data is present in revenue data
    if (hasRevenueData) {
      const sampleDate = Object.keys(revenueByDate)[0];
      const sample = revenueByDate[sampleDate];
      console.log(`[Google Play] Sample revenue data (${sampleDate}): gross=${sample?.gross}, net=${sample?.net}, proceeds=${sample?.proceeds}, transactions=${sample?.transactions}`);
      
      // Count how many dates have proceeds > 0
      const datesWithProceeds = Object.entries(revenueByDate).filter(([_, data]: [string, any]) => (data.proceeds || 0) > 0).length;
      const totalDates = Object.keys(revenueByDate).length;
      console.log(`[Google Play] Proceeds data: ${datesWithProceeds}/${totalDates} dates have proceeds > 0`);
    }

    // Get all unique dates from both revenue and subscription data
    const allDates = new Set([
      ...Object.keys(revenueByDate || {}),
      ...Object.keys(subscriptionMetricsByDate || {})
    ]);

    console.log(`[Google Play] Processing ${allDates.size} unique dates`);

    // Get unique months from all dates for historical rate lookups
    const uniqueMonths = new Set<string>();
    for (const date of allDates) {
      uniqueMonths.add(date.substring(0, 7));
    }

    // Pre-fetch exchange rates for each month (historical rates)
    const ratesByMonth = new Map<string, number>();
    for (const yearMonth of uniqueMonths) {
      let rate = 1.0;
      if (userCurrency.toUpperCase() !== "USD") {
        // Try historical rate first
        const historicalRate = await ctx.db
          .query("exchangeRates")
          .withIndex("by_pair_month", (q: any) => q.eq("fromCurrency", "USD").eq("toCurrency", userCurrency.toUpperCase()).eq("yearMonth", yearMonth))
          .first();
        
        if (historicalRate) {
          rate = historicalRate.rate;
        } else {
          // Fall back to latest rate
          const latestRate = await ctx.db
            .query("exchangeRates")
            .withIndex("by_pair", (q: any) => q.eq("fromCurrency", "USD").eq("toCurrency", userCurrency.toUpperCase()))
            .order("desc")
            .first();
          
          if (latestRate) {
            rate = latestRate.rate;
          } else {
            // Try inverse
            const inverseRate = await ctx.db
              .query("exchangeRates")
              .withIndex("by_pair", (q: any) => q.eq("fromCurrency", userCurrency.toUpperCase()).eq("toCurrency", "USD"))
              .order("desc")
              .first();
            if (inverseRate) {
              rate = 1 / inverseRate.rate;
            }
          }
        }
      }
      ratesByMonth.set(yearMonth, rate);
    }
    console.log(`[Google Play] Pre-fetched exchange rates for ${ratesByMonth.size} months`);

    // Helper function for conversion using historical rate for the date's month
    const convertCurrency = (amount: number, date: string): number => {
      const yearMonth = date.substring(0, 7);
      const rate = ratesByMonth.get(yearMonth) ?? 1.0;
      const converted = amount * rate;
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
      // gross = Charged Revenue (what customer paid, including VAT)
      // net = Revenue (item price, excluding VAT)
      // proceeds = Developer Proceeds (what you actually receive after fees)
      let convertedChargedRevenue = 0;
      let convertedRevenue = 0;
      let convertedProceeds = 0;
      let weeklyChargedRevenue = 0;
      let weeklyRevenue = 0;
      let weeklyProceeds = 0;

      if (revenueData) {
        convertedChargedRevenue = convertCurrency(revenueData.gross, date);
        convertedRevenue = convertCurrency(revenueData.net, date);
        convertedProceeds = convertCurrency(revenueData.proceeds || 0, date);
        weeklyChargedRevenue = Math.round((convertedChargedRevenue + Number.EPSILON) * 100) / 100;
        weeklyRevenue = Math.round((convertedRevenue + Number.EPSILON) * 100) / 100;
        weeklyProceeds = Math.round((convertedProceeds + Number.EPSILON) * 100) / 100;
      }

      // Extract subscription metrics if available
      const activeSubscribers = subMetrics?.active || 0;
      const trialSubscribers = subMetrics?.trial || 0;
      // FIX: Calculate paid = active - trial (don't require trial > 0)
      const paidSubscribers = subMetrics?.paid || Math.max(0, activeSubscribers - trialSubscribers);
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

      // MRR: For Google Play, we don't have per-subscription pricing.
      // We store MRR = 0 here, and let getLatestMetrics calculate it dynamically
      // using App Store's average subscription prices applied to Google Play subscriber counts.
      // 
      // This is the correct approach because:
      // - MRR is subscriber-based (subscriber count × monthly price contribution)
      // - Google Play doesn't provide per-subscription pricing
      // - App Store's average prices can be derived from plan revenue / subscriber counts
      //
      // The query-time calculation will:
      // 1. Calculate App Store's avg monthly price = monthlyPlanChargedRevenue / monthlySubscribers
      // 2. Calculate App Store's avg yearly price from yearlyPlanChargedRevenue
      // 3. Apply these prices to Google Play subscriber counts for accurate MRR
      const mrr = 0;

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
        paybacks: 0,
        firstPayments: newSubscriptions,
        renewals,
        refunds: refundsByDate?.[date] || 0, // From financial reports
        mrr,
        // Revenue metrics - from financial reports
        weeklyChargedRevenue,
        weeklyRevenue,
        weeklyProceeds,
        monthlyChargedRevenue: Math.round((convertedChargedRevenue + Number.EPSILON) * 100) / 100,
        monthlyRevenue: Math.round((convertedRevenue + Number.EPSILON) * 100) / 100,
        monthlyProceeds: Math.round((convertedProceeds + Number.EPSILON) * 100) / 100,
        monthlySubscribers,
        yearlySubscribers,
        // Revenue split by plan type - NOT available from Google Play (will be derived from App Store ratio if setting enabled)
        monthlyPlanChargedRevenue: 0,
        yearlyPlanChargedRevenue: 0,
        monthlyPlanRevenue: 0,
        yearlyPlanRevenue: 0,
        monthlyPlanProceeds: 0,
        yearlyPlanProceeds: 0,
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
      const { gross, net, proceeds, transactions } = data as { gross: number; net: number; proceeds?: number; transactions: number };

      const yearMonth = date.substring(0, 7);
      // gross = Charged Revenue (including VAT), net = Revenue (excluding VAT), proceeds = Developer Proceeds
      const convertedChargedRevenue = await convertAndRoundCurrency(ctx, gross, "USD", userCurrency, yearMonth);
      const convertedRevenue = await convertAndRoundCurrency(ctx, net, "USD", userCurrency, yearMonth);
      const convertedProceeds = await convertAndRoundCurrency(ctx, proceeds || 0, "USD", userCurrency, yearMonth);

      const snapshot = {
        appId,
        date,
        platform: "googleplay" as const,
        activeSubscribers: 0,
        trialSubscribers: 0,
        paidSubscribers: 0,
        cancellations: 0,
        churn: 0,
        paybacks: 0,
        firstPayments: 0,
        renewals: 0,
        refunds: 0,
        mrr: 0,
        weeklyChargedRevenue: Math.round((convertedChargedRevenue + Number.EPSILON) * 100) / 100,
        weeklyRevenue: Math.round((convertedRevenue + Number.EPSILON) * 100) / 100,
        weeklyProceeds: Math.round((convertedProceeds + Number.EPSILON) * 100) / 100,
        monthlyChargedRevenue: Math.round((convertedChargedRevenue + Number.EPSILON) * 100) / 100,
        monthlyRevenue: Math.round((convertedRevenue + Number.EPSILON) * 100) / 100,
        monthlyProceeds: Math.round((convertedProceeds + Number.EPSILON) * 100) / 100,
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

