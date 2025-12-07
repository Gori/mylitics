export type RevenueFormat = "whole" | "twoDecimals";

export function formatRevenue(
  amount: number,
  currency: string,
  format: RevenueFormat = "whole",
  locale = "de-DE"
) {
  const fractionDigits = format === "twoDecimals" ? 2 : 0;

  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(amount);
}

