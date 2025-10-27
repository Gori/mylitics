"use node";

import { action } from "../_generated/server";
import { v } from "convex/values";
import { google } from "googleapis";

export const fetchGooglePlayData = action({
  args: {
    serviceAccountJson: v.string(),
    packageName: v.string(),
    startDate: v.optional(v.number()),
    endDate: v.optional(v.number()),
  },
  handler: async (ctx, { serviceAccountJson, packageName, startDate, endDate }) => {
    return await fetchGoogle(serviceAccountJson, packageName, startDate, endDate);
  },
});

export async function fetchGoogle(
  serviceAccountJson: string,
  packageName: string,
  startDate?: number,
  endDate?: number
) {
  const credentials = JSON.parse(serviceAccountJson);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/androidpublisher"],
  });

  const androidpublisher = google.androidpublisher({
    version: "v3",
    auth,
  });

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

  try {
    const productsResponse = await androidpublisher.monetization.subscriptions.list({
      packageName,
    });

    const products = productsResponse.data.subscriptions || [];

    for (const product of products) {
      const productId = product.productId;
      if (!productId) continue;

      // Placeholder: fill from purchases API when tokens available
    }
  } catch (error) {
    console.error("Error fetching Google Play data:", error);
  }

  return { subscriptions, revenueEvents };
}

