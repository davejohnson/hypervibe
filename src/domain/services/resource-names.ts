import { createHash } from 'node:crypto';
import type { Environment } from '../entities/environment.entity.js';

/** A name discriminator, never proof of ownership or provider membership. */
export function resourceScopeSuffix(scope: readonly string[]): string {
  if (scope.length === 0 || scope.some((part) => !part?.trim())) {
    throw new Error('Resource naming requires a complete non-secret scope.');
  }
  return createHash('sha256').update(JSON.stringify(scope)).digest('hex').slice(0, 10);
}

/** Plain names within native namespaces; one short scope suffix otherwise. */
export function resourceName(name: string, options: {
  maxLength?: number;
  minLength?: number;
  scope?: readonly string[];
  compact?: boolean;
  reservedPrefixes?: readonly string[];
} = {}): string {
  const { maxLength = 63, minLength = 1, scope, compact = false } = options;
  const separator = compact ? '' : '-';
  let base = name.toLowerCase().replace(/[^a-z0-9]+/g, separator).replace(/^-+|-+$/g, '');
  if (!/^[a-z]/.test(base)) base = `r${separator}${base}`;
  if (options.reservedPrefixes?.some((prefix) => base.startsWith(prefix))) base = `r${separator}${base}`;
  const scopeSuffix = scope ? `${separator}${resourceScopeSuffix(scope)}` : '';
  // Sanitizing/truncating must not turn distinct logical names into one id.
  const changed = base !== name || base.length + scopeSuffix.length > maxLength || base.length < minLength;
  const nameSuffix = changed
    ? `${separator}${createHash('sha256').update(name).digest('hex').slice(0, 8)}`
    : '';
  const room = maxLength - nameSuffix.length - scopeSuffix.length;
  if (room < 1) throw new Error('Resource name limit leaves no room for its identity.');
  return `${base.slice(0, room).replace(/-+$/g, '')}${nameSuffix}${scopeSuffix}`;
}

/** Datastores share account/project namespaces rather than hosting envs. */
export function environmentResourceName(name: string, environment: Environment): string {
  return resourceName(name, { scope: [environment.projectId, environment.name] });
}
