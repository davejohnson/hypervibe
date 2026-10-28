import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { databaseTaskCheckpointSchema } from '../ports/hosting.port.js';
import { databaseInitializationApprovedVariablesSchema, databaseInitializationImageSchema,
  databaseInitializationVariableReferenceSchema } from '../ports/database-initialization-bootstrap.port.js';
import { recoveryIdentityStringSchema, recoverySourceIdentitySchema } from '../services/recovery-source.js';
import { DATABASE_INITIALIZATION_AUTH_COMMAND_HASH, DATABASE_INITIALIZATION_RECEIPT_PREFIX,
  parseDatabaseInitializationReceipt } from '../services/database-initialization-program.js';
import type { PlanAction } from './plan.types.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const DATABASE_BOOTSTRAP_AUTHENTICATE_OPERATION = 'databaseBootstrapAuthenticate';
export const DATABASE_BOOTSTRAP_MIGRATE_OPERATION = 'databaseBootstrapMigrate';
export const DATABASE_BOOTSTRAP_OPERATIONS = [DATABASE_BOOTSTRAP_AUTHENTICATE_OPERATION, DATABASE_BOOTSTRAP_MIGRATE_OPERATION] as const;
export const databaseBootstrapBaseSchema = z.object({
  componentId: z.string().min(1), generationHash: hash, intentId: z.string().min(1),
  hostingProvider: recoveryIdentityStringSchema,
  service: recoveryIdentityStringSchema, image: databaseInitializationImageSchema, migrationCommandHash: hash,
  source: recoverySourceIdentitySchema, databaseDeploymentId: recoveryIdentityStringSchema,
  sourceServiceId: recoveryIdentityStringSchema, sourceInstanceId: recoveryIdentityStringSchema,
  environmentFingerprint: hash,
  variableReferences: z.array(databaseInitializationVariableReferenceSchema).min(1).max(16),
  approvedVariables: databaseInitializationApprovedVariablesSchema,
}).strict();
export type DatabaseBootstrapBase = z.infer<typeof databaseBootstrapBaseSchema>;
export const databaseBootstrapMetadataSchema = databaseBootstrapBaseSchema.extend({
  operation: z.enum(DATABASE_BOOTSTRAP_OPERATIONS), mode: z.enum(['authenticate', 'migrate']),
  executionId: z.uuid(), commandHash: hash,
}).strict().superRefine((value, ctx) => {
  if (value.operation !== (value.mode === 'authenticate' ? DATABASE_BOOTSTRAP_AUTHENTICATE_OPERATION : DATABASE_BOOTSTRAP_MIGRATE_OPERATION)
    || value.commandHash !== (value.mode === 'authenticate' ? DATABASE_INITIALIZATION_AUTH_COMMAND_HASH : value.migrationCommandHash)) {
    ctx.addIssue({ code: 'custom', message: 'Bootstrap action authority is inconsistent.' });
  }
});
export type DatabaseBootstrapMetadata = z.infer<typeof databaseBootstrapMetadataSchema>;
export const databaseBootstrapActionId = (value: Pick<DatabaseBootstrapMetadata, 'componentId' | 'generationHash' | 'mode'>) =>
  `database-bootstrap:${encodeURIComponent(value.componentId)}:${value.generationHash}:${value.mode}`;
export const databaseBootstrapActionSchema = z.object({
  id: z.string().min(1), type: z.literal('update'),
  resource: z.object({ kind: z.literal('database'), name: z.literal('postgres'), provider: recoveryIdentityStringSchema }).strict(),
  verified: z.literal(true), requiresConfirm: z.literal(true), billable: z.literal(true), dataBearing: z.boolean(),
  reason: z.string(), dependsOn: z.array(z.string()).max(0).optional(), metadata: databaseBootstrapMetadataSchema,
}).strict().superRefine((action, ctx) => {
  if (action.id !== databaseBootstrapActionId(action.metadata) || action.resource.provider !== action.metadata.source.provider
    || action.dataBearing !== (action.metadata.mode === 'migrate')) {
    ctx.addIssue({ code: 'custom', message: 'Bootstrap requires one exact confirmed task action.' });
  }
});
export const isDatabaseBootstrapAction = (action: PlanAction): boolean => databaseBootstrapActionSchema.safeParse(action).success;

