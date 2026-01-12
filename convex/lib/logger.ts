/**
 * Conditional logging utility for Convex functions.
 * In production, only errors are logged. In development, all logs are shown.
 *
 * Usage:
 *   import { logger } from "./lib/logger";
 *   logger.debug("[Module]", "message", data);
 *   logger.info("[Module]", "message");
 *   logger.error("[Module]", "error message", error);
 */

// Check if we're in development mode
// In Convex, process.env isn't available, so we check for common patterns
const isDev = typeof process !== "undefined" && process.env?.NODE_ENV !== "production";

type LogLevel = "debug" | "info" | "warn" | "error";

interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  setLevel: (level: LogLevel) => void;
}

let currentLevel: LogLevel = isDev ? "debug" : "warn";

const levels: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function shouldLog(level: LogLevel): boolean {
  return levels[level] >= levels[currentLevel];
}

export const logger: Logger = {
  debug: (...args: unknown[]) => {
    if (shouldLog("debug")) {
      console.log(...args);
    }
  },
  info: (...args: unknown[]) => {
    if (shouldLog("info")) {
      console.log(...args);
    }
  },
  warn: (...args: unknown[]) => {
    if (shouldLog("warn")) {
      console.warn(...args);
    }
  },
  error: (...args: unknown[]) => {
    if (shouldLog("error")) {
      console.error(...args);
    }
  },
  setLevel: (level: LogLevel) => {
    currentLevel = level;
  },
};

/**
 * Create a scoped logger with a prefix.
 * Usage:
 *   const log = createLogger("[Google Play]");
 *   log.debug("Processing file", fileName);
 */
export function createLogger(prefix: string): Logger {
  return {
    debug: (...args: unknown[]) => logger.debug(prefix, ...args),
    info: (...args: unknown[]) => logger.info(prefix, ...args),
    warn: (...args: unknown[]) => logger.warn(prefix, ...args),
    error: (...args: unknown[]) => logger.error(prefix, ...args),
    setLevel: logger.setLevel,
  };
}
