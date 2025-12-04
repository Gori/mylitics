"use node";

import { action } from "../_generated/server";
import { v } from "convex/values";
import { Storage } from "@google-cloud/storage";
import { google } from "googleapis";
import AdmZip from "adm-zip";

// Types for different report data
type RevenueData = {
  gross: number; // Charged amount (what customer paid, including VAT)
  net: number; // Item price (excluding VAT, but including platform fees)
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

  // Track revenue by source for debugging duplicate counting
  const revenueBySource: Record<string, { gross: number; net: number; transactions: number; dates: number }> = {};
  
  try {
    console.log(`[Google Play] Scanning bucket gs://${gcsBucketName}/${gcsReportPrefix || "(root)"}`);
    
    // Phase 1: Discover all CSV files in bucket
    const [allFiles] = await storage.bucket(gcsBucketName).getFiles({
      prefix: gcsReportPrefix,
    });

    // DEBUG: Log all files found in bucket
    console.log(`[Google Play DEBUG] Total files in bucket: ${allFiles.length}`);
    const allCsvFiles = allFiles.filter(f => f.name.toLowerCase().endsWith('.csv'));
    const allZipFiles = allFiles.filter(f => f.name.toLowerCase().endsWith('.zip'));
    console.log(`[Google Play DEBUG] All CSV files: ${allCsvFiles.length}, All ZIP files: ${allZipFiles.length}`);
    
    // Log file counts by folder (summary only)
    const filesByFolder: Record<string, number> = {};
    for (const file of allFiles) {
      const folder = file.name.split('/')[0] || '(root)';
      filesByFolder[folder] = (filesByFolder[folder] || 0) + 1;
    }
    const folderSummary = Object.entries(filesByFolder).map(([f, c]) => `${f}:${c}`).join(', ');
    console.log(`[Google Play DEBUG] Files by folder: ${folderSummary}`);

    // Filter for CSV files matching our package name OR in special folders (earnings, sales)
    const packageVariants = [
      packageName.toLowerCase(),
      packageName.toLowerCase().replace(/\./g, '_'),
      packageName.toLowerCase().replace(/\./g, '')
    ];
    
    console.log(`[Google Play DEBUG] Looking for package variants: ${packageVariants.join(', ')}`);
    
    // Filter for CSV files matching package name
    const csvFiles = allFiles.filter(file => {
      const name = file.name.toLowerCase();
      return name.endsWith('.csv') && packageVariants.some(variant => name.includes(variant));
    });
    
    // DEBUG: Log matched CSV files (summary only to avoid log overflow)
    console.log(`[Google Play DEBUG] CSV files matching package name: ${csvFiles.length} files`);
    
    // Get ZIP files from earnings/ and sales/ folders
    // We need to understand which contains the actual revenue data
    const zipFiles = allFiles.filter(file => {
      const path = file.name.toLowerCase();
      const isEarnings = path.includes('earnings/') || path.startsWith('earnings/');
      const isSales = path.includes('sales/') || path.startsWith('sales/');
      return (isEarnings || isSales) && path.endsWith('.zip');
    });
    
    // DEBUG: Log ZIP files by source
    const earningsZips = zipFiles.filter(f => f.name.toLowerCase().includes('earnings/'));
    const salesZips = zipFiles.filter(f => f.name.toLowerCase().includes('sales/'));
    console.log(`[Google Play DEBUG] ZIP files: ${earningsZips.length} from earnings/, ${salesZips.length} from sales/`);
    earningsZips.slice(0, 3).forEach(f => console.log(`  earnings: ${f.name}`));
    salesZips.slice(0, 3).forEach(f => console.log(`  sales: ${f.name}`));

    if (csvFiles.length === 0 && zipFiles.length === 0) {
      console.warn(`[Google Play GCS] No reports found for ${packageName}`);
      return { revenueByDate, subscriptionMetricsByDate, discoveredReportTypes: Array.from(discoveredReportTypes) };
    }

    // Log breakdown of file types found
    console.log(`[Google Play GCS] Found ${csvFiles.length} CSV files (package match), ${zipFiles.length} ZIP files (earnings + sales)`);

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
      
      // Check folder patterns (with or without leading slash)
      const isInEarnings = path.includes('earnings/') || path.startsWith('earnings/');
      const isInSales = path.includes('sales/') || path.startsWith('sales/');
      
      // PRIORITY 1: Earnings folder (highest priority - contains actual revenue transactions)
      if (isInEarnings) {
        categorizedFiles.financial.push(file);
      }
      // PRIORITY 2: Sales folder (also revenue data)
      else if (isInSales) {
        categorizedFiles.financial.push(file);
      }
      // PRIORITY 3: Subscription stats (active subscriber counts)
      else if (
        name.includes('subscription') ||
        name.includes('subscriber') ||
        path.includes('subscriptions/') ||
        path.includes('stats_subscriptions') ||
        path.includes('financial-stats/subscriptions')
      ) {
        categorizedFiles.subscription.push(file);
      }
      // PRIORITY 4: Other financial files
      else if (
        name.includes('earning') || 
        name.includes('estimated')
      ) {
        categorizedFiles.financial.push(file);
      }
      // PRIORITY 5: Statistics
      else if (
        name.includes('statistic') ||
        name.includes('stats') ||
        path.includes('statistics/')
      ) {
        categorizedFiles.statistics.push(file);
      }
      // PRIORITY 6: Unknown
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

    // Process financial reports (CSV)
    let csvRevenueCount = 0;
    const fileContributions: Array<{ file: string; gross: number; dates: number; sampleDates: string[] }> = [];
    
    for (const file of categorizedFiles.financial) {
      try {
        const [contents] = await file.download();
        const csvContent = detectAndDecodeCSV(contents);
        
        const parsed = await parseFinancialReportCSV(csvContent, file.name, startDate, endDate);
        if (parsed && parsed.revenueByDate) {
          parsedReports.push(parsed);
          discoveredReportTypes.add(parsed.type);
          csvRevenueCount++;
          
          // Track revenue by source
          const dates = Object.keys(parsed.revenueByDate);
          const totalGross = Object.values(parsed.revenueByDate).reduce((sum, d) => sum + d.gross, 0);
          const totalNet = Object.values(parsed.revenueByDate).reduce((sum, d) => sum + d.net, 0);
          const totalTx = Object.values(parsed.revenueByDate).reduce((sum, d) => sum + d.transactions, 0);
          
          // Log each file's contribution
          fileContributions.push({ file: file.name, gross: totalGross, dates: dates.length, sampleDates: dates.slice(0, 3) });
          
          const sourceKey = file.name.toLowerCase().includes('earnings/') ? 'csv-earnings' 
            : file.name.toLowerCase().includes('sales/') ? 'csv-sales' : 'csv-other';
          if (!revenueBySource[sourceKey]) revenueBySource[sourceKey] = { gross: 0, net: 0, transactions: 0, dates: 0 };
          revenueBySource[sourceKey].gross += totalGross;
          revenueBySource[sourceKey].net += totalNet;
          revenueBySource[sourceKey].transactions += totalTx;
          revenueBySource[sourceKey].dates += dates.length;
        }
      } catch (error) {
        console.error(`[Google Play GCS] Error processing ${file.name}:`, error);
      }
    }
    console.log(`[Google Play DEBUG] Processed ${categorizedFiles.financial.length} financial CSVs, ${csvRevenueCount} had revenue data`);

    // Process ZIP files from earnings/ and sales/ folders
    console.log(`[Google Play GCS] Processing ${zipFiles.length} ZIP files for financial data...`);
    let zipProcessed = 0;
    let zipErrors = 0;
    
    for (const file of zipFiles) {
      const isEarningsZip = file.name.toLowerCase().includes('earnings/');
      const isSalesZip = file.name.toLowerCase().includes('sales/');
      const zipSourceKey = isEarningsZip ? 'zip-earnings' : isSalesZip ? 'zip-sales' : 'zip-other';
      
      try {
        const [zipBuffer] = await file.download();
        const zip = new AdmZip(zipBuffer);
        const zipEntries = zip.getEntries();
        
        for (const entry of zipEntries) {
          if (entry.entryName.toLowerCase().endsWith('.csv') && !entry.isDirectory) {
            try {
              const csvBuffer = entry.getData();
              const csvContent = detectAndDecodeCSV(csvBuffer);
              
              const parsed = await parseFinancialReportCSV(csvContent, `${file.name}/${entry.entryName}`, startDate, endDate);
              if (parsed && parsed.revenueByDate) {
                parsedReports.push(parsed);
                discoveredReportTypes.add("financial");
                zipProcessed++;
                
                // Track revenue by source
                const dates = Object.keys(parsed.revenueByDate);
                const totalGross = Object.values(parsed.revenueByDate).reduce((sum, d) => sum + d.gross, 0);
                const totalNet = Object.values(parsed.revenueByDate).reduce((sum, d) => sum + d.net, 0);
                const totalTx = Object.values(parsed.revenueByDate).reduce((sum, d) => sum + d.transactions, 0);
                
                // Log each ZIP entry's contribution
                fileContributions.push({ 
                  file: `${file.name}/${entry.entryName}`, 
                  gross: totalGross, 
                  dates: dates.length, 
                  sampleDates: dates.slice(0, 3) 
                });
                
                if (!revenueBySource[zipSourceKey]) revenueBySource[zipSourceKey] = { gross: 0, net: 0, transactions: 0, dates: 0 };
                revenueBySource[zipSourceKey].gross += totalGross;
                revenueBySource[zipSourceKey].net += totalNet;
                revenueBySource[zipSourceKey].transactions += totalTx;
                revenueBySource[zipSourceKey].dates += dates.length;
              }
            } catch (csvError) {
              console.error(`[Google Play GCS] Error parsing CSV in ZIP ${file.name}/${entry.entryName}:`, csvError);
              zipErrors++;
            }
          }
        }
      } catch (error) {
        console.error(`[Google Play GCS] Error processing ZIP ${file.name}:`, error);
        zipErrors++;
      }
    }
    
    if (zipFiles.length > 0) {
      console.log(`[Google Play GCS] ZIP processing complete: ${zipProcessed} CSVs extracted, ${zipErrors} errors`);
    }
    
    // DEBUG: Summary of revenue by source
    console.log(`[Google Play DEBUG] ========== REVENUE BY SOURCE ==========`);
    for (const [source, data] of Object.entries(revenueBySource)) {
      console.log(`[Google Play DEBUG] ${source}: $${data.gross.toFixed(2)} gross, $${data.net.toFixed(2)} net, ${data.transactions} tx, ${data.dates} date entries`);
    }
    const totalFromAllSources = Object.values(revenueBySource).reduce((sum, d) => sum + d.gross, 0);
    console.log(`[Google Play DEBUG] TOTAL from all sources: $${totalFromAllSources.toFixed(2)} gross`);
    console.log(`[Google Play DEBUG] =======================================`);
    
    // DEBUG: Log all file contributions to identify duplicates
    console.log(`[Google Play DEBUG] ========== ALL FILE CONTRIBUTIONS (${fileContributions.length} files) ==========`);
    // Sort by gross revenue descending to see biggest contributors first
    const sortedContributions = [...fileContributions].sort((a, b) => b.gross - a.gross);
    for (const contrib of sortedContributions.slice(0, 50)) { // Show top 50
      console.log(`[Google Play FILE] $${contrib.gross.toFixed(2)} from ${contrib.file} (${contrib.dates} dates: ${contrib.sampleDates.join(', ')}...)`);
    }
    if (sortedContributions.length > 50) {
      console.log(`[Google Play FILE] ... and ${sortedContributions.length - 50} more files`);
    }
    
    // DEBUG: Specifically check November 2024 contributions for validation
    const nov2024Files = fileContributions.filter(f => 
      f.sampleDates.some(d => d.startsWith('2024-11'))
    );
    if (nov2024Files.length > 0) {
      console.log(`[Google Play NOV2024] ========== FILES WITH NOV 2024 DATA ==========`);
      let nov2024Total = 0;
      for (const contrib of nov2024Files) {
        console.log(`[Google Play NOV2024] $${contrib.gross.toFixed(2)} from ${contrib.file}`);
        nov2024Total += contrib.gross;
      }
      console.log(`[Google Play NOV2024] TOTAL from ${nov2024Files.length} files: $${nov2024Total.toFixed(2)}`);
      console.log(`[Google Play NOV2024] ================================================`);
    }
    console.log(`[Google Play DEBUG] ====================================================`);

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
    console.log(`[Google Play Summary] ========================================`);
    console.log(`[Google Play Summary] Report types: ${Array.from(discoveredReportTypes).join(', ')}`);
    console.log(`[Google Play Summary] Dates with revenue: ${Object.keys(revenueByDate).length}`);
    console.log(`[Google Play Summary] Dates with subscription metrics: ${Object.keys(subscriptionMetricsByDate).length}`);
    
    // Show revenue by source
    console.log(`[Google Play Summary] REVENUE BY SOURCE:`);
    for (const [source, data] of Object.entries(revenueBySource)) {
      console.log(`  ${source}: $${data.gross.toFixed(2)} gross, $${data.net.toFixed(2)} net, ${data.transactions} tx, ${data.dates} date entries`);
    }

    if (Object.keys(revenueByDate).length > 0) {
      const totalGross = Object.values(revenueByDate).reduce((sum, d) => sum + d.gross, 0);
      const totalNet = Object.values(revenueByDate).reduce((sum, d) => sum + d.net, 0);
      const totalTx = Object.values(revenueByDate).reduce((sum, d) => sum + d.transactions, 0);
      console.log(`[Google Play Summary] MERGED TOTAL: $${totalGross.toFixed(2)} gross, $${totalNet.toFixed(2)} net, ${totalTx} transactions`);
      
      // Show date range
      const sortedDates = Object.keys(revenueByDate).sort();
      const firstDate = sortedDates[0];
      const lastDate = sortedDates[sortedDates.length - 1];
      console.log(`[Google Play Summary] Date range: ${firstDate} to ${lastDate}`);
      
      // Show sample of dates with revenue amounts
      const datesWithRevenue = sortedDates.filter(d => revenueByDate[d].gross > 0);
      console.log(`[Google Play Summary] Dates with non-zero revenue: ${datesWithRevenue.length} of ${sortedDates.length}`);
      
      // Show first and last few dates with revenue
      if (datesWithRevenue.length > 0) {
        const sampleFirst = datesWithRevenue.slice(0, 3).map(d => `${d}:$${revenueByDate[d].gross.toFixed(0)}`).join(', ');
        const sampleLast = datesWithRevenue.slice(-3).map(d => `${d}:$${revenueByDate[d].gross.toFixed(0)}`).join(', ');
        console.log(`[Google Play Summary] First dates with revenue: ${sampleFirst}`);
        console.log(`[Google Play Summary] Last dates with revenue: ${sampleLast}`);
      }
    }

    if (Object.keys(subscriptionMetricsByDate).length > 0) {
      const latestDate = Object.keys(subscriptionMetricsByDate).sort().pop();
      if (latestDate) {
        const latest = subscriptionMetricsByDate[latestDate];
        console.log(`[Google Play Summary] Latest subs (${latestDate}): Active=${latest.active}, Trial=${latest.trial}, Paid=${latest.paid}`);
      }
    }
    console.log(`[Google Play Summary] ========================================`);

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

// Extended type for financial reports with renewal tracking
type FinancialReportData = {
  revenueByDate: Record<string, RevenueData>;
  renewalsByDate: Record<string, number>;
  refundsByDate: Record<string, number>;
};

// Parse financial/earnings reports
async function parseFinancialReportCSV(
  csvContent: string,
  fileName: string,
  startDate?: number,
  endDate?: number
): Promise<ParsedReport | null> {
  const revenueByDate: Record<string, RevenueData> = {};
  const renewalsByDate: Record<string, number> = {};
  const refundsByDate: Record<string, number> = {};

  try {
    const lines = csvContent.trim().split(/\r?\n/);
    if (lines.length < 2) {
      console.log(`[Google Play Financial CSV] Empty CSV - no data in ${fileName}`);
      return null;
    }

    const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/"/g, ''));

    const findColumnIndex = (possibleNames: string[]): number => {
      return headers.findIndex(h => 
        possibleNames.some(name => h.includes(name))
      );
    };

    const dateIdx = findColumnIndex(['transaction date', 'order charged date', 'charged date', 'date', 'day']);
    // For Charged Revenue (what customer paid, including VAT):
    // - Sales reports: 'charged amount' 
    // - Earnings reports: 'amount (merchant currency)' (already net of VAT from Google's perspective)
    const chargedAmountIdx = findColumnIndex(['charged amount']);
    const merchantAmountIdx = findColumnIndex(['amount (merchant currency)']);
    // For Revenue (excluding VAT):
    // - Sales reports: 'item price' (before tax)
    // - Earnings reports: same as merchant amount (Google already deducts VAT in some regions)
    const itemPriceIdx = findColumnIndex(['item price']);
    const taxesCollectedIdx = findColumnIndex(['taxes collected']);
    const netIdx = findColumnIndex(['developer proceeds', 'payouts', 'earnings', 'net']);
    const transactionTypeIdx = findColumnIndex(['transaction type', 'type', 'financial status']);
    const descriptionIdx = findColumnIndex(['description', 'sku description', 'product title']);
    const skuIdx = findColumnIndex(['sku id', 'product id', 'sku']);
    const currencyIdx = findColumnIndex(['currency of sale', 'buyer currency', 'currency']);
    const countryIdx = findColumnIndex(['country of buyer', 'buyer country', 'country']);

    // Only log first occurrence of each file type to understand format
    const isEarningsFile = fileName.toLowerCase().includes('earnings');
    const isSalesFile = fileName.toLowerCase().includes('sales');
    const fileType = isEarningsFile ? 'EARNINGS' : isSalesFile ? 'SALES' : 'OTHER';
    
    // Determine which columns to use based on report type
    // Sales reports: charged amount (gross incl VAT), item price (net excl VAT)
    // Earnings reports: merchant amount (already processed by Google)
    const grossIdx = isSalesFile ? chargedAmountIdx : merchantAmountIdx;
    const revenueIdx = isSalesFile ? itemPriceIdx : merchantAmountIdx;
    
    // Log detailed info for first file of each type (for debugging format issues)
    if ((isEarningsFile && fileName.includes('202310')) || (isSalesFile && fileName.includes('202310'))) {
      console.log(`[Google Play CSV SAMPLE] ${fileType}: ${fileName}`);
      console.log(`[Google Play CSV SAMPLE] ALL Headers: ${headers.join(', ')}`);
      console.log(`[Google Play CSV SAMPLE] Columns - date:${dateIdx}, chargedAmount:${chargedAmountIdx}, itemPrice:${itemPriceIdx}, taxes:${taxesCollectedIdx}, country:${countryIdx}`);
      console.log(`[Google Play CSV SAMPLE] Using: gross=${headers[grossIdx] || 'NOT FOUND'}, revenue=${headers[revenueIdx] || 'NOT FOUND'}`);
    }

    if (dateIdx < 0) {
      return null; // No date column - skip silently
    }
    
    // Need at least one revenue column
    const hasRevenueColumn = grossIdx >= 0 || revenueIdx >= 0 || netIdx >= 0 || merchantAmountIdx >= 0 || itemPriceIdx >= 0;
    if (!hasRevenueColumn) {
      return null; // No revenue columns - skip silently
    }

    // Track unique transaction types and currencies for debugging
    const transactionTypes = new Set<string>();
    const currenciesUsed = new Map<string, { count: number; totalGross: number }>();

    // Parse data rows
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const cols = parseCSVLine(line);
      const dateStr = cols[dateIdx]?.replace(/"/g, '').trim();
      if (!dateStr) continue;

      const date = parseDateString(dateStr, startDate, endDate);
      if (!date) continue;

      let gross = 0; // Charged amount (including VAT)
      let net = 0; // Revenue excluding VAT

      // For sales reports: use charged amount as gross, item price as net (revenue excl VAT)
      // For earnings reports: use merchant amount for both (Google already handles VAT)
      if (isSalesFile) {
        // Sales report: charged amount includes VAT, item price excludes VAT
        if (chargedAmountIdx >= 0) {
          gross = parseNumber(cols[chargedAmountIdx]);
        } else if (itemPriceIdx >= 0) {
          // Fallback: if no charged amount, use item price + taxes
          const itemPrice = parseNumber(cols[itemPriceIdx]);
          const taxes = taxesCollectedIdx >= 0 ? parseNumber(cols[taxesCollectedIdx]) : 0;
          gross = itemPrice + taxes;
        }
        
        if (itemPriceIdx >= 0) {
          net = parseNumber(cols[itemPriceIdx]);
        } else if (chargedAmountIdx >= 0 && taxesCollectedIdx >= 0) {
          // Fallback: charged amount - taxes
          const charged = parseNumber(cols[chargedAmountIdx]);
          const taxes = parseNumber(cols[taxesCollectedIdx]);
          net = charged - taxes;
        }
      } else {
        // Earnings report: merchant amount is already net of VAT in most cases
        if (merchantAmountIdx >= 0) {
          gross = parseNumber(cols[merchantAmountIdx]);
          net = gross; // For earnings, gross and net are the same (Google handles VAT)
        }
        if (netIdx >= 0) {
          net = parseNumber(cols[netIdx]);
        }
      }

      // Track currency usage
      const currency = currencyIdx >= 0 
        ? (cols[currencyIdx] || 'UNKNOWN').toUpperCase().trim().replace(/"/g, '')
        : 'UNKNOWN';
      if (!currenciesUsed.has(currency)) {
        currenciesUsed.set(currency, { count: 0, totalGross: 0 });
      }
      const currencyStats = currenciesUsed.get(currency)!;
      currencyStats.count += 1;
      currencyStats.totalGross += gross;

      // CRITICAL: Sales reports have amounts in BUYER CURRENCY, not USD!
      // We need to convert to USD since downstream expects USD and will convert to user currency.
      // For earnings reports, "amount (merchant currency)" is already in merchant's currency (typically USD).
      // 
      // These are approximate rates used ONLY for normalizing sales report data to USD.
      // The actual USD → user currency conversion uses live rates from the exchangeRates table.
      // Small inaccuracies here (±5%) are acceptable as they're normalized across all transactions.
      if (isSalesFile && currency !== 'USD' && currency !== 'UNKNOWN') {
        // Approximate exchange rates to USD (updated December 2024)
        // Source: approximate mid-market rates
        const toUsdRates: Record<string, number> = {
          // Nordic currencies
          'NOK': 0.088,  // Norwegian Krone
          'SEK': 0.091,  // Swedish Krona
          'DKK': 0.14,   // Danish Krone
          'ISK': 0.0071, // Icelandic Króna
          // European currencies
          'EUR': 1.05,   // Euro
          'GBP': 1.26,   // British Pound
          'CHF': 1.12,   // Swiss Franc
          'PLN': 0.24,   // Polish Złoty
          'CZK': 0.042,  // Czech Koruna
          'HUF': 0.0026, // Hungarian Forint
          'RON': 0.21,   // Romanian Leu
          'BGN': 0.54,   // Bulgarian Lev
          'HRK': 0.14,   // Croatian Kuna
          'TRY': 0.029,  // Turkish Lira
          'RUB': 0.010,  // Russian Ruble
          'UAH': 0.024,  // Ukrainian Hryvnia
          // Americas
          'CAD': 0.71,   // Canadian Dollar
          'MXN': 0.049,  // Mexican Peso
          'BRL': 0.16,   // Brazilian Real
          'ARS': 0.001,  // Argentine Peso
          'CLP': 0.001,  // Chilean Peso
          'COP': 0.00023,// Colombian Peso
          'PEN': 0.26,   // Peruvian Sol
          // Asia-Pacific
          'JPY': 0.0066, // Japanese Yen
          'CNY': 0.14,   // Chinese Yuan
          'HKD': 0.13,   // Hong Kong Dollar
          'TWD': 0.031,  // Taiwan Dollar
          'KRW': 0.00071,// South Korean Won
          'INR': 0.012,  // Indian Rupee
          'IDR': 0.000063,// Indonesian Rupiah
          'MYR': 0.22,   // Malaysian Ringgit
          'SGD': 0.74,   // Singapore Dollar
          'THB': 0.029,  // Thai Baht
          'PHP': 0.017,  // Philippine Peso
          'VND': 0.000040,// Vietnamese Dong
          'PKR': 0.0036, // Pakistani Rupee
          'BDT': 0.0083, // Bangladeshi Taka
          // Oceania
          'AUD': 0.64,   // Australian Dollar
          'NZD': 0.58,   // New Zealand Dollar
          // Middle East & Africa
          'AED': 0.27,   // UAE Dirham
          'SAR': 0.27,   // Saudi Riyal
          'ILS': 0.27,   // Israeli Shekel
          'ZAR': 0.055,  // South African Rand
          'EGP': 0.020,  // Egyptian Pound
          'NGN': 0.00062,// Nigerian Naira
          'KES': 0.0077, // Kenyan Shilling
        };
        const rate = toUsdRates[currency] || 0.1; // Default fallback for unknown currencies
        gross = gross * rate;
        net = net * rate;
      }

      // Get transaction type for renewal/refund detection
      const transactionType = transactionTypeIdx >= 0 
        ? (cols[transactionTypeIdx] || '').toLowerCase().trim().replace(/"/g, '')
        : '';
      const description = descriptionIdx >= 0 
        ? (cols[descriptionIdx] || '').toLowerCase().trim().replace(/"/g, '')
        : '';

      if (transactionType) {
        transactionTypes.add(transactionType);
      }

      // For sales reports, gross (charged) and net (item price) should both be available
      // For earnings reports or if missing, estimate based on typical VAT (~20% average)
      if (gross > 0 && net === 0) {
        // Estimate net (excl VAT) from gross - assume ~20% average VAT
        net = gross / 1.20;
      } else if (net > 0 && gross === 0) {
        // Estimate gross from net - assume ~20% average VAT
        gross = net * 1.20;
      }

      if (!revenueByDate[date]) {
        revenueByDate[date] = { gross: 0, net: 0, transactions: 0 };
      }

      // Only count positive charges as revenue (skip Google fees, taxes, etc.)
      const isCharge = transactionType.includes('charge') && !transactionType.includes('refund');
      const isRefund = transactionType.includes('refund');
      const isGoogleFee = transactionType.includes('fee') || transactionType.includes('tax');

      if (isRefund) {
        // Track refunds separately
        if (!refundsByDate[date]) refundsByDate[date] = 0;
        refundsByDate[date] += 1;
        // Refunds are typically negative, but ensure we subtract
        revenueByDate[date].gross -= Math.abs(gross);
        revenueByDate[date].net -= Math.abs(net);
      } else if (!isGoogleFee && gross !== 0) {
        revenueByDate[date].gross += gross;
        revenueByDate[date].net += net;
        revenueByDate[date].transactions += 1;

        // Count as renewal if it's a subscription charge (renewals are charges on existing subscriptions)
        // Note: Google Play doesn't distinguish new vs renewal in basic reports
        // But every charge transaction is either a new sub or a renewal
        if (isCharge || gross > 0) {
          if (!renewalsByDate[date]) renewalsByDate[date] = 0;
          renewalsByDate[date] += 1;
        }
      }
    }

    // Log transaction types found (once per file pattern)
    if ((fileName.includes('earnings_202411') || fileName.includes('salesreport_202411')) && transactionTypes.size > 0) {
      console.log(`[Google Play Financial CSV] Transaction types found: ${Array.from(transactionTypes).join(', ')}`);
    }

    // Log currency breakdown for November 2024 file (to debug currency issue)
    if (fileName.includes('salesreport_202411') && currenciesUsed.size > 0) {
      console.log(`[Google Play CURRENCY DEBUG] ========== CURRENCY BREAKDOWN (Nov 2024) ==========`);
      const sortedCurrencies = Array.from(currenciesUsed.entries())
        .sort((a, b) => b[1].totalGross - a[1].totalGross);
      for (const [curr, stats] of sortedCurrencies.slice(0, 10)) {
        console.log(`[Google Play CURRENCY DEBUG] ${curr}: ${stats.count} transactions, total ${stats.totalGross.toFixed(2)} (in ${curr})`);
      }
      // Show total after conversion to USD
      const totalRevenueUsd = Object.values(revenueByDate).reduce((sum, d) => sum + d.gross, 0);
      console.log(`[Google Play CURRENCY DEBUG] After USD conversion: $${totalRevenueUsd.toFixed(2)} USD`);
      console.log(`[Google Play CURRENCY DEBUG] Expected: ~$${(84396.80 * 0.09).toFixed(2)} USD (84396 NOK * 0.09)`);
      console.log(`[Google Play CURRENCY DEBUG] ===================================================`);
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
