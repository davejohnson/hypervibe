import type { ProviderLogEntry } from '../ports/provider-logs.port.js';

const ERROR_LOG_SEVERITIES = new Set([
  'warn',
  'warning',
  'err',
  'error',
  'critical',
  'alert',
  'emergency',
  'fatal',
]);

export function isErrorLike(log: ProviderLogEntry): boolean {
  const message = log.message.trim();
  const normalizedMessage = message.toLowerCase();
  const severity = (log.severity || '').toLowerCase();
  // Normalize the provider vocabularies we expose through the shared log
  // port. In particular, Cloud Logging returns WARNING/CRITICAL/ALERT/
  // EMERGENCY and would otherwise be dropped by this second-stage filter.
  if (ERROR_LOG_SEVERITIES.has(severity)) {
    return true;
  }

  // File/module names are not runtime exceptions merely because their path
  // contains "error" or "exception".
  if (
    /^(?:loading|loaded|registering|registered|importing|imported)\b/i.test(message)
    && /\b(?:errors?|exceptions?)\.[a-z0-9]+(?:\b|$)/i.test(message)
  ) {
    return false;
  }

  // Successful summaries such as "0 errors" should not be promoted to
  // failures. Strip the zero-count phrase so a separate real failure signal
  // on the same line can still win.
  const withoutZeroCounts = normalizedMessage.replace(/\b0\s+(?:errors?|failures?)\b/g, '');
  return (
    /\b(?:error|exception|failed|failure|crash(?:ed)?|fatal)\b/.test(withoutZeroCounts)
    || /\b(?:econnrefused|connection refused|unhandled rejection|uncaught exception)\b/.test(withoutZeroCounts)
    || /[A-Za-z][A-Za-z0-9]*Error(?=[:\s]|$)/.test(message)
  );
}
