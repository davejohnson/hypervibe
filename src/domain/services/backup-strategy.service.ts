import type { EnvironmentSpec } from '../spec/spec.schema.js';

export const DEFAULT_BACKUP_STORAGE = 'hypervibe-backups';
export const BACKUP_DEFAULTS = { retainSets: 7, maxDataAgeHours: 24, restoreEveryDays: 7 } as const;

/** Derived desired resources use the normal confirmed storage lifecycle; no writes or source hash changes here. */
export function withBackupStorageDefaults(spec: EnvironmentSpec): EnvironmentSpec {
  if (spec.backups?.mode === 'disabled' || spec.backups?.destination
    || Object.values(spec.storage ?? {}).some(storage => storage.purpose === 'backup')
    || spec.storage?.[DEFAULT_BACKUP_STORAGE]) return spec;
  // Reuse a reviewed provider/placement, never guess an account, region or billing destination.
  const source = Object.entries(spec.storage ?? {}).sort(([a], [b]) => a.localeCompare(b))[0]?.[1];
  if (!source) return spec;
  return { ...spec, storage: { ...spec.storage, [DEFAULT_BACKUP_STORAGE]: {
    provider: source.provider, region: source.region, type: 'bucket', injectInto: [], purpose: 'backup',
  } } };
}

export function resolveBackupStrategy(input: EnvironmentSpec): {
  mode: 'daily' | 'disabled'; destination?: string; runnerImage?: string; issues: string[];
  retainSets: 7; maxDataAgeHours: 24; restoreEveryDays: 7;
} {
  const spec = withBackupStorageDefaults(input);
  if (spec.backups?.mode === 'disabled') return { mode: 'disabled', ...BACKUP_DEFAULTS, issues: [] };
  const candidates = Object.entries(spec.storage ?? {}).filter(([, value]) => value.purpose === 'backup');
  const destination = spec.backups?.destination ?? (candidates.length === 1 ? candidates[0][0] : undefined);
  const issues: string[] = [];
  if (!destination) issues.push(spec.storage?.[DEFAULT_BACKUP_STORAGE]?.purpose !== 'backup' && spec.storage?.[DEFAULT_BACKUP_STORAGE]
    ? 'The default backup destination name is already used by application storage. Declare a separate backup destination.'
    : 'A single separate backup destination must be declared before retained recovery sets can run.');
  if (!spec.backups?.runnerImage) issues.push('The managed private backup runner requires a published immutable Hypervibe helper image.');
  return { mode: 'daily', ...BACKUP_DEFAULTS, ...(destination ? { destination } : {}),
    ...(spec.backups?.runnerImage ? { runnerImage: spec.backups.runnerImage } : {}), issues };
}
