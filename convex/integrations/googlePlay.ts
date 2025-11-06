"use node";

import { action } from "../_generated/server";
import { v } from "convex/values";
import { Storage } from "@google-cloud/storage";

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
      gcsReportPrefix || "earnings/",
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

  // Return structure matching other platforms (empty for now, will be populated from CSV)
  const revenueByDate: Record<string, {
    gross: number;
    net: number;
    transactions: number;
  }> = {};

  try {
    console.log(`[Google Play] Listing reports in gs://${gcsBucketName}/${gcsReportPrefix}`);
    
    // List all files in the GCS bucket with the specified prefix
    const [files] = await storage.bucket(gcsBucketName).getFiles({
      prefix: gcsReportPrefix,
    });

    console.log(`[Google Play] Found ${files.length} files in GCS bucket`);

    // Filter for CSV files that match expected patterns
    const reportFiles = files.filter(file => {
      const name = file.name.toLowerCase();
      return name.endsWith('.csv') && (
        name.includes('earnings') || 
        name.includes('financial') || 
        name.includes('sales')
      );
    });

    console.log(`[Google Play] Found ${reportFiles.length} potential financial report files`);

    // Download and parse each report
    for (const file of reportFiles) {
      try {
        console.log(`[Google Play] Downloading report: ${file.name}`);
        
        const [contents] = await file.download();
        const csvContent = contents.toString('utf-8');
        
        // Parse the CSV and aggregate revenue by date
        const parsedData = parseFinancialReportCSV(csvContent, startDate, endDate);
        
        // Merge parsed data into revenueByDate
        for (const [date, data] of Object.entries(parsedData)) {
          if (!revenueByDate[date]) {
            revenueByDate[date] = { gross: 0, net: 0, transactions: 0 };
          }
          revenueByDate[date].gross += data.gross;
          revenueByDate[date].net += data.net;
          revenueByDate[date].transactions += data.transactions;
        }
        
        console.log(`[Google Play] Processed ${file.name}: ${Object.keys(parsedData).length} days`);
      } catch (error) {
        console.error(`[Google Play] Error processing file ${file.name}:`, error);
        // Continue with next file
      }
    }

    console.log(`[Google Play] Total dates with revenue data: ${Object.keys(revenueByDate).length}`);
    if (Object.keys(revenueByDate).length > 0) {
      const totalGross = Object.values(revenueByDate).reduce((sum, d) => sum + d.gross, 0);
      const totalNet = Object.values(revenueByDate).reduce((sum, d) => sum + d.net, 0);
      console.log(`[Google Play] Total revenue - Gross: ${totalGross.toFixed(2)}, Net: ${totalNet.toFixed(2)}`);
    }

    return { revenueByDate };
  } catch (error) {
    console.error(`[Google Play] Error accessing GCS bucket:`, error);
    throw new Error(`Failed to access GCS bucket: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseFinancialReportCSV(
  csvContent: string,
  startDate?: number,
  endDate?: number
): Record<string, { gross: number; net: number; transactions: number }> {
  const revenueByDate: Record<string, { gross: number; net: number; transactions: number }> = {};

  try {
    const lines = csvContent.trim().split(/\r?\n/);
    if (lines.length < 2) {
      console.log(`[Google Play CSV] Empty CSV - no data`);
      return revenueByDate;
    }

    // Parse header row to find column indices
    const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/"/g, ''));
    console.log(`[Google Play CSV] Headers found: ${headers.join(', ')}`);

    // Common column name variations in Google Play earnings reports
    const findColumnIndex = (possibleNames: string[]): number => {
      return headers.findIndex(h => 
        possibleNames.some(name => h.includes(name))
      );
    };

    // Find key columns
    const dateIdx = findColumnIndex(['transaction date', 'order charged date', 'charged date', 'date']);
    const grossIdx = findColumnIndex(['amount (merchant currency)', 'charged amount', 'item price']);
    const netIdx = findColumnIndex(['developer proceeds', 'payouts', 'earnings']);
    const transactionTypeIdx = findColumnIndex(['transaction type', 'type', 'product type']);
    const currencyIdx = findColumnIndex(['currency of sale', 'currency', 'merchant currency']);

    console.log(`[Google Play CSV] Column indices - Date: ${dateIdx}, Gross: ${grossIdx}, Net: ${netIdx}, Type: ${transactionTypeIdx}`);

    if (dateIdx < 0) {
      console.warn(`[Google Play CSV] No date column found - skipping file`);
      return revenueByDate;
    }

    // Parse data rows
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      // Simple CSV parsing (handles quoted fields)
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
      cols.push(currentField.trim()); // Add last field

      // Extract date
      const dateStr = cols[dateIdx]?.replace(/"/g, '').trim();
      if (!dateStr) continue;

      // Parse date - try multiple formats
      let dateMs: number;
      try {
        // Common formats: YYYY-MM-DD, MM/DD/YYYY, DD/MM/YYYY
        if (dateStr.includes('-')) {
          dateMs = new Date(dateStr).getTime();
        } else if (dateStr.includes('/')) {
          const parts = dateStr.split('/');
          if (parts.length === 3) {
            // Try MM/DD/YYYY first
            const mm = parseInt(parts[0]);
            const dd = parseInt(parts[1]);
            const yyyy = parseInt(parts[2]);
            if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
              dateMs = new Date(yyyy, mm - 1, dd).getTime();
            } else {
              continue;
            }
          } else {
            continue;
          }
        } else {
          continue;
        }
      } catch (error) {
        console.warn(`[Google Play CSV] Invalid date format: ${dateStr}`);
        continue;
      }

      // Filter by date range if provided
      if (startDate && dateMs < startDate) continue;
      if (endDate && dateMs > endDate) continue;

      // Convert to YYYY-MM-DD for grouping
      const date = new Date(dateMs).toISOString().split('T')[0];

      // Extract revenue amounts
      let gross = 0;
      let net = 0;

      if (grossIdx >= 0) {
        const grossStr = cols[grossIdx]?.replace(/[",\s]/g, '');
        gross = parseFloat(grossStr) || 0;
      }

      if (netIdx >= 0) {
        const netStr = cols[netIdx]?.replace(/[",\s]/g, '');
        net = parseFloat(netStr) || 0;
      }

      // If we only have one, estimate the other (Google takes ~15% cut)
      if (gross > 0 && net === 0) {
        net = gross * 0.85;
      } else if (net > 0 && gross === 0) {
        gross = net / 0.85;
      }

      // Initialize date entry if needed
      if (!revenueByDate[date]) {
        revenueByDate[date] = { gross: 0, net: 0, transactions: 0 };
      }

      // Add to totals
      revenueByDate[date].gross += gross;
      revenueByDate[date].net += net;
      revenueByDate[date].transactions += 1;
    }

    console.log(`[Google Play CSV] Parsed ${Object.keys(revenueByDate).length} unique dates`);
    
  } catch (error) {
    console.error(`[Google Play CSV] Error parsing CSV:`, error);
  }

  return revenueByDate;
}
