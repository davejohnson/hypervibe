import { environmentProfile } from '../domain/services/infrastructure-engine-selection.js';
import type { EnvironmentSpec } from '../domain/spec/spec.schema.js';

/**
 * What a Google Cloud database looks like for an environment. Production and
 * staging share one shape (dedicated cores, deletion protection, two weeks of
 * backups on creation); every other environment gets the cheapest instance.
 * Existing native backup policy and PITR are preserved by the engine lifecycle.
 *
 * Prices are Cloud SQL Enterprise list prices for the instance alone in a US
 * region, rounded up; storage and backups are billed on top by the gigabyte.
 */
export interface GcpDatabaseShape {
  tier: string;
  deletionProtection: boolean;
  retainedBackups: number;
  transactionLogDays: number;
  /** One sentence for the plan: size, monthly cost and protection. */
  summary: string;
}

const SIZES = {
  small: { tier: 'db-custom-1-3840', label: '1 vCPU, 3.75 GB', monthlyUsd: 50 },
  medium: { tier: 'db-custom-2-7680', label: '2 vCPU, 7.5 GB', monthlyUsd: 100 },
  large: { tier: 'db-custom-4-15360', label: '4 vCPU, 15 GB', monthlyUsd: 200 },
} as const;
const SHARED = { tier: 'db-f1-micro', label: 'shared CPU, 0.6 GB', monthlyUsd: 10 } as const;

export function gcpDatabaseShape(environmentName: string, database: NonNullable<EnvironmentSpec['database']>): GcpDatabaseShape {
  const production = environmentProfile(environmentName) === 'production';
  const size = database.size ? SIZES[database.size] : production ? SIZES.small : SHARED;
  const deletionProtection = database.deletionProtection ?? production;
  const retainedBackups = production ? 14 : 7;
  const transactionLogDays = 7;
  return {
    tier: size.tier, deletionProtection, retainedBackups, transactionLogDays,
    summary: `Database: ${size.label}, about US$${size.monthlyUsd} a month plus storage. `
      + `New databases start with ${retainedBackups} daily backups and ${transactionLogDays} days of point-in-time recovery; existing backup and recovery settings are preserved. `
      + `Deletion protection is ${deletionProtection ? 'on' : 'off'}.`,
  };
}

const PROTECTED_DATABASE_BLOCKER = 'This database has deletion protection on, so Hypervibe will not plan its deletion. '
  + 'To delete it, keep the database in the spec with "deletionProtection": false, plan and apply that change, then remove the database and plan again.';

/**
 * Removing a database from the spec deletes it. Returns why that plan must stop, or
 * undefined only after Google confirms the instance is unprotected or already gone.
 */
export async function databaseRemovalBlocker(instanceName: string, readInstance: () => Promise<Response>): Promise<string | undefined> {
  const response = await readInstance();
  if (response.status === 404) return undefined;
  if (!response.ok) return `Cloud SQL returned HTTP ${response.status} while checking deletion protection on ${instanceName}.`;
  const instance = await response.json() as { settings?: { deletionProtectionEnabled?: boolean } };
  return instance.settings?.deletionProtectionEnabled ? PROTECTED_DATABASE_BLOCKER : undefined;
}
