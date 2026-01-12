/**
 * Error handling utilities for platform integrations.
 * Provides consistent error logging and handling across the codebase.
 */

// =============================================================================
// ERROR TYPES
// =============================================================================

/**
 * Base class for integration errors with additional context.
 */
export class IntegrationError extends Error {
  public readonly platform: string;
  public readonly operation: string;
  public readonly context?: Record<string, unknown>;
  public readonly originalError?: Error;

  constructor(
    platform: string,
    operation: string,
    message: string,
    options?: {
      context?: Record<string, unknown>;
      cause?: Error;
    }
  ) {
    super(`[${platform}] ${operation}: ${message}`);
    this.name = "IntegrationError";
    this.platform = platform;
    this.operation = operation;
    this.context = options?.context;
    this.originalError = options?.cause;

    // Preserve stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, IntegrationError);
    }
  }
}

/**
 * Error for API/network failures.
 */
export class ApiError extends IntegrationError {
  public readonly statusCode?: number;
  public readonly responseBody?: string;

  constructor(
    platform: string,
    operation: string,
    message: string,
    options?: {
      statusCode?: number;
      responseBody?: string;
      context?: Record<string, unknown>;
      cause?: Error;
    }
  ) {
    super(platform, operation, message, options);
    this.name = "ApiError";
    this.statusCode = options?.statusCode;
    this.responseBody = options?.responseBody;
  }
}

/**
 * Error for credential/authentication failures.
 */
export class CredentialError extends IntegrationError {
  constructor(
    platform: string,
    message: string,
    options?: {
      context?: Record<string, unknown>;
      cause?: Error;
    }
  ) {
    super(platform, "authentication", message, options);
    this.name = "CredentialError";
  }
}

/**
 * Error for data parsing failures.
 */
export class ParseError extends IntegrationError {
  public readonly rawData?: string;

  constructor(
    platform: string,
    operation: string,
    message: string,
    options?: {
      rawData?: string;
      context?: Record<string, unknown>;
      cause?: Error;
    }
  ) {
    super(platform, operation, message, options);
    this.name = "ParseError";
    this.rawData = options?.rawData?.substring(0, 500); // Truncate for safety
  }
}

// =============================================================================
// ERROR HANDLING UTILITIES
// =============================================================================

/**
 * Extract a human-readable message from any error type.
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return String(error);
}

/**
 * Log an error with consistent formatting.
 */
export function logError(
  platform: string,
  operation: string,
  error: unknown,
  context?: Record<string, unknown>
): void {
  const message = getErrorMessage(error);
  const timestamp = new Date().toISOString();

  console.error(`[${timestamp}] [${platform}] ${operation} failed:`, message);

  if (context) {
    console.error(`[${platform}] Context:`, JSON.stringify(context, null, 2));
  }

  if (error instanceof Error && error.stack) {
    console.error(`[${platform}] Stack:`, error.stack);
  }
}

/**
 * Wrap an async operation with error logging.
 * Returns the result or null on failure.
 */
export async function withErrorLogging<T>(
  platform: string,
  operation: string,
  fn: () => Promise<T>,
  context?: Record<string, unknown>
): Promise<T | null> {
  try {
    return await fn();
  } catch (error) {
    logError(platform, operation, error, context);
    return null;
  }
}

/**
 * Wrap an async operation with error handling that re-throws with context.
 */
export async function withErrorContext<T>(
  platform: string,
  operation: string,
  fn: () => Promise<T>,
  context?: Record<string, unknown>
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw new IntegrationError(platform, operation, getErrorMessage(error), {
      context,
      cause: error instanceof Error ? error : undefined,
    });
  }
}

// =============================================================================
// FETCH WRAPPER WITH ERROR HANDLING
// =============================================================================

export interface FetchOptions extends RequestInit {
  /** Timeout in milliseconds (default: 30000) */
  timeout?: number;
}

export interface FetchResult<T> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
  rawBody?: string;
}

/**
 * Fetch with proper error handling and timeout support.
 */
export async function safeFetch<T = unknown>(
  platform: string,
  operation: string,
  url: string,
  options?: FetchOptions
): Promise<FetchResult<T>> {
  const timeout = options?.timeout ?? 30000;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    const rawBody = await response.text();

    if (!response.ok) {
      logError(platform, operation, `HTTP ${response.status}`, {
        url,
        status: response.status,
        body: rawBody.substring(0, 500),
      });

      return {
        ok: false,
        status: response.status,
        error: `HTTP ${response.status}: ${rawBody.substring(0, 200)}`,
        rawBody,
      };
    }

    // Try to parse as JSON if the body looks like JSON
    let data: T | undefined;
    if (rawBody.startsWith("{") || rawBody.startsWith("[")) {
      try {
        data = JSON.parse(rawBody) as T;
      } catch {
        // Not valid JSON, keep as string
      }
    }

    return {
      ok: true,
      status: response.status,
      data,
      rawBody,
    };
  } catch (error) {
    clearTimeout(timeoutId);

    const message = error instanceof Error && error.name === "AbortError"
      ? `Request timeout after ${timeout}ms`
      : getErrorMessage(error);

    logError(platform, operation, message, { url });

    return {
      ok: false,
      status: 0,
      error: message,
    };
  }
}

// =============================================================================
// RETRY UTILITIES
// =============================================================================

export interface RetryOptions {
  /** Maximum number of attempts (default: 3) */
  maxAttempts?: number;
  /** Base delay between retries in ms (default: 1000) */
  baseDelayMs?: number;
  /** Whether to use exponential backoff (default: true) */
  exponentialBackoff?: boolean;
  /** Function to determine if error is retryable */
  isRetryable?: (error: unknown) => boolean;
}

/**
 * Retry an async operation with configurable backoff.
 */
export async function withRetry<T>(
  platform: string,
  operation: string,
  fn: () => Promise<T>,
  options?: RetryOptions
): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? 3;
  const baseDelayMs = options?.baseDelayMs ?? 1000;
  const exponentialBackoff = options?.exponentialBackoff ?? true;
  const isRetryable = options?.isRetryable ?? (() => true);

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      const shouldRetry = attempt < maxAttempts && isRetryable(error);

      if (!shouldRetry) {
        throw error;
      }

      const delay = exponentialBackoff
        ? baseDelayMs * Math.pow(2, attempt - 1)
        : baseDelayMs;

      console.warn(
        `[${platform}] ${operation} failed (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms:`,
        getErrorMessage(error)
      );

      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
