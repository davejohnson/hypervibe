import { z } from 'zod';
import { recoverySourceIdentitySchema } from './recovery-source.js';

const timestamp = z.string().datetime({ offset: true });
/** A selected recovery point is an identity, not evidence that it is available.
 * Snapshot creation time and database recovery time intentionally differ.
 * A PITR selector need not have a snapshot ID or asynchronous workflow ID.
 */
export const recoveryPointSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('snapshot'), source: recoverySourceIdentitySchema,
    id: z.string().trim().min(1), createdAt: timestamp,
    expiresAt: timestamp.nullable(), dataTime: timestamp.optional(),
  }).strict(),
  z.object({
    kind: z.literal('point-in-time'), source: recoverySourceIdentitySchema,
    selector: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('timestamp'), value: timestamp }).strict(),
      z.object({ kind: z.literal('lsn'), value: z.string().regex(/^[0-9A-F]+\/[0-9A-F]+$/i) }).strict(),
    ]),
  }).strict(),
]);
export type RecoveryPoint = z.infer<typeof recoveryPointSchema>;
