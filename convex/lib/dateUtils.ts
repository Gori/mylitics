/**
 * Centralized date utilities for consistent date handling across the codebase.
 * All dates are handled in UTC to avoid timezone issues.
 */

import { ONE_DAY_MS } from "./constants";

// =============================================================================
// DATE FORMATTING
// =============================================================================

/**
 * Format a Date object to YYYY-MM-DD string in UTC.
 * This is the canonical format used throughout the application.
 */
export function formatDateUTC(date: Date): string {
  return date.toISOString().split("T")[0];
}

/**
 * Format a Date object to YYYY-MM string in UTC.
 * Used for month-based aggregations.
 */
export function formatYearMonthUTC(date: Date): string {
  return date.toISOString().substring(0, 7);
}

/**
 * Get today's date as YYYY-MM-DD string in UTC.
 */
export function getTodayUTC(): string {
  return formatDateUTC(new Date());
}

/**
 * Get current timestamp in milliseconds (Date.now() alias for consistency).
 */
export function nowMs(): number {
  return Date.now();
}

// =============================================================================
// DATE PARSING
// =============================================================================

/**
 * Parse a date string in various formats to YYYY-MM-DD format.
 * Handles:
 * - YYYY-MM-DD (ISO format)
 * - MM/DD/YYYY (US format)
 * - "Month DD, YYYY" (long format)
 *
 * Returns null if the date cannot be parsed.
 */
export function parseDateString(dateStr: string): string | null {
  if (!dateStr || typeof dateStr !== "string") {
    return null;
  }

  const trimmed = dateStr.trim();

  // Try ISO format first: YYYY-MM-DD
  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    if (isValidDate(parseInt(year), parseInt(month), parseInt(day))) {
      return trimmed;
    }
  }

  // Try US format: MM/DD/YYYY
  const usMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (usMatch) {
    const [, month, day, year] = usMatch;
    const mm = parseInt(month);
    const dd = parseInt(day);
    const yyyy = parseInt(year);
    if (isValidDate(yyyy, mm, dd)) {
      return `${yyyy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
    }
  }

  // Try long format: "Month DD, YYYY" or "Month D, YYYY"
  const longMatch = trimmed.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (longMatch) {
    const [, monthName, day, year] = longMatch;
    const monthIndex = getMonthIndex(monthName);
    if (monthIndex !== -1) {
      const dd = parseInt(day);
      const yyyy = parseInt(year);
      if (isValidDate(yyyy, monthIndex + 1, dd)) {
        return `${yyyy}-${String(monthIndex + 1).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
      }
    }
  }

  return null;
}

/**
 * Parse a date string and return a Date object.
 * Returns null if the date cannot be parsed.
 */
export function parseToDate(dateStr: string): Date | null {
  const parsed = parseDateString(dateStr);
  if (!parsed) return null;

  const date = new Date(parsed + "T00:00:00.000Z");
  return isNaN(date.getTime()) ? null : date;
}

/**
 * Safely parse a date, returning the current date if parsing fails.
 */
export function parseDateOrNow(dateStr: string | undefined | null): Date {
  if (!dateStr) return new Date();
  const parsed = parseToDate(dateStr);
  return parsed ?? new Date();
}

// =============================================================================
// DATE CALCULATIONS
// =============================================================================

/**
 * Get a date N days ago from now (or from a given date).
 * Returns as YYYY-MM-DD string in UTC.
 */
export function daysAgoUTC(days: number, fromDate?: Date): string {
  const from = fromDate ?? new Date();
  const result = new Date(from.getTime() - days * ONE_DAY_MS);
  return formatDateUTC(result);
}

/**
 * Get a date N days in the future from now (or from a given date).
 * Returns as YYYY-MM-DD string in UTC.
 */
export function daysFromNowUTC(days: number, fromDate?: Date): string {
  const from = fromDate ?? new Date();
  const result = new Date(from.getTime() + days * ONE_DAY_MS);
  return formatDateUTC(result);
}

/**
 * Get the start of a week (Monday or Sunday) for a given date.
 */
export function getWeekStart(date: Date, weekStartDay: "monday" | "sunday"): Date {
  const weekStart = new Date(date);
  const dayOfWeek = date.getUTCDay();

  if (weekStartDay === "monday") {
    const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    weekStart.setUTCDate(date.getUTCDate() - daysFromMonday);
  } else {
    weekStart.setUTCDate(date.getUTCDate() - dayOfWeek);
  }

  // Reset time to start of day in UTC
  weekStart.setUTCHours(0, 0, 0, 0);
  return weekStart;
}

/**
 * Get the start of today in UTC as a timestamp.
 */
export function getStartOfTodayMs(): number {
  const now = new Date();
  const todayStr = formatDateUTC(now);
  return new Date(todayStr + "T00:00:00.000Z").getTime();
}

/**
 * Get the end of today in UTC as a timestamp.
 */
export function getEndOfTodayMs(): number {
  return getStartOfTodayMs() + ONE_DAY_MS - 1;
}

/**
 * Generate an array of dates between start and end (inclusive).
 * Returns dates as YYYY-MM-DD strings.
 */
export function getDateRange(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  const start = parseToDate(startDate);
  const end = parseToDate(endDate);

  if (!start || !end || start > end) {
    return dates;
  }

  const current = new Date(start);
  while (current <= end) {
    dates.push(formatDateUTC(current));
    current.setUTCDate(current.getUTCDate() + 1);
  }

  return dates;
}

/**
 * Calculate the number of days between two dates.
 */
export function daysBetween(startDate: string, endDate: string): number {
  const start = parseToDate(startDate);
  const end = parseToDate(endDate);

  if (!start || !end) return 0;

  const diffMs = end.getTime() - start.getTime();
  return Math.floor(diffMs / ONE_DAY_MS);
}

// =============================================================================
// MONTH UTILITIES
// =============================================================================

const MONTH_NAMES = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december"
];

const MONTH_ABBREVS = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec"
];

/**
 * Get month index (0-11) from month name.
 * Returns -1 if not found.
 */
function getMonthIndex(monthName: string): number {
  const lower = monthName.toLowerCase();

  const fullIndex = MONTH_NAMES.indexOf(lower);
  if (fullIndex !== -1) return fullIndex;

  const abbrevIndex = MONTH_ABBREVS.indexOf(lower);
  return abbrevIndex;
}

/**
 * Get the number of days in a specific month.
 */
export function getDaysInMonth(year: number, month: number): number {
  // month is 1-based (1 = January)
  return new Date(year, month, 0).getDate();
}

// =============================================================================
// VALIDATION
// =============================================================================

/**
 * Check if a date is valid, including proper days per month.
 */
export function isValidDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12) return false;
  if (day < 1) return false;

  const daysInMonth = getDaysInMonth(year, month);
  return day <= daysInMonth;
}

/**
 * Check if a string is a valid YYYY-MM-DD date.
 */
export function isValidDateString(dateStr: string): boolean {
  return parseDateString(dateStr) !== null;
}

// =============================================================================
// TIMESTAMP CONVERSIONS
// =============================================================================

/**
 * Convert Unix timestamp (seconds) to milliseconds.
 */
export function unixSecondsToMs(unixSeconds: number): number {
  return unixSeconds * 1000;
}

/**
 * Convert milliseconds to Unix timestamp (seconds).
 */
export function msToUnixSeconds(ms: number): number {
  return Math.floor(ms / 1000);
}

/**
 * Convert Unix timestamp (seconds) to YYYY-MM-DD string.
 */
export function unixSecondsToDateStr(unixSeconds: number): string {
  return formatDateUTC(new Date(unixSecondsToMs(unixSeconds)));
}
