"use node";

import { action } from "../_generated/server";
import { v } from "convex/values";
import { Storage } from "@google-cloud/storage";
import { google } from "googleapis";

// Types for different report data
type RevenueData = {
  gross: number;
  net: number;
  transactions: number;
};

type SubscriptionMetrics = {
  active: number;
  trial: number;
  paid: number;
  monthly: number;
  yearly: number;
  newSubscriptions: number;
  canceledSubscriptions: number;
  renewals: number;
};

type ReportType = "financial" | "subscription" | "statistics" | "unknown";

interface ParsedReport {
  type: ReportType;
  fileName: string;
  revenueByDate?: Record<string, RevenueData>;
  subscriptionMetricsByDate?: Record<string, SubscriptionMetrics>;
}

// Helper: Detect and decode CSV encoding (UTF-8 vs UTF-16)
function detectAndDecodeCSV(buffer: Buffer): string {
  // Check for UTF-16 BOM (Byte Order Mark)
  // UTF-16 LE BOM: FF FE
  // UTF-16 BE BOM: FE FF
  if (buffer.length >= 2) {
    if (buffer[0] === 0xFF && buffer[1] === 0xFE) {
      return buffer.toString('utf16le');
    }
    if (buffer[0] === 0xFE && buffer[1] === 0xFF) {
      // Node.js doesn't have utf16be, need to swap bytes
      const swapped = Buffer.alloc(buffer.length);
      for (let i = 0; i < buffer.length - 1; i += 2) {
        swapped[i] = buffer[i + 1];
        swapped[i + 1] = buffer[i];
      }
      return swapped.toString('utf16le');
    }
  }

  // Check for UTF-16 without BOM by detecting null bytes pattern
  // UTF-16 has null bytes between ASCII characters
  let nullCount = 0;
  const sampleSize = Math.min(200, buffer.length);
  for (let i = 0; i < sampleSize; i++) {
    if (buffer[i] === 0) nullCount++;
  }

  // If >30% null bytes, it's likely UTF-16
  if (nullCount / sampleSize > 0.3) {
    return buffer.toString('utf16le');
  }

  // Default to UTF-8
  return buffer.toString('utf-8');
}

export const fetchGooglePlayData = action({
  args: {
    serviceAccountJson: v.string(),
    packageName: v.string(),
    gcsBucketName: v.string(),
    gcsReportPrefix: v.optional(v.string()),
    startDate: v.optional(v.number()),
    endDate: v.optional(v.number()),
  },
  handler: async (ctx, { serviceAccountJson, packageName, gcsBucketName, gcsReportPrefix, startDate, endDate }) => {
    return await fetchGooglePlayFromGCS(
      serviceAccountJson,
      packageName,
      gcsBucketName,
      gcsReportPrefix || "",
      startDate,
      endDate
    );
  },
});

