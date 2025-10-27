"use node";

import { action } from "../_generated/server";
import { v } from "convex/values";
import Stripe from "stripe";

export const fetchStripeData = action({
  args: {
    apiKey: v.string(),
    startDate: v.optional(v.number()),
    endDate: v.optional(v.number()),
  },
  handler: async (ctx, { apiKey, startDate, endDate }) => {
    return await fetchStripe(apiKey, startDate, endDate);
  },
});

export async function fetchStripe(apiKey: string, startDate?: number, endDate?: number) {
  const stripe = new Stripe(apiKey);

  const subscriptions: Array<{
    externalId: string;
    customerId: string;
    status: string;
    productId: string;
    startDate: number;
    endDate?: number;
    isTrial: boolean;
    willCancel: boolean;
    isInGrace: boolean;
    rawData: string;
  }> = [];

  const revenueEvents: Array<{
    subscriptionExternalId: string;
    eventType: "first_payment" | "renewal" | "refund";
    amount: number;
    currency: string;
    timestamp: number;
    rawData: string;
  }> = [];

  const listParams: any = { limit: 100, expand: ["data.items.data.price"], status: "all" };
  if (startDate) {
    listParams.created = { gte: Math.floor(startDate / 1000) };
  }

  console.log(`[Stripe] Fetching subscriptions with params:`, listParams);
  let subCount = 0;
  
  for await (const subscription of stripe.subscriptions.list(listParams)) {
    const subAny = subscription as any;
    const createdAt = (subscription.created || 0) * 1000;
    
    if (endDate && createdAt > endDate) continue;
    
    const endTimestamp = subscription.status === "canceled" 
      ? (subAny.canceled_at || subAny.ended_at || subAny.current_period_end || 0) * 1000
      : (subAny.current_period_end || 0) * 1000;
    
    subscriptions.push({
      externalId: subscription.id,
      customerId: subscription.customer as string,
      status: subscription.status,
      productId: subscription.items.data[0]?.price.product as string,
      startDate: createdAt,
      endDate: endTimestamp,
      isTrial: subscription.status === "trialing",
      willCancel: subAny.cancel_at_period_end || false,
      isInGrace: subscription.status === "past_due",
      rawData: JSON.stringify(subscription),
    });
    subCount++;
  }
  
  console.log(`[Stripe] Fetched ${subCount} subscriptions`);

  const invoiceParams: any = { 
    limit: 100
  };
  if (startDate) {
    invoiceParams.created = { gte: Math.floor(startDate / 1000) };
  }

  console.log(`[Stripe] Fetching invoices with params:`, invoiceParams);
  let invoiceCount = 0;
  let skippedInvoices = 0;
  const invoiceStatusCounts: Record<string, number> = {};
  let invoicesWithSubscription = 0;
  let invoicesPaid = 0;
  const eventTypeCounts: Record<string, number> = { first_payment: 0, renewal: 0, refund: 0 };
  
  for await (const invoice of stripe.invoices.list(invoiceParams)) {
    invoiceCount++;
    const invAny = invoice as any;
    const createdAt = (invoice.created || 0) * 1000;
    
    if (endDate && createdAt > endDate) {
      skippedInvoices++;
      continue;
    }
    
    const status = invoice.status || "unknown";
    invoiceStatusCounts[status] = (invoiceStatusCounts[status] || 0) + 1;

    // Extract subscription ID from parent.subscription_details.subscription (new Stripe format)
    let subscriptionId: string | null = null;
    const parentSub = invAny.parent?.subscription_details?.subscription;
    if (typeof parentSub === "string" && parentSub.length > 0) {
      subscriptionId = parentSub;
    }
    
    // Debug logging for first few invoices
    if (invoiceCount <= 5) {
      console.log(`[Stripe] Invoice #${invoiceCount}: id=${invoice.id}, status=${invoice.status}, billing_reason=${invAny.billing_reason}, extracted subId=${subscriptionId || "NULL"}, will_create_revenue=${subscriptionId && invoice.status === "paid" ? "YES" : "NO"}, amount_paid=${invAny.amount_paid}`);
    }
    
    if (subscriptionId) {
      invoicesWithSubscription++;
      
      // Only process paid invoices for revenue
      if (invoice.status === "paid") {
        invoicesPaid++;
        
        let eventType: "first_payment" | "renewal" | "refund" = "renewal";
        let amount = (invAny.amount_paid || 0) / 100;
        
        // Check if this is a refund (negative amount or specific billing reason)
        if (amount < 0 || invAny.billing_reason === "subscription_cycle" && invAny.amount_paid < 0) {
          eventType = "refund";
          amount = Math.abs(amount);
        } else if (invAny.billing_reason === "subscription_create") {
          eventType = "first_payment";
        }
        
        eventTypeCounts[eventType]++;
        
        revenueEvents.push({
          subscriptionExternalId: subscriptionId,
          eventType,
          amount,
          currency: invoice.currency || "usd",
          timestamp: createdAt,
          rawData: JSON.stringify(invoice),
        });
      }
    }
  }
  
  console.log(`[Stripe] Processed ${invoiceCount} invoices, created ${revenueEvents.length} revenue events, skipped ${skippedInvoices} by date`);
  console.log(`[Stripe] Event type breakdown: First Payments=${eventTypeCounts.first_payment}, Renewals=${eventTypeCounts.renewal}, Refunds=${eventTypeCounts.refund}`);
  console.log(`[Stripe] Revenue events summary - Total: ${revenueEvents.length}, Invoices with subscription: ${invoicesWithSubscription}, Paid invoices: ${invoicesPaid}`);

  // Fetch refunds/credit notes
  const refundParams: any = { limit: 100 };
  if (startDate) {
    refundParams.created = { gte: Math.floor(startDate / 1000) };
  }
  
  console.log(`[Stripe] Fetching refunds with params:`, refundParams);
  let refundCount = 0;
  
  try {
    for await (const refund of stripe.refunds.list(refundParams)) {
      const refundAny = refund as any;
      const refundedAt = (refund.created || 0) * 1000;
      
      if (endDate && refundedAt > endDate) continue;
      
      // Try to find the associated subscription from the charge/payment intent
      if (refundAny.charge) {
        try {
          const charge = await stripe.charges.retrieve(refundAny.charge);
          const chargeAny = charge as any;
          if (chargeAny.invoice) {
            const invoice = await stripe.invoices.retrieve(chargeAny.invoice);
            const invoiceAny = invoice as any;
            if (typeof invoiceAny.subscription === "string") {
              revenueEvents.push({
                subscriptionExternalId: invoiceAny.subscription,
                eventType: "refund",
                amount: (refund.amount || 0) / 100,
                currency: refund.currency || "usd",
                timestamp: refundedAt,
                rawData: JSON.stringify(refund),
              });
              refundCount++;
            }
          }
        } catch (e) {
          // Skip if we can't resolve the subscription
          console.log(`[Stripe] Could not resolve subscription for refund ${refund.id}`);
        }
      }
    }
  } catch (e) {
    console.log(`[Stripe] Error fetching refunds:`, e);
  }
  
  console.log(`[Stripe] Fetched ${refundCount} refunds`);

  const debug = {
    invoiceCount,
    skippedInvoices,
    invoiceStatusCounts,
    invoicesWithSubscription,
    invoicesPaid,
    refundCount,
    eventTypeCounts,
  } as const;

  return { subscriptions, revenueEvents, debug };
}

