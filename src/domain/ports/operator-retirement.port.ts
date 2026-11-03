import { z } from 'zod';

export const operatorRetirementReferenceSchema = z.object({ installationId: z.string().guid(),
  planDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
/** Explicit retirement only. Missing declarations never authorize deletion. */
export const operatorRetirementDeclarationSchema = z.object({ from: operatorRetirementReferenceSchema,
  resources: z.literal('delete-owned'), data: z.enum(['retain', 'delete-owned']),
  targets: z.array(operatorRetirementReferenceSchema).min(1).max(20).optional(),
}).strict();
export const operatorRetirementIntentSchema = operatorRetirementDeclarationSchema.extend({
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