/** One initialization generation only. A later reset needs its own reviewed lifecycle. */
export const databaseBootstrapRecoverySchema = z.object({
  version: z.literal(1), base: databaseBootstrapBaseSchema, inspectionEncrypted: z.string().min(1),
  authenticationExecutionId: z.uuid(), migrationExecutionId: z.uuid(),
  authentication: databaseTaskCheckpointSchema.optional(), migration: databaseTaskCheckpointSchema.optional(),
  authenticationVerifiedAt: z.iso.datetime().optional(), consumedAt: z.iso.datetime().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.authenticationExecutionId === value.migrationExecutionId || value.migration && !value.authenticationVerifiedAt
    || value.authenticationVerifiedAt && (value.authentication?.phase !== 'complete' || value.authentication.terminal?.status !== 'succeeded')
    || value.consumedAt && (!value.authenticationVerifiedAt || value.migration?.phase !== 'complete' || value.migration.terminal?.status !== 'succeeded')) {
    ctx.addIssue({ code: 'custom', message: 'Bootstrap stage evidence is incomplete.' });
  }
  for (const mode of ['authenticate', 'migrate'] as const) {
    const state = mode === 'authenticate' ? value.authentication : value.migration;
    const result = state?.terminal?.result;
    const expected = { executionId: mode === 'authenticate' ? value.authenticationExecutionId : value.migrationExecutionId, mode,
      commandHash: mode === 'authenticate' ? DATABASE_INITIALIZATION_AUTH_COMMAND_HASH : value.base.migrationCommandHash };
    if (result && !parseDatabaseInitializationReceipt(DATABASE_INITIALIZATION_RECEIPT_PREFIX + JSON.stringify(result), expected)
      || state?.terminal?.status === 'succeeded' && (!result || result.authentication !== 'authenticated'
        || state.terminal.exitCode !== 0 || mode === 'migrate' && result.migration !== 'completed')) {
      ctx.addIssue({ code: 'custom', message: 'Bootstrap terminal receipt is not correlated to its reviewed execution.' });
    }
  }
});
export type DatabaseBootstrapRecovery = z.infer<typeof databaseBootstrapRecoverySchema>;

export function hasPendingDatabaseBootstrap(bindings: Record<string, unknown>): boolean {
  if (!Object.hasOwn(bindings, 'databaseBootstrap')) return false;
  const parsed = databaseBootstrapRecoverySchema.safeParse(bindings.databaseBootstrap);
  return !parsed.success || !parsed.data.consumedAt;
}

function observableExecution(bindings: Record<string, unknown>) {
  const parsed = databaseBootstrapRecoverySchema.safeParse(bindings.databaseBootstrap);
  if (!parsed.success || parsed.data.consumedAt) return undefined;
  const state = parsed.data, mode = state.authenticationVerifiedAt ? 'migrate' : 'authenticate';
  const checkpoint = mode === 'authenticate' ? state.authentication : state.migration;
  return checkpoint && ['deployed', 'terminal', 'cleanup-attempted'].includes(checkpoint.phase) ? { state, mode } : undefined;
}

/** Only acknowledged execution observation/cleanup can ignore incompatible
 * current desired providers. New task mutations retain ordinary validation. */
export function hasDatabaseBootstrapObservationOrCleanup(bindings: Record<string, unknown>): boolean {
  return Boolean(observableExecution(bindings));
}

export function matchesDatabaseBootstrapObservationOrCleanup(bindings: Record<string, unknown>, action: PlanAction): boolean {
  const retained = observableExecution(bindings), parsed = databaseBootstrapActionSchema.safeParse(action);
  if (!retained || !parsed.success) return false;
  const { operation: _operation, commandHash: _commandHash, executionId, mode, ...base } = parsed.data.metadata;
  return mode === retained.mode && isDeepStrictEqual(base, retained.state.base)
    && executionId === (mode === 'authenticate' ? retained.state.authenticationExecutionId : retained.state.migrationExecutionId);
}
