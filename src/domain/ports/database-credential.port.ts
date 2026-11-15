import { z } from 'zod';
import type { Component } from '../entities/component.entity.js';
import type { Environment } from '../entities/environment.entity.js';

export const databaseCredentialSelectionSchema = z.object({
  environment: z.string().min(1),
  component: z.string().min(1),
  username: z.string().min(1),
  database: z.string().min(1),
  applicationDriver: z.literal('node-postgres').optional(),
}).strict();
export type DatabaseCredentialSelection = z.infer<typeof databaseCredentialSelectionSchema>;
export const databaseCredentialTargetSchema = z.object({
  provider: z.string().min(1),
  componentId: z.string().min(1),
  environmentId: z.string().min(1),
  externalId: z.string().min(1),
  username: z.string().min(1),
  database: z.string().min(1),
  providerScope: z.record(z.string(), z.string()),
  inputMode: z.enum(['supplied', 'provider-generated']),
  connection: z.object({ host: z.string(), port: z.number().int().positive(), username: z.string(), database: z.string() }).strict(),
}).strict();
export type DatabaseCredentialTarget = z.infer<typeof databaseCredentialTargetSchema>;
export type DatabaseCredentialProbe = { state: 'authenticated' | 'rejected' | 'unknown'; tested: string };
/** Value-free prerequisite failure that may be exposed by reviewed planning. */
export class DatabaseCredentialReviewError extends Error {
  constructor() { super('Existing authorized runtime access and the exact application connection configuration could not be verified for every affected consumer. No database mutation is authorized.'); }
}
export type DatabaseCredentialUpdate = {
  /** blocked proves no authentication mutation was attempted; unknown does not. */
  state: 'acknowledged' | 'unknown' | 'blocked';
  /** Private return value. Encrypt immediately; never expose in receipts. */
  replacement?: string;
  operationId?: string;
};

export const databaseCredentialConfigurationSchema = z.object({
  issuerNames: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).min(1),
  consumers: z.array(z.object({
    service: z.string().min(1), externalId: z.string().min(1),
    // Private evidence: an offline value verifier, encrypted with the plan.
    envVarHashes: z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), z.string().regex(/^[a-f0-9]{64}$/)),
  }).strict()).min(1),
  /** Private source templates and progress, encrypted with the existing plan. */
  privateState: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type DatabaseCredentialConfiguration = z.infer<typeof databaseCredentialConfigurationSchema>;

/** Reviewed issuer/consumer configuration, supplied by a native optimization or
 * composed in the application from issuer and existing hosting capabilities.
 * Every existing consumer retains its exact service and endpoint identity.
 * Literal URL passwords are replaced only from frozen reviewed templates;
 * references remain references. All private templates stay encrypted. */
export interface DatabaseCredentialConfigurationLifecycle {
  inspect(environment: Environment, component: Component, target: DatabaseCredentialTarget, replacement: string,
    requiredConsumerKeys: Record<string, string[]>, priorReview?: DatabaseCredentialConfiguration): Promise<DatabaseCredentialConfiguration>;
  observe(environment: Environment, component: Component, target: DatabaseCredentialTarget, replacement: string,
    review: DatabaseCredentialConfiguration): Promise<{ issuer: 'match' | 'different' | 'unknown'; references: 'match' | 'different' | 'unknown' }>;
  synchronize(environment: Environment, component: Component, target: DatabaseCredentialTarget, replacement: string,
    review: DatabaseCredentialConfiguration): Promise<{ state: 'acknowledged' | 'unknown' | 'blocked' }>;
}

/** Optional complete configuration capability for explicit deployed-driver proof.
 * Native password/issuer support alone does not imply this runtime boundary. */
export interface DatabaseCredentialRuntimeConfiguration extends DatabaseCredentialConfigurationLifecycle {
  verifyAuthentication(environment: Environment, component: Component, target: DatabaseCredentialTarget,
    review: DatabaseCredentialConfiguration, driver: 'node-postgres'): Promise<DatabaseCredentialProbe>;
}

/** Actual database authentication, distinct from application environment wiring.
 * Mutations can invalidate the old password for new sessions immediately. */
export interface DatabaseCredentialLifecycle {
  readonly configuration?: DatabaseCredentialConfigurationLifecycle;
  readonly runtimeConfiguration?: DatabaseCredentialRuntimeConfiguration;
  inspect(environment: Environment, component: Component, selection: DatabaseCredentialSelection): Promise<DatabaseCredentialTarget>;
  /** Exact provider-owned user read. Private value; null means not retrievable. */
  readCurrent(environment: Environment, component: Component, target: DatabaseCredentialTarget): Promise<string | null>;
  probe(environment: Environment, component: Component, target: DatabaseCredentialTarget, replacement: string): Promise<DatabaseCredentialProbe>;
  /** Caller persists attempted intent first and owns uncertain-write recovery. */
  rotate(environment: Environment, component: Component, target: DatabaseCredentialTarget, replacement?: string): Promise<DatabaseCredentialUpdate>;
  /** Repair issuer metadata after proven authentication, without another reset. */
  finalize?(environment: Environment, component: Component, target: DatabaseCredentialTarget, replacement: string): Promise<DatabaseCredentialUpdate>;
  inspectIssuer?(environment: Environment, component: Component, target: DatabaseCredentialTarget, replacement: string): Promise<'match' | 'different' | 'unknown'>;
}

export function databaseCredentialLifecycle(adapter: unknown): DatabaseCredentialLifecycle | undefined {
  const value = (adapter as { credentialLifecycle?: DatabaseCredentialLifecycle } | undefined)?.credentialLifecycle;
  return value && ['inspect', 'readCurrent', 'probe', 'rotate'].every(key => typeof (value as unknown as Record<string, unknown>)[key] === 'function') ? value : undefined;
}

/** SQL-only adapters are deliberately not full password-rotation capabilities. */
export function databasePasswordRotationLifecycle(adapter: unknown): (DatabaseCredentialLifecycle & { configuration: DatabaseCredentialConfigurationLifecycle }) | undefined {
  const port = databaseCredentialLifecycle(adapter);
  const configuration = port?.configuration;
  return port && configuration && ['inspect', 'observe', 'synchronize'].every(key => typeof (configuration as unknown as Record<string, unknown>)[key] === 'function')
    ? port as DatabaseCredentialLifecycle & { configuration: DatabaseCredentialConfigurationLifecycle } : undefined;
}

/** A native reset must include a read-only issuer observation and an idempotent
 * issuer finalizer before application-level consumer composition is admitted. */
export function canComposeDatabasePasswordRotation(adapter: unknown): boolean {
  const port = databaseCredentialLifecycle(adapter);
  return Boolean(port && (port.configuration || typeof port.finalize === 'function' && typeof port.inspectIssuer === 'function'));
}
