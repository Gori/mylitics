/**
 * Centralized constants for the Milytics application.
 * These constants replace magic numbers scattered throughout the codebase.
 */

// =============================================================================
// TIME CONSTANTS (in milliseconds)
// =============================================================================

/** One second in milliseconds */
export const ONE_SECOND_MS = 1000;

/** One minute in milliseconds */
export const ONE_MINUTE_MS = 60 * ONE_SECOND_MS;

/** One hour in milliseconds */
export const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;

/** One day in milliseconds */
export const ONE_DAY_MS = 24 * ONE_HOUR_MS;

/** One week (7 days) in milliseconds */
export const ONE_WEEK_MS = 7 * ONE_DAY_MS;

/** 30 days in milliseconds (approximate month) */
export const THIRTY_DAYS_MS = 30 * ONE_DAY_MS;

/** 90 days in milliseconds (approximate quarter) */
export const NINETY_DAYS_MS = 90 * ONE_DAY_MS;

/** One year (365 days) in milliseconds */
export const ONE_YEAR_MS = 365 * ONE_DAY_MS;

// =============================================================================
// TIME CONSTANTS (in days)
// =============================================================================

/** Historical sync period for initial data fetch */
export const HISTORICAL_SYNC_DAYS = 365;

/** Default lookback period for metrics queries */
export const DEFAULT_LOOKBACK_DAYS = 30;

/** Short lookback period for recent metrics */
export const SHORT_LOOKBACK_DAYS = 7;

/** Extended lookback period for quarterly metrics */
export const QUARTER_LOOKBACK_DAYS = 90;

/** Months to backfill for exchange rates */
export const EXCHANGE_RATE_BACKFILL_MONTHS = 24;

// =============================================================================
// SYNC & BATCH CONSTANTS
// =============================================================================

/** Days per chunk for chunked sync operations */
export const SYNC_CHUNK_SIZE_DAYS = 30;

/** Batch size for database operations */
export const DB_BATCH_SIZE = 100;

/** Maximum items to delete in a single operation */
export const MAX_DELETE_BATCH = 500;

/** Days per chunk for unified sync operations */
export const UNIFIED_SYNC_CHUNK_DAYS = 100;

/** Delay between scheduled operations (in milliseconds) */
export const SCHEDULER_DELAY_MS = 100;

// =============================================================================
// API PAGINATION & LIMITS
// =============================================================================

/** Default limit for Stripe API list operations */
export const STRIPE_API_LIMIT = 100;

/** Default limit for database query results */
export const DEFAULT_QUERY_LIMIT = 100;

/** Maximum messages in chat API */
export const MAX_CHAT_MESSAGES = 50;

/** Maximum question length in chat API */
export const MAX_QUESTION_LENGTH = 2000;

/** Maximum request size for chat API (5MB) */
export const MAX_REQUEST_SIZE_BYTES = 5 * 1024 * 1024;

// =============================================================================
// SAMPLE & DISPLAY SIZES
// =============================================================================

/** Small sample size for logging/debugging */
export const SAMPLE_SIZE_SMALL = 3;

/** Medium sample size for logging/debugging */
export const SAMPLE_SIZE_MEDIUM = 5;

/** Standard sample size for logging/debugging */
export const SAMPLE_SIZE_STANDARD = 10;

/** Large sample size for logging/debugging */
export const SAMPLE_SIZE_LARGE = 15;

/** Extra large sample size for logging/debugging */
export const SAMPLE_SIZE_XLARGE = 50;

/** Top results limit for queries */
export const TOP_RESULTS_LIMIT = 100;

// =============================================================================
// FINANCIAL CONSTANTS
// =============================================================================

/** Divisor to convert cents to dollars (or smallest unit to standard) */
export const CENTS_PER_DOLLAR = 100;

/** Multiplier for percentage calculations with 2 decimal places */
export const PERCENTAGE_PRECISION = 100;

/** Number of decimal places for currency display */
export const CURRENCY_DECIMAL_PLACES = 2;

// =============================================================================
// ENCODING DETECTION CONSTANTS
// =============================================================================

/** Sample size for UTF-16 detection in bytes */
export const UTF16_SAMPLE_SIZE = 200;

/** Threshold ratio of null bytes to detect UTF-16 encoding */
export const UTF16_NULL_BYTE_THRESHOLD = 0.3;

// =============================================================================
// LOG LEVELS (for type safety)
// =============================================================================

export const LOG_LEVELS = ["debug", "info", "warn", "error", "success"] as const;
export type LogLevel = typeof LOG_LEVELS[number];

// =============================================================================
// PLATFORM IDENTIFIERS
// =============================================================================

export const PLATFORMS = ["appstore", "googleplay", "stripe", "unified"] as const;
export type Platform = typeof PLATFORMS[number];