export async function fetchGooglePlayFromGCS(
  serviceAccountJson: string,
  packageName: string,
  gcsBucketName: string,
  gcsReportPrefix: string,
  startDate?: number,
  endDate?: number
) {
  const credentials = JSON.parse(serviceAccountJson);
  const storage = new Storage({ credentials });

  // Aggregated results
  const revenueByDate: Record<string, RevenueData> = {};
  const subscriptionMetricsByDate: Record<string, SubscriptionMetrics> = {};
  const discoveredReportTypes: Set<ReportType> = new Set();

  try {
    console.log(`[Google Play] Scanning bucket gs://${gcsBucketName}/${gcsReportPrefix || "(root)"}`);
    
    // Phase 1: Discover all CSV files in bucket
    const [allFiles] = await storage.bucket(gcsBucketName).getFiles({
      prefix: gcsReportPrefix,
    });

    // Filter for CSV files matching our package name
    const csvFiles = allFiles.filter(file => {
      const name = file.name.toLowerCase();
      const packageVariants = [
        packageName.toLowerCase(),
        packageName.toLowerCase().replace(/\./g, '_'),
        packageName.toLowerCase().replace(/\./g, '')
      ];
      return name.endsWith('.csv') && packageVariants.some(variant => name.includes(variant));
    });

    if (csvFiles.length === 0) {
      console.warn(`[Google Play GCS] No reports found for ${packageName}`);
      return { revenueByDate, subscriptionMetricsByDate, discoveredReportTypes: Array.from(discoveredReportTypes) };
    }

    console.log(`[Google Play GCS] Processing ${csvFiles.length} reports for ${packageName}`);

    // Phase 2: Categorize files by path patterns
    const categorizedFiles: Record<ReportType, typeof csvFiles> = {
      financial: [],
      subscription: [],
      statistics: [],
      unknown: []
    };

    for (const file of csvFiles) {
      const name = file.name.toLowerCase();
      const path = file.name.toLowerCase();
      
      // PRIORITY 1: Subscription metrics (check first, more specific)
      if (
        name.includes('subscription') ||
        name.includes('subscriber') ||
        path.includes('/subscriptions/') ||
        path.includes('/stats_subscriptions') ||
        path.includes('financial-stats/subscriptions')
      ) {
        categorizedFiles.subscription.push(file);
      }
      // PRIORITY 2: Financial/earnings (revenue data)
      else if (
        name.includes('earning') || 
        name.includes('sales') ||
        name.includes('estimated') ||
        path.includes('/earnings/')
      ) {
        categorizedFiles.financial.push(file);
      }
      // PRIORITY 3: Statistics
      else if (
        name.includes('statistic') ||
        name.includes('stats') ||
        path.includes('/statistics/')
      ) {
        categorizedFiles.statistics.push(file);
      }
      // PRIORITY 4: Unknown
      else {
        categorizedFiles.unknown.push(file);
      }
    }

    console.log(`[Google Play GCS] Reports: ${categorizedFiles.subscription.length} subscription, ${categorizedFiles.financial.length} financial`);

    // Phase 3: Process each category
    const parsedReports: ParsedReport[] = [];

    // Process subscription reports first (they provide the most valuable metrics)
    for (const file of categorizedFiles.subscription) {
      try {
        const [contents] = await file.download();
        const csvContent = detectAndDecodeCSV(contents);
        
        const parsed = await parseSubscriptionReportCSV(csvContent, file.name, startDate, endDate);
        if (parsed) {
          parsedReports.push(parsed);
          discoveredReportTypes.add(parsed.type);
        }
      } catch (error) {
        console.error(`[Google Play GCS] Error processing ${file.name}:`, error);
      }
    }

    // Process financial reports
    for (const file of categorizedFiles.financial) {
      try {
        const [contents] = await file.download();
        const csvContent = detectAndDecodeCSV(contents);
        
        const parsed = await parseFinancialReportCSV(csvContent, file.name, startDate, endDate);
        if (parsed) {
          parsedReports.push(parsed);
          discoveredReportTypes.add(parsed.type);
        }
      } catch (error) {
        console.error(`[Google Play GCS] Error processing ${file.name}:`, error);
      }
    }

    // Phase 4: Merge all parsed data

    for (const report of parsedReports) {
      // Merge revenue data
      if (report.revenueByDate) {
        for (const [date, data] of Object.entries(report.revenueByDate)) {
          if (!revenueByDate[date]) {
            revenueByDate[date] = { gross: 0, net: 0, transactions: 0 };
          }
          revenueByDate[date].gross += data.gross;
          revenueByDate[date].net += data.net;
          revenueByDate[date].transactions += data.transactions;
        }
      }

      // Merge subscription metrics
      if (report.subscriptionMetricsByDate) {
        for (const [date, metrics] of Object.entries(report.subscriptionMetricsByDate)) {
          if (!subscriptionMetricsByDate[date]) {
            subscriptionMetricsByDate[date] = {
              active: 0,
              trial: 0,
              paid: 0,
              monthly: 0,
              yearly: 0,
              newSubscriptions: 0,
              canceledSubscriptions: 0,
              renewals: 0,
            };
          }
          // Use max values for stock metrics (active, trial, paid)
          subscriptionMetricsByDate[date].active = Math.max(
            subscriptionMetricsByDate[date].active,
            metrics.active
          );
          subscriptionMetricsByDate[date].trial = Math.max(
            subscriptionMetricsByDate[date].trial,
            metrics.trial
          );
          subscriptionMetricsByDate[date].paid = Math.max(
            subscriptionMetricsByDate[date].paid,
            metrics.paid
          );
          subscriptionMetricsByDate[date].monthly = Math.max(
            subscriptionMetricsByDate[date].monthly,
            metrics.monthly
          );
          subscriptionMetricsByDate[date].yearly = Math.max(
            subscriptionMetricsByDate[date].yearly,
            metrics.yearly
          );
          // Sum flow metrics
          subscriptionMetricsByDate[date].newSubscriptions += metrics.newSubscriptions;
          subscriptionMetricsByDate[date].canceledSubscriptions += metrics.canceledSubscriptions;
          subscriptionMetricsByDate[date].renewals += metrics.renewals;
        }
      }
    }

    // Phase 5: Log summary
    console.log(`[Google Play Summary] Discovered report types: ${Array.from(discoveredReportTypes).join(', ')}`);
    console.log(`[Google Play Summary] Dates with revenue data: ${Object.keys(revenueByDate).length}`);
    console.log(`[Google Play Summary] Dates with subscription metrics: ${Object.keys(subscriptionMetricsByDate).length}`);

    if (Object.keys(revenueByDate).length > 0) {
      const totalGross = Object.values(revenueByDate).reduce((sum, d) => sum + d.gross, 0);
      const totalNet = Object.values(revenueByDate).reduce((sum, d) => sum + d.net, 0);
      console.log(`[Google Play Summary] Total revenue - Gross: $${totalGross.toFixed(2)}, Net: $${totalNet.toFixed(2)}`);
    }

    if (Object.keys(subscriptionMetricsByDate).length > 0) {
      const latestDate = Object.keys(subscriptionMetricsByDate).sort().pop();
      if (latestDate) {
        const latest = subscriptionMetricsByDate[latestDate];
        console.log(`[Google Play Summary] Latest subscription metrics (${latestDate}): Active=${latest.active}, Trial=${latest.trial}, Paid=${latest.paid}`);
      }
    }

    return { 
      revenueByDate, 
      subscriptionMetricsByDate, 
      discoveredReportTypes: Array.from(discoveredReportTypes) 
    };
  } catch (error) {
    console.error(`[Google Play] Error accessing GCS bucket:`, error);
    throw new Error(`Failed to access GCS bucket: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Parse subscription-specific reports
async function parseSubscriptionReportCSV(
  csvContent: string,
  fileName: string,
  startDate?: number,
  endDate?: number
): Promise<ParsedReport | null> {
  const subscriptionMetricsByDate: Record<string, SubscriptionMetrics> = {};

  try {
    const lines = csvContent.trim().split(/\r?\n/);
    if (lines.length < 2) {
      console.log(`[Google Play Subscription CSV] Empty CSV - no data in ${fileName}`);
      return null;
    }

    const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/"/g, ''));
    // Detect column headers (removed verbose logging)

    const findColumnIndex = (possibleNames: string[]): number => {
      return headers.findIndex(h => 
        possibleNames.some(name => h.includes(name))
      );
    };

    // Look for subscription-specific columns
    const dateIdx = findColumnIndex(['date', 'period', 'day', 'month']);
    const activeIdx = findColumnIndex(['active subscriptions', 'active subs', 'current subscribers']);
    const newIdx = findColumnIndex(['new subscriptions', 'new subs', 'subscriptions started']);
    const canceledIdx = findColumnIndex(['canceled subscriptions', 'cancelled', 'churned']);
    const trialIdx = findColumnIndex(['trial', 'free trial', 'trial subscriptions']);
    const monthlyIdx = findColumnIndex(['monthly subscriptions', 'monthly subs', 'monthly plan']);
    const yearlyIdx = findColumnIndex(['yearly subscriptions', 'annual subscriptions', 'yearly plan']);
    const renewalsIdx = findColumnIndex(['renewals', 'renewed', 'subscription renewals']);

    // Column indices detected (removed verbose logging)

    if (dateIdx < 0) {
      console.warn(`[Google Play Subscription CSV] No date column found in ${fileName}`);
      return null;
    }

    // If no subscription columns found, this might not be a subscription report
    if (activeIdx < 0 && newIdx < 0 && canceledIdx < 0) {
      console.log(`[Google Play Subscription CSV] No subscription metrics columns found in ${fileName}`);
      return null;
    }

    // Parse data rows
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const cols = parseCSVLine(line);
      const dateStr = cols[dateIdx]?.replace(/"/g, '').trim();
      if (!dateStr) continue;

      const date = parseDateString(dateStr, startDate, endDate);
      if (!date) continue;

      if (!subscriptionMetricsByDate[date]) {
        subscriptionMetricsByDate[date] = {
          active: 0,
          trial: 0,
          paid: 0,
          monthly: 0,
          yearly: 0,
          newSubscriptions: 0,
          canceledSubscriptions: 0,
          renewals: 0,
        };
      }

      // Extract metrics (aggregate across rows for same date - e.g. multi-country breakdown)
      if (activeIdx >= 0) {
        subscriptionMetricsByDate[date].active += parseNumber(cols[activeIdx]);
      }
      if (newIdx >= 0) {
        subscriptionMetricsByDate[date].newSubscriptions += parseNumber(cols[newIdx]);
      }
      if (canceledIdx >= 0) {
        subscriptionMetricsByDate[date].canceledSubscriptions += parseNumber(cols[canceledIdx]);
      }
      if (trialIdx >= 0) {
        subscriptionMetricsByDate[date].trial += parseNumber(cols[trialIdx]);
      }
      if (monthlyIdx >= 0) {
        subscriptionMetricsByDate[date].monthly += parseNumber(cols[monthlyIdx]);
      }
      if (yearlyIdx >= 0) {
        subscriptionMetricsByDate[date].yearly += parseNumber(cols[yearlyIdx]);
      }
      if (renewalsIdx >= 0) {
        subscriptionMetricsByDate[date].renewals += parseNumber(cols[renewalsIdx]);
      }

      // Calculate paid = active - trial (if we have both)
      if (subscriptionMetricsByDate[date].active > 0 && subscriptionMetricsByDate[date].trial > 0) {
        subscriptionMetricsByDate[date].paid = Math.max(
          0,
          subscriptionMetricsByDate[date].active - subscriptionMetricsByDate[date].trial
        );
      }
    }


    return {
      type: "subscription",
      fileName,
      subscriptionMetricsByDate,
    };
  } catch (error) {
    console.error(`[Google Play Subscription CSV] Error parsing ${fileName}:`, error);
    return null;
  }
}

// Parse financial/earnings reports
async function parseFinancialReportCSV(
  csvContent: string,
  fileName: string,
  startDate?: number,
  endDate?: number
): Promise<ParsedReport | null> {
  const revenueByDate: Record<string, RevenueData> = {};

  try {
    const lines = csvContent.trim().split(/\r?\n/);
    if (lines.length < 2) {
      console.log(`[Google Play Financial CSV] Empty CSV - no data in ${fileName}`);
      return null;
    }

    const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/"/g, ''));
    // Detect headers

    const findColumnIndex = (possibleNames: string[]): number => {
      return headers.findIndex(h => 
        possibleNames.some(name => h.includes(name))
      );
    };

    const dateIdx = findColumnIndex(['transaction date', 'order charged date', 'charged date', 'date', 'day']);
    const grossIdx = findColumnIndex(['amount (merchant currency)', 'charged amount', 'item price', 'gross']);
    const netIdx = findColumnIndex(['developer proceeds', 'payouts', 'earnings', 'net']);
    const transactionTypeIdx = findColumnIndex(['transaction type', 'type', 'product type']);


    if (dateIdx < 0) {
      console.warn(`[Google Play Financial CSV] No date column found in ${fileName}`);
      return null;
    }

    // Parse data rows
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const cols = parseCSVLine(line);
      const dateStr = cols[dateIdx]?.replace(/"/g, '').trim();
      if (!dateStr) continue;

      const date = parseDateString(dateStr, startDate, endDate);
      if (!date) continue;

      let gross = 0;
      let net = 0;

      if (grossIdx >= 0) {
        gross = parseNumber(cols[grossIdx]);
      }
      if (netIdx >= 0) {
        net = parseNumber(cols[netIdx]);
      }

      // Estimate missing value (Google takes ~15% cut)
      if (gross > 0 && net === 0) {
        net = gross * 0.85;
      } else if (net > 0 && gross === 0) {
        gross = net / 0.85;
      }

      if (!revenueByDate[date]) {
        revenueByDate[date] = { gross: 0, net: 0, transactions: 0 };
      }

      revenueByDate[date].gross += gross;
      revenueByDate[date].net += net;
      revenueByDate[date].transactions += 1;
    }


    return {
      type: "financial",
      fileName,
      revenueByDate,
    };
  } catch (error) {
    console.error(`[Google Play Financial CSV] Error parsing ${fileName}:`, error);
    return null;
  }
}

// Try to parse unknown files by detecting schema
async function parseUnknownReportCSV(
  csvContent: string,
  fileName: string,
  startDate?: number,
  endDate?: number
): Promise<ParsedReport | null> {
  try {
    const lines = csvContent.trim().split(/\r?\n/);
    if (lines.length < 2) return null;

    const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/"/g, ''));
    
    // Check if it looks like a subscription report
    const hasSubscriptionColumns = headers.some(h => 
      h.includes('subscription') || h.includes('active') || h.includes('subscriber')
    );

    // Check if it looks like a financial report
    const hasFinancialColumns = headers.some(h => 
      h.includes('earning') || h.includes('revenue') || h.includes('proceeds') || h.includes('amount')
    );

    console.log(`[Google Play Unknown CSV] Detecting ${fileName} - Subscription: ${hasSubscriptionColumns}, Financial: ${hasFinancialColumns}`);

    if (hasSubscriptionColumns) {
      return await parseSubscriptionReportCSV(csvContent, fileName, startDate, endDate);
    } else if (hasFinancialColumns) {
      return await parseFinancialReportCSV(csvContent, fileName, startDate, endDate);
    }

    console.log(`[Google Play Unknown CSV] Could not determine type for ${fileName}`);
    return null;
  } catch (error) {
    console.error(`[Google Play Unknown CSV] Error detecting type for ${fileName}:`, error);
    return null;
  }
}

// Helper: Parse CSV line handling quoted fields
function parseCSVLine(line: string): string[] {
  const cols: string[] = [];
  let currentField = '';
  let inQuotes = false;

  for (let j = 0; j < line.length; j++) {
    const char = line[j];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      cols.push(currentField.trim());
      currentField = '';
    } else {
      currentField += char;
    }
  }
  cols.push(currentField.trim());
  return cols;
}

// Helper: Parse number from string
function parseNumber(str: string | undefined): number {
  if (!str) return 0;
  const cleaned = str.replace(/[",\s]/g, '');
  return parseFloat(cleaned) || 0;
}

// Helper: Parse date string to YYYY-MM-DD
function parseDateString(dateStr: string, startDate?: number, endDate?: number): string | null {
  if (!dateStr) return null;

  let dateMs: number;
  try {
    if (dateStr.includes('-')) {
      dateMs = new Date(dateStr).getTime();
    } else if (dateStr.includes('/')) {
      const parts = dateStr.split('/');
      if (parts.length === 3) {
        const mm = parseInt(parts[0]);
        const dd = parseInt(parts[1]);
        const yyyy = parseInt(parts[2]);
        if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
          dateMs = new Date(yyyy, mm - 1, dd).getTime();
        } else {
          return null;
        }
      } else {
        return null;
      }
    } else {
      return null;
    }
  } catch (error) {
    return null;
  }

  if (isNaN(dateMs)) return null;
  if (startDate && dateMs < startDate) return null;
  if (endDate && dateMs > endDate) return null;

  return new Date(dateMs).toISOString().split('T')[0];
}
