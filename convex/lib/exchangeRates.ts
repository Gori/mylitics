import { QueryCtx } from "../_generated/server";

/**
 * Fallback exchange rates to USD when database rates are not available.
 * These are approximate rates and should only be used as a last resort.
 * Updated: January 2025
 */
export const FALLBACK_RATES_TO_USD: Record<string, number> = {
  // Nordic currencies
  'NOK': 0.088,
  'SEK': 0.091,
  'DKK': 0.14,
  'ISK': 0.0071,
  // European currencies
  'EUR': 1.05,
  'GBP': 1.26,
  'CHF': 1.12,
  'PLN': 0.24,
  'CZK': 0.042,
  'HUF': 0.0026,
  'RON': 0.21,
  'BGN': 0.54,
  'HRK': 0.14,
  'TRY': 0.029,
  'RUB': 0.010,
  'UAH': 0.024,
  // Americas
  'CAD': 0.71,
  'MXN': 0.049,
  'BRL': 0.16,
  'ARS': 0.001,
  'CLP': 0.001,
  'COP': 0.00023,
  'PEN': 0.26,
  // Asia-Pacific
  'JPY': 0.0066,
  'CNY': 0.14,
  'HKD': 0.13,
  'TWD': 0.031,
  'KRW': 0.00071,
  'INR': 0.012,
  'IDR': 0.000063,
  'MYR': 0.22,
  'SGD': 0.74,
  'THB': 0.029,
  'PHP': 0.017,
  'VND': 0.000040,
  'PKR': 0.0036,
  'BDT': 0.0083,
  // Oceania
  'AUD': 0.64,
  'NZD': 0.58,
  // Middle East & Africa
  'AED': 0.27,
  'SAR': 0.27,
  'ILS': 0.27,
  'ZAR': 0.055,
  'EGP': 0.020,
  'NGN': 0.00062,
  'KES': 0.0077,
};

/**
 * Fetch exchange rates from the database for converting to USD.
 * Returns a map of currency code -> USD rate.
 */
export async function fetchExchangeRatesToUSD(ctx: QueryCtx): Promise<Record<string, number>> {
  const rates: Record<string, number> = { 'USD': 1.0 };

  // Fetch all rates from USD to other currencies
  const dbRates = await ctx.db
    .query("exchangeRates")
    .withIndex("by_pair", (q) => q.eq("fromCurrency", "USD"))
    .collect();

  // Group by target currency and get the most recent rate
  const ratesByTarget: Record<string, { rate: number; timestamp: number }> = {};
  for (const r of dbRates) {
    const existing = ratesByTarget[r.toCurrency];
    if (!existing || r.timestamp > existing.timestamp) {
      ratesByTarget[r.toCurrency] = { rate: r.rate, timestamp: r.timestamp };
    }
  }

  // Convert USD -> X rates to X -> USD (inverse)
  for (const [currency, { rate }] of Object.entries(ratesByTarget)) {
    if (rate > 0) {
      rates[currency] = 1 / rate;
    }
  }

  // Also fetch rates where fromCurrency is not USD (e.g., EUR -> USD)
  const directToUsdRates = await ctx.db
    .query("exchangeRates")
    .withIndex("by_pair")
    .filter((q) => q.eq(q.field("toCurrency"), "USD"))
    .collect();

  for (const r of directToUsdRates) {
    // Only use if we don't already have a rate for this currency
    if (!rates[r.fromCurrency] && r.rate > 0) {
      rates[r.fromCurrency] = r.rate;
    }
  }

  return rates;
}

/**
 * Get the exchange rate from a currency to USD.
 * First checks the provided dynamic rates, then falls back to hardcoded rates.
 */
export function getToUsdRate(
  currency: string,
  dynamicRates: Record<string, number>
): number {
  const normalizedCurrency = currency.toUpperCase().trim();

  if (normalizedCurrency === 'USD' || normalizedCurrency === 'UNKNOWN') {
    return 1.0;
  }

  // First try dynamic rates from database
  if (dynamicRates[normalizedCurrency]) {
    return dynamicRates[normalizedCurrency];
  }

  // Fall back to hardcoded rates
  if (FALLBACK_RATES_TO_USD[normalizedCurrency]) {
    return FALLBACK_RATES_TO_USD[normalizedCurrency];
  }

  // Ultimate fallback for completely unknown currencies
  return 0.1;
}

/**
 * Convert an amount from a currency to USD.
 */
export function convertToUsd(
  amount: number,
  currency: string,
  dynamicRates: Record<string, number>
): number {
  const rate = getToUsdRate(currency, dynamicRates);
  return amount * rate;
}
