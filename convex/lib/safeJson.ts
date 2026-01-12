/**
 * Safe JSON parsing utilities for Convex functions.
 * Provides error handling for JSON.parse operations to prevent crashes from malformed data.
 */

export class JsonParseError extends Error {
  constructor(message: string, public readonly originalError?: unknown) {
    super(message);
    this.name = "JsonParseError";
  }
}

/**
 * Safely parse JSON with proper error handling.
 * Returns the parsed object or throws a descriptive error.
 */
export function safeJsonParse<T = unknown>(
  json: string,
  context: string = "data"
): T {
  try {
    return JSON.parse(json) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new JsonParseError(
      `Failed to parse ${context}: ${message}. Check that the stored data is valid JSON.`,
      error
    );
  }
}

/**
 * Safely parse credentials JSON with context-specific error messaging.
 */
export function parseCredentials<T = Record<string, unknown>>(
  credentials: string,
  platform: string
): T {
  return safeJsonParse<T>(credentials, `${platform} credentials`);
}

/**
 * Try to parse JSON, returning null on failure instead of throwing.
 * Useful for optional parsing where missing data is acceptable.
 */
export function tryJsonParse<T = unknown>(json: string): T | null {
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}
