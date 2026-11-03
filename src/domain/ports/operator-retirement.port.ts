import { z } from 'zod';

export const operatorRetirementReferenceSchema = z.object({ installationId: z.string().guid(),
  planDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
/** Explicit retirement only. Missing declarations never authorize deletion. */
export const operatorRetirementDeclarationSchema = z.object({ from: operatorRetirementReferenceSchema,
  resources: z.literal('delete-owned'), data: z.enum(['retain', 'delete-owned']),
  targets: z.array(operatorRetirementReferenceSchema).min(1).max(20).optional(),
  continueFrom: operatorRetirementReferenceSchema.optional(),
  outputTargets: z.array(z.object({ from: operatorRetirementReferenceSchema,
    role: z.string().regex(/^[a-z][a-z0-9-]{0,40}$/), key: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/),
    version: z.string().regex(/^[1-9][0-9]{0,19}$/) }).strict()).min(1).max(200).optional(),
}).strict().refine(value => Boolean(value.continueFrom) === Boolean(value.outputTargets)
  && (!value.continueFrom || value.data === 'delete-owned'
    && value.continueFrom.installationId !== value.from.installationId
    && new Set(value.outputTargets!.map(item => JSON.stringify(item))).size === value.outputTargets!.length
    && value.outputTargets!.every(item => (value.targets ?? [value.from]).some(target =>
      target.installationId === item.from.installationId && target.planDigest === item.from.planDigest))),
  'Output deletion requires a separate completed-retirement reference and exact output versions.');
export const operatorRetirementIntentSchema = operatorRetirementDeclarationSchema.safeExtend({
  targets: z.array(operatorRetirementReferenceSchema.extend({ evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(20),
}).strict();
export type OperatorRetirementIntent = z.infer<typeof operatorRetirementIntentSchema>;
/** Active removal is not proof of permanent data erasure. Keep retained native
 * identities even when the corresponding active binding is removed. */
export const operatorRetirementOutcomeSchema = z.object({
  outcome: z.enum(['removed', 'deletion-scheduled', 'retained-by-choice']),
  retained: z.array(z.object({ kind: z.string().min(1).max(200), id: z.string().min(1).max(2048),
    identity: z.record(z.string().min(1).max(100), z.string().min(1).max(2048)).refine(value => Object.keys(value).length > 0, 'Retained native lifetime evidence is required.'),
    reason: z.enum(['provider-retention', 'data-retention']),
    retentionUntil: z.string().datetime().optional(),
  }).strict()).max(300),
}).strict().superRefine((value, context) => {
  if ((value.outcome === 'removed') !== (value.retained.length === 0))
    context.addIssue({ code: 'custom', message: 'Retirement must report every retained native target.' });
  if (value.outcome === 'deletion-scheduled' && value.retained.some(item => item.reason !== 'provider-retention')
    || value.outcome === 'retained-by-choice' && !value.retained.some(item => item.reason === 'data-retention'))
    context.addIssue({ code: 'custom', message: 'Retirement must distinguish provider retention from deliberately retained data.' });
});
