import type { Environment } from '../entities/environment.entity.js';
import type { ProviderRuntimeIdentity, Receipt } from './provider.port.js';
import type { RecoverySourceIdentity } from './recovery-source.port.js';
import { z } from 'zod';
import { runtimeCoordinateSchema, runtimeExecutionCoordinatesSchema } from '../../lib/value-free-coordinates.js';

const nonempty = z.string().min(1);
const coordinates = z.record(z.string(), nonempty);
/** Serialized public connection descriptors, never reusable credentials. */
export const recoveryAutomationSchema = z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), z.object({
  credentials: runtimeCoordinateSchema.refine(value => runtimeExecutionCoordinatesSchema.safeParse({ configuration: value }).success),
  environmentKeys: z.array(z.enum(['ACTIONS_ID_TOKEN_REQUEST_URL', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN'])).max(2),
  oidc: z.boolean(),
}).strict().superRefine((value, context) => {
  const keys = [...new Set(value.environmentKeys)].sort();
  if (keys.length !== value.environmentKeys.length || value.oidc && keys.join(',') !== 'ACTIONS_ID_TOKEN_REQUEST_TOKEN,ACTIONS_ID_TOKEN_REQUEST_URL'
    || !value.oidc && keys.length) context.addIssue({ code: 'custom', message: 'Recovery automation has incomplete or unrelated authorization inputs.' });
}));
export const recoveryRuntimeStepSchema = z.object({
  component: nonempty, operation: z.enum(['create', 'grant', 'write', 'destroy', 'recover']),
  target: coordinates, description: nonempty, requiresConfirm: z.boolean(), billable: z.boolean().optional(),
  privateInputKeys: z.array(nonempty).optional(),
}).strict();
export const recoveryRuntimeBindingSchema = z.object({
  provider: nonempty, evidence: coordinates,
  pending: z.object({ attemptId: nonempty, step: recoveryRuntimeStepSchema }).strict().optional(),
}).strict();
export const recoveryRuntimeExecutionTargetSchema = z.object({
  environmentId: runtimeCoordinateSchema, region: runtimeCoordinateSchema.optional(),
  provider: runtimeCoordinateSchema, providerScope: runtimeExecutionCoordinatesSchema,
  identity: z.object({ provider: runtimeCoordinateSchema, principal: runtimeCoordinateSchema, scope: runtimeExecutionCoordinatesSchema, source: z.enum(['observed', 'configured']) }).strict(),
  configuration: runtimeExecutionCoordinatesSchema,
  worker: z.object({ provider: runtimeCoordinateSchema, configuration: runtimeExecutionCoordinatesSchema }).strict(),
}).strict();

export interface RecoveryRuntimeStorageIdentity {
  provider: string;
  externalId: string;
  instanceScope: Record<string, string>;
}

/** Reviewed sources and archive; no application credentials or arbitrary worker command. */
export interface RecoveryRuntimeTarget {
  environment: Environment;
  database: RecoverySourceIdentity;
  destination: RecoveryRuntimeStorageIdentity;
  objects: Array<{ name: string; identity: RecoveryRuntimeStorageIdentity }>;
  runnerImage: string;
  /** Safe hashes of encrypted database inputs; detects rotation without exposing values. */
  privateInputFingerprints?: Record<string, string>;
}

/** Exact prepared authority for the temporary worker. All fields are non-secret. */
export interface RecoveryRuntimeExecutionTarget {
  environmentId: string;
  region?: string;
  provider: string;
  providerScope: Record<string, string>;
  identity: ProviderRuntimeIdentity;
  configuration: Record<string, string>;
  worker: { provider: string; configuration: Record<string, string> };
}

export interface RecoveryRuntimeStep {
  component: string;
  operation: 'create' | 'grant' | 'write' | 'destroy' | 'recover';
  target: Record<string, string>;
  description: string;
  requiresConfirm: boolean;
  billable?: boolean;
  /** Resolve privately, encrypt and durably persist with the attempt BEFORE apply. */
  privateInputKeys?: readonly string[];
}

export interface RecoveryRuntimeBinding {
  provider: string;
  evidence: Record<string, string>;
  pending?: { attemptId: string; step: RecoveryRuntimeStep };
}

export interface RecoveryRuntimeRequest {
  target: RecoveryRuntimeTarget;
  binding?: RecoveryRuntimeBinding;
  mode: 'ensure' | 'destroy';
}

export type RecoveryRuntimeObservation =
  | { state: 'ready'; executionTarget?: RecoveryRuntimeExecutionTarget }
  | { state: 'action'; step: RecoveryRuntimeStep }
  | { state: 'unknown' | 'waiting'; reason: string };

/** Only the current observed resource/operation frontier may mutate. */
export interface IRecoveryRuntime {
  inspect(request: RecoveryRuntimeRequest): Promise<RecoveryRuntimeObservation>;
  resolvePrivateInputs?(request: RecoveryRuntimeRequest & { step: RecoveryRuntimeStep }): Promise<Record<string, string>>;
  apply(request: RecoveryRuntimeRequest & {
    step: RecoveryRuntimeStep;
    attemptId: string;
    /** Loaded from the exact encrypted pending attempt; never returned to an interface. */
    privateInputs?: Record<string, string>;
  }): Promise<{ receipt: Receipt; binding?: RecoveryRuntimeBinding }>;
}
