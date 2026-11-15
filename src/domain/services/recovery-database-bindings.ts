import { z } from 'zod';
import type { Component } from '../entities/component.entity.js';
import { recoveryIdentityStringSchema } from './recovery-source.js';

/** Portable source coordinates only. Connection URLs and arbitrary component metadata never cross this boundary. */
export const recoveryDatabaseBindingsSchema = z.array(z.object({
  componentId: recoveryIdentityStringSchema, provider: recoveryIdentityStringSchema,
  engine: z.literal('postgres'), externalId: recoveryIdentityStringSchema,
  resourceKind: recoveryIdentityStringSchema.optional(),
}).strict()).max(256).superRefine((rows, context) => {
  if (new Set(rows.map(row => row.componentId)).size !== rows.length
    || new Set(rows.map(row => `${row.provider}\0${row.externalId}`)).size !== rows.length) {
    context.addIssue({ code: 'custom', message: 'Recovery database identities must be unique.' });
  }
});
export function recoveryDatabaseBindings(value: unknown) {
  const parsed = recoveryDatabaseBindingsSchema.safeParse(value);
  if (!parsed.success) throw new Error('Recovery database bindings are missing, malformed or ambiguous.');
  return parsed.data;
}
export function projectRecoveryDatabases(components: Component[], environmentId: string) {
  return recoveryDatabaseBindings(components.filter(component => component.environmentId === environmentId
    && component.type === 'postgres' && component.externalId !== null).map(component => ({
    componentId: component.id, provider: component.bindings.provider, engine: component.type, externalId: component.externalId,
    ...(component.bindings.resourceKind === undefined ? {} : { resourceKind: component.bindings.resourceKind }),
  })).sort((a, b) => a.componentId.localeCompare(b.componentId)));
}
