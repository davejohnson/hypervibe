import { createHash } from 'node:crypto';
import { z } from 'zod';
import { HYPERVIBE_VERSION } from '../../version.js';
import { projectSpecSchema } from './spec.schema.js';

/**
 * Identity of the Hypervibe build that wrote a stored spec revision.
 *
 * The package version alone cannot distinguish development builds that share
 * a release number, so the fingerprint of the accepted spec input shape is
 * recorded too. A reader whose fingerprint differs knows the revision may use
 * fields it does not understand.
 */
export interface SpecWriterIdentity {
  version: string;
  schema: string;
}

let current: SpecWriterIdentity | undefined;

export function specSchemaFingerprint(schema: z.ZodType = projectSpecSchema): string {
  const shape = JSON.stringify(z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' }));
  return createHash('sha256').update(shape).digest('hex').slice(0, 16);
}

export function currentSpecWriter(): SpecWriterIdentity {
  current ??= { version: HYPERVIBE_VERSION, schema: specSchemaFingerprint() };
  return current;
}

function parseSemver(version: string): number[] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return match ? match.slice(1).map(Number) : null;
}

/** Positive when `left` is a newer release than `right`; null when either is not a release version. */
export function compareReleaseVersions(left: string, right: string): number | null {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}
