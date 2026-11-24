import { createHash } from 'node:crypto';
import { z } from 'zod';

const id = z.string().regex(/^[A-Za-z0-9-]{1,128}$/);
export const migrationVersionSourceSchema = z.object({
  projectId: id, environmentId: id, serviceId: id, serviceInstanceId: id,
  deploymentId: id, replicaId: id, volumeId: id, volumeInstanceId: id,
  imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict();
export type MigrationVersionSource = z.infer<typeof migrationVersionSourceSchema>;
export const serverVersionNumber = z.number().int().min(100000).max(999999);
export const migrationSourceInventorySchema = z.object({
  versionNumber: serverVersionNumber, tables: z.number().int().min(0).max(2147483647),
  estimatedRows: z.string().regex(/^(?:0|[1-9][0-9]{0,29})$/),
}).strict();
export type MigrationSourceInventory = z.infer<typeof migrationSourceInventorySchema>;
export type MigrationInspectionAccess = 'inspect' | 'reuse-receipt';
export interface PrivateMigrationSourceInspection {
  hasTrustedAccess(projectId: string, purpose: MigrationInspectionAccess): Promise<boolean>;
  observe(scope: Pick<MigrationVersionSource, 'projectId' | 'environmentId' | 'serviceId'>): Promise<MigrationVersionSource>;
  programHash(source: MigrationVersionSource): string;
  inspect(source: MigrationVersionSource): Promise<MigrationSourceInventory>;
}
const metadata = z.object({
  operation: z.literal('migrationSourceVersion'), targetEnvironment: z.string().min(1).max(128),
  componentId: id, source: migrationVersionSourceSchema, programHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type MigrationVersionMetadata = z.infer<typeof metadata>;
export function migrationVersionActionId(value: MigrationVersionMetadata): string {
  return 'database:source-version:' + createHash('sha256').update(JSON.stringify(metadata.parse(value))).digest('hex');
}
export const migrationVersionActionSchema = z.object({
  id: z.string(), type: z.literal('update'), verified: z.literal(true), requiresConfirm: z.literal(true),
  resource: z.object({ kind: z.literal('database'), provider: z.literal('railway'), name: z.literal('postgres') }).strict(),
  reason: z.string(), metadata,
}).strict().refine(action => action.id === migrationVersionActionId(action.metadata), 'Source inspection identity changed.');
export const migrationVersionReceiptSchema = z.object({
  planId: id, actionId: z.string(), metadata, inventory: migrationSourceInventorySchema,
}).strict().refine(value => value.actionId === migrationVersionActionId(value.metadata));
