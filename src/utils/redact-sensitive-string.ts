const REDACTED = '[redacted]';

/** Shared pattern boundary for provider evidence and command output. */
export function redactSensitiveString(value: string): string {
  return value
    .replace(/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/g, REDACTED)
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^@\s/]+:[^@\s/]+)@/gi, `$1${REDACTED}@`)
    .replace(/\bgithub_pat_[A-Za-z0-9_]+/g, REDACTED)
    .replace(/\bgh[oprsu]_[A-Za-z0-9_]{20,}/g, REDACTED)
    .replace(/\bglpat-[A-Za-z0-9_-]{20,}/g, REDACTED)
    .replace(/\bsk-ant-(?:api\d{2}-)?[A-Za-z0-9_-]{16,}/g, REDACTED)
    .replace(/\bsk_(?:live|test)_[A-Za-z0-9]{16,}/g, REDACTED)
    .replace(/\brk_(?:live|test)_[A-Za-z0-9]{16,}/g, REDACTED)
    .replace(/\bwhsec_[A-Za-z0-9]{16,}/g, REDACTED)
    .replace(/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, REDACTED)
    .replace(/\bsbp_[A-Za-z0-9_]{16,}/g, REDACTED)
    .replace(/\bsb_secret_[A-Za-z0-9_]{16,}/g, REDACTED)
    .replace(/\bxox[abprs]-[A-Za-z0-9-]{16,}/g, REDACTED);
}
