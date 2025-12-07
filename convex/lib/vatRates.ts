/**
 * VAT rates by ISO 3166-1 alpha-2 country code.
 * Used to calculate Revenue (excl. VAT) from Charged Revenue for App Store transactions.
 * 
 * Note: These are standard VAT rates. Some countries have reduced rates for digital services,
 * but Apple typically charges the standard rate.
 */

export const VAT_RATES: Record<string, number> = {
  // EU Member States (as of 2024)
  AT: 0.20, // Austria
  BE: 0.21, // Belgium
  BG: 0.20, // Bulgaria
  HR: 0.25, // Croatia
  CY: 0.19, // Cyprus
  CZ: 0.21, // Czech Republic
  DK: 0.25, // Denmark
  EE: 0.22, // Estonia
  FI: 0.24, // Finland
  FR: 0.20, // France
  DE: 0.19, // Germany
  GR: 0.24, // Greece
  HU: 0.27, // Hungary
  IE: 0.23, // Ireland
  IT: 0.22, // Italy
  LV: 0.21, // Latvia
  LT: 0.21, // Lithuania
  LU: 0.17, // Luxembourg
  MT: 0.18, // Malta
  NL: 0.21, // Netherlands
  PL: 0.23, // Poland
  PT: 0.23, // Portugal
  RO: 0.19, // Romania
  SK: 0.20, // Slovakia
  SI: 0.22, // Slovenia
  ES: 0.21, // Spain
  SE: 0.25, // Sweden

  // EEA (non-EU)
  NO: 0.25, // Norway
  IS: 0.24, // Iceland
  LI: 0.077, // Liechtenstein

  // Other European
  CH: 0.081, // Switzerland
  GB: 0.20, // United Kingdom

  // Rest of World with VAT/GST on digital services
  AU: 0.10, // Australia (GST)
  NZ: 0.15, // New Zealand (GST)
  JP: 0.10, // Japan (Consumption Tax)
  KR: 0.10, // South Korea
  SG: 0.09, // Singapore (GST)
  IN: 0.18, // India (GST)
  ZA: 0.15, // South Africa
  CA: 0.05, // Canada (GST federal only - provinces vary)
  MX: 0.16, // Mexico
  BR: 0.00, // Brazil (complex, handled differently)
  AR: 0.21, // Argentina
  CL: 0.19, // Chile
  CO: 0.19, // Colombia

  // Middle East
  AE: 0.05, // UAE
  SA: 0.15, // Saudi Arabia
  IL: 0.17, // Israel

  // Asia
  TW: 0.05, // Taiwan
  TH: 0.07, // Thailand
  MY: 0.06, // Malaysia (SST)
  ID: 0.11, // Indonesia
  PH: 0.12, // Philippines
  VN: 0.10, // Vietnam
  HK: 0.00, // Hong Kong (no VAT)
  CN: 0.13, // China

  // Countries with no VAT on digital services (or 0% rate)
  US: 0.00, // United States (no federal VAT, sales tax varies by state but not collected by Apple)
};

/**
 * Get VAT rate for a country code.
 * Returns 0 if country is not found (conservative approach - assumes no VAT).
 */
export function getVatRate(countryCode: string): number {
  const code = countryCode?.toUpperCase();
  return VAT_RATES[code] ?? 0;
}

/**
 * Calculate revenue excluding VAT from charged amount.
 * Formula: Revenue = ChargedAmount / (1 + VAT_RATE)
 * 
 * @param chargedAmount - Amount including VAT
 * @param countryCode - ISO 3166-1 alpha-2 country code
 * @returns Amount excluding VAT
 */
export function calculateRevenueExcludingVat(
  chargedAmount: number,
  countryCode: string
): number {
  const vatRate = getVatRate(countryCode);
  if (vatRate === 0) return chargedAmount;
  return chargedAmount / (1 + vatRate);
}



