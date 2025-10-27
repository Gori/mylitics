import { v } from "convex/values";
import { mutation, query, internalMutation } from "./_generated/server";
import { Id } from "./_generated/dataModel";

export const processAndStoreMetrics = internalMutation({
  args: {
    userId: v.id("users"),
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
  handler: async (ctx, { userId, platform, subscriptions, revenueEvents, snapshotDate }) => {
    const now = new Date();
    const today = snapshotDate || now.toISOString().split("T")[0];

    // Store raw subscription data
    console.log(`[Metrics ${platform}] Storing ${subscriptions.length} subscriptions...`);
    for (const sub of subscriptions) {
      const existing = await ctx.db
        .query("subscriptions")
        .withIndex("by_external_id", (q) =>
          q.eq("platform", platform).eq("externalId", sub.externalId)
        )
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
          userId,
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
      .withIndex("by_user_platform", (q) => q.eq("userId", userId).eq("platform", platform))
      .collect();
    console.log(`[Metrics ${platform}] Found ${allSubs.length} subscriptions in database for matching`);
    if (allSubs.length > 0 && allSubs.length <= 5) {
      console.log(`[Metrics ${platform}] Sample subscription externalIds: ${allSubs.map(s => s.externalId).join(", ")}`);
    }
    
    // Load all existing revenue events for this user/platform ONCE to avoid repeated queries
    const existingRevenue = await ctx.db
      .query("revenueEvents")
      .withIndex("by_user_platform", (q) => q.eq("userId", userId).eq("platform", platform))
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
            userId,
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

    // MRR from current active subscription prices
    let mrr = 0;
    for (const s of subscriptions) {
      if (s.isTrial) continue;
      if (!(s.status === "active" || s.status === "trialing")) continue;
      try {
        const raw = JSON.parse(s.rawData);
        const unit = raw?.items?.data?.[0]?.price?.unit_amount;
        const interval = raw?.items?.data?.[0]?.price?.recurring?.interval;
        if (typeof unit === "number") {
          if (interval === "year") mrr += unit / 100 / 12;
          else mrr += unit / 100;
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
      if (e.eventType === "refund") {
        monthlyRevenueGross -= e.amount;
        monthlyRevenueNet -= e.amount * 0.85;
      } else {
        monthlyRevenueGross += e.amount;
        monthlyRevenueNet += e.amount * 0.85;
      }
    }
    
    monthlyRevenueGross = Math.round((monthlyRevenueGross + Number.EPSILON) * 100) / 100;
    monthlyRevenueNet = Math.round((monthlyRevenueNet + Number.EPSILON) * 100) / 100;

    // Weekly revenue is the net revenue for this day (will be summed over weeks for display)
    const weeklyRevenue = monthlyRevenueNet;

    console.log(`[Metrics ${platform}] Calculated - Active: ${activeSubscribers}, Trial: ${trialSubscribers}, Paid: ${paidSubscribers}, Cancellations: ${cancellations}, Churn: ${churn}, Grace: ${graceEvents}, First: ${firstPayments}, Renewals: ${renewals}, MRR: ${mrr}, Revenue: ${weeklyRevenue}`);
    console.log(`[Metrics ${platform}] Revenue breakdown - Gross: ${monthlyRevenueGross}, Net: ${monthlyRevenueNet}, Weekly: ${weeklyRevenue}`);

    // Store snapshot
    const existingSnapshot = await ctx.db
      .query("metricsSnapshots")
      .withIndex("by_user_platform", (q) =>
        q.eq("userId", userId).eq("platform", platform)
      )
      .filter((q) => q.eq(q.field("date"), today))
      .first();

    const snapshotData = {
      userId,
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

    if (existingSnapshot) {
      await ctx.db.patch(existingSnapshot._id, snapshotData);
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
    userId: v.id("users"),
  },
  handler: async (ctx, { userId }) => {
    const today = new Date().toISOString().split("T")[0];

    const platformSnapshots = await ctx.db
      .query("metricsSnapshots")
      .withIndex("by_user_date", (q) => q.eq("userId", userId).eq("date", today))
      .filter((q) => q.neq(q.field("platform"), "unified"))
      .collect();

    if (platformSnapshots.length === 0) return;

    const unified = {
      userId,
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
      mrr: platformSnapshots.reduce((acc, s) => acc + s.mrr, 0),
      weeklyRevenue: platformSnapshots.reduce((acc, s) => acc + (s.weeklyRevenue || s.monthlyRevenueNet || 0), 0),
      monthlyRevenueGross: platformSnapshots.reduce((acc, s) => acc + s.monthlyRevenueGross, 0),
      monthlyRevenueNet: platformSnapshots.reduce((acc, s) => acc + s.monthlyRevenueNet, 0),
      monthlySubscribers: platformSnapshots.reduce((acc, s) => acc + (s.monthlySubscribers || 0), 0),
      yearlySubscribers: platformSnapshots.reduce((acc, s) => acc + (s.yearlySubscribers || 0), 0),
    };

    const existingUnified = await ctx.db
      .query("metricsSnapshots")
      .withIndex("by_user_platform", (q) =>
        q.eq("userId", userId).eq("platform", "unified")
      )
      .filter((q) => q.eq(q.field("date"), today))
      .first();

    if (existingUnified) {
      await ctx.db.patch(existingUnified._id, unified);
    } else {
      await ctx.db.insert("metricsSnapshots", unified);
    }
  },
});

export const generateHistoricalSnapshots = internalMutation({
  args: {
    userId: v.id("users"),
    platform: v.union(
      v.literal("appstore"),
      v.literal("googleplay"),
      v.literal("stripe"),
    ),
    startMs: v.number(),
    endMs: v.number(),
  },
  handler: async (ctx, { userId, platform, startMs, endMs }) => {
    const oneDayMs = 24 * 60 * 60 * 1000;

    const subs = await ctx.db
      .query("subscriptions")
      .withIndex("by_user_platform", (q) => q.eq("userId", userId).eq("platform", platform))
      .collect();

    const revenue = await ctx.db
      .query("revenueEvents")
      .withIndex("by_user_platform", (q) => q.eq("userId", userId).eq("platform", platform))
      .collect();
    
    console.log(`[Historical ${platform}] Found ${subs.length} subscriptions and ${revenue.length} revenue events in database for historical calculation`);
    if (revenue.length > 0) {
      const minTimestamp = Math.min(...revenue.map(r => r.timestamp));
      const maxTimestamp = Math.max(...revenue.map(r => r.timestamp));
      console.log(`[Historical ${platform}] Revenue events date range: ${new Date(minTimestamp).toISOString()} to ${new Date(maxTimestamp).toISOString()}`);
    }

    let daysProcessed = 0;

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

          if (!s.isTrial && (s.status === "active" || s.status === "trialing")) {
            const unit = raw?.items?.data?.[0]?.price?.unit_amount;
            const interval = raw?.items?.data?.[0]?.price?.recurring?.interval;
            if (typeof unit === "number") {
              if (interval === "year") mrr += unit / 100 / 12;
              else mrr += unit / 100;
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
        if (e.eventType === "refund") {
          monthlyRevenueGross -= e.amount;
          monthlyRevenueNet -= e.amount * 0.85;
        } else {
          monthlyRevenueGross += e.amount;
          monthlyRevenueNet += e.amount * 0.85;
        }
      }
      monthlyRevenueGross = Math.round((monthlyRevenueGross + Number.EPSILON) * 100) / 100;
      monthlyRevenueNet = Math.round((monthlyRevenueNet + Number.EPSILON) * 100) / 100;
      const weeklyRevenue = monthlyRevenueNet;

      const existing = await ctx.db
        .query("metricsSnapshots")
        .withIndex("by_user_platform", (q) => q.eq("userId", userId).eq("platform", platform))
        .filter((q) => q.eq(q.field("date"), date))
        .first();

      const snapshot = {
        userId,
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

      if (existing) await ctx.db.patch(existing._id, snapshot);
      else await ctx.db.insert("metricsSnapshots", snapshot);

      daysProcessed += 1;
      if (daysProcessed % 30 === 0) {
        console.log(`[Metrics ${platform}] Generated ${daysProcessed} daily snapshots so far...`);
      }
    }

    console.log(`[Metrics ${platform}] Historical generation complete: ${daysProcessed} days processed`);
  },
});

export const processAppStoreReport = internalMutation({
  args: {
    userId: v.id("users"),
    date: v.string(), // YYYY-MM-DD
    tsv: v.string(),
    eventData: v.optional(v.object({
      renewals: v.number(),
      firstPayments: v.number(),
      cancellations: v.number(),
    })),
  },
  handler: async (ctx, { userId, date, tsv, eventData }) => {
    const lines = tsv.trim().split(/\r?\n/);
    if (lines.length < 2) {
      console.log(`[App Store ${date}] Empty TSV - no data`);
      return;
    }

    // Get previous day's snapshot to calculate cancellations
    const prevDate = new Date(new Date(date).getTime() - 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const prevSnapshot = await ctx.db
      .query("metricsSnapshots")
      .withIndex("by_user_platform", (q) => q.eq("userId", userId).eq("platform", "appstore"))
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
      
      // Extract revenue
      const gross = customerPriceIdx >= 0 ? Number(cols[customerPriceIdx] || 0) : 0;
      const netRaw = proceedsIdx >= 0 ? Number(cols[proceedsIdx] || 0) : null;
      const net = netRaw === null || isNaN(netRaw) ? gross * 0.85 : netRaw;
      
      monthlyRevenueGross += gross;
      monthlyRevenueNet += net;
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
    
    // Use event data from SUBSCRIBER report for renewals, but day-over-day for cancellations
    if (eventData && eventData.renewals > 0) {
      console.log(`[App Store ${date}] Using SUBSCRIBER report: Renewals=${eventData.renewals}`);
      finalRenewals = eventData.renewals;
      
      // Use cancellations from event data only if present
      if (eventData.cancellations > 0) {
        finalCancellations = eventData.cancellations;
        console.log(`[App Store ${date}] Using SUBSCRIBER report: Cancellations=${eventData.cancellations}`);
      }
      
      // Use first payments from event data if present
      if (eventData.firstPayments > 0) {
        finalFirstPayments = eventData.firstPayments;
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

    // MRR: estimate from monthly revenue and active subscribers
    const estimatedMRR = finalActiveSubscribers > 0 ? (monthlyRevenueNet / finalActiveSubscribers) * finalActiveSubscribers : 0;
    
    const weeklyRevenue = Math.round((monthlyRevenueNet + Number.EPSILON) * 100) / 100;
    
    const snapshot = {
      userId,
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
      .withIndex("by_user_platform", (q) => q.eq("userId", userId).eq("platform", "appstore"))
      .filter((q) => q.eq(q.field("date"), date))
      .first();

    if (existing) await ctx.db.patch(existing._id, snapshot);
    else await ctx.db.insert("metricsSnapshots", snapshot);
  },
});

export const processAppStoreSubscriberReport = internalMutation({
  args: {
    userId: v.id("users"),
    date: v.string(), // YYYY-MM-DD
    tsv: v.string(),
  },
  handler: async (ctx, { userId, date, tsv }) => {
    const lines = tsv.trim().split(/\r?\n/);
    if (lines.length < 2) {
      console.log(`[App Store Subscriber ${date}] Empty TSV - no event data`);
      return { renewals: 0, firstPayments: 0, cancellations: 0 };
    }

    const headers = lines[0].split("\t").map((h) => h.trim().toLowerCase());
    console.log(`[App Store Subscriber ${date}] Headers:`, JSON.stringify(headers));

    const idx = (name: RegExp) => headers.findIndex((h) => name.test(h));
    
    // Look for "Event" column which contains event types like "Renew", "Cancel", etc.
    const eventIdx = idx(/^event$/i);
    const eventDateIdx = idx(/event.*date/i);
    const quantityIdx = idx(/^quantity$/i);
    
    // Fallback: If no "Event" column, try "proceeds reason" (older format)
    const proceedsReasonIdx = idx(/proceeds\s*reason/i);
    
    const eventColumnIdx = eventIdx >= 0 ? eventIdx : proceedsReasonIdx;
    
    if (eventColumnIdx < 0) {
      console.log(`[App Store Subscriber ${date}] No 'Event' or 'Proceeds Reason' column found - skipping`);
      console.log(`[App Store Subscriber ${date}] Available headers:`, headers.join(", "));
      return { renewals: 0, firstPayments: 0, cancellations: 0 };
    }

    console.log(`[App Store Subscriber ${date}] Column indices:`, {
      event: eventIdx,
      proceedsReason: proceedsReasonIdx,
      eventDate: eventDateIdx,
      quantity: quantityIdx,
      usingColumn: eventIdx >= 0 ? "Event" : "Proceeds Reason",
    });

    let renewals = 0;
    let firstPayments = 0;
    let cancellations = 0;
    const eventTypes: Record<string, number> = {};
    const sampleEvents: string[] = [];

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split("\t");
      const eventValue = (cols[eventColumnIdx] || "").trim();
      const quantity = quantityIdx >= 0 ? Number(cols[quantityIdx] || 1) : 1;
      
      if (eventValue) {
        const eventLower = eventValue.toLowerCase();
        eventTypes[eventValue] = (eventTypes[eventValue] || 0) + quantity;
        
        // Capture sample events for debugging (first 5)
        if (sampleEvents.length < 5 && !sampleEvents.includes(eventValue)) {
          sampleEvents.push(eventValue);
        }
        
        // Match renewal patterns
        if (eventLower === "renew" || 
            eventLower.includes("renewal") ||
            eventLower.includes("renewal from billing retry") ||
            eventLower.includes("rate after one year")) { // Higher revenue share after 1 year
          renewals += quantity;
        } 
        // Match new subscription/first payment patterns
        else if (eventLower.includes("start introductory price") ||
                 eventLower.includes("paid subscription from introductory price") ||
                 eventLower.includes("start promotional offer") ||
                 eventLower.includes("initial") || 
                 eventLower.includes("new") || 
                 eventLower.includes("subscribe")) {
          firstPayments += quantity;
        } 
        // Match cancellation patterns
        else if (eventLower === "cancel" || 
                 eventLower.includes("canceled") ||
                 eventLower.includes("refund")) {
          cancellations += quantity;
        }
      }
    }

    console.log(`[App Store Subscriber ${date}] Event values found (${Object.keys(eventTypes).length}):`, JSON.stringify(eventTypes));
    console.log(`[App Store Subscriber ${date}] Sample events:`, sampleEvents.join(", "));
    console.log(`[App Store Subscriber ${date}] Renewals: ${renewals}, First Payments: ${firstPayments}, Cancellations: ${cancellations}`);

    return { renewals, firstPayments, cancellations };
  },
});

export const storeAppStoreReport = internalMutation({
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

export const generateUnifiedHistoricalSnapshots = internalMutation({
  args: {
    userId: v.id("users"),
    daysBack: v.number(),
  },
  handler: async (ctx, { userId, daysBack }) => {
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
        .withIndex("by_user_date", (q) => q.eq("userId", userId).eq("date", dateStr))
        .filter((q) => q.neq(q.field("platform"), "unified"))
        .collect();

      // Skip if no platform data for this date
      if (platformSnapshots.length === 0) continue;

      // Sum up all platforms
      const unified = {
        userId,
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
        mrr: platformSnapshots.reduce((acc, s) => acc + s.mrr, 0),
        weeklyRevenue: platformSnapshots.reduce((acc, s) => acc + (s.weeklyRevenue || s.monthlyRevenueNet || 0), 0),
        monthlyRevenueGross: platformSnapshots.reduce((acc, s) => acc + s.monthlyRevenueGross, 0),
        monthlyRevenueNet: platformSnapshots.reduce((acc, s) => acc + s.monthlyRevenueNet, 0),
        monthlySubscribers: platformSnapshots.reduce((acc, s) => acc + (s.monthlySubscribers || 0), 0),
        yearlySubscribers: platformSnapshots.reduce((acc, s) => acc + (s.yearlySubscribers || 0), 0),
      };

      // Check if unified snapshot already exists for this date
      const existingUnified = await ctx.db
        .query("metricsSnapshots")
        .withIndex("by_user_date", (q) =>
          q.eq("userId", userId).eq("date", dateStr)
        )
        .filter((q) => q.eq(q.field("platform"), "unified"))
        .first();

      if (existingUnified) {
        await ctx.db.patch(existingUnified._id, unified);
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
    userId: v.id("users"),
    date: v.string(),
    previousSnapshot: v.any(), // Accept any object and extract what we need
  },
  handler: async (ctx, { userId, date, previousSnapshot }) => {
    // Create snapshot with same subscriber counts but 0 revenue/events (no sales today)
    // Since no actual sales report, we can't calculate flow metrics from day-to-day
    const snapshot = {
      userId,
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
      .withIndex("by_user_platform", (q) => q.eq("userId", userId).eq("platform", "appstore"))
      .filter((q) => q.eq(q.field("date"), date))
      .first();

    if (existing) await ctx.db.patch(existing._id, snapshot);
    else await ctx.db.insert("metricsSnapshots", snapshot);
  },
});

