import { cronJobs } from "convex/server";
import { action } from "./_generated/server";
import { api, internal } from "./_generated/api";

// Fetch exchange rates from exchangerate-api.io (free tier)
export const fetchExchangeRates = action({
  args: {},
  handler: async (ctx) => {
    console.log("[Exchange Rates] Starting fetch...");
    const baseCurrency = "USD";
    const currencies = ["USD", "EUR", "GBP", "JPY", "CAD", "AUD", "CHF", "CNY", "INR", "BRL", "SEK", "NOK", "DKK", "NZD", "SGD", "HKD", "KRW", "MXN", "ZAR", "TRY", "PLN"];
    
    try {
      console.log(`[Exchange Rates] Fetching from API for base ${baseCurrency}...`);
      const response = await fetch(`https://open.er-api.com/v6/latest/${baseCurrency}`);
      
      if (!response.ok) {
        console.error(`[Exchange Rates] Failed to fetch: HTTP ${response.status}`);
        return { success: false, error: `HTTP ${response.status}` };
      }
      
      const data = await response.json() as { result?: string; rates?: Record<string, number> };
      
      if (data.result !== "success" || !data.rates) {
        console.error("[Exchange Rates] Invalid response - missing rates");
        return { success: false, error: "Invalid response" };
      }
      
      console.log(`[Exchange Rates] API response received, rates available: ${Object.keys(data.rates).length}`);
      
      const rates = [];
      
      // Store rates from USD to each currency
      for (const currency of currencies) {
        if (currency === baseCurrency) continue;
        
        const rate = data.rates[currency];
        if (rate) {
          rates.push({
            fromCurrency: baseCurrency,
            toCurrency: currency,
            rate,
          });
          if (currency === "NOK") {
            console.log(`[Exchange Rates] USD -> NOK rate: ${rate}`);
          }
        }
      }
      
      console.log(`[Exchange Rates] Prepared ${rates.length} rates to store`);
      
      if (rates.length > 0) {
        await ctx.runMutation(internal.mutations.storeExchangeRates, { rates });
        console.log(`[Exchange Rates] ✅ Successfully stored ${rates.length} exchange rates`);
        return { success: true, count: rates.length };
      }
      
      console.error("[Exchange Rates] No rates to store");
      return { success: false, error: "No rates found" };
    } catch (error: any) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error("[Exchange Rates] Error:", errorMsg);
      
      // Provide helpful error message for common issues
      if (errorMsg.includes("tunnel") || errorMsg.includes("Connect")) {
        return { 
          success: false, 
          error: "Network connection failed. Please check your internet connection and try again." 
        };
      }
      
      return { success: false, error: errorMsg };
    }
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

