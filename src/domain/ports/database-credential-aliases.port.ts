import { z } from 'zod';
import type { Component } from '../entities/component.entity.js';
import type { Environment } from '../entities/environment.entity.js';
import type { Receipt } from './provider.port.js';

export const databaseCredentialAliasTargetSchema = z.object({
  provider: z.string().min(1), resourceId: z.string().min(1),
  providerScope: z.record(z.string().min(1), z.string().min(1)),
}).strict();
export type DatabaseCredentialAliasTarget = z.infer<typeof databaseCredentialAliasTargetSchema>;
export const databaseCredentialAliasesInspectionSchema = z.object({
  target: databaseCredentialAliasTargetSchema,
  checkedNames: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).min(1),
  changeNames: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)),
  /** Private provider evidence; encrypt before persistence and never render. */
  privateState: z.record(z.unknown()),
}).strict().superRefine((value, ctx) => {
  if (!Object.keys(value.target.providerScope).length
    || new Set(value.checkedNames).size !== value.checkedNames.length
    || new Set(value.changeNames).size !== value.changeNames.length
    || value.changeNames.some(name => !value.checkedNames.includes(name))) {
    ctx.addIssue({ code: 'custom', message: 'Credential aliases require exact unique names and provider scope.' });
  }
});
export type DatabaseCredentialAliasesInspection = z.infer<typeof databaseCredentialAliasesInspectionSchema>;

/** Repairs provider aliases only; never resets SQL authentication, creates access,
 * deploys, or changes application variables. Unknown outcomes are read back with
 * allowWrite=false. Call beforeWrite immediately before the first provider write.
 * Receipt data contains requestedCount/appliedCount/skippedCount,
 * referencesVerified, deploymentDeferred and authentication:'unchecked'. */
export interface IDatabaseCredentialAliases {
  inspect(input: { component: Component; environment: Environment }): Promise<DatabaseCredentialAliasesInspection>;
  repair(input: {
    component: Component; environment: Environment;
    expected: DatabaseCredentialAliasesInspection; allowWrite: boolean;
    beforeWrite: () => Promise<void>;
  }): Promise<Receipt>;
}
