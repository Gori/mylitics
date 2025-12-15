"use node";

import { action } from "../_generated/server";
import { v } from "convex/values";
import { google } from "googleapis";

/**
 * Google Play Developer API Integration
 * 
 * This module provides access to detailed subscription data via the Google Play Developer API.
 * Unlike GCS reports which provide aggregated statistics, this API gives user-level subscription details:
 * - Trial vs Paid status
 * - Base plan & offer details
 * - Payment state (success, failure, account hold)
 * - Auto-renewal status
 * - Price & currency
 * - Exact expiry times
 * 
 * This is designed to work WITHOUT purchase tokens (which would require app modifications).
 * Instead, it will be called on a schedule to poll subscription statuses.
 */

export interface SubscriptionDetails {
  purchaseToken: string;
  productId: string;
  basePlanId: string;
  offerId?: string;
  state: 'ACTIVE' | 'CANCELED' | 'IN_GRACE_PERIOD' | 'ON_HOLD' | 'PAUSED' | 'EXPIRED';
  startTime: string;
  expiryTime: string;
  autoRenewEnabled: boolean;
  priceCurrencyCode: string;
  priceAmountMicros: string;
  country: string;
  isTrial: boolean;
  isIntroductoryPricePeriod: boolean;
  acknowledgementState: 'ACKNOWLEDGED' | 'PENDING';
}

/**
 * Fetch subscription details for a specific purchase token
 * 
 * This is the core API call that retrieves detailed subscription information.
 * In a real implementation, you would maintain a list of purchase tokens to poll.
 */
export async function getSubscriptionDetails(
  serviceAccountJson: string,
  packageName: string,
  purchaseToken: string
): Promise<SubscriptionDetails | null> {
  try {
    const credentials = JSON.parse(serviceAccountJson);
    
    // Initialize Google Auth
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/androidpublisher'],
    });

    const androidPublisher = google.androidpublisher({ version: 'v3', auth });

    // Call purchases.subscriptionsv2.get
    const response = await androidPublisher.purchases.subscriptionsv2.get({
      packageName,
      token: purchaseToken,
    });

    const data = response.data as any;

    if (!data || !data.lineItems || data.lineItems.length === 0) {
      console.warn(`[Google Play API] No subscription data found for token ${purchaseToken.substring(0, 10)}...`);
      return null;
    }

    const lineItem = data.lineItems[0];
    const autoRenewingPlan = lineItem.autoRenewingPlan;
    const offerDetails = lineItem.offerDetails;

    // Determine if this is a trial or intro offer
    const isTrial = offerDetails?.offerTags?.includes('trial') || offerDetails?.basePlanId?.includes('trial') || false;
    const isIntroductoryPricePeriod = offerDetails?.offerTags?.includes('intro') || offerDetails?.offerId?.includes('intro') || false;

    return {
      purchaseToken,
      productId: lineItem.productId || '',
      basePlanId: offerDetails?.basePlanId || '',
      offerId: offerDetails?.offerId,
      state: mapSubscriptionState(data.subscriptionState),
      startTime: data.startTime || '',
      expiryTime: lineItem.expiryTime || '',
      autoRenewEnabled: autoRenewingPlan?.autoRenewEnabled || false,
      priceCurrencyCode: autoRenewingPlan?.recurringPrice?.currencyCode || 'USD',
      priceAmountMicros: autoRenewingPlan?.recurringPrice?.units || '0',
      country: data.regionCode || '',
      isTrial,
      isIntroductoryPricePeriod,
      acknowledgementState: data.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED' ? 'ACKNOWLEDGED' : 'PENDING',
    };
  } catch (error: any) {
    if (error.response?.status === 404) {
      console.log(`[Google Play API] Subscription not found for token ${purchaseToken.substring(0, 10)}... (expired or invalid)`);
      return null;
    }
    console.error(`[Google Play API] Error fetching subscription:`, error.message);
    throw error;
  }
}

/**
 * Map Google Play subscription states to our simplified states
 */
function mapSubscriptionState(state: string): SubscriptionDetails['state'] {
  switch (state) {
    case 'SUBSCRIPTION_STATE_ACTIVE':
      return 'ACTIVE';
    case 'SUBSCRIPTION_STATE_CANCELED':
      return 'CANCELED';
    case 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD':
      return 'IN_GRACE_PERIOD';
    case 'SUBSCRIPTION_STATE_ON_HOLD':
      return 'ON_HOLD';
    case 'SUBSCRIPTION_STATE_PAUSED':
      return 'PAUSED';
    case 'SUBSCRIPTION_STATE_EXPIRED':
      return 'EXPIRED';
    default:
      return 'EXPIRED';
  }
}

/**
 * Batch fetch subscription details for multiple tokens
 * 
 * This is useful for syncing all known subscriptions periodically.
 * Returns { success: SubscriptionDetails[], failed: string[] }
 */
export async function batchGetSubscriptionDetails(
  serviceAccountJson: string,
  packageName: string,
  purchaseTokens: string[]
): Promise<{ success: SubscriptionDetails[]; failed: string[] }> {
  const success: SubscriptionDetails[] = [];
  const failed: string[] = [];

  console.log(`[Google Play API] Fetching details for ${purchaseTokens.length} subscriptions`);

  for (const token of purchaseTokens) {
    try {
      const details = await getSubscriptionDetails(serviceAccountJson, packageName, token);
      if (details) {
        success.push(details);
      } else {
        failed.push(token);
      }
    } catch (error) {
      failed.push(token);
    }
  }

  console.log(`[Google Play API] Successfully fetched ${success.length} subscriptions, ${failed.length} failed`);

  return { success, failed };
}

/**
 * Convex action to fetch subscription details via Google Play Developer API
 * 
 * This can be called periodically to sync subscription statuses for known users.
 * NOTE: This requires maintaining a list of purchase tokens (from app events or previous syncs).
 */
export const fetchSubscriptionDetailsAction = action({
  args: {
    serviceAccountJson: v.string(),
    packageName: v.string(),
    purchaseToken: v.string(),
  },
  handler: async (ctx, { serviceAccountJson, packageName, purchaseToken }) => {
    return await getSubscriptionDetails(serviceAccountJson, packageName, purchaseToken);
  },
});

/**
 * Convex action to batch fetch subscription details
 */
export const batchFetchSubscriptionDetailsAction = action({
  args: {
    serviceAccountJson: v.string(),
    packageName: v.string(),
    purchaseTokens: v.array(v.string()),
  },
  handler: async (ctx, { serviceAccountJson, packageName, purchaseTokens }) => {
    return await batchGetSubscriptionDetails(serviceAccountJson, packageName, purchaseTokens);
  },
});

