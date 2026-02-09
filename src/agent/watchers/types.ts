import { createHash } from 'crypto';

/**
 * A normalized error from any hosting platform.
 */
export interface NormalizedError {
  /** Timestamp when the error occurred */
  timestamp: Date;
  /** The error message */
  message: string;
  /** Stack trace if available */
  stackTrace?: string;
  /** Service name where the error occurred */
  serviceName: string;
  /** Environment name */
  environmentName: string;
  /** Project identifier */
  projectId: string;
  /** Original raw log lines */
  rawLines: string[];
  /** Error type if detectable (e.g., 'TypeError', 'ConnectionError') */
  errorType?: string;
}

/**
 * Options for fetching errors.
 */
export interface FetchErrorsOptions {
  /** Maximum number of errors to return */
  limit?: number;
  /** Only return errors after this timestamp */
  since?: Date;
}

/**
 * Create a fingerprint for deduplication.
 * Uses error type + first line of stack trace (or message) to group similar errors.
 */
export function createFingerprint(error: NormalizedError): string {
  // Extract error type from message if not provided
  const errorType = error.errorType || extractErrorType(error.message);

  // Get stable part of stack trace (first frame)
  const stackFrame = error.stackTrace?.split('\n')[0]?.trim() || '';

  // Normalize message (remove variable parts like IDs, timestamps)
  const normalizedMessage = normalizeMessage(error.message);

  // Combine and hash
  const input = `${errorType}:${stackFrame}:${normalizedMessage}`;
  return createHash('sha256').update(input).digest('hex').substring(0, 16);
}

/**
 * Extract error type from message.
 * e.g., "TypeError: Cannot read property..." -> "TypeError"
 */
function extractErrorType(message: string): string {
  // Common patterns
  const patterns = [
    /^(\w+Error):/,           // TypeError:, ReferenceError:, etc.
    /^(\w+Exception):/,       // NullPointerException:, etc.
    /^Error: (\w+):/,         // Error: ENOENT:, etc.
    /^Uncaught (\w+Error)/,   // Uncaught TypeError
    /^\[(\w+Error)\]/,        // [DatabaseError]
  ];

  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match) {
      return match[1];
    }
  }

  return 'UnknownError';
}

/**
 * Normalize a message by removing variable parts.
 */
function normalizeMessage(message: string): string {
  return message
    // Remove UUIDs
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>')
    // Remove hex IDs
    .replace(/\b[0-9a-f]{24,}\b/gi, '<ID>')
    // Remove timestamps
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.\d]*Z?/g, '<TIMESTAMP>')
    // Remove numbers that look like IDs or counts
    .replace(/\b\d{5,}\b/g, '<NUM>')
    // Remove IP addresses
    .replace(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/g, '<IP>')
    // Remove file paths with line numbers
    .replace(/:\d+:\d+/g, ':<LINE>')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim()
    // Take first 200 chars
    .substring(0, 200);
}

/**
 * Keywords that indicate an error log.
 */
export const ERROR_KEYWORDS = [
  'error',
  'exception',
  'failed',
  'crash',
  'fatal',
  'panic',
  'unhandled',
  'uncaught',
];

/**
 * Check if a log message indicates an error.
 */
export function isErrorLog(message: string, severity?: string): boolean {
  if (severity === 'error') {
    return true;
  }

  const lower = message.toLowerCase();
  return ERROR_KEYWORDS.some((keyword) => lower.includes(keyword));
}

/**
 * Group consecutive error logs into a single error (for stack traces).
 */
export function groupConsecutiveErrors(
  logs: Array<{ timestamp: string; message: string; severity?: string }>
): Array<{ timestamp: string; lines: string[] }> {
  const groups: Array<{ timestamp: string; lines: string[] }> = [];
  let currentGroup: { timestamp: string; lines: string[] } | null = null;

  for (const log of logs) {
    const isError = isErrorLog(log.message, log.severity);
    const isStackTraceLine = /^\s+at\s/.test(log.message) || /^\s+\^/.test(log.message);

    if (isError || (currentGroup && isStackTraceLine)) {
      if (!currentGroup) {
        currentGroup = { timestamp: log.timestamp, lines: [] };
      }
      currentGroup.lines.push(log.message);
    } else if (currentGroup) {
      groups.push(currentGroup);
      currentGroup = null;
    }
  }

  if (currentGroup) {
    groups.push(currentGroup);
  }

  return groups;
}
