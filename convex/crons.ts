import { cronJobs } from "convex/server";
import { action } from "./_generated/server";
import { api, internal } from "./_generated/api";

// All supported currencies
const CURRENCIES = [
  // Major currencies
  "USD", "EUR", "GBP", "JPY", "CAD", "AUD", "CHF", "CNY", "INR", "BRL",
  // Nordics
  "SEK", "NOK", "DKK",
  // Asia Pacific
  "NZD", "SGD", "HKD", "KRW", "TWD", "THB", "PHP", "IDR", "MYR", "VND",
  // Europe (non-Euro)
  "PLN", "CZK", "HUF", "RON", "BGN", "HRK", "RUB", "UAH",
  // Americas
  "MXN", "ARS", "CLP", "COP", "PEN",
  // Middle East / Africa
  "ZAR", "TRY", "ILS", "AED", "SAR", "EGP", "NGN",
];

const MONTHS_TO_BACKFILL = 24;

// Fetch exchange rates using Frankfurter.app (free, supports historical)
// Duplicates are automatically skipped, so this is safe to run repeatedly
export const fetchExchangeRates = action({
  args: {},
  handler: async (ctx): Promise<{ success: boolean; error?: string; stored?: number; skipped?: number; errors?: string[] }> => {
    console.log("[Exchange Rates] Starting fetch (current + historical)...");
    const baseCurrency = "USD";
    
    // Generate list of months: current + past 24 months
    const months: string[] = [];
    const now = new Date();
    for (let i = 0; i < MONTHS_TO_BACKFILL; i++) {
      const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push(date.toISOString().substring(0, 7));
    }
    
    let totalStored = 0;
    let totalSkipped = 0;
    const errors: string[] = [];
    
    for (const yearMonth of months) {
      try {
        // Frankfurter.app: use /latest for current, /YYYY-MM-DD for historical
        const isCurrentMonth = yearMonth === now.toISOString().substring(0, 7);
        const url = isCurrentMonth
          ? `https://api.frankfurter.app/latest?from=${baseCurrency}`
          : `https://api.frankfurter.app/${yearMonth}-01?from=${baseCurrency}`;
        
        const response = await fetch(url);
        
        if (!response.ok) {
          errors.push(`${yearMonth}: HTTP ${response.status}`);
          continue;
        }
        
        const data = await response.json() as { rates?: Record<string, number> };
        
        if (!data.rates) {
          errors.push(`${yearMonth}: Invalid response`);
          continue;
        }
        
        const rates: { fromCurrency: string; toCurrency: string; rate: number }[] = [];
        for (const currency of CURRENCIES) {
          if (currency === baseCurrency) continue;
          const rate = data.rates[currency];
          if (rate) {
            rates.push({ fromCurrency: baseCurrency, toCurrency: currency, rate });
          }
        }
        
        if (rates.length > 0) {
          const result = await ctx.runMutation(internal.mutations.storeExchangeRates, { rates, yearMonth });
          totalStored += result.count;
          totalSkipped += result.skipped;
          if (result.count > 0) {
            console.log(`[Exchange Rates] ${yearMonth}: stored ${result.count} new rates`);
          }
        }
        
        // Small delay to avoid rate limiting
        if (!isCurrentMonth) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        errors.push(`${yearMonth}: ${msg}`);
      }
    }
    
    console.log(`[Exchange Rates] ✅ Complete: ${totalStored} stored, ${totalSkipped} already existed, ${errors.length} errors`);
    return { success: true, stored: totalStored, skipped: totalSkipped, errors: errors.length > 0 ? errors : undefined };
  },
});

const crons = cronJobs();

crons.daily(
  "daily sync",
  { hourUTC: 0, minuteUTC: 0 },
  api.sync.syncAllApps
);

crons.daily(
  "fetch exchange rates",
  { hourUTC: 1, minuteUTC: 0 },
  api.crons.fetchExchangeRates
);

export default crons;

