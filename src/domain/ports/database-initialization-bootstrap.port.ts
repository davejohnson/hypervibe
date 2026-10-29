import { z } from 'zod';
import type { Environment } from '../entities/environment.entity.js';
import type { CompletedDatabaseInitializationReceipt } from '../plan/database-initialization.contract.js';
import { recoveryIdentityStringSchema, recoverySourceIdentitySchema } from '../services/recovery-source.js';

const key = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const databaseInitializationImageSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9./:_-]*@sha256:[a-f0-9]{64}$/)
  .refine(value => !value.includes('://'));
export const databaseInitializationApprovedVariablesSchema = z.object({
  NODE_ENV: z.enum(['production', 'development', 'test']).optional(),
}).strict();
export const databaseInitializationVariableReferenceSchema = z.object({
  sourceServiceId: recoveryIdentityStringSchema, variableName: key, targetName: key,
}).strict();

/** Private URL material and comparison hashes must be encrypted before storage. */
export const databaseInitializationPrivateConfigurationSchema = z.object({
  keys: z.array(key).min(1).max(16),
  expectedHashes: z.record(key, hash),
  authentication: z.object({ username: z.string().min(1), database: z.string().min(1) }).strict(),
  rawDefinitions: z.record(key, z.string()),
  issuerDefinitions: z.record(key, z.string()),
  resolvedValues: z.record(key, z.string()),
}).strict().superRefine((value, ctx) => {
  if (!value.keys.includes('DATABASE_URL') || new Set(value.keys).size !== value.keys.length
    || Object.keys(value.expectedHashes).length !== value.keys.length
    || Object.keys(value.resolvedValues).length !== value.keys.length
    || value.keys.some(name => !value.expectedHashes[name] || !value.resolvedValues[name])) {
    ctx.addIssue({ code: 'custom', message: 'Database inspection requires complete unique connection keys.' });
  }
});

/** Configuration evidence only; a provider read cannot certify authentication. */
export const databaseInitializationBootstrapInspectionSchema = z.object({
  source: recoverySourceIdentitySchema,
  databaseDeploymentId: recoveryIdentityStringSchema,
  sourceServiceId: recoveryIdentityStringSchema,
  sourceInstanceId: recoveryIdentityStringSchema,
  image: databaseInitializationImageSchema,
  variableReferences: z.array(databaseInitializationVariableReferenceSchema).min(1).max(16),
  approvedVariables: databaseInitializationApprovedVariablesSchema,
  verification: z.object({
    rawReferences: z.literal('verified'), configuredValues: z.literal('matched'),
    sqlAuthentication: z.literal('unchecked'), deployedConfiguration: z.literal('unchecked'),
    applicationOperation: z.literal('unchecked'),
  }).strict(),
  privateConfiguration: databaseInitializationPrivateConfigurationSchema,
}).strict();
export type DatabaseInitializationBootstrapInspection = z.infer<typeof databaseInitializationBootstrapInspectionSchema>;

export interface DatabaseInitializationBootstrapInput {
  environment: Environment;
  completedInitialization: Pick<CompletedDatabaseInitializationReceipt, 'target' | 'storageId' | 'storageInstanceId' | 'deploymentId' | 'activationReconciliation'>;
  sourceServiceName: string;
  expectedImage: string;
  databaseEnvAliases?: Record<string, 'DATABASE_URL' | 'DIRECT_URL'>;
  approvedVariables?: z.infer<typeof databaseInitializationApprovedVariablesSchema>;
}

/** Read-only provider admission. Callers own fresh-receipt validation, exact
 * plan confirmation, encrypted persistence and execution sequencing. */
export interface IDatabaseInitializationBootstrap {
  inspect(input: DatabaseInitializationBootstrapInput): Promise<DatabaseInitializationBootstrapInspection>;
}
