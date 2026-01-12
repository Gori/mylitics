"use node";

import { action } from "../_generated/server";
import { v } from "convex/values";
import Stripe from "stripe";
import { logError, getErrorMessage } from "../lib/errors";
import { STRIPE_API_LIMIT, CENTS_PER_DOLLAR } from "../lib/constants";

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
    // Extracted fields for efficient storage
    trialEnd?: number;
    priceAmount?: number;
    priceInterval?: string;
    priceCurrency?: string;
  }> = [];

  const revenueEvents: Array<{
    subscriptionExternalId: string;
    eventType: "first_payment" | "renewal" | "refund";
    amount: number; // Charged amount (including VAT)
    amountExcludingTax?: number; // Amount excluding VAT (only if Stripe Tax provided it)
    amountProceeds?: number; // Amount after Stripe fees (what you receive)
    currency: string;
    country?: string; // ISO country code
    timestamp: number;
    externalId: string; // Invoice ID for reference
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
    
    // Extract pricing from primary subscription item
    const primaryItem = subscription.items.data[0];
    const priceAmount = primaryItem?.price?.unit_amount ?? undefined;
    const priceInterval = primaryItem?.price?.recurring?.interval ?? undefined;
    const priceCurrency = primaryItem?.price?.currency ?? undefined;
    const trialEnd = subAny.trial_end ? subAny.trial_end * 1000 : undefined;
    
    subscriptions.push({
      externalId: subscription.id,
      customerId: subscription.customer as string,
      status: subscription.status,
      productId: primaryItem?.price.product as string,
      startDate: createdAt,
      endDate: endTimestamp,
      isTrial: subscription.status === "trialing",
      willCancel: subAny.cancel_at_period_end || false,
      trialEnd,
      priceAmount,
      priceInterval,
      priceCurrency,
    });
    subCount++;
  }
  
  console.log(`[Stripe] Fetched ${subCount} subscriptions`);

  const invoiceParams: any = { 
    limit: 100,
    // Expand payment_intent to get charge info for proceeds calculation
    expand: ["data.payment_intent", "data.charge"]
  };
  if (startDate) {
    invoiceParams.created = { gte: Math.floor(startDate / 1000) };
  }

  console.log(`[Stripe] Fetching invoices with params:`, invoiceParams);
  
  // STEP 1: Collect all invoices first (fast)
  const allInvoices: Stripe.Invoice[] = [];
  for await (const invoice of stripe.invoices.list(invoiceParams)) {
    allInvoices.push(invoice);
  }
  console.log(`[Stripe] Collected ${allInvoices.length} invoices, now processing proceeds in parallel...`);
  
  let invoiceCount = 0;
  let skippedInvoices = 0;
  const invoiceStatusCounts: Record<string, number> = {};
  let invoicesWithSubscription = 0;
  let invoicesPaid = 0;
  const eventTypeCounts: Record<string, number> = { first_payment: 0, renewal: 0, refund: 0 };
  
  // Debug counters for proceeds tracking
  let invoicesWithChargeField = 0;
  let invoicesWithPaymentIntent = 0;
  let invoicesWithProceeds = 0;
  let chargeRetrievalErrors = 0;
  let paymentIntentRetrievalErrors = 0;
  let invoicesWithNoPaymentPath = 0;
  let balanceTxIsString = 0;
  
  // STEP 2: Process invoices and identify which need proceeds fetching
  type PendingInvoice = {
    invoice: Stripe.Invoice;
    subscriptionId: string;
    eventTimestamp: number;
    amount: number;
    amountExcludingTax?: number;
    country?: string;
    eventType: "first_payment" | "renewal" | "refund";
    // For proceeds fetching
    chargeId?: string;
    needsProceedsFetch: boolean;
    amountProceeds?: number;
  };
  
  const pendingInvoices: PendingInvoice[] = [];
  
  for (const invoice of allInvoices) {
    invoiceCount++;
    const invAny = invoice as any;
    
    const paidAt = invAny.status_transitions?.paid_at;
    const eventTimestamp = paidAt ? paidAt * 1000 : (invoice.created || 0) * 1000;
    
    if (startDate && eventTimestamp < startDate) {
      skippedInvoices++;
      continue;
    }
    if (endDate && eventTimestamp > endDate) {
      skippedInvoices++;
      continue;
    }
    
    const status = invoice.status || "unknown";
    invoiceStatusCounts[status] = (invoiceStatusCounts[status] || 0) + 1;

    let subscriptionId: string | null = null;
    const parentSub = invAny.parent?.subscription_details?.subscription;
    if (typeof parentSub === "string" && parentSub.length > 0) {
      subscriptionId = parentSub;
    } else if (typeof invAny.subscription === "string" && invAny.subscription.length > 0) {
      subscriptionId = invAny.subscription;
    }
    
    if (invoiceCount <= 3) {
      console.log(`[Stripe] Invoice #${invoiceCount}: id=${invoice.id}, status=${invoice.status}, amount_paid=${invAny.amount_paid}, subId=${subscriptionId || "NULL"}`);
    }
    
    if (subscriptionId && invoice.status === "paid") {
      invoicesWithSubscription++;
      invoicesPaid++;
      
      let eventType: "first_payment" | "renewal" | "refund" = "renewal";
      let amount = (invAny.amount_paid || 0) / 100;
      let amountExcludingTax: number | undefined = invAny.total_excluding_tax != null 
        ? invAny.total_excluding_tax / 100 
        : undefined;
      
      let amountProceeds: number | undefined = undefined;
      let chargeId: string | undefined = undefined;
      let needsProceedsFetch = true;
      
      // Check if proceeds already available from expanded data
      if (invAny.charge && typeof invAny.charge === "object" && invAny.charge.id) {
        chargeId = invAny.charge.id;
        invoicesWithChargeField++;
        const btx = invAny.charge.balance_transaction;
        if (btx && typeof btx === "object" && btx.net !== undefined) {
          amountProceeds = btx.net / 100;
          invoicesWithProceeds++;
          needsProceedsFetch = false;
        }
      } else if (invAny.payment_intent && typeof invAny.payment_intent === "object") {
        invoicesWithPaymentIntent++;
        const piAny = invAny.payment_intent;
        if (piAny.latest_charge && typeof piAny.latest_charge === "object" && piAny.latest_charge.id) {
          chargeId = piAny.latest_charge.id;
          const btx = piAny.latest_charge.balance_transaction;
          if (btx && typeof btx === "object" && btx.net !== undefined) {
            amountProceeds = btx.net / 100;
            invoicesWithProceeds++;
            needsProceedsFetch = false;
          }
        }
      } else if (invAny.charge && typeof invAny.charge === "string") {
        chargeId = invAny.charge;
        invoicesWithChargeField++;
      } else if (invAny.payment_intent && typeof invAny.payment_intent === "string") {
        // Will need to fetch payment_intent
        invoicesWithPaymentIntent++;
      }
      
      const country = invAny.customer_address?.country || undefined;
      
      if (amount < 0 || (invAny.billing_reason === "subscription_cycle" && invAny.amount_paid < 0)) {
        eventType = "refund";
        amount = Math.abs(amount);
        if (amountExcludingTax !== undefined) amountExcludingTax = Math.abs(amountExcludingTax);
        if (amountProceeds !== undefined) amountProceeds = Math.abs(amountProceeds);
      } else if (invAny.billing_reason === "subscription_create") {
        eventType = "first_payment";
      }
      
      eventTypeCounts[eventType]++;
      
      pendingInvoices.push({
        invoice,
        subscriptionId,
        eventTimestamp,
        amount,
        amountExcludingTax,
        country,
        eventType,
        chargeId,
        needsProceedsFetch,
        amountProceeds,
      });
    }
  }
  
  console.log(`[Stripe] Found ${pendingInvoices.length} paid invoices, ${pendingInvoices.filter(p => p.needsProceedsFetch).length} need proceeds fetch`);
  
  // STEP 3: Fetch proceeds in parallel batches (10 concurrent requests)
  const BATCH_SIZE = 10;
  const needsProceedsFetch = pendingInvoices.filter(p => p.needsProceedsFetch);
  
  for (let i = 0; i < needsProceedsFetch.length; i += BATCH_SIZE) {
    const batch = needsProceedsFetch.slice(i, i + BATCH_SIZE);
    if (i % 100 === 0 && i > 0) {
      console.log(`[Stripe] Processing proceeds batch ${i}/${needsProceedsFetch.length}...`);
    }
    
    await Promise.all(batch.map(async (pending) => {
      const invAny = pending.invoice as any;
      let chargeId = pending.chargeId;
      let amountProceeds: number | undefined = undefined;
      
      // Try to get payment_intent ID
      let paymentIntentId: string | undefined = undefined;
      if (invAny.payment_intent && typeof invAny.payment_intent === "string") {
        paymentIntentId = invAny.payment_intent;
      }
      
      // Path: Use /v1/invoice_payments endpoint for newer Stripe API
      if (!chargeId && !paymentIntentId) {
        try {
          const resp = await fetch(`https://api.stripe.com/v1/invoice_payments?invoice=${pending.invoice.id}`, {
            headers: { "Authorization": `Bearer ${apiKey}` },
          });
          if (resp.ok) {
            const data = await resp.json() as any;
            if (data.data?.[0]?.payment?.payment_intent) {
              paymentIntentId = data.data[0].payment.payment_intent;
            }
          }
        } catch (error) {
          logError("stripe", "fetch invoice payments", error, { invoiceId: pending.invoice.id });
        }
      }
      
      // Fetch payment_intent to get charge
      if (paymentIntentId && !chargeId) {
        try {
          const pi = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ["latest_charge.balance_transaction"] });
          const piAny = pi as any;
          if (piAny.latest_charge?.id) {
            chargeId = piAny.latest_charge.id;
            if (piAny.latest_charge.balance_transaction?.net !== undefined) {
              amountProceeds = piAny.latest_charge.balance_transaction.net / 100;
              invoicesWithProceeds++;
              pending.amountProceeds = amountProceeds;
              pending.chargeId = chargeId;
              return;
            }
          }
        } catch (error) {
          paymentIntentRetrievalErrors++;
          logError("stripe", "retrieve payment intent", error, { paymentIntentId });
        }
      }
      
      // Fetch from charge if we have chargeId but no proceeds
      if (chargeId && amountProceeds === undefined) {
        try {
          const charge = await stripe.charges.retrieve(chargeId, { expand: ["balance_transaction"] });
          const btx = (charge as any).balance_transaction;
          if (btx && typeof btx === "object" && btx.net !== undefined) {
            amountProceeds = btx.net / 100;
            invoicesWithProceeds++;
          } else if (btx && typeof btx === "string") {
            balanceTxIsString++;
            const btxObj = await stripe.balanceTransactions.retrieve(btx);
            amountProceeds = btxObj.net / 100;
            invoicesWithProceeds++;
          }
        } catch (error) {
          chargeRetrievalErrors++;
          logError("stripe", "retrieve charge", error, { chargeId });
        }
      }
      
      pending.amountProceeds = amountProceeds;
      pending.chargeId = chargeId;
    }));
  }
  
  // STEP 4: Build final revenue events
  for (const pending of pendingInvoices) {
    if (invoicesPaid <= 5) {
      console.log(`[Stripe] Invoice ${pending.invoice.id}: amount=${pending.amount}, amountProceeds=${pending.amountProceeds ?? 'undefined'}, chargeId=${pending.chargeId || 'null'}`);
    }
    
    revenueEvents.push({
      subscriptionExternalId: pending.subscriptionId,
      eventType: pending.eventType,
      amount: pending.amount,
      amountExcludingTax: pending.amountExcludingTax,
      amountProceeds: pending.amountProceeds,
      currency: pending.invoice.currency || "usd",
      country: pending.country,
      timestamp: pending.eventTimestamp,
      externalId: pending.invoice.id,
    });
  }
  
  console.log(`[Stripe] Processed ${invoiceCount} invoices, created ${revenueEvents.length} revenue events, skipped ${skippedInvoices} by date`);
  console.log(`[Stripe] Event type breakdown: First Payments=${eventTypeCounts.first_payment}, Renewals=${eventTypeCounts.renewal}, Refunds=${eventTypeCounts.refund}`);
  console.log(`[Stripe] Revenue events summary - Total: ${revenueEvents.length}, Invoices with subscription: ${invoicesWithSubscription}, Paid invoices: ${invoicesPaid}`);
  console.log(`[Stripe] PROCEEDS DEBUG: invoicesWithChargeField=${invoicesWithChargeField}, invoicesWithPaymentIntent=${invoicesWithPaymentIntent}, invoicesWithProceeds=${invoicesWithProceeds}, chargeRetrievalErrors=${chargeRetrievalErrors}, piRetrievalErrors=${paymentIntentRetrievalErrors}, noPaymentPath=${invoicesWithNoPaymentPath}, balanceTxIsString=${balanceTxIsString}`);

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
              const refundAmount = (refund.amount || 0) / 100;
              // For refunds, try to get actual proceeds from balance transaction
              let refundProceeds: number | undefined = undefined;
              if (refundAny.balance_transaction) {
                try {
                  const balanceTx = await stripe.balanceTransactions.retrieve(refundAny.balance_transaction);
                  // For refunds, net is negative (money leaving your account)
                  refundProceeds = Math.abs((balanceTx.net || 0) / 100);
                } catch (e) {
                  // If we can't fetch, leave undefined
                }
              }
              revenueEvents.push({
                subscriptionExternalId: invoiceAny.subscription,
                eventType: "refund",
                amount: refundAmount,
                amountExcludingTax: refundAmount, // Refunds don't have separate tax-excluded amount
                amountProceeds: refundProceeds,
                currency: refund.currency || "usd",
                country: invoiceAny.customer_address?.country || undefined,
                timestamp: refundedAt,
                externalId: refund.id,
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

