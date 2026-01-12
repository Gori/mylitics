/**
 * Type definitions for Google Play report processing.
 */

export type RevenueData = {
  gross: number; // Charged amount (what customer paid, including VAT)
  net: number; // Item price (excluding VAT, but including platform fees)
  proceeds: number; // Developer proceeds (what you actually receive after VAT and platform fees)
  transactions: number;
};

export type SubscriptionMetrics = {
  active: number;
  trial: number;
  paid: number;
  monthly: number;
  yearly: number;
  newSubscriptions: number;
  canceledSubscriptions: number;
  renewals: number;
};

export type ReportType = "financial" | "subscription" | "statistics" | "unknown";

export interface ParsedReport {
  type: ReportType;
  fileName: string;
  revenueByDate?: Record<string, RevenueData>;
  subscriptionMetricsByDate?: Record<string, SubscriptionMetrics>;
  renewalsByDate?: Record<string, number>;
  refundsByDate?: Record<string, number>;
}

export interface GooglePlaySyncResult {
  revenueByDate: Record<string, RevenueData>;
  subscriptionMetricsByDate: Record<string, SubscriptionMetrics>;
  renewalsByDate: Record<string, number>;
  refundsByDate: Record<string, number>;
  discoveredReportTypes: string[];
}
