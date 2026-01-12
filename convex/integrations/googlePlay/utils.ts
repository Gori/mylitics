/**
 * Utility functions for Google Play report processing.
 */

/**
 * Detect and decode CSV content that may be UTF-8 or UTF-16 encoded.
 */
export function detectAndDecodeCSV(buffer: Buffer): string {
  // Check for UTF-16 BOM (Byte Order Mark)
  // UTF-16 LE BOM: FF FE
  // UTF-16 BE BOM: FE FF
  if (buffer.length >= 2) {
    if (buffer[0] === 0xFF && buffer[1] === 0xFE) {
      return buffer.toString('utf16le');
    }
    if (buffer[0] === 0xFE && buffer[1] === 0xFF) {
      // Node.js doesn't have utf16be, need to swap bytes
      const swapped = Buffer.alloc(buffer.length);
      for (let i = 0; i < buffer.length - 1; i += 2) {
        swapped[i] = buffer[i + 1];
        swapped[i + 1] = buffer[i];
      }
      return swapped.toString('utf16le');
    }
  }

  // Check for UTF-16 without BOM by detecting null bytes pattern
  // UTF-16 has null bytes between ASCII characters
  let nullCount = 0;
  const sampleSize = Math.min(200, buffer.length);
  for (let i = 0; i < sampleSize; i++) {
    if (buffer[i] === 0) nullCount++;
  }

  // If >30% null bytes, it's likely UTF-16
  if (nullCount / sampleSize > 0.3) {
    return buffer.toString('utf16le');
  }

  // Default to UTF-8
  return buffer.toString('utf-8');
}

/**
 * Parse a CSV line handling quoted fields correctly.
 */
export function parseCSVLine(line: string): string[] {
  const cols: string[] = [];
  let currentField = '';
  let inQuotes = false;

  for (let j = 0; j < line.length; j++) {
    const char = line[j];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      cols.push(currentField.trim());
      currentField = '';
    } else {
      currentField += char;
    }
  }
  cols.push(currentField.trim());
  return cols;
}

/**
 * Parse a number from a string, handling currency formatting.
 */
export function parseNumber(str: string | undefined): number {
  if (!str) return 0;
  const cleaned = str.replace(/[",\s]/g, '');
  return parseFloat(cleaned) || 0;
}

/**
 * Parse a date string to YYYY-MM-DD format.
 * Returns null if the date is invalid or outside the specified range.
 */
export function parseDateString(
  dateStr: string,
  startDate?: number,
  endDate?: number
): string | null {
  if (!dateStr) return null;

  let dateMs: number;
  try {
    if (dateStr.includes('-')) {
      // Format: YYYY-MM-DD or similar
      dateMs = new Date(dateStr).getTime();
    } else if (dateStr.includes('/')) {
      // Format: MM/DD/YYYY
      const parts = dateStr.split('/');
      if (parts.length === 3) {
        const mm = parseInt(parts[0]);
        const dd = parseInt(parts[1]);
        const yyyy = parseInt(parts[2]);
        if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
          dateMs = new Date(yyyy, mm - 1, dd).getTime();
        } else {
          return null;
        }
      } else {
        return null;
      }
    } else if (dateStr.includes(',')) {
      // Format: "Month DD, YYYY"
      dateMs = new Date(dateStr).getTime();
    } else {
      return null;
    }

    if (isNaN(dateMs)) return null;

    // Check date range if specified
    if (startDate && dateMs < startDate) return null;
    if (endDate && dateMs > endDate) return null;

    return new Date(dateMs).toISOString().split('T')[0];
  } catch {
    return null;
  }
}
