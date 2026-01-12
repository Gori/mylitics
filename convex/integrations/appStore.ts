"use node";

import { action } from "../_generated/server";
import { v } from "convex/values";
import { AppStoreServerAPIClient, Environment, SignedDataVerifier } from "@apple/app-store-server-library";
import jwt from "jsonwebtoken";
import zlib from "zlib";

export const fetchAppStoreData = action({
  args: {
    issuerId: v.string(),
    keyId: v.string(),
    bundleId: v.string(),
    privateKey: v.string(),
  },
  handler: async (ctx, { issuerId, keyId, bundleId, privateKey }) => {
    return await fetchAppStore(issuerId, keyId, bundleId, privateKey);
  },
});

export async function fetchAppStore(
  issuerId: string,
  keyId: string,
  bundleId: string,
  privateKey: string
) {
  const client = new AppStoreServerAPIClient(
    privateKey,
    keyId,
    issuerId,
    bundleId,
    Environment.PRODUCTION
  );

  const subscriptions: Array<{
    externalId: string;
    customerId: string;
    status: string;
    productId: string;
    startDate: number;
    endDate?: number;
    isTrial: boolean;
    willCancel: boolean;
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

  // See note in handler: requires transaction IDs from notifications

  return { subscriptions, revenueEvents };
}

export const decodeAppStoreNotification = action({
  args: {
    signedPayload: v.string(),
    bundleId: v.optional(v.string()),
    appAppleId: v.optional(v.number()),
  },
  handler: async (ctx, { signedPayload, bundleId, appAppleId }) => {
    // SignedDataVerifier constructor:
    // - appleRootCAs: Empty array means it will fetch Apple's root CAs online
    // - enableOnlineChecks: true enables OCSP checks and fetching root CAs
    // - environment: PRODUCTION for live app notifications
    // - bundleId: Required for validation (use empty string if unknown, will be extracted from payload)
    // - appAppleId: Optional app ID for additional validation
    const verifier = new SignedDataVerifier(
      [], // Empty array - will fetch Apple root CAs via online checks
      true, // Enable online checks (fetches Apple root CAs and OCSP validation)
      Environment.PRODUCTION,
      bundleId || "", // Bundle ID for validation (can be empty, extracted from payload)
      appAppleId // Optional: App Apple ID for additional validation
    );

    try {
      const decoded = await verifier.verifyAndDecodeNotification(signedPayload);
      return decoded;
    } catch (error) {
      // Log verification errors for debugging
      console.error("[App Store] Notification verification failed:", error);
      throw new Error(`App Store notification verification failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
});

// App Store Connect: minimal endpoints to fetch vendor numbers and download subscription reports
export const listVendors = action({
  args: {
    issuerId: v.string(),
    keyId: v.string(),
    privateKey: v.string(),
  },
  handler: async (ctx, { issuerId, keyId, privateKey }) => {
    const token = createASCJWT(issuerId, keyId, privateKey);
    const res = await fetch("https://api.appstoreconnect.apple.com/v1/salesReports?filter[reportType]=VENDOR&filter[reportSubType]=SUMMARY&filter[frequency]=DAILY&filter[vendorNumber]=000000", {
      headers: { Authorization: `Bearer ${token}` },
    });
    // The ASC Sales API requires a vendorNumber; typically retrieved via Finance reports UI.
    // For simplicity, return 403/400 text so user can provide vendorNumber.
    return { status: res.status, text: await res.text() };
  },
});

export const downloadSubscriptionSummary = action({
  args: {
    issuerId: v.string(),
    keyId: v.string(),
    privateKey: v.string(),
    vendorNumber: v.string(),
    reportDate: v.string(), // YYYY-MM-DD
    frequency: v.optional(v.string()), // DAILY default
    version: v.optional(v.string()), // e.g. 1_4
  },
  handler: async (ctx, { issuerId, keyId, privateKey, vendorNumber, reportDate, frequency = "DAILY", version = "1_4" }) => {
    return await downloadASCSubscriptionSummary(issuerId, keyId, privateKey, vendorNumber, reportDate, frequency, version);
  },
});

// SUBSCRIPTION_EVENT report - actual events (Subscribe, Cancel, Conversion)
export const downloadSubscriptionEventReport = action({
  args: {
    issuerId: v.string(),
    keyId: v.string(),
    privateKey: v.string(),
    vendorNumber: v.string(),
    reportDate: v.string(), // YYYY-MM-DD
    frequency: v.optional(v.string()), // DAILY default
    version: v.optional(v.string()), // e.g. 1_3
  },
  handler: async (ctx, { issuerId, keyId, privateKey, vendorNumber, reportDate, frequency = "DAILY", version = "1_3" }) => {
    return await downloadASCSubscriptionEventReport(issuerId, keyId, privateKey, vendorNumber, reportDate, frequency, version);
  },
});

export const downloadHistoricalReports = action({
  args: {
    issuerId: v.string(),
    keyId: v.string(),
    privateKey: v.string(),
    vendorNumber: v.string(),
    startDate: v.string(), // YYYY-MM-DD
    endDate: v.string(), // YYYY-MM-DD
  },
  handler: async (ctx, { issuerId, keyId, privateKey, vendorNumber, startDate, endDate }) => {
    const reports: Array<{ date: string; content: string }> = [];
    const start = new Date(startDate);
    const end = new Date(endDate);
    
    for (let date = new Date(start); date <= end; date.setDate(date.getDate() + 1)) {
      const dateStr = date.toISOString().split("T")[0];
      const result = await downloadASCSubscriptionSummary(
        issuerId,
        keyId,
        privateKey,
        vendorNumber,
        dateStr,
        "DAILY"
      );
      
      if (result.ok) {
        reports.push({ date: dateStr, content: result.tsv });
      }
    }
    
    return reports;
  },
});

function normalizePEMKey(key: string): string {
  // Remove any existing newlines and whitespace
  let normalized = key.replace(/\r?\n|\r/g, "").trim();
  
  // If the key doesn't have headers, it's likely raw base64
  if (!normalized.includes("BEGIN") && !normalized.includes("END")) {
    normalized = `-----BEGIN PRIVATE KEY-----\n${normalized}\n-----END PRIVATE KEY-----`;
  }
  
  // Add proper newlines to PEM format
  normalized = normalized
    .replace(/-----BEGIN PRIVATE KEY-----/g, "-----BEGIN PRIVATE KEY-----\n")
    .replace(/-----END PRIVATE KEY-----/g, "\n-----END PRIVATE KEY-----")
    .replace(/-----BEGIN EC PRIVATE KEY-----/g, "-----BEGIN EC PRIVATE KEY-----\n")
    .replace(/-----END EC PRIVATE KEY-----/g, "\n-----END EC PRIVATE KEY-----");
  
  // Add newlines every 64 characters in the body
  const lines = normalized.split("\n");
  const result = [];
  
  for (const line of lines) {
    if (line.includes("BEGIN") || line.includes("END")) {
      result.push(line);
    } else if (line.length > 64) {
      // Split long lines into 64-char chunks
      for (let i = 0; i < line.length; i += 64) {
        result.push(line.substring(i, i + 64));
      }
    } else if (line.length > 0) {
      result.push(line);
    }
  }
  
  return result.join("\n");
}

function createASCJWT(issuerId: string, keyId: string, privateKey: string) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: issuerId,
    aud: "appstoreconnect-v1",
    iat: now,
    exp: now + 60 * 2,
  } as const;
  
  const normalizedKey = normalizePEMKey(privateKey);
  
  return jwt.sign(payload, normalizedKey, { algorithm: "ES256", keyid: keyId });
}

async function downloadASCReport(
  issuerId: string,
  keyId: string,
  privateKey: string,
  vendorNumber: string,
  reportDate: string,
  reportType: string,
  reportSubType: string,
  frequency: string = "DAILY",
  version: string = "1_4",
) {
  const token = createASCJWT(issuerId, keyId, privateKey);
  const params = new URLSearchParams({
    'filter[reportType]': reportType,
    'filter[reportSubType]': reportSubType,
    'filter[frequency]': frequency,
    'filter[vendorNumber]': vendorNumber,
    'filter[reportDate]': reportDate,
    'filter[version]': version,
  });
  const url = `https://api.appstoreconnect.apple.com/v1/salesReports?${params.toString()}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const text = await res.text();
    const wwwAuth = res.headers.get("www-authenticate") || null;
    const requestId = res.headers.get("x-request-id") || null;
    // Only log non-404 errors (404s are common for recent dates due to Apple reporting delay)
    if (res.status !== 404) {
      console.log(`[App Store API] HTTP ${res.status} error for ${reportType}/${reportSubType} ${reportDate}`);
    }
    return { ok: false, status: res.status, text, wwwAuth, requestId } as const;
  }
  const gz = Buffer.from(await res.arrayBuffer());
  const tsv = zlib.gunzipSync(gz).toString("utf-8");
  return { ok: true, tsv } as const;
}

export async function downloadASCSubscriptionSummary(
  issuerId: string,
  keyId: string,
  privateKey: string,
  vendorNumber: string,
  reportDate: string,
  frequency: string = "DAILY",
  version: string = "1_4",
) {
  return downloadASCReport(issuerId, keyId, privateKey, vendorNumber, reportDate, "SUBSCRIPTION", "SUMMARY", frequency, version);
}

export async function downloadASCSubscriberReport(
  issuerId: string,
  keyId: string,
  privateKey: string,
  vendorNumber: string,
  reportDate: string,
  frequency: string = "DAILY",
  version: string = "1_3",
) {
  return downloadASCReport(issuerId, keyId, privateKey, vendorNumber, reportDate, "SUBSCRIBER", "DETAILED", frequency, version);
}

// SUBSCRIPTION_EVENT report - contains actual subscription events (Subscribe, Cancel, etc.)
export async function downloadASCSubscriptionEventReport(
  issuerId: string,
  keyId: string,
  privateKey: string,
  vendorNumber: string,
  reportDate: string,
  frequency: string = "DAILY",
  version: string = "1_3",
) {
  return downloadASCReport(issuerId, keyId, privateKey, vendorNumber, reportDate, "SUBSCRIPTION_EVENT", "SUMMARY", frequency, version);
}

