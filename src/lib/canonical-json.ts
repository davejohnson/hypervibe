import { createHash } from 'crypto';

export function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => [key, canonicalizeJson(child)])
  );
}

export function canonicalJsonSha256(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalizeJson(value)), 'utf8')
    .digest('hex');
}
